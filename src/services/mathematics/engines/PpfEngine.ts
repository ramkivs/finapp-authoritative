/**
 * ARTHAVAULT WP-22: Public Provident Fund (PPF) Mathematical Engine
 * Computes statutory 15-year PPF maturity schedule governed by an externalized policy contract.
 */

import { CalculationResult } from '../../../domain/mathematics/types';
import { PpfPolicyParameters, STATUTORY_PPF_SCHEME_2019 } from '../policies/PpfPolicyContract';
import { ProvenanceService } from '../ProvenanceService';

export interface PpfCalculationInput {
  annualDepositAmount: number;        // ₹ (500 <= P <= 150,000)
  customRatePct?: number;             // Optional override rate (e.g. 7.10)
  tenureYears?: number;               // Default 15 years
  policyVersion?: string;             // e.g. '2019.1'
}

export interface PpfYearlyScheduleRow {
  year: number;
  openingBalance: number;
  depositAmount: number;
  interestEarned: number;
  closingBalance: number;
  cumulativeDeposited: number;
}

export interface PpfCalculationOutput {
  totalDeposited: number;
  totalInterestEarned: number;
  maturityAmount: number;
  statutoryTenureYears: number;
  applicableRatePct: number;
  yearlySchedule: PpfYearlyScheduleRow[];
}

export class PpfEngine {
  /**
   * Calculate statutory 15-year Public Provident Fund (PPF) compounding schedule.
   * Interest is calculated on the balance and credited annually on March 31.
   */
  static calculate(input: PpfCalculationInput): CalculationResult<PpfCalculationOutput> {
    const startTime = Date.now();
    const annualDeposit = Math.max(0, input.annualDepositAmount);
    const tenureYears = input.tenureYears ?? 15;
    const policyRate = ((STATUTORY_PPF_SCHEME_2019.parameters.annualInterestRatePct.value as number) * 100);
    const ratePct = input.customRatePct ?? policyRate;
    const r = ratePct / 100;

    const provenance = ProvenanceService.createProvenance({
      engineId: 'ENGINE_PPF',
      algorithmId: 'ALG_PPF_STATUTORY_SCHEME',
      algorithmVersion: '1.0.0',
      policyContractId: 'IN_PPF_SCHEME_2019',
      policyVersion: input.policyVersion ?? '2019.1',
      rawInputs: input,
      referenceType: 'STATUTORY_AUTHORITY',
      citation: 'Ministry of Finance PPF Scheme 2019 Statutory Compounding Schedule'
    });

    if (annualDeposit <= 0 || tenureYears < 1 || r < 0) {
      return {
        calculationId: 'ENGINE_PPF',
        state: annualDeposit === 0 ? 'ZERO' : 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Annual deposit amount must be at least ₹500 and tenure at least 1 year.'
        }
      };
    }

    let runningBalance = 0;
    let cumulativeDeposited = 0;
    const yearlySchedule: PpfYearlyScheduleRow[] = [];

    for (let y = 1; y <= tenureYears; y++) {
      const opening = runningBalance;
      // In statutory PPF: Deposit made before 5th of April earns full year's interest
      const eligibleBalanceForInterest = opening + annualDeposit;
      const annualInterest = Math.round(eligibleBalanceForInterest * r);
      runningBalance = eligibleBalanceForInterest + annualInterest;
      cumulativeDeposited += annualDeposit;

      yearlySchedule.push({
        year: y,
        openingBalance: Math.round(opening),
        depositAmount: annualDeposit,
        interestEarned: annualInterest,
        closingBalance: Math.round(runningBalance),
        cumulativeDeposited
      });
    }

    const maturityAmount = Math.round(runningBalance);
    const totalInterestEarned = maturityAmount - cumulativeDeposited;

    return {
      calculationId: 'ENGINE_PPF',
      state: 'VALID',
      freshness: 'CURRENT',
      data: {
        totalDeposited: cumulativeDeposited,
        totalInterestEarned,
        maturityAmount,
        statutoryTenureYears: tenureYears,
        applicableRatePct: ratePct,
        yearlySchedule
      },
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance
    };
  }
}
