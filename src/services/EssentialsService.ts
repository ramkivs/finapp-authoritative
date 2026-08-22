import {
  Asset,
  Account,
  Transaction,
  MonthlyBudget,
  InsurancePolicy,
  FinancialGoal,
  FinancialProfile,
  EmergencyFundAnalysis,
  HealthScoreBreakdown,
  mapTransactionCategoryToBudget
} from '../domain/types';
import { LiquidReservesService } from './LiquidReservesService';

export class EssentialsService {
  /**
   * Calculate Emergency Fund Analysis.
   * Coverage Months = Liquid Reserves / Monthly Essential Expenses
   *
   * Liquid Reserves Semantics (WP-FB-DATA-05b — B5 closed):
   * - Liquid accounts (Bank/Cash/Wallet) contribute their transaction-DERIVED
   *   balance via AccountBalanceService, not their opening balance.
   * - Cash & Savings assets contribute unless the money is already counted:
   *   an explicit Account.linkedAssetId suppresses the asset (F1), and a
   *   same-name unlinked pair is held pending user confirmation (G3).
   * - Deduplication is link-based. The name comparison that remains is a
   *   transitional display hold, never an inferred relationship.
   *
   * All of this lives in LiquidReservesService, the single definition shared
   * with WealthIntelligenceService (Decision I).
   */
  static calculateEmergencyFundAnalysis(
    assets: Asset[] = [],
    accounts: Account[] = [],
    transactions: Transaction[] = [],
    budgets: MonthlyBudget[] = [],
    targetMonths: number = 6,
    customProfile?: FinancialProfile | null
  ): EmergencyFundAnalysis {
    // 1. Liquid Reserves — single authority (WP-FB-DATA-05b)
    const liquidity = LiquidReservesService.compute(assets, accounts, transactions);
    const liquidReserves = liquidity.total;

    // 2. Calculate Monthly Essential Expenses
    let monthlyEssentialExpenses = 0;

    if (customProfile && customProfile.monthlyExpenses > 0) {
      monthlyEssentialExpenses = customProfile.monthlyExpenses;
    } else {
      // Aggregate essential expense categories: Housing, Groceries, Utilities, EMI & Loans, Healthcare, Insurance
      const essentialCategories = new Set([
        'Housing',
        'Groceries',
        'Utilities',
        'EMI & Loans',
        'Healthcare',
        'Insurance'
      ]);

      const monthlyTotals: Record<string, number> = {};
      for (const t of transactions) {
        if (t.type !== 'Expense') continue;
        const bCat = mapTransactionCategoryToBudget(t.category);
        if (essentialCategories.has(bCat)) {
          const ym = t.date.slice(0, 7);
          monthlyTotals[ym] = (monthlyTotals[ym] || 0) + t.amount;
        }
      }

      const expenseMonths = Object.keys(monthlyTotals);
      if (expenseMonths.length > 0) {
        const sum = expenseMonths.reduce((s, m) => s + monthlyTotals[m], 0);
        monthlyEssentialExpenses = Math.round(sum / expenseMonths.length);
      } else {
        // Check active budget allocations
        const latestBudget = budgets[0];
        if (latestBudget && latestBudget.allocations) {
          monthlyEssentialExpenses = Object.entries(latestBudget.allocations)
            .filter(([cat]) => essentialCategories.has(cat))
            .reduce((s, [, amt]) => s + amt, 0);
        }
      }
    }

    if (monthlyEssentialExpenses <= 0 && liquidReserves <= 0) {
      return {
        liquidReserves: 0,
        monthlyEssentialExpenses: 0,
        runwayMonths: 0,
        targetMonths,
        targetAmount: 0,
        fundingGap: 0,
        status: 'NOT_CONFIGURED',
        linkCandidates: liquidity.candidates,
        brokenLinks: liquidity.brokenLinks,
        heldPendingConfirmation: liquidity.heldPendingConfirmation
      };
    }

    const runwayMonths = monthlyEssentialExpenses > 0
      ? Math.round((liquidReserves / monthlyEssentialExpenses) * 10) / 10
      : liquidReserves > 0 ? 99.0 : 0;

    const targetAmount = Math.round(monthlyEssentialExpenses * targetMonths);
    const fundingGap = Math.max(0, targetAmount - liquidReserves);

    return {
      liquidReserves,
      monthlyEssentialExpenses,
      runwayMonths,
      targetMonths,
      targetAmount,
      fundingGap,
      status: 'RECONCILED',
      linkCandidates: liquidity.candidates,
      brokenLinks: liquidity.brokenLinks,
      heldPendingConfirmation: liquidity.heldPendingConfirmation
    };
  }

  /**
   * Aggregate active insurance sum insured.
   */
  static calculateActiveInsuranceTotal(policies: InsurancePolicy[] = []): number {
    return policies
      .filter(p => p.status === 'Active')
      .reduce((sum, p) => sum + p.coverAmount, 0);
  }

  /**
   * Calculate milestone goal progress percentage and remaining corpus.
   */
  static calculateGoalProgress(goal: FinancialGoal): { progressPct: number; remainingAmount: number } {
    if (goal.targetAmount <= 0) {
      return { progressPct: 0, remainingAmount: 0 };
    }
    const saved = Number(goal.currentSavedAmount) || 0;
    const progressPct = Math.min(100, Math.round((saved / goal.targetAmount) * 100));
    const remainingAmount = Math.max(0, goal.targetAmount - saved);
    return { progressPct, remainingAmount };
  }

  /**
   * Aggregate monthly SIP commitments across active goals.
   */
  static calculateMonthlySipCommitment(goals: FinancialGoal[] = []): number {
    return goals
      .filter(g => g.status === 'In Progress')
      .reduce((sum, g) => sum + (Number(g.monthlyContribution) || 0), 0);
  }

  /**
   * Calculate future value with inflation compounding: FV = PV * (1 + inflationRate)^years
   */
  static calculateFutureValueWithInflation(
    presentValue: number,
    annualInflationPct: number,
    years: number
  ): number {
    if (presentValue <= 0 || years <= 0) return Math.max(0, presentValue);
    const r = annualInflationPct / 100;
    return Math.round(presentValue * Math.pow(1 + r, years));
  }

  /**
   * Transparent 4-factor Financial Health Score (0-100 pts).
   * 1. Emergency Runway (25 pts): >=6M=25, >=3M=15, >0=5, else 0
   * 2. Debt Solvency (25 pts): Debt/Assets <=20%=25, <=50%=15, <=80%=5, else 0
   * 3. Savings Rate (25 pts): >=30%=25, >=15%=15, >0%=5, else 0
   * 4. Insurance Adequacy (25 pts): Active Life + Active Health = 25, Single Active Category = 15, No Active Insurance = 0
   */
  static calculateFinancialHealthScore(params: {
    emergencyAnalysis: EmergencyFundAnalysis;
    totalDebt: number;
    totalAssets: number;
    totalInsuranceCover?: number;
    policies?: InsurancePolicy[];
    profile: FinancialProfile | null;
    savingsRate?: number;
  }): HealthScoreBreakdown {
    const {
      emergencyAnalysis,
      totalDebt,
      totalAssets,
      totalInsuranceCover,
      policies = [],
      profile,
      savingsRate
    } = params;

    const activePolicies = policies.filter(p => p.status === 'Active');
    const totCover = totalInsuranceCover !== undefined
      ? totalInsuranceCover
      : this.calculateActiveInsuranceTotal(policies);

    // Check if system has any data configured
    const hasData =
      emergencyAnalysis.status === 'RECONCILED' ||
      totalAssets > 0 ||
      totalDebt > 0 ||
      totCover > 0 ||
      activePolicies.length > 0 ||
      (profile !== null && (profile.monthlyIncome > 0 || profile.monthlyExpenses > 0));

    if (!hasData) {
      return {
        score: 0,
        status: 'NOT_CONFIGURED',
        emergencyRunwayScore: 0,
        debtSolvencyScore: 0,
        savingsRateScore: 0,
        insuranceAdequacyScore: 0,
        explanations: ['Financial profile and account data not configured.']
      };
    }

    const explanations: string[] = [];

    // Factor 1: Emergency Runway (25 pts)
    let emergencyScore = 0;
    if (emergencyAnalysis.runwayMonths >= 6) {
      emergencyScore = 25;
      explanations.push('Strong 6+ months liquid emergency cushion (25/25 pts)');
    } else if (emergencyAnalysis.runwayMonths >= 3) {
      emergencyScore = 15;
      explanations.push('Moderate 3-5 months emergency runway (15/25 pts)');
    } else if (emergencyAnalysis.runwayMonths > 0) {
      emergencyScore = 5;
      explanations.push('Limited emergency cushion under 3 months (5/25 pts)');
    } else {
      emergencyScore = 0;
      explanations.push('No liquid emergency reserves detected (0/25 pts)');
    }

    // Factor 2: Debt Solvency / Leverage Ratio (25 pts)
    let debtScore = 25;
    if (totalAssets > 0) {
      const debtRatio = totalDebt / totalAssets;
      if (debtRatio <= 0.2) {
        debtScore = 25;
        explanations.push('Low debt burden under 20% of asset base (25/25 pts)');
      } else if (debtRatio <= 0.5) {
        debtScore = 15;
        explanations.push('Manageable debt burden between 20-50% (15/25 pts)');
      } else if (debtRatio <= 0.8) {
        debtScore = 5;
        explanations.push('High debt burden between 50-80% (5/25 pts)');
      } else {
        debtScore = 0;
        explanations.push('Severe leverage exceeding 80% of asset base (0/25 pts)');
      }
    } else if (totalDebt > 0) {
      debtScore = 0;
      explanations.push('Liabilities present with zero recorded assets (0/25 pts)');
    } else {
      debtScore = 25;
      explanations.push('Zero liabilities recorded (25/25 pts)');
    }

    // Factor 3: Savings Rate (25 pts)
    let effSavingsRate = 0;
    if (profile && profile.savingsRate > 0) {
      effSavingsRate = profile.savingsRate;
    } else if (savingsRate !== undefined && savingsRate > 0) {
      effSavingsRate = savingsRate;
    }

    let savingsScore = 0;
    if (effSavingsRate >= 30) {
      savingsScore = 25;
      explanations.push(`Strong savings rate of ${effSavingsRate}% (25/25 pts)`);
    } else if (effSavingsRate >= 15) {
      savingsScore = 15;
      explanations.push(`Healthy savings rate of ${effSavingsRate}% (15/25 pts)`);
    } else if (effSavingsRate > 0) {
      savingsScore = 5;
      explanations.push(`Modest savings rate of ${effSavingsRate}% (5/25 pts)`);
    } else {
      savingsScore = 0;
      explanations.push('No ongoing savings surplus detected (0/25 pts)');
    }

    // Factor 4: Insurance Adequacy (25 pts)
    // Strictly evaluates active policies by category without arbitrary monetary thresholds
    const hasActiveLife = activePolicies.some(p => p.type === 'Term Life');
    const hasActiveHealth = activePolicies.some(p => p.type === 'Health');

    let insuranceScore = 0;
    if (hasActiveLife && hasActiveHealth) {
      insuranceScore = 25;
      explanations.push('Comprehensive active insurance coverage in place (Term Life + Health) (25/25 pts)');
    } else if (hasActiveLife) {
      insuranceScore = 15;
      explanations.push('Partial insurance protection (Active Term Life cover only; Health insurance missing) (15/25 pts)');
    } else if (hasActiveHealth) {
      insuranceScore = 15;
      explanations.push('Partial insurance protection (Active Health cover only; Term Life insurance missing) (15/25 pts)');
    } else if (activePolicies.length > 0) {
      insuranceScore = 15;
      explanations.push(`Partial insurance protection (Active ${activePolicies[0].type} cover only) (15/25 pts)`);
    } else {
      insuranceScore = 0;
      explanations.push('No active term or health insurance policies recorded (0/25 pts)');
    }

    const totalScore = emergencyScore + debtScore + savingsScore + insuranceScore;
    const status: HealthScoreBreakdown['status'] =
      totalScore >= 70 ? 'HEALTHY' : totalScore >= 40 ? 'MODERATE' : 'NEEDS_ATTENTION';

    return {
      score: totalScore,
      status,
      emergencyRunwayScore: emergencyScore,
      debtSolvencyScore: debtScore,
      savingsRateScore: savingsScore,
      insuranceAdequacyScore: insuranceScore,
      explanations
    };
  }
}
