import { FinancialMetric, FinancialSeries, Transaction, Asset, Liability, NetWorthSnapshot } from '../domain/types';
import { DateRangeService, getEffectiveAsOfDate } from './DateRangeService';
import { LedgerExclusionService } from './LedgerExclusionService';
import { DividendService } from './DividendService';
import { WealthIntelligenceService } from './WealthIntelligenceService';
import { EssentialsService } from './EssentialsService';
import { repository } from '../repositories';

export class FinancialMetricService {
  static getMetric(
    metricName: string,
    transactions: Transaction[] = [],
    assets: Asset[] = [],
    liabilities: Liability[] = [],
    snapshots: NetWorthSnapshot[] = [],
    asOfDateStr: string = getEffectiveAsOfDate()
  ): FinancialMetric {
    // WP-FB-DATA-06c-1: every metric below derives money from rows, so all of
    // them read the exclusion-filtered set rather than the raw input.
    transactions = LedgerExclusionService.forDerivation(transactions);

    if (metricName === 'TTM_REALIZED_DIVIDEND') {
      const bounds = DateRangeService.getBounds('12M', asOfDateStr);
      const ttmVal = transactions
        .filter(t => t.category === 'DIVIDEND' && t.status === 'CLEARED' && t.date >= bounds.startDate && t.date <= bounds.endDate)
        .reduce((sum, t) => sum + t.amount, 0);

      return {
        metric: 'TTM_REALIZED_DIVIDEND',
        value: ttmVal,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> DividendService',
        filters: { category: 'DIVIDEND', status: 'CLEARED', dateRange: '12M_TRAILING' },
        formula: 'SUM(transaction.amount)',
        status: 'RECONCILED'
      };
    } else if (metricName === 'MONTHLY_AVERAGE_DIVIDEND') {
      const bounds = DateRangeService.getBounds('12M', asOfDateStr);
      const ttmVal = transactions
        .filter(t => t.category === 'DIVIDEND' && t.status === 'CLEARED' && t.date >= bounds.startDate && t.date <= bounds.endDate)
        .reduce((sum, t) => sum + t.amount, 0);

      return {
        metric: 'MONTHLY_AVERAGE_DIVIDEND',
        value: Math.round((ttmVal / 12) * 100) / 100,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> DividendService',
        filters: { category: 'DIVIDEND', status: 'CLEARED', dateRange: '12M_TRAILING' },
        formula: 'TTM_REALIZED_DIVIDEND / 12',
        status: 'RECONCILED'
      };
    } else if (metricName === 'MTD_REALIZED_DIVIDEND') {
      const bounds = DateRangeService.getBounds('This Month', asOfDateStr);
      const mtdVal = transactions
        .filter(t => t.date >= bounds.startDate && t.date <= bounds.endDate && t.category === 'DIVIDEND' && t.status === 'CLEARED')
        .reduce((sum, t) => sum + t.amount, 0);

      return {
        metric: 'MTD_REALIZED_DIVIDEND',
        value: mtdVal,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> DividendService',
        filters: { category: 'DIVIDEND', status: 'CLEARED', dateRange: 'MTD' },
        formula: 'SUM(transaction.amount WHERE YYYY-MM == currentMonth)',
        status: 'RECONCILED'
      };
    } else if (metricName === 'NET_WORTH') {
      const totAssets = assets.reduce((sum, a) => sum + a.amount, 0);
      const totLiabs = liabilities.reduce((sum, l) => sum + l.amount, 0);

      return {
        metric: 'NET_WORTH',
        value: totAssets - totLiabs,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Asset/Liability Registry',
        filters: {},
        formula: 'Total Assets - Total Liabilities',
        status: 'RECONCILED'
      };
    } else if (metricName === 'TOTAL_ASSETS') {
      const totAssets = assets.reduce((sum, a) => sum + a.amount, 0);
      return {
        metric: 'TOTAL_ASSETS',
        value: totAssets,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Asset Registry',
        filters: {},
        formula: 'SUM(assets.amount)',
        status: 'RECONCILED'
      };
    } else if (metricName === 'TOTAL_LIABILITIES') {
      const totLiabs = liabilities.reduce((sum, l) => sum + l.amount, 0);
      return {
        metric: 'TOTAL_LIABILITIES',
        value: totLiabs,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Liability Registry',
        filters: {},
        formula: 'SUM(liabilities.amount)',
        status: 'RECONCILED'
      };
    } else if (metricName === 'DIVIDEND_YIELD_TTM') {
      const bounds = DateRangeService.getBounds('12M', asOfDateStr);
      const ttmVal = transactions
        .filter(t => t.category === 'DIVIDEND' && t.status === 'CLEARED' && t.date >= bounds.startDate && t.date <= bounds.endDate)
        .reduce((sum, t) => sum + t.amount, 0);
      const invAsset = assets
        .filter(a => a.name.toLowerCase().includes('brokerage') || a.name.toLowerCase().includes('invest') || a.name.toLowerCase().includes('zerodha') || a.name.toLowerCase().includes('groww') || a.name.toLowerCase().includes('upstox') || a.name.includes('3 Brokerages'))
        .reduce((sum, a) => sum + a.amount, 0);
      const y = invAsset > 0 ? Math.round((ttmVal / invAsset) * 10000) / 100 : 0;
      return {
        metric: 'DIVIDEND_YIELD_TTM',
        value: y,
        currency: '%',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Portfolio Yield',
        filters: {},
        formula: '(TTM_REALIZED_DIVIDEND / InvestedPortfolio) * 100',
        status: invAsset > 0 ? 'RECONCILED' : 'NOT_CONFIGURED',
        displayLabel: invAsset > 0 ? undefined : 'Not configured (Requires Portfolio Registry)'
      };
    } else if (metricName === 'NET_WORTH_CAGR') {
      return WealthIntelligenceService.calculateNetWorthCAGR(snapshots, asOfDateStr);
    } else if (metricName === 'EMERGENCY_FUND_COVERAGE') {
      const accounts = repository.accounts.findAllSync();
      const budgets = repository.budgets.findAllSync();
      const profile = repository.profile.getSync();
      const em = EssentialsService.calculateEmergencyFundAnalysis(assets, accounts, transactions, budgets, 6, profile);
      return {
        metric: 'EMERGENCY_FUND_COVERAGE',
        value: em.runwayMonths,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> EssentialsService',
        filters: { targetMonths: 6 },
        formula: 'LiquidReserves / MonthlyEssentialExpenses',
        status: em.status,
        displayLabel: em.status === 'RECONCILED' ? `${em.runwayMonths} Months` : 'Not configured'
      };
    } else if (metricName === 'ACTIVE_INSURANCE_POLICY_TOTAL') {
      const policies = repository.policies.findAllSync();
      const activeTotal = EssentialsService.calculateActiveInsuranceTotal(policies);
      const isConfigured = policies.length > 0;
      return {
        metric: 'ACTIVE_INSURANCE_POLICY_TOTAL',
        value: activeTotal,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> EssentialsService',
        filters: { status: 'Active' },
        formula: 'Sum(ActivePolicy.coverAmount)',
        status: isConfigured ? 'RECONCILED' : 'NOT_CONFIGURED',
        displayLabel: isConfigured ? `₹${activeTotal.toLocaleString('en-IN')}` : 'Not configured'
      };
    } else if (metricName === 'SIP_COMMITMENT_MONTHLY') {
      const goals = repository.goals.findAllSync();
      const sipTotal = EssentialsService.calculateMonthlySipCommitment(goals);
      const isConfigured = goals.length > 0;
      return {
        metric: 'SIP_COMMITMENT_MONTHLY',
        value: sipTotal,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> EssentialsService',
        filters: { status: 'In Progress' },
        formula: 'Sum(InProgressGoal.monthlyContribution)',
        status: isConfigured ? 'RECONCILED' : 'NOT_CONFIGURED',
        displayLabel: isConfigured ? `₹${sipTotal.toLocaleString('en-IN')}` : 'Not configured'
      };
    } else if (metricName === 'EMERGENCY_FUND_GOAL') {
      const accounts = repository.accounts.findAllSync();
      const budgets = repository.budgets.findAllSync();
      const profile = repository.profile.getSync();
      const emGoal = EssentialsService.calculateEmergencyFundAnalysis(assets, accounts, transactions, budgets, 6, profile);
      return {
        metric: 'EMERGENCY_FUND_GOAL',
        value: emGoal.targetAmount,
        currency: 'INR',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> EssentialsService',
        filters: { targetMonths: 6 },
        formula: 'MonthlyEssentialExpenses * 6',
        status: emGoal.status,
        displayLabel: emGoal.status === 'RECONCILED' ? `₹${emGoal.targetAmount.toLocaleString('en-IN')}` : 'Not configured'
      };
    }
    return {
      metric: metricName,
      value: 0,
      currency: 'INR',
      asOf: asOfDateStr,
      source: 'Unknown',
      filters: {},
      formula: '',
      status: 'ESTIMATED'
    };
  }

  static getSeries(seriesName: string, transactions: Transaction[], asOfDateStr: string = getEffectiveAsOfDate()): FinancialSeries | null {
    if (seriesName === 'MONTHLY_DIVIDEND_HISTOGRAM') {
      return {
        series: 'MONTHLY_DIVIDEND_HISTOGRAM',
        asOf: asOfDateStr,
        points: DividendService.getMonthlyTotals(transactions, asOfDateStr),
        source: 'CanonicalLedger -> DividendService',
        filters: { category: 'DIVIDEND', status: 'CLEARED', dateRange: '12M_TRAILING' },
        status: 'RECONCILED'
      };
    }
    return null;
  }
}

if (typeof window !== 'undefined') {
  (window as any).FinancialMetricService = FinancialMetricService;
}
