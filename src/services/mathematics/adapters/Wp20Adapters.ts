/**
 * ARTHAVAULT WP-22: WP-20 Mathematical Engine Adapters
 * Wraps certified WP-20 calculation engines into the canonical Phase B CalculationResult<T> envelope.
 */

import { CalculatorsService } from '../../CalculatorsService';
import {
  CalculationResult,
  CalculationRequest,
  CalculationState
} from '../../../domain/mathematics/types';
import { ProvenanceService } from '../ProvenanceService';

export class Wp20Adapters {
  /**
   * Canonical adapter for WP-20 SIP Engine
   */
  static calculateSip(
    monthlyInvestment: number,
    annualRate: number,
    years: number,
    stepUpPct: number = 0
  ): CalculationResult<ReturnType<typeof CalculatorsService.calculateSip>> {
    const startTime = Date.now();

    // Input validation
    if (monthlyInvestment < 0 || annualRate < 0 || years < 0 || stepUpPct < 0) {
      return {
        calculationId: 'ENGINE_SIP',
        state: 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance: ProvenanceService.createProvenance({
          engineId: 'ENGINE_SIP',
          algorithmId: 'ALG_SIP_ITERATIVE_STEPUP',
          algorithmVersion: '1.0.0',
          rawInputs: { monthlyInvestment, annualRate, years, stepUpPct },
          referenceType: 'FIRST_PRINCIPLES',
          citation: 'Iterative monthly accumulation with annual percentage step-up compounding'
        }),
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Investment parameters must be non-negative numbers.'
        }
      };
    }

    if (monthlyInvestment === 0) {
      const data = CalculatorsService.calculateSip(0, annualRate, years, stepUpPct);
      return {
        calculationId: 'ENGINE_SIP',
        state: 'ZERO',
        freshness: 'CURRENT',
        data,
        unit: 'CURRENCY_INR',
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance: ProvenanceService.createProvenance({
          engineId: 'ENGINE_SIP',
          algorithmId: 'ALG_SIP_ITERATIVE_STEPUP',
          algorithmVersion: '1.0.0',
          rawInputs: { monthlyInvestment, annualRate, years, stepUpPct },
          referenceType: 'FIRST_PRINCIPLES',
          citation: 'Iterative monthly accumulation with annual percentage step-up compounding'
        })
      };
    }

    const data = CalculatorsService.calculateSip(monthlyInvestment, annualRate, years, stepUpPct);

    return {
      calculationId: 'ENGINE_SIP',
      state: 'VALID',
      freshness: 'CURRENT',
      data,
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance: ProvenanceService.createProvenance({
        engineId: 'ENGINE_SIP',
        algorithmId: 'ALG_SIP_ITERATIVE_STEPUP',
        algorithmVersion: '1.0.0',
        rawInputs: { monthlyInvestment, annualRate, years, stepUpPct },
        referenceType: 'FIRST_PRINCIPLES',
        citation: 'Iterative monthly accumulation with annual percentage step-up compounding'
      })
    };
  }

  /**
   * Canonical adapter for WP-20 Lumpsum Engine
   */
  static calculateLumpsum(
    principal: number,
    annualRate: number,
    years: number,
    expectedInflation: number = 6.0
  ): CalculationResult<ReturnType<typeof CalculatorsService.calculateLumpsum>> {
    const startTime = Date.now();

    if (principal < 0 || annualRate < 0 || years <= 0 || expectedInflation < 0) {
      return {
        calculationId: 'ENGINE_LUMPSUM',
        state: 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance: ProvenanceService.createProvenance({
          engineId: 'ENGINE_LUMPSUM',
          algorithmId: 'ALG_LUMPSUM_COMPOUNDING',
          algorithmVersion: '1.0.0',
          rawInputs: { principal, annualRate, years, expectedInflation },
          referenceType: 'FIRST_PRINCIPLES',
          citation: 'Nominal future value and inflation-adjusted purchasing power'
        }),
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Principal and rates must be non-negative and years must be greater than zero.'
        }
      };
    }

    const data = CalculatorsService.calculateLumpsum(principal, annualRate, years, expectedInflation);
    const state: CalculationState = principal === 0 ? 'ZERO' : 'VALID';

    return {
      calculationId: 'ENGINE_LUMPSUM',
      state,
      freshness: 'CURRENT',
      data,
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance: ProvenanceService.createProvenance({
        engineId: 'ENGINE_LUMPSUM',
        algorithmId: 'ALG_LUMPSUM_COMPOUNDING',
        algorithmVersion: '1.0.0',
        rawInputs: { principal, annualRate, years, expectedInflation },
        referenceType: 'FIRST_PRINCIPLES',
        citation: 'Nominal future value and inflation-adjusted purchasing power'
      })
    };
  }

  /**
   * Canonical adapter for WP-20 CAGR Engine
   */
  static calculateCagr(
    initialValue: number,
    finalValue: number,
    years: number
  ): CalculationResult<ReturnType<typeof CalculatorsService.calculateCagr>> {
    const startTime = Date.now();

    if (initialValue <= 0 || years <= 0 || finalValue < 0) {
      return {
        calculationId: 'ENGINE_CAGR',
        state: initialValue === 0 ? 'OUT_OF_DOMAIN' : 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance: ProvenanceService.createProvenance({
          engineId: 'ENGINE_CAGR',
          algorithmId: 'ALG_CAGR_ANALYTICAL',
          algorithmVersion: '1.0.0',
          rawInputs: { initialValue, finalValue, years },
          referenceType: 'FIRST_PRINCIPLES',
          citation: 'Compound Annual Growth Rate formula: (Vf / Vi)^(1/t) - 1'
        }),
        error: {
          code: initialValue === 0 ? 'ERR_OUT_OF_DOMAIN' : 'ERR_INPUT_INVALID',
          message: 'Initial value must be greater than zero, years must be greater than zero, and final value non-negative.'
        }
      };
    }

    const data = CalculatorsService.calculateCagr(initialValue, finalValue, years);
    const state: CalculationState = finalValue === initialValue ? 'ZERO' : 'VALID';

    return {
      calculationId: 'ENGINE_CAGR',
      state,
      freshness: 'CURRENT',
      data,
      unit: 'PERCENTAGE_NOMINAL_ANNUAL',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance: ProvenanceService.createProvenance({
        engineId: 'ENGINE_CAGR',
        algorithmId: 'ALG_CAGR_ANALYTICAL',
        algorithmVersion: '1.0.0',
        rawInputs: { initialValue, finalValue, years },
        referenceType: 'FIRST_PRINCIPLES',
        citation: 'Compound Annual Growth Rate formula: (Vf / Vi)^(1/t) - 1'
      })
    };
  }

  /**
   * Canonical adapter for WP-20 Loan EMI Engine
   */
  static calculateLoanEmi(
    principal: number,
    annualRate: number,
    tenureMonths: number
  ): CalculationResult<ReturnType<typeof CalculatorsService.calculateLoanEmi>> {
    const startTime = Date.now();

    if (principal < 0 || annualRate < 0 || tenureMonths <= 0) {
      return {
        calculationId: 'ENGINE_LOAN_EMI',
        state: 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance: ProvenanceService.createProvenance({
          engineId: 'ENGINE_LOAN_EMI',
          algorithmId: 'ALG_LOAN_EMI_REDUCING',
          algorithmVersion: '1.0.0',
          rawInputs: { principal, annualRate, tenureMonths },
          referenceType: 'FIRST_PRINCIPLES',
          citation: 'Reducing balance amortization schedule with monthly rest'
        }),
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Principal and rate must be non-negative and tenure must be at least 1 month.'
        }
      };
    }

    const data = CalculatorsService.calculateLoanEmi(principal, annualRate, tenureMonths);
    const state: CalculationState = principal === 0 ? 'ZERO' : 'VALID';

    return {
      calculationId: 'ENGINE_LOAN_EMI',
      state,
      freshness: 'CURRENT',
      data,
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance: ProvenanceService.createProvenance({
        engineId: 'ENGINE_LOAN_EMI',
        algorithmId: 'ALG_LOAN_EMI_REDUCING',
        algorithmVersion: '1.0.0',
        rawInputs: { principal, annualRate, tenureMonths },
        referenceType: 'FIRST_PRINCIPLES',
        citation: 'Reducing balance amortization schedule with monthly rest'
      })
    };
  }
}
