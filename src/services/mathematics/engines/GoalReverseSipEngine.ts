/**
 * ARTHAVAULT WP-22: Goal Reverse SIP Solver Mathematical Engine
 * Inverts the annuity compounding formula to solve for the exact monthly SIP required to achieve a target corpus milestone.
 */

import { CalculationResult } from '../../../domain/mathematics/types';
import { ProvenanceService } from '../ProvenanceService';

export interface GoalReverseSipInput {
  targetCorpus: number;               // Target milestone amount (₹ > 0)
  tenureYears: number;                // Years to goal target (t > 0)
  annualExpectedRatePct: number;      // Expected growth rate (% p.a.)
  currentSavings?: number;            // Existing corpus already accumulated
  annualStepUpPct?: number;           // Optional planned annual step-up percentage
}

export interface GoalReverseSipOutput {
  targetCorpus: number;
  tenureYears: number;
  expectedRatePct: number;
  currentSavings: number;
  currentSavingsFutureValue: number;
  remainingCorpusDeficit: number;
  requiredMonthlySip: number;         // Initial monthly SIP required
  totalCapitalInvested: number;
  totalEstimatedGains: number;
}

export class GoalReverseSipEngine {
  /**
   * Solve for the required monthly SIP contribution to reach target corpus.
   */
  static calculate(input: GoalReverseSipInput): CalculationResult<GoalReverseSipOutput> {
    const startTime = Date.now();
    const T = Math.max(0, input.targetCorpus);
    const S0 = Math.max(0, input.currentSavings ?? 0);
    const t = Math.max(0.1, input.tenureYears);
    const totalMonths = Math.round(t * 12);
    const rAnnual = Math.max(0, input.annualExpectedRatePct) / 100;
    const iMonthly = rAnnual / 12;
    const stepUp = Math.max(0, input.annualStepUpPct ?? 0) / 100;

    const provenance = ProvenanceService.createProvenance({
      engineId: 'ENGINE_GOAL_SOLVER',
      algorithmId: 'ALG_GOAL_REVERSE_SIP',
      algorithmVersion: '1.0.0',
      rawInputs: input,
      referenceType: 'FIRST_PRINCIPLES',
      citation: 'Annuity inversion formula with compounding initial corpus growth'
    });

    if (T <= 0 || t <= 0) {
      return {
        calculationId: 'ENGINE_GOAL_SOLVER',
        state: T === 0 ? 'ZERO' : 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Target corpus and tenure must be positive numbers.'
        }
      };
    }

    // Future value of existing accumulated savings
    const currentSavingsFV = Math.round(S0 * Math.pow(1 + rAnnual, t));
    const remainingDeficit = Math.max(0, T - currentSavingsFV);

    if (remainingDeficit === 0) {
      return {
        calculationId: 'ENGINE_GOAL_SOLVER',
        state: 'VALID',
        freshness: 'CURRENT',
        data: {
          targetCorpus: T,
          tenureYears: t,
          expectedRatePct: input.annualExpectedRatePct,
          currentSavings: S0,
          currentSavingsFutureValue: currentSavingsFV,
          remainingCorpusDeficit: 0,
          requiredMonthlySip: 0,
          totalCapitalInvested: 0,
          totalEstimatedGains: currentSavingsFV - S0
        },
        unit: 'CURRENCY_INR',
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance
      };
    }

    let requiredMonthlySip = 0;

    if (stepUp === 0) {
      // Standard analytical closed-form inversion
      if (iMonthly === 0) {
        requiredMonthlySip = Math.ceil(remainingDeficit / totalMonths);
      } else {
        // Annuity accumulation factor: FV_factor = (1+i) * ((1+i)^n - 1) / i
        const fvFactor = (1 + iMonthly) * (Math.pow(1 + iMonthly, totalMonths) - 1) / iMonthly;
        requiredMonthlySip = Math.ceil(remainingDeficit / fvFactor);
      }
    } else {
      // Numerical inversion for annual step-up compounding
      const simulateCorpus = (p: number): number => {
        let val = 0;
        let pCurrent = p;
        for (let m = 1; m <= totalMonths; m++) {
          if (m > 1 && (m - 1) % 12 === 0) {
            pCurrent = pCurrent * (1 + stepUp);
          }
          val = (val + pCurrent) * (1 + iMonthly);
        }
        return val;
      };

      let low = 1;
      let high = remainingDeficit;
      for (let iter = 0; iter < 50; iter++) {
        const mid = (low + high) / 2;
        const corpusGenerated = simulateCorpus(mid);
        if (Math.abs(corpusGenerated - remainingDeficit) < 1.0) {
          requiredMonthlySip = Math.ceil(mid);
          break;
        }
        if (corpusGenerated < remainingDeficit) {
          low = mid;
        } else {
          high = mid;
        }
      }
      if (requiredMonthlySip === 0) {
        requiredMonthlySip = Math.ceil(high);
      }
    }

    // Compute total invested capital across the tenure
    let totalInvestedFromSip = 0;
    let pIter = requiredMonthlySip;
    for (let m = 1; m <= totalMonths; m++) {
      if (m > 1 && (m - 1) % 12 === 0) {
        pIter = pIter * (1 + stepUp);
      }
      totalInvestedFromSip += pIter;
    }

    const totalInvested = Math.round(totalInvestedFromSip);
    const totalGains = Math.max(0, remainingDeficit - totalInvested);

    return {
      calculationId: 'ENGINE_GOAL_SOLVER',
      state: 'VALID',
      freshness: 'CURRENT',
      data: {
        targetCorpus: T,
        tenureYears: t,
        expectedRatePct: input.annualExpectedRatePct,
        currentSavings: S0,
        currentSavingsFutureValue: currentSavingsFV,
        remainingCorpusDeficit: remainingDeficit,
        requiredMonthlySip,
        totalCapitalInvested: totalInvested,
        totalEstimatedGains: totalGains
      },
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance
    };
  }
}
