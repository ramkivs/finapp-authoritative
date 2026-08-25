import { repository } from '../repositories';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { FinancialMetricService } from '../services/FinancialMetricService';
import { WealthIntelligenceService } from '../services/WealthIntelligenceService';
import { EssentialsService } from '../services/EssentialsService';
import { DateRangeService, getEffectiveAsOfDate } from '../services/DateRangeService';
import { Wp20Adapters } from '../services/mathematics/adapters/Wp20Adapters';
import { XirrEngine, XirrFlowInput } from '../services/mathematics/solvers/XirrEngine';
import { RecurringDepositEngine, RdCalculationInput } from '../services/mathematics/engines/RecurringDepositEngine';
import { PpfEngine, PpfCalculationInput } from '../services/mathematics/engines/PpfEngine';
import { SwpEngine, SwpCalculationInput } from '../services/mathematics/engines/SwpEngine';
import { GoalReverseSipEngine, GoalReverseSipInput } from '../services/mathematics/engines/GoalReverseSipEngine';
import { RetirementFireEngine, RetirementFireInput } from '../services/mathematics/engines/RetirementFireEngine';
import { CalculationResult } from '../domain/mathematics/types';
import {
  FinancialMetric,
  FinancialSeries,
  Transaction,
  NetWorthSnapshot,
  WealthHealthSummary,
  AssetConcentrationAnalysis,
  AllocationDiagnostics,
  LiabilityDiagnostics,
  NetWorthTrendIntelligence,
  WealthInsight,
  WealthDataQuality,
  Account,
  MonthlyBudget,
  InsurancePolicy,
  FinancialGoal,
  FinancialProfile,
  EmergencyFundAnalysis,
  HealthScoreBreakdown,
  mapTransactionCategoryToBudget
} from '../domain/types';

export interface MoneyInsightsData {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  totalInvested: number; // Strictly transactions with category === 'INVESTMENT'
  brokerageFunding: number; // Transfers to brokerage accounts (tracked separately from investment)
  savingsRate: number;
  status: 'RECONCILED' | 'NOT_CONFIGURED';
  expenseCategoryBreakdown: Array<{ category: string; amount: number; pct: number }>;
  monthlyTrends: Array<{ month: string; income: number; expense: number; net: number }>;
}

export class FinancialQueries {
  static getMetric(metricName: string): FinancialMetric {
    const transactions = repository.transactions.findAllSync();
    const assets = repository.assets.findAllSync();
    const liabilities = repository.liabilities.findAllSync();
    const snapshots = repository.snapshots.findAllSync();
    return FinancialMetricService.getMetric(metricName, transactions, assets, liabilities, snapshots);
  }

  static getSeries(seriesName: string): FinancialSeries | null {
    const transactions = repository.transactions.findAllSync();
    return FinancialMetricService.getSeries(seriesName, transactions);
  }

  static queryTransactions(params: {
    type?: 'Expense' | 'Income' | 'Transfer' | 'All';
    dateRange?: string;
    search?: string;
    customStart?: string | null;
    customEnd?: string | null;
  }): Transaction[] {
    return repository.transactions.findManySync(params);
  }

  static getSnapshots(): NetWorthSnapshot[] {
    return repository.snapshots.findAllSync();
  }

  /* WP-18: Account & Budget Queries */
  static getAccounts(): Account[] {
    return repository.accounts.findAllSync();
  }

  static getBudgetForMonth(monthStr: string): MonthlyBudget | null {
    return repository.budgets.findForMonthSync(monthStr);
  }

  static getBudgets(): MonthlyBudget[] {
    return repository.budgets.findAllSync();
  }

  static getMoneyInsights(dateRange: string = 'This Month', customStart?: string, customEnd?: string): MoneyInsightsData {
    const bounds = DateRangeService.getBounds(dateRange, getEffectiveAsOfDate(), customStart, customEnd);
    // WP-FB-DATA-06c-1: income/expense/investment aggregation is a derived
    // financial surface, so excluded rows are filtered out first.
    const allTxs = LedgerExclusionService.forDerivation(repository.transactions.findAllSync());
    const periodTxs = allTxs.filter(t => t.date >= bounds.startDate && t.date <= bounds.endDate);

    let totalIncome = 0;
    let totalExpenses = 0;
    let totalInvested = 0;
    let brokerageFunding = 0;
    const catTotals: Record<string, number> = {};

    for (const t of periodTxs) {
      if (t.type === 'Income') {
        totalIncome += t.amount;
      } else if (t.type === 'Expense') {
        totalExpenses += t.amount;
        const bCat = mapTransactionCategoryToBudget(t.category);
        catTotals[bCat] = (catTotals[bCat] || 0) + t.amount;
        if (t.category === 'INVESTMENT') {
          totalInvested += t.amount;
        }
      } else if (t.type === 'Transfer') {
        if (t.title.toLowerCase().includes('brokerage') || t.title.toLowerCase().includes('zerodha') || t.title.toLowerCase().includes('invest')) {
          brokerageFunding += t.amount;
        }
      }
    }

    const netCashFlow = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0;
    const status: 'RECONCILED' | 'NOT_CONFIGURED' = periodTxs.length > 0 ? 'RECONCILED' : 'NOT_CONFIGURED';

    const expenseCategoryBreakdown = Object.entries(catTotals)
      .map(([category, amount]) => ({
        category,
        amount,
        pct: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    // Compute monthly trends (trailing 6 months)
    const monthMap: Record<string, { income: number; expense: number }> = {};
    for (const t of allTxs) {
      const ym = t.date.slice(0, 7);
      if (!monthMap[ym]) monthMap[ym] = { income: 0, expense: 0 };
      if (t.type === 'Income') monthMap[ym].income += t.amount;
      if (t.type === 'Expense') monthMap[ym].expense += t.amount;
    }

    const monthlyTrends = Object.entries(monthMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([month, data]) => ({
        month,
        income: data.income,
        expense: data.expense,
        net: data.income - data.expense
      }));

    return {
      totalIncome,
      totalExpenses,
      netCashFlow,
      totalInvested,
      brokerageFunding,
      savingsRate,
      status,
      expenseCategoryBreakdown,
      monthlyTrends
    };
  }

  /* WP-17 Phase C: Wealth Intelligence Queries */
  static getWealthHealthSummary(): WealthHealthSummary {
    const assets = repository.assets.findAllSync();
    const liabilities = repository.liabilities.findAllSync();
    const snapshots = repository.snapshots.findAllSync();
    // WP-FB-IMPORT-BROKER-01 D-04: imported Holdings contribute their
    // currentValue to net worth via HoldingWealthBridge. Threaded
    // through the queries layer so the live displayed wealth
    // includes broker-imported positions.
    const holdings = repository.holdings.findAllSync();
    return WealthIntelligenceService.getHealthSummary(
      assets,
      liabilities,
      snapshots,
      repository.accounts.findAllSync(),
      repository.transactions.findAllSync(),
      holdings,
    );
  }

  static getAssetConcentration(): AssetConcentrationAnalysis {
    const assets = repository.assets.findAllSync();
    // WP-FB-IMPORT-BROKER-01 D-04: thread holdings for concentration totals.
    const holdings = repository.holdings.findAllSync();
    return WealthIntelligenceService.getAssetConcentration(assets, holdings);
  }

  static getAllocationDiagnostics(): AllocationDiagnostics {
    const assets = repository.assets.findAllSync();
    // WP-FB-IMPORT-BROKER-01 D-04: thread holdings for allocation totals.
    const holdings = repository.holdings.findAllSync();
    return WealthIntelligenceService.getAllocationDiagnostics(assets, holdings);
  }

  static getLiabilityDiagnostics(): LiabilityDiagnostics {
    const assets = repository.assets.findAllSync();
    const liabilities = repository.liabilities.findAllSync();
    // WP-FB-IMPORT-BROKER-01 D-04: thread holdings for totalAssets in
    // debt-to-asset diagnostics.
    const holdings = repository.holdings.findAllSync();
    return WealthIntelligenceService.getLiabilityDiagnostics(assets, liabilities, holdings);
  }

  static getTrendIntelligence(): NetWorthTrendIntelligence {
    const snapshots = repository.snapshots.findAllSync();
    return WealthIntelligenceService.getTrendIntelligence(snapshots);
  }

  static getDataQuality(): WealthDataQuality {
    const assets = repository.assets.findAllSync();
    const liabilities = repository.liabilities.findAllSync();
    const snapshots = repository.snapshots.findAllSync();
    // WP-FB-IMPORT-BROKER-01 D-04-HWA-07: thread holdings for activation
    // semantics. Completeness methodology remains unchanged.
    const holdings = repository.holdings.findAllSync();
    return WealthIntelligenceService.getDataQuality(assets, liabilities, snapshots, holdings);
  }

  static getWealthInsights(): WealthInsight[] {
    const assets = repository.assets.findAllSync();
    const liabilities = repository.liabilities.findAllSync();
    const snapshots = repository.snapshots.findAllSync();
    return WealthIntelligenceService.generateInsights(assets, liabilities, snapshots);
  }

  /* =========================================================================
   * WP-19: Essentials Queries
   * ========================================================================= */

  static getPolicies(): InsurancePolicy[] {
    return repository.policies.findAllSync();
  }

  static getGoals(): FinancialGoal[] {
    return repository.goals.findAllSync();
  }

  static getProfile(): FinancialProfile | null {
    return repository.profile.getSync();
  }

  static getEmergencyFundAnalysis(targetMonths: number = 6): EmergencyFundAnalysis {
    const assets = repository.assets.findAllSync();
    const accounts = repository.accounts.findAllSync();
    const transactions = repository.transactions.findAllSync();
    const budgets = repository.budgets.findAllSync();
    const profile = repository.profile.getSync();
    return EssentialsService.calculateEmergencyFundAnalysis(assets, accounts, transactions, budgets, targetMonths, profile);
  }

  static getFinancialHealthScore(): HealthScoreBreakdown {
    const emergencyAnalysis = this.getEmergencyFundAnalysis(6);
    const assets = repository.assets.findAllSync();
    const liabilities = repository.liabilities.findAllSync();
    const totalAssets = assets.reduce((s, a) => s + a.amount, 0);
    const totalDebt = liabilities.reduce((s, l) => s + l.amount, 0);
    const policies = repository.policies.findAllSync();
    const totalInsuranceCover = EssentialsService.calculateActiveInsuranceTotal(policies);
    const profile = repository.profile.getSync();
    const insights = this.getMoneyInsights('This Month');
    return EssentialsService.calculateFinancialHealthScore({
      emergencyAnalysis,
      totalDebt,
      totalAssets,
      totalInsuranceCover,
      policies,
      profile,
      savingsRate: insights.savingsRate
    });
  }
  /* =========================================================================
   * WP-22: Canonical Mathematical Intelligence Engine Queries
   * ========================================================================= */

  static calculateSip(
    monthlyInvestment: number,
    annualRate: number,
    years: number,
    stepUpPct: number = 0
  ) {
    return Wp20Adapters.calculateSip(monthlyInvestment, annualRate, years, stepUpPct);
  }

  static calculateLumpsum(
    principal: number,
    annualRate: number,
    years: number,
    expectedInflation: number = 6.0
  ) {
    return Wp20Adapters.calculateLumpsum(principal, annualRate, years, expectedInflation);
  }

  static calculateLoanEmi(
    principal: number,
    annualRate: number,
    tenureMonths: number
  ) {
    return Wp20Adapters.calculateLoanEmi(principal, annualRate, tenureMonths);
  }

  static calculateCagr(
    initialValue: number,
    finalValue: number,
    years: number
  ) {
    return Wp20Adapters.calculateCagr(initialValue, finalValue, years);
  }

  static calculateXirr(
    cashFlows: XirrFlowInput[],
    config?: Parameters<typeof XirrEngine.calculate>[1]
  ) {
    return XirrEngine.calculate(cashFlows, config);
  }

  static calculateRecurringDeposit(input: RdCalculationInput) {
    return RecurringDepositEngine.calculate(input);
  }

  static calculatePpf(input: PpfCalculationInput) {
    return PpfEngine.calculate(input);
  }

  static calculateSwp(input: SwpCalculationInput) {
    return SwpEngine.calculate(input);
  }

  static calculateGoalReverseSip(input: GoalReverseSipInput) {
    return GoalReverseSipEngine.calculate(input);
  }

  static calculateRetirementFire(input: RetirementFireInput) {
    return RetirementFireEngine.calculate(input);
  }
}

if (typeof window !== 'undefined') {
  (window as any).FinancialQueries = FinancialQueries;
}
