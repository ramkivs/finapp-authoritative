/**
 * ARTHAVAULT WP-22: Retirement & FIRE Target Mathematical Engine
 * Models longevity runway, target retirement corpus, Coast FIRE milestones, and Safe Withdrawal Rates (SWR).
 */

import { CalculationResult } from '../../../domain/mathematics/types';
import { ProvenanceService } from '../ProvenanceService';

export interface RetirementFireInput {
  currentAge: number;                 // e.g. 32 (1 <= age <= 100)
  targetRetirementAge: number;        // e.g. 55 (targetRetirementAge > currentAge)
  annualLivingExpenses: number;       // ₹ Current annual living expenditure (> 0)
  currentInvestedCorpus: number;      // ₹ Current accumulated wealth (>= 0)
  monthlySavings: number;             // ₹ Planned monthly investment (>= 0)
  preRetirementReturnRatePct: number; // % p.a. (e.g. 12.0)
  postRetirementReturnRatePct: number;// % p.a. (e.g. 8.0)
  expectedInflationPct?: number;      // % p.a. (default 6.0)
  safeWithdrawalRatePct?: number;     // % p.a. (default 4.0)
}

export interface RetirementFireOutput {
  yearsToRetirement: number;
  futureAnnualExpensesAtRetirement: number;
  targetRetirementCorpus: number;     // SWR-based target corpus required
  projectedCorpusAtRetirement: number;// Projected wealth at retirement from current corpus + SIP
  coastFireCorpusToday: number;       // Wealth needed today to reach goal with ₹0 further SIP
  isTargetAchievable: boolean;
  corpusDeficitOrSurplus: number;     // Projected - Target (+ surplus, - deficit)
  fireMultiplier: number;             // e.g. 25.0x (1 / SWR)
  currentRunwayYears: number;         // Current corpus / current annual expenses
}

export class RetirementFireEngine {
  /**
   * Calculate comprehensive Retirement and Financial Independence (FIRE) metrics.
   */
  static calculate(input: RetirementFireInput): CalculationResult<RetirementFireOutput> {
    const startTime = Date.now();
    const currentAge = Math.max(1, input.currentAge);
    const targetRetirementAge = Math.max(currentAge + 1, input.targetRetirementAge);
    const yearsToRetire = targetRetirementAge - currentAge;

    const annualExpenses = Math.max(0, input.annualLivingExpenses);
    const currentCorpus = Math.max(0, input.currentInvestedCorpus);
    const monthlyP = Math.max(0, input.monthlySavings);

    const preRate = Math.max(0, input.preRetirementReturnRatePct) / 100;
    const postRate = Math.max(0, input.postRetirementReturnRatePct) / 100;
    const inflation = Math.max(0, input.expectedInflationPct ?? 6.0) / 100;
    const swr = Math.max(0.01, input.safeWithdrawalRatePct ?? 4.0) / 100;

    const provenance = ProvenanceService.createProvenance({
      engineId: 'ENGINE_RETIREMENT_FIRE',
      algorithmId: 'ALG_FIRE_LONGEVITY_MODEL',
      algorithmVersion: '1.0.0',
      rawInputs: input,
      referenceType: 'FIRST_PRINCIPLES',
      citation: 'Safe Withdrawal Rate (SWR) corpus capitalization model with pre-retirement compounding'
    });

    if (annualExpenses <= 0 || yearsToRetire <= 0) {
      return {
        calculationId: 'ENGINE_RETIREMENT_FIRE',
        state: annualExpenses === 0 ? 'ZERO' : 'INVALID_INPUT',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_INPUT_OUT_OF_RANGE',
          message: 'Annual living expenses must be positive and target retirement age must exceed current age.'
        }
      };
    }

    // 1. Inflation-adjusted annual living expenses at retirement age
    const futureExpensesAtRetirement = Math.round(annualExpenses * Math.pow(1 + inflation, yearsToRetire));

    // 2. Target Retirement Corpus = Future Annual Expenses / SWR (e.g. 25x rule for 4% SWR)
    const targetCorpus = Math.round(futureExpensesAtRetirement / swr);

    // 3. Projected Corpus at retirement from current wealth + ongoing monthly investments
    const currentCorpusFV = currentCorpus * Math.pow(1 + preRate, yearsToRetire);

    let sipFV = 0;
    const totalMonths = yearsToRetire * 12;
    const monthlyRate = preRate / 12;
    if (monthlyP > 0) {
      if (monthlyRate === 0) {
        sipFV = monthlyP * totalMonths;
      } else {
        sipFV = monthlyP * (1 + monthlyRate) * (Math.pow(1 + monthlyRate, totalMonths) - 1) / monthlyRate;
      }
    }

    const projectedCorpus = Math.round(currentCorpusFV + sipFV);

    // 4. Coast FIRE Number = Target Corpus discounted back to today at pre-retirement return rate
    const coastFireCorpus = Math.round(targetCorpus / Math.pow(1 + preRate, yearsToRetire));

    // 5. Financial metrics
    const surplusOrDeficit = projectedCorpus - targetCorpus;
    const isAchievable = surplusOrDeficit >= 0;
    const fireMultiplier = Math.round((1 / swr) * 10) / 10;
    const currentRunway = Math.round((currentCorpus / annualExpenses) * 10) / 10;

    return {
      calculationId: 'ENGINE_RETIREMENT_FIRE',
      state: 'VALID',
      freshness: 'CURRENT',
      data: {
        yearsToRetirement: yearsToRetire,
        futureAnnualExpensesAtRetirement: futureExpensesAtRetirement,
        targetRetirementCorpus: targetCorpus,
        projectedCorpusAtRetirement: projectedCorpus,
        coastFireCorpusToday: coastFireCorpus,
        isTargetAchievable: isAchievable,
        corpusDeficitOrSurplus: surplusOrDeficit,
        fireMultiplier,
        currentRunwayYears: currentRunway
      },
      unit: 'CURRENCY_INR',
      diagnostics: { executionTimeMs: Date.now() - startTime },
      provenance
    };
  }
}
