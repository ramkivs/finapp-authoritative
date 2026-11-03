/**
 * ARTHAVAULT WP-22: Executable Canonical Golden Vectors
 * Reference validation test vectors for all certified and new mathematical intelligence engines.
 */

import { GoldenVectorOutputField, CanonicalUnit, CalculationState } from './types';

export interface ExecutableGoldenVector<TInput, TExpected> {
  vectorId: string;
  calculationId: string;
  inputs: TInput;
  expectedState: CalculationState;
  expectedOutputs: TExpected;
  provenance: {
    referenceType: 'STATUTORY_AUTHORITY' | 'INDUSTRY_STANDARD' | 'FIRST_PRINCIPLES' | 'ILLUSTRATIVE';
    authority: string;
    citation: string;
  };
  notes?: string;
}

// 1. Golden Vector: Loan EMI 30L @ 8.5% over 20 Years (Reducing Balance)
export const GV_LOAN_EMI_30L_8_5P_20Y: ExecutableGoldenVector<
  { principal: number; annualRate: number; tenureMonths: number },
  {
    monthlyEmi: GoldenVectorOutputField<number>;
    totalInterest: GoldenVectorOutputField<number>;
    totalAmount: GoldenVectorOutputField<number>;
    interestPrincipalRatio: GoldenVectorOutputField<number>;
  }
> = {
  vectorId: 'GV-LOAN-EMI-30L-8.5P-20Y',
  calculationId: 'LOAN_EMI',
  inputs: { principal: 3000000, annualRate: 8.5, tenureMonths: 240 },
  expectedState: 'VALID',
  expectedOutputs: {
    monthlyEmi: {
      exactExpectedValue: 26034.697000966835,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹26,035'
    },
    totalInterest: {
      exactExpectedValue: 3248212,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹32,48,212'
    },
    totalAmount: {
      exactExpectedValue: 6248212,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹62,48,212'
    },
    interestPrincipalRatio: {
      exactExpectedValue: 1.08,
      canonicalUnit: 'GROWTH_MULTIPLE',
      permissibleTolerance: 0.01,
      displayExpectedValue: '1.08x'
    }
  },
  provenance: {
    referenceType: 'FIRST_PRINCIPLES',
    authority: 'Indian Banking Standard Reducing Balance Methodology',
    citation: 'EMI = P * r * (1+r)^n / ((1+r)^n - 1) with monthly rest'
  }
};

// 2. Golden Vector: Lumpsum 5L @ 12% over 10 Years with 6% Inflation
export const GV_LUMPSUM_5L_12P_10Y: ExecutableGoldenVector<
  { principal: number; annualRate: number; years: number; expectedInflation: number },
  {
    totalValue: GoldenVectorOutputField<number>;
    realPurchasingPower: GoldenVectorOutputField<number>;
    absoluteGrowthMultiple: GoldenVectorOutputField<number>;
  }
> = {
  vectorId: 'GV-LUMPSUM-5L-12P-10Y',
  calculationId: 'LUMPSUM',
  inputs: { principal: 500000, annualRate: 12, years: 10, expectedInflation: 6 },
  expectedState: 'VALID',
  expectedOutputs: {
    totalValue: {
      exactExpectedValue: 1552924,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹15,52,924'
    },
    realPurchasingPower: {
      exactExpectedValue: 867140,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹8,67,140'
    },
    absoluteGrowthMultiple: {
      exactExpectedValue: 3.11,
      canonicalUnit: 'GROWTH_MULTIPLE',
      permissibleTolerance: 0.01,
      displayExpectedValue: '3.11x'
    }
  },
  provenance: {
    referenceType: 'FIRST_PRINCIPLES',
    authority: 'Analytical Compounding Standard',
    citation: 'FV = P * (1+r)^t; Real FV = FV / (1+infl)^t'
  }
};

// 4. Golden Vector: Recurring Deposit 5k / mo @ 7.0% for 12 Months (Model A Analytical Compounding)
export const GV_RD_5K_7P_12M: ExecutableGoldenVector<
  { monthlyDeposit: number; annualNominalRatePct: number; tenureMonths: number; compoundingFrequency: 'QUARTERLY' },
  {
    totalDeposited: GoldenVectorOutputField<number>;
    totalInterestEarned: GoldenVectorOutputField<number>;
    maturityCorpus: GoldenVectorOutputField<number>;
    effectiveYieldPct: GoldenVectorOutputField<number>;
  }
> = {
  vectorId: 'GV-RD-5K-7P-12M-MODEL-A',
  calculationId: 'RECURRING_DEPOSIT',
  inputs: { monthlyDeposit: 5000, annualNominalRatePct: 7.0, tenureMonths: 12, compoundingFrequency: 'QUARTERLY' },
  expectedState: 'VALID',
  expectedOutputs: {
    totalDeposited: {
      exactExpectedValue: 60000,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 0,
      displayExpectedValue: '₹60,000'
    },
    totalInterestEarned: {
      exactExpectedValue: 2310.660538,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹2,311'
    },
    maturityCorpus: {
      exactExpectedValue: 62310.660538,
      canonicalUnit: 'CURRENCY_INR',
      permissibleTolerance: 1.0,
      displayExpectedValue: '₹62,311'
    },
    effectiveYieldPct: {
      exactExpectedValue: 7.19,
      canonicalUnit: 'PERCENTAGE_EFFECTIVE_ANNUAL',
      permissibleTolerance: 0.01,
      displayExpectedValue: '7.19%'
    }
  },
  provenance: {
    referenceType: 'FIRST_PRINCIPLES',
    authority: 'Analytical Monthly Cash-Flow Quarterly Compounding Model (Model A)',
    citation: 'A = P * sum_{k=1}^n (1 + r/m)^(m * (n - k + 1) / 12)'
  },
  notes: 'Canonical Model A: fractional-period quarterly rest compounding with 100% schedule reconciliation.'
};
