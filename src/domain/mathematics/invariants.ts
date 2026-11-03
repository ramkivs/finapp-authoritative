/**
 * ARTHAVAULT WP-22: Mathematical Invariant Assertions
 * Pure property test implementations verifying scale invariance, conservation, and inverse relationships.
 */

import { XirrEngine } from '../../services/mathematics/solvers/XirrEngine';
import { CalculatorsService } from '../../services/CalculatorsService';
import { GoalReverseSipEngine } from '../../services/mathematics/engines/GoalReverseSipEngine';
import { RecurringDepositEngine } from '../../services/mathematics/engines/RecurringDepositEngine';
import { SwpEngine } from '../../services/mathematics/engines/SwpEngine';
import { PpfEngine } from '../../services/mathematics/engines/PpfEngine';
import { RetirementFireEngine } from '../../services/mathematics/engines/RetirementFireEngine';

export class MathematicalInvariants {
  /**
   * Invariant 1: Scale Invariance of XIRR
   * XIRR(C) === XIRR(k * C) for any finite positive k > 0
   */
  static verifyXirrScaleInvariance(
    flows: Array<{ date: string; amount: number }>,
    scaleFactor: number = 100
  ): boolean {
    const res1 = XirrEngine.calculate(flows);
    const scaledFlows = flows.map(f => ({ date: f.date, amount: f.amount * scaleFactor }));
    const res2 = XirrEngine.calculate(scaledFlows);

    if (res1.state !== 'VALID' || res2.state !== 'VALID' || !res1.data || !res2.data) {
      return res1.state === res2.state;
    }

    const rate1 = res1.data.effectiveAnnualRate;
    const rate2 = res2.data.effectiveAnnualRate;
    return Math.abs(rate1 - rate2) <= 1e-4;
  }

  /**
   * Invariant 2: Loan EMI Conservation of Principal
   * Sum(principal components) === original principal amount exactly
   */
  static verifyLoanPrincipalConservation(principal: number, rate: number, months: number): boolean {
    const res = CalculatorsService.calculateLoanEmi(principal, rate, months);
    if (principal === 0) return res.totalAmount === 0;

    const sumPrincipal = res.schedule.reduce((sum, row) => sum + row.principalComponent, 0);
    const finalBalance = res.schedule.length > 0 ? res.schedule[res.schedule.length - 1].closingBalance : 0;

    return sumPrincipal === principal && finalBalance === 0;
  }

  /**
   * Invariant 3: CAGR Analytical Inversion
   * Initial * (1 + CAGR)^t === Final
   */
  static verifyCagrInverse(initial: number, finalVal: number, years: number): boolean {
    const res = CalculatorsService.calculateCagr(initial, finalVal, years);
    if (!res.isValid) return false;

    const cagrFraction = res.cagr / 100;
    const reconstructedFinal = initial * Math.pow(1 + cagrFraction, years);
    const relativeError = Math.abs(reconstructedFinal - finalVal) / finalVal;

    return relativeError <= 0.01;
  }

  /**
   * Invariant 4: Zero Rate Boundaries
   * SIP(P, r=0, n) === n * P
   * Lumpsum(P, r=0, t) === P
   * EMI(P, r=0, n) === P / n
   */
  static verifyZeroRateBoundaries(): boolean {
    const sipRes = CalculatorsService.calculateSip(10000, 0, 5, 0);
    const lumpRes = CalculatorsService.calculateLumpsum(500000, 0, 10, 0);
    const emiRes = CalculatorsService.calculateLoanEmi(120000, 0, 12);

    const sipPass = sipRes.totalValue === 600000 && sipRes.totalInvested === 600000;
    const lumpPass = lumpRes.totalValue === 500000 && lumpRes.estimatedReturns === 0;
    const emiPass = emiRes.monthlyEmi === 10000 && emiRes.totalInterest === 0;

    return sipPass && lumpPass && emiPass;
  }
}
