/**
 * ARTHAVAULT WP-22: Systematic Withdrawal Plan (SWP) Mathematical Engine
 * Models annuity depletion, periodic retirement cash flows, capital longevity, and residual corpus.
 */

import { CalculationResult } from '../../../domain/mathematics/types';
import { ProvenanceService } from '../ProvenanceService';

export interface SwpCalculationInput {
  initialCorpus: number;              // Initial capital corpus (₹ > 0)
  monthlyWithdrawal: number;          // Monthly withdrawal payout (₹ > 0)
  annualReturnRatePct: number;        // Expected portfolio growth rate (% p.a.)
  tenureYears: number;                // Duration horizon in years
  annualStepUpPct?: number;           // Optional annual inflation adjustment to withdrawal
}

export interface SwpScheduleYear {
  year: number;
  openingBalance: number;
  totalWithdrawnThisYear: number;
  interestEarnedThisYear: number;
  closingBalance: number;
  cumulativeWithdrawn: number;
}

export interface SwpCalculationOutput {
  initialCorpus: number;
  totalWithdrawn: number;
  totalGainsGenerated: number;
  finalRemainingCorpus: number;
  isCorpusExhausted: boolean;
  exhaustionMonth?: number | null;
  yearlySchedule: SwpScheduleYear[];
}

export class SwpEngine {
  /**
   * Calculate Systematic Withdrawal Plan (SWP) decumulation and capital longevity schedule.
   */
  static calculate(input: SwpCalculationInput): CalculationResult<SwpCalculationOutput> {
    const startTime = Date.now();
    const initialCorpus = Math.max(0, input.initialCorpus);
    const W0 = Math.max(0, input.monthlyWithdrawal);
    const rAnnual = Math.max(0, input.annualReturnRatePct) / 100;
    const iMonthly = rAnnual / 12;
    const totalYears = Math.max(1, Math.min(50, Math.round(input.tenureYears)));
    const totalMonths = totalYears * 12;
    const stepUp = Math.max(0, input.annualStepUpPct ?? 0) / 100;

    const provenance = ProvenanceService.createProvenance({
      engineId: 'ENGINE_SWP',
      algorithmId: 'ALG_SWP_ANNUITY_DEPLETION',
      algorithmVersion: '1.0.0',
      rawInputs: input,
      referenceType: 'FIRST_PRINCIPLES',
      citation: 'Monthly annuity depletion model with growth compounding and annual withdrawal step-up'
    });

    if (initialCorpus <= 0 || W0 <= 0 || totalYears < 1) {
      return {
        calculationId: 'ENGINE_SWP',
        state: initialCorpus === 0 ? 'ZERO' : 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Initial corpus and monthly withdrawal must be positive numbers.'
        }
      };
    }

    let runningBalance = initialCorpus;
    let currentMonthlyW = W0;
    let totalWithdrawn = 0;
    let totalGains = 0;
    let isExhausted = false;
    let exhaustionMonth: number | null = null;

    const yearlySchedule: SwpScheduleYear[] = [];
    let yearOpening = runningBalance;
    let yearWithdrawn = 0;
    let yearInterest = 0;

    for (let m = 1; m <= totalMonths; m++) {
      const yearIndex = Math.floor((m - 1) / 12) + 1;

      // Apply annual step-up to withdrawal at beginning of year
      if (m > 1 && (m - 1) % 12 === 0) {
        currentMonthlyW = currentMonthlyW * (1 + stepUp);
      }

      if (runningBalance <= 0) {
        if (!isExhausted) {
          isExhausted = true;
          exhaustionMonth = m - 1;
        }
        runningBalance = 0;
      } else {
        // Withdrawal at beginning of month
        const actualWithdrawal = Math.min(runningBalance, currentMonthlyW);
        runningBalance -= actualWithdrawal;
        totalWithdrawn += actualWithdrawal;
        yearWithdrawn += actualWithdrawal;

        // Interest compounding on remaining balance during the month
        const monthlyInterest = runningBalance * iMonthly;
        runningBalance += monthlyInterest;
        totalGains += monthlyInterest;
        yearInterest += monthlyInterest;

        if (runningBalance < 0.01) {
          runningBalance = 0;
          if (!isExhausted) {
            isExhausted = true;
            exhaustionMonth = m;
          }
        }
      }

      // Record year-end snapshot
      if (m % 12 === 0 || m === totalMonths) {
        yearlySchedule.push({
          year: yearIndex,
          openingBalance: Math.round(yearOpening),
          totalWithdrawnThisYear: Math.round(yearWithdrawn),
          interestEarnedThisYear: Math.round(yearInterest),
          closingBalance: Math.round(runningBalance),
          cumulativeWithdrawn: Math.round(totalWithdrawn)
        });

        yearOpening = runningBalance;
        yearWithdrawn = 0;
        yearInterest = 0;
      }
    }

    return {
      calculationId: 'ENGINE_SWP',
      state: 'VALID',
      freshness: 'CURRENT',
      data: {
        initialCorpus,
        totalWithdrawn: Math.round(totalWithdrawn),
        totalGainsGenerated: Math.round(totalGains),
        finalRemainingCorpus: Math.round(runningBalance),
        isCorpusExhausted: isExhausted,
        exhaustionMonth,
        yearlySchedule
      },
      unit: 'CURRENCY_INR',
      diagnostics: {
        executionTimeMs: Date.now() - startTime
      },
      provenance
    };
  }
}
