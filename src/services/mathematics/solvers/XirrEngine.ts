/**
 * ARTHAVAULT WP-22: Hardened Canonical XIRR Solver Engine
 * Implements multi-stage Newton-Raphson with adaptive bisection fallback, scale-invariant tolerance, and multiple root detection.
 */

import {
  CalculationResult,
  CalculationState
} from '../../../domain/mathematics/types';
import { ProvenanceService } from '../ProvenanceService';

export interface XirrFlowInput {
  date: string;
  amount: number;
  description?: string;
}

export interface XirrEngineOutput {
  effectiveAnnualRate: number;      // Exact decimal fraction (e.g. 0.1542018)
  displayRate: string;              // Formatted percentage string (e.g. '15.42%')
  totalInvested: number;            // Whole Rupee integer
  totalWithdrawn: number;           // Whole Rupee integer
  netGain: number;                  // totalWithdrawn - totalInvested
  rootStatus: 'UNIQUE' | 'AMBIGUOUS' | 'NONE';
  candidateRoots?: number[];
}

export class XirrEngine {
  /**
   * Solve Extended Internal Rate of Return (XIRR) adhering to Phase B canonical specifications.
   */
  static calculate(
    cashFlows: XirrFlowInput[],
    config: {
      dayCountBasis?: number;
      minRate?: number;
      maxRate?: number;
      maxIterations?: number;
      rateTolerance?: number;
      npvRelativeTolerance?: number;
      npvAbsoluteFloor?: number;
    } = {}
  ): CalculationResult<XirrEngineOutput> {
    const startTime = Date.now();
    const dayCountBasis = config.dayCountBasis ?? 365.25;
    const minRate = config.minRate ?? -0.9999;
    const maxRate = config.maxRate ?? 10.0;
    const maxIterations = config.maxIterations ?? 100;
    const rateTolerance = config.rateTolerance ?? 1e-6;
    const npvRelativeTolerance = config.npvRelativeTolerance ?? 1e-7;
    const npvAbsoluteFloor = config.npvAbsoluteFloor ?? 1e-4;

    // Filter valid flows
    const validFlows = cashFlows.filter(
      cf => cf && cf.date && typeof cf.amount === 'number' && !isNaN(cf.amount) && isFinite(cf.amount) && cf.amount !== 0
    );

    const totalInvested = Math.round(
      validFlows.filter(cf => cf.amount < 0).reduce((s, cf) => s + Math.abs(cf.amount), 0)
    );
    const totalWithdrawn = Math.round(
      validFlows.filter(cf => cf.amount > 0).reduce((s, cf) => s + cf.amount, 0)
    );
    const netGain = totalWithdrawn - totalInvested;
    const sumAbsoluteFlows = validFlows.reduce((s, cf) => s + Math.abs(cf.amount), 0);

    const provenance = ProvenanceService.createProvenance({
      engineId: 'ENGINE_XIRR',
      algorithmId: 'ALG_XIRR_HARDENED_HYBRID',
      algorithmVersion: '1.0.0',
      configVersion: `CONFIG_BASIS_${dayCountBasis}`,
      rawInputs: { cashFlows: validFlows, config },
      referenceType: 'FIRST_PRINCIPLES',
      citation: 'Generalized discounted cash flow equation with scale-invariant relative tolerance'
    });

    // 1. Cardinality check
    if (validFlows.length < 2) {
      return {
        calculationId: 'ENGINE_XIRR',
        state: 'INSUFFICIENT_DATA',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_INSUFFICIENT_DATA',
          message: 'XIRR requires at least two valid cash flows (an investment and a terminal value or withdrawal).'
        }
      };
    }

    // 2. Sign variation check
    const hasNegative = validFlows.some(cf => cf.amount < 0);
    const hasPositive = validFlows.some(cf => cf.amount > 0);

    if (!hasNegative || !hasPositive) {
      return {
        calculationId: 'ENGINE_XIRR',
        state: 'NO_SOLUTION',
        freshness: 'CURRENT',
        data: null,
        diagnostics: { executionTimeMs: Date.now() - startTime },
        provenance,
        error: {
          code: 'ERR_NO_SOLUTION',
          message: 'Mathematical analysis proves no real solution exists: cash flows must contain both negative outflows and positive inflows.'
        }
      };
    }

    // 3. Date sorting and normalization
    const sorted = [...validFlows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const d0 = new Date(sorted[0].date).getTime();

    const flows = sorted.map(cf => ({
      amount: cf.amount,
      years: (new Date(cf.date).getTime() - d0) / (86400000 * dayCountBasis)
    }));

    // Objective function and derivative
    const npv = (r: number): number => {
      let sum = 0;
      for (const f of flows) {
        sum += f.amount / Math.pow(1 + r, f.years);
      }
      return sum;
    };

    const npvPrime = (r: number): number => {
      let sum = 0;
      for (const f of flows) {
        sum -= (f.years * f.amount) / Math.pow(1 + r, f.years + 1);
      }
      return sum;
    };

    const isNpvConverged = (val: number): boolean => {
      return Math.abs(val) <= npvAbsoluteFloor || Math.abs(val) / sumAbsoluteFlows <= npvRelativeTolerance;
    };

    // 4. Candidate Root Discovery via Adaptive Intervals & Newton-Raphson
    const candidateRoots: number[] = [];
    const searchPartitions = 20;
    const partitionWidth = (maxRate - minRate) / searchPartitions;

    for (let p = 0; p < searchPartitions; p++) {
      const pLow = minRate + p * partitionWidth;
      const pHigh = minRate + (p + 1) * partitionWidth;
      const fLow = npv(pLow);
      const fHigh = npv(pHigh);

      // Sign crossing bracket
      if (fLow * fHigh <= 0 || isNpvConverged(fLow) || isNpvConverged(fHigh)) {
        let bLow = pLow;
        let bHigh = pHigh;

        for (let iter = 0; iter < 60; iter++) {
          const mid = (bLow + bHigh) / 2;
          const fMid = npv(mid);

          if (isNpvConverged(fMid) || (bHigh - bLow) / 2 < rateTolerance) {
            candidateRoots.push(mid);
            break;
          }

          if (fLow * fMid < 0) {
            bHigh = mid;
          } else {
            bLow = mid;
          }
        }
      }
    }

    // 5. Newton-Raphson from initial guess 0.10
    let nRate = 0.10;
    let nConverged = false;

    for (let i = 0; i < maxIterations; i++) {
      const fVal = npv(nRate);
      const fDeriv = npvPrime(nRate);

      if (isNpvConverged(fVal)) {
        nConverged = true;
        candidateRoots.push(nRate);
        break;
      }

      if (Math.abs(fDeriv) < 1e-12) {
        break; // Zero derivative stagnation
      }

      const step = fVal / fDeriv;
      nRate = nRate - step;

      if (nRate <= minRate) {
        nRate = (minRate + 0.0001);
      }
      if (nRate >= maxRate) {
        nRate = maxRate;
        break;
      }
    }

    // 6. Root Deduplication (|r_i - r_j| < 1e-4)
    const uniqueRoots: number[] = [];
    for (const r of candidateRoots) {
      if (r >= minRate && r <= maxRate && !isNaN(r) && isFinite(r)) {
        const isDuplicate = uniqueRoots.some(ur => Math.abs(ur - r) < 1e-4);
        if (!isDuplicate && isNpvConverged(npv(r))) {
          uniqueRoots.push(Math.round(r * 1000000) / 1000000);
        }
      }
    }

    // 7. Root Classification
    if (uniqueRoots.length === 0) {
      return {
        calculationId: 'ENGINE_XIRR',
        state: 'CONVERGENCE_FAILURE',
        freshness: 'CURRENT',
        data: null,
        diagnostics: {
          executionTimeMs: Date.now() - startTime,
          iterationsUsed: maxIterations
        },
        provenance,
        error: {
          code: 'ERR_CONVERGENCE_FAILURE',
          message: 'Solver iteration limit reached without establishing convergence to a valid root.'
        }
      };
    }

    if (uniqueRoots.length > 1) {
      return {
        calculationId: 'ENGINE_XIRR',
        state: 'AMBIGUOUS_SOLUTION',
        freshness: 'CURRENT',
        data: null,
        diagnostics: {
          executionTimeMs: Date.now() - startTime,
          detectedCandidateRoots: uniqueRoots
        },
        provenance,
        error: {
          code: 'ERR_AMBIGUOUS_SOLUTION',
          message: `Multiple mathematically valid internal rates of return detected (${uniqueRoots.map(r => (r * 100).toFixed(2) + '%').join(', ')}). Cannot select an arbitrary root.`
        }
      };
    }

    const finalRate = uniqueRoots[0];
    const displayRate = `${(finalRate * 100).toFixed(2)}%`;

    return {
      calculationId: 'ENGINE_XIRR',
      state: 'VALID',
      freshness: 'CURRENT',
      data: {
        effectiveAnnualRate: finalRate,
        displayRate,
        totalInvested,
        totalWithdrawn,
        netGain,
        rootStatus: 'UNIQUE',
        candidateRoots: uniqueRoots
      },
      unit: 'PERCENTAGE_EFFECTIVE_ANNUAL',
      diagnostics: {
        executionTimeMs: Date.now() - startTime,
        residualNpv: npv(finalRate),
        relativeResidual: Math.abs(npv(finalRate)) / sumAbsoluteFlows,
        detectedCandidateRoots: uniqueRoots
      },
      provenance
    };
  }
}
