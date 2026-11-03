/**
 * ARTHAVAULT WP-22: Generic Recurring Deposit (RD) Mathematical Engine
 * Pure annuity compounding engine with configurable deposit and compounding rests.
 */

import { CalculationResult } from '../../../domain/mathematics/types';
import { ProvenanceService } from '../ProvenanceService';

export interface RdCalculationInput {
  monthlyDeposit: number;           // ₹ (P > 0)
  annualNominalRatePct: number;     // e.g. 7.0 for 7.0% p.a.
  tenureMonths: number;             // n >= 6 months
  compoundingFrequency?: 'QUARTERLY' | 'MONTHLY' | 'ANNUAL';
}

export interface RdScheduleQuarter {
  quarter: number;
  monthStart: number;
  monthEnd: number;
  openingBalance: number;
  quarterlyDeposits: number;
  interestEarned: number;
  closingBalance: number;
}

export interface RdCalculationOutput {
  totalDeposited: number;           // Total principal paid
  totalInterestEarned: number;      // Total interest accrued
  maturityCorpus: number;           // Maturity payout
  effectiveYieldPct: number;        // Compounded effective annual rate
  quarterlyBreakdown: RdScheduleQuarter[];
}

export class RecurringDepositEngine {
  /**
   * Calculate Recurring Deposit maturity using generalized compounding rules.
   * Standard Indian Banking convention uses quarterly compounding rest (compoundingFrequency = 'QUARTERLY').
   */
  static calculate(input: RdCalculationInput): CalculationResult<RdCalculationOutput> {
    const startTime = Date.now();
    const compFreq = input.compoundingFrequency ?? 'QUARTERLY';

    const provenance = ProvenanceService.createProvenance({
      engineId: 'ENGINE_RECURRING_DEPOSIT',
      algorithmId: 'ALG_RD_GENERALIZED_COMPOUNDING',
      algorithmVersion: '1.0.0',
      configVersion: `CONFIG_COMP_${compFreq}`,
      rawInputs: input,
      referenceType: 'INDUSTRY_STANDARD',
      citation: 'Quarterly rest annuity accumulation model'
    });

    if (input.monthlyDeposit < 0 || input.annualNominalRatePct < 0 || input.tenureMonths < 1) {
      return {
        calculationId: 'ENGINE_RECURRING_DEPOSIT',
        state: 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Deposit amount and rate must be non-negative and tenure at least 1 month.'
        }
      };
    }

    if (input.monthlyDeposit === 0) {
      return {
        calculationId: 'ENGINE_RECURRING_DEPOSIT',
        state: 'ZERO',
        freshness: 'CURRENT',
        data: {
          totalDeposited: 0,
          totalInterestEarned: 0,
          maturityCorpus: 0,
          effectiveYieldPct: 0,
          quarterlyBreakdown: []
        },
        unit: 'CURRENCY_INR',
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance
      };
    }

    const P = input.monthlyDeposit;
    const rNominal = input.annualNominalRatePct / 100;
    const n = Math.round(input.tenureMonths);

    // Number of compounding periods per year
    const mPeriods = compFreq === 'QUARTERLY' ? 4 : compFreq === 'MONTHLY' ? 12 : 1;
    const periodRate = rNominal / mPeriods;

    // Standard analytical formula for monthly deposits compounded quarterly:
    // Maturity A = P * sum_{k=1}^n (1 + r/m)^(m * (n - k + 1) / 12)
    let totalMaturityFloat = 0;
    for (let k = 1; k <= n; k++) {
      const remainingMonths = n - k + 1;
      const compoundingExponents = mPeriods * (remainingMonths / 12);
      totalMaturityFloat += P * Math.pow(1 + periodRate, compoundingExponents);
    }

    const totalDeposited = P * n;
    const maturityCorpus = Math.round(totalMaturityFloat);
    const totalInterestEarned = Math.max(0, maturityCorpus - totalDeposited);
    const effectiveYield = Math.pow(1 + periodRate, mPeriods) - 1;
    const effectiveYieldPct = Math.round(effectiveYield * 10000) / 100;

    // Generate quarterly schedule derived strictly from Model A compounding
    const totalQuarters = Math.ceil(n / 3);
    const quarterlyBreakdown: RdScheduleQuarter[] = [];
    let previousQuarterClosingFloat = 0;

    for (let q = 1; q <= totalQuarters; q++) {
      const mStart = (q - 1) * 3 + 1;
      const mEnd = Math.min(n, q * 3);
      const monthsInQuarter = mEnd - mStart + 1;
      const qDeposits = P * monthsInQuarter;

      // Compounded value of all deposits made up to mEnd at the end of month mEnd:
      let cumulativeBalanceFloat = 0;
      for (let k = 1; k <= mEnd; k++) {
        const remMonths = mEnd - k + 1;
        const exp = mPeriods * (remMonths / 12);
        cumulativeBalanceFloat += P * Math.pow(1 + periodRate, exp);
      }

      const openingBalance = Math.round(previousQuarterClosingFloat);
      const closingBalance = Math.round(cumulativeBalanceFloat);
      const interestEarned = closingBalance - openingBalance - qDeposits;

      quarterlyBreakdown.push({
        quarter: q,
        monthStart: mStart,
        monthEnd: mEnd,
        openingBalance,
        quarterlyDeposits: qDeposits,
        interestEarned,
        closingBalance
      });

      previousQuarterClosingFloat = cumulativeBalanceFloat;
    }

    return {
      calculationId: 'ENGINE_RECURRING_DEPOSIT',
      state: 'VALID',
      freshness: 'CURRENT',
      data: {
        totalDeposited,
        totalInterestEarned,
        maturityCorpus,
        effectiveYieldPct,
        quarterlyBreakdown
      },
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance
    };
  }
}
