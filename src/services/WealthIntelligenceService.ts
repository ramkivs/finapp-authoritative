import {
  Account,
  Transaction,
  Asset,
  AssetType,
  Liability,
  Holding,
  NetWorthSnapshot,
  WealthHealthSummary,
  AssetConcentrationAnalysis,
  AllocationDiagnostics,
  LiabilityDiagnostics,
  NetWorthTrendIntelligence,
  WealthInsight,
  WealthDataQuality,
  FinancialMetric
} from '../domain/types';
import { getEffectiveAsOfDate } from './DateRangeService';
import { LiquidReservesService } from './LiquidReservesService';
import { HoldingWealthBridge } from './HoldingWealthBridge';

/**
 * Single authoritative definition of the Reference Allocation Benchmark.
 * Analytical reference benchmark; not personalized investment advice.
 */
export const REFERENCE_ALLOCATION_BENCHMARK: Array<{
  category: AssetType;
  targetPct: number;
  color: string;
}> = [
  { category: 'Equity', targetPct: 55, color: 'bg-cyan-500' },
  { category: 'Debt', targetPct: 20, color: 'bg-green-500' },
  { category: 'Real Estate', targetPct: 10, color: 'bg-purple-500' },
  { category: 'Commodities', targetPct: 10, color: 'bg-amber-500' },
  { category: 'Cash & Savings', targetPct: 5, color: 'bg-gray-400' }
];

export const TARGET_ALLOCATION_REFERENCE: Record<string, number> = Object.fromEntries(
  REFERENCE_ALLOCATION_BENCHMARK.map(b => [b.category, b.targetPct])
);

/**
 * Deterministic date parser for snapshot timestamp comparison.
 * Returns NaN for malformed/unparseable dates to prevent epoch-zero analytical contamination.
 */
export function parseDateToTime(dateStr: string): number {
  if (!dateStr || typeof dateStr !== 'string') return NaN;
  const clean = dateStr.replace(' (Today)', '').trim();
  if (!clean) return NaN;

  // Try direct Date parse
  const direct = new Date(clean).getTime();
  if (!isNaN(direct)) return direct;

  // Try DD-MM-YYYY format
  const ddmmyyyy = clean.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`).getTime();
  }

  // Try DD MMM YYYY format
  const ddMmmYyyy = clean.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (ddMmmYyyy) {
    return new Date(clean).getTime();
  }

  return NaN;
}

export class WealthIntelligenceService {
  public static readonly REFERENCE_BENCHMARK = REFERENCE_ALLOCATION_BENCHMARK;
  public static readonly TARGET_ALLOCATION_REFERENCE = TARGET_ALLOCATION_REFERENCE;

  /**
   * Authoritative Net Worth CAGR Calculation.
   * Formula: CAGR = (EndingNetWorth / StartingNetWorth) ^ (1 / Years) - 1
   */
  public static calculateNetWorthCAGR(
    snapshots: NetWorthSnapshot[],
    asOfDateStr: string = getEffectiveAsOfDate()
  ): FinancialMetric {
    if (!snapshots || snapshots.length === 0) {
      return {
        metric: 'NET_WORTH_CAGR',
        value: 0,
        currency: '%',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Historical Snapshots',
        filters: {},
        formula: '(EndingNetWorth / StartingNetWorth) ^ (1 / Years) - 1',
        status: 'NOT_CONFIGURED',
        displayLabel: 'Not configured (Requires Snapshots)'
      };
    }

    const validSnapshots = snapshots
      .map(s => ({ ...s, timestamp: parseDateToTime(s.dateStr) }))
      .filter(s => !isNaN(s.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (validSnapshots.length < 2) {
      return {
        metric: 'NET_WORTH_CAGR',
        value: 0,
        currency: '%',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Historical Snapshots',
        filters: {},
        formula: '(EndingNetWorth / StartingNetWorth) ^ (1 / Years) - 1',
        status: 'NOT_CONFIGURED',
        displayLabel: validSnapshots.length === 1 ? 'Requires 2+ snapshots' : 'Not configured (Invalid dates)'
      };
    }

    const oldest = validSnapshots[0];
    const latest = validSnapshots[validSnapshots.length - 1];

    const startNW = oldest.netWorth;
    const endNW = latest.netWorth;

    // Non-positive net worth check
    if (startNW <= 0 || endNW <= 0) {
      return {
        metric: 'NET_WORTH_CAGR',
        value: 0,
        currency: '%',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Historical Snapshots',
        filters: {},
        formula: '(EndingNetWorth / StartingNetWorth) ^ (1 / Years) - 1',
        status: 'NOT_CONFIGURED',
        displayLabel: startNW <= 0 ? 'Starting Net Worth <= 0 (CAGR undefined)' : 'Ending Net Worth <= 0 (CAGR undefined)'
      };
    }

    const elapsedMs = latest.timestamp - oldest.timestamp;
    const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

    // Duplicate or same-day interval check
    if (elapsedDays < 1) {
      return {
        metric: 'NET_WORTH_CAGR',
        value: 0,
        currency: '%',
        asOf: asOfDateStr,
        source: 'CanonicalLedger -> Historical Snapshots',
        filters: {},
        formula: '(EndingNetWorth / StartingNetWorth) ^ (1 / Years) - 1',
        status: 'NOT_CONFIGURED',
        displayLabel: 'Interval too short (same day snapshots)'
      };
    }

    const years = elapsedDays / 365.25;
    const rawCagr = Math.pow(endNW / startNW, 1 / years) - 1;
    const roundedCagr = Math.round(rawCagr * 1000) / 10;

    return {
      metric: 'NET_WORTH_CAGR',
      value: roundedCagr,
      currency: '%',
      asOf: asOfDateStr,
      source: 'CanonicalLedger -> Historical Snapshots',
      filters: { snapshotCount: validSnapshots.length, years: Math.round(years * 100) / 100 },
      formula: '(EndingNetWorth / StartingNetWorth) ^ (1 / Years) - 1',
      status: 'RECONCILED'
    };
  }

  /** Compute Wealth Health Summary (Workstream C1) */
  public static getHealthSummary(
    assets: Asset[],
    liabilities: Liability[],
    snapshots: NetWorthSnapshot[] = [],
    // WP-FB-DATA-05b Decision I: liquidity now needs the account registry and
    // the canonical transactions. Optional so existing callers keep compiling;
    // omitting them yields asset-only liquidity, matching prior behaviour.
    accounts: Account[] = [],
    transactions: Transaction[] = [],
    // WP-FB-IMPORT-BROKER-01 D-04: imported Holdings contribute currentValue to
    // the net-worth sum. Optional so existing callers keep compiling.
    holdings: Holding[] = []
  ): WealthHealthSummary {
    const totalAssets = HoldingWealthBridge.aggregateAssetsAndHoldings(assets, holdings);
    const totalLiabilities = liabilities.reduce((s, l) => s + l.amount, 0);
    const netWorth = totalAssets - totalLiabilities;

    if (assets.length === 0 && liabilities.length === 0) {
      return {
        netWorth: 0,
        totalAssets: 0,
        totalLiabilities: 0,
        debtToAssetRatio: 0,
        liquidReserve: 0,
        liquidRatio: 0,
        topAssetConcentration: 0,
        status: 'NOT_CONFIGURED'
      };
    }

    const debtToAssetRatio = totalAssets > 0 ? (totalLiabilities / totalAssets) * 100 : (totalLiabilities > 0 ? 100 : 0);

    // Liquid reserve: WP-FB-DATA-05b Decision I - one definition across the
    // product, shared with EssentialsService. Previously this counted only
    // Cash & Savings assets and ignored accounts entirely, so the app carried
    // two different "liquid" numbers.
    const liquidReserve = LiquidReservesService.total(assets, accounts, transactions);

    const liquidRatio = totalAssets > 0 ? (liquidReserve / totalAssets) * 100 : 0;

    const maxAssetAmt = assets.length > 0 ? Math.max(...assets.map(a => a.amount)) : 0;
    const topAssetConcentration = totalAssets > 0 ? (maxAssetAmt / totalAssets) * 100 : 0;

    return {
      netWorth,
      totalAssets,
      totalLiabilities,
      debtToAssetRatio,
      liquidReserve,
      liquidRatio,
      topAssetConcentration,
      status: 'RECONCILED'
    };
  }

  /**
   * Compute Asset Concentration Analysis (Workstream C2).
   * Missing geography and currency remain 'Not Specified' without inference.
   * Missing type remains 'Unclassified' without converting to 'Other'.
   */
  public static getAssetConcentration(assets: Asset[], holdings: Holding[] = []): AssetConcentrationAnalysis {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(assets, holdings);
    if (assets.length === 0 || total === 0) {
      return {
        byType: [],
        byGeography: [],
        byCurrency: [],
        isConcentrated: false,
        unclassifiedPct: 0
      };
    }

    // Largest individual asset
    const sorted = [...assets].sort((a, b) => b.amount - a.amount);
    const top = sorted[0];
    const topAsset = top
      ? {
          name: top.name,
          amount: top.amount,
          pct: Math.round((top.amount / total) * 100)
        }
      : undefined;

    // Concentration by Type
    const typeMap: Record<string, number> = {};
    let unclassifiedAmt = 0;
    for (const a of assets) {
      const t = a.type ? a.type : 'Unclassified';
      typeMap[t] = (typeMap[t] || 0) + a.amount;
      if (!a.type) {
        unclassifiedAmt += a.amount;
      }
    }
    const byType = Object.entries(typeMap)
      .map(([type, amount]) => ({
        type,
        amount,
        pct: Math.round((amount / total) * 100)
      }))
      .sort((a, b) => b.amount - a.amount);

    // Concentration by Geography (explicit metadata only; missing remains 'Not Specified')
    const geoMap: Record<string, number> = {};
    for (const a of assets) {
      const g = a.geography ? a.geography : 'Not Specified';
      geoMap[g] = (geoMap[g] || 0) + a.amount;
    }
    const byGeography = Object.entries(geoMap)
      .map(([geography, amount]) => ({
        geography,
        amount,
        pct: Math.round((amount / total) * 100)
      }))
      .sort((a, b) => b.amount - a.amount);

    // Concentration by Currency (explicit metadata only; missing remains 'Not Specified')
    const currMap: Record<string, number> = {};
    for (const a of assets) {
      const c = a.currency ? a.currency : 'Not Specified';
      currMap[c] = (currMap[c] || 0) + a.amount;
    }
    const byCurrency = Object.entries(currMap)
      .map(([currency, amount]) => ({
        currency,
        amount,
        pct: Math.round((amount / total) * 100)
      }))
      .sort((a, b) => b.amount - a.amount);

    const isConcentrated = (topAsset?.pct || 0) > 40 || (byType[0]?.pct || 0) > 60;
    const unclassifiedPct = Math.round((unclassifiedAmt / total) * 100);

    return {
      topAsset,
      byType,
      byGeography,
      byCurrency,
      isConcentrated,
      unclassifiedPct
    };
  }

  /** Compute Allocation Diagnostics & Target Drift (Workstream C3) */
  public static getAllocationDiagnostics(assets: Asset[], holdings: Holding[] = []): AllocationDiagnostics {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(assets, holdings);
    if (assets.length === 0 || total === 0) {
      return {
        underrepresentedCategories: [],
        targetDrift: [],
        hasConcentrationWarning: false,
        metadataCompletenessPct: 0
      };
    }

    const typeMap: Record<string, number> = {};
    let classifiedCount = 0;
    for (const a of assets) {
      const t = a.type || 'Unclassified';
      typeMap[t] = (typeMap[t] || 0) + a.amount;
      if (a.type) classifiedCount++;
    }

    const dominantCategory = Object.entries(typeMap).sort((a, b) => b[1] - a[1])[0]?.[0];
    const dominantPct = total > 0 && dominantCategory ? (typeMap[dominantCategory] / total) * 100 : 0;
    const hasConcentrationWarning = dominantPct > 60;

    const underrepresentedCategories: string[] = [];
    const targetDrift: Array<{
      category: string;
      targetPct: number;
      actualPct: number;
      driftPct: number;
    }> = [];

    for (const benchmark of REFERENCE_ALLOCATION_BENCHMARK) {
      const cat = benchmark.category;
      const targetPct = benchmark.targetPct;
      const actualAmt = typeMap[cat] || 0;
      const actualPct = total > 0 ? Math.round((actualAmt / total) * 100) : 0;
      const driftPct = actualPct - targetPct;
      targetDrift.push({ category: cat, targetPct, actualPct, driftPct });
      if (actualPct < targetPct / 2) {
        underrepresentedCategories.push(cat);
      }
    }

    const metadataCompletenessPct = Math.round((classifiedCount / assets.length) * 100);

    return {
      dominantCategory,
      underrepresentedCategories,
      targetDrift,
      hasConcentrationWarning,
      metadataCompletenessPct
    };
  }

  /** Compute Liquidity & Liability Health (Workstream C4) */
  public static getLiabilityDiagnostics(assets: Asset[], liabilities: Liability[], holdings: Holding[] = []): LiabilityDiagnostics {
    const totalAssets = HoldingWealthBridge.aggregateAssetsAndHoldings(assets, holdings);
    const totalDebt = liabilities.reduce((s, l) => s + l.amount, 0);

    if (assets.length === 0 && liabilities.length === 0) {
      return {
        totalDebt: 0,
        debtToAssetRatio: 0,
        burdenLevel: 'NOT_CONFIGURED'
      };
    }

    const debtToAssetRatio = totalAssets > 0 ? (totalDebt / totalAssets) * 100 : (totalDebt > 0 ? 100 : 0);

    let burdenLevel: 'LOW' | 'MODERATE' | 'ELEVATED' | 'NOT_CONFIGURED';
    if (totalAssets === 0 && totalDebt === 0) {
      burdenLevel = 'NOT_CONFIGURED';
    } else if (debtToAssetRatio > 40) {
      burdenLevel = 'ELEVATED';
    } else if (debtToAssetRatio > 20) {
      burdenLevel = 'MODERATE';
    } else {
      burdenLevel = 'LOW';
    }

    const sorted = [...liabilities].sort((a, b) => b.amount - a.amount);
    const top = sorted[0];
    const largestLiability = top
      ? {
          name: top.name,
          amount: top.amount,
          type: top.type || 'Unclassified',
          pct: totalDebt > 0 ? Math.round((top.amount / totalDebt) * 100) : 0
        }
      : undefined;

    return {
      totalDebt,
      debtToAssetRatio,
      largestLiability,
      burdenLevel
    };
  }

  /** Compute Net-Worth Trend Intelligence (Workstream C5) */
  public static getTrendIntelligence(snapshots: NetWorthSnapshot[]): NetWorthTrendIntelligence {
    if (!snapshots || snapshots.length === 0) {
      return {
        status: 'NOT_CONFIGURED',
        snapshotCount: 0,
        latestNetWorth: 0,
        direction: 'NONE'
      };
    }

    const sorted = [...snapshots]
      .map(s => ({ ...s, timestamp: parseDateToTime(s.dateStr) }))
      .filter(s => !isNaN(s.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);

    const count = sorted.length;
    if (count === 0) {
      return {
        status: 'NOT_CONFIGURED',
        snapshotCount: 0,
        latestNetWorth: 0,
        direction: 'NONE'
      };
    }

    const latest = sorted[count - 1];

    if (count === 1) {
      return {
        status: 'BASELINE_SET',
        snapshotCount: 1,
        latestNetWorth: latest.netWorth,
        direction: 'NONE'
      };
    }

    const previous = sorted[count - 2];
    const absoluteChange = latest.netWorth - previous.netWorth;
    const percentageChange = previous.netWorth !== 0 ? (absoluteChange / Math.abs(previous.netWorth)) * 100 : 0;
    const direction: 'UP' | 'DOWN' | 'FLAT' =
      absoluteChange > 0 ? 'UP' : absoluteChange < 0 ? 'DOWN' : 'FLAT';

    const status = count >= 3 ? 'COMPOUNDING_ACTIVE' : 'TREND_ACTIVE';

    return {
      status,
      snapshotCount: count,
      latestNetWorth: latest.netWorth,
      previousNetWorth: previous.netWorth,
      absoluteChange,
      percentageChange,
      direction
    };
  }

  /** Compute Wealth Data Quality (Workstream C7) */
  public static getDataQuality(
    assets: Asset[],
    liabilities: Liability[],
    snapshots: NetWorthSnapshot[] = []
  ): WealthDataQuality {
    const totalRecords = assets.length + liabilities.length;
    if (totalRecords === 0) {
      return {
        status: 'NOT_CONFIGURED',
        completenessScore: 0,
        missingAssetTypeCount: 0,
        missingGeographyCount: 0,
        missingCurrencyCount: 0,
        missingLiabilityTypeCount: 0,
        totalRecords: 0
      };
    }

    let missingAssetTypeCount = 0;
    let missingGeographyCount = 0;
    let missingCurrencyCount = 0;
    for (const a of assets) {
      if (!a.type) missingAssetTypeCount++;
      if (!a.geography) missingGeographyCount++;
      if (!a.currency) missingCurrencyCount++;
    }

    let missingLiabilityTypeCount = 0;
    for (const l of liabilities) {
      if (!l.type) missingLiabilityTypeCount++;
    }

    const totalFields = assets.length * 3 + liabilities.length * 1;
    const missingFields =
      missingAssetTypeCount + missingGeographyCount + missingCurrencyCount + missingLiabilityTypeCount;
    const completenessScore =
      totalFields > 0 ? Math.round(((totalFields - missingFields) / totalFields) * 100) : 100;

    let status: 'COMPLETE' | 'PARTIAL' | 'NEEDS_ATTENTION' | 'NOT_CONFIGURED';
    if (completenessScore >= 80) {
      status = 'COMPLETE';
    } else if (completenessScore >= 40) {
      status = 'PARTIAL';
    } else {
      status = 'NEEDS_ATTENTION';
    }

    return {
      status,
      completenessScore: Math.max(0, completenessScore),
      missingAssetTypeCount,
      missingGeographyCount,
      missingCurrencyCount,
      missingLiabilityTypeCount,
      totalRecords
    };
  }

  /**
   * Deterministic Insights Engine (Workstream C6).
   * Diagnostic / review-oriented language only; no personalized investment prescriptions.
   */
  public static generateInsights(
    assets: Asset[],
    liabilities: Liability[],
    snapshots: NetWorthSnapshot[] = []
  ): WealthInsight[] {
    const insights: WealthInsight[] = [];

    if (assets.length === 0 && liabilities.length === 0) {
      insights.push({
        id: 'wi-empty',
        severity: 'INFO',
        title: 'Wealth Ledger Initial Setup',
        explanation: 'Add your first asset and liability to initialize portfolio concentration and wealth health metrics.',
        sourceMetric: 'PORTFOLIO_STATE',
        deterministicReason: '0 canonical assets and 0 liabilities recorded'
      });
      return insights;
    }

    const health = this.getHealthSummary(assets, liabilities, snapshots);
    const concentration = this.getAssetConcentration(assets);
    const liabDiag = this.getLiabilityDiagnostics(assets, liabilities);
    const trend = this.getTrendIntelligence(snapshots);
    const dataQuality = this.getDataQuality(assets, liabilities, snapshots);

    // 1. Debt Burden Diagnostic
    if (liabDiag.burdenLevel === 'ELEVATED') {
      insights.push({
        id: 'wi-debt-elevated',
        severity: 'ACTION',
        title: 'Elevated Debt-to-Asset Ratio',
        explanation: `Total liabilities represent ${Math.round(liabDiag.debtToAssetRatio)}% of total asset valuation. Review debt obligations and financing terms.`,
        sourceMetric: 'DEBT_TO_ASSET_RATIO',
        deterministicReason: `Debt ratio (${Math.round(liabDiag.debtToAssetRatio)}%) exceeds 40% threshold`
      });
    } else if (liabDiag.burdenLevel === 'MODERATE') {
      insights.push({
        id: 'wi-debt-moderate',
        severity: 'WATCH',
        title: 'Moderate Debt Obligation',
        explanation: `Total liabilities represent ${Math.round(liabDiag.debtToAssetRatio)}% of assets. Debt schedule is manageable but warrants ongoing monitoring.`,
        sourceMetric: 'DEBT_TO_ASSET_RATIO',
        deterministicReason: `Debt ratio (${Math.round(liabDiag.debtToAssetRatio)}%) is between 20% and 40%`
      });
    } else if (liabDiag.totalDebt > 0 && liabDiag.burdenLevel === 'LOW') {
      insights.push({
        id: 'wi-debt-low',
        severity: 'INFO',
        title: 'Conservative Debt Profile',
        explanation: `Total liabilities represent only ${Math.round(liabDiag.debtToAssetRatio)}% of assets, indicating strong leverage solvency.`,
        sourceMetric: 'DEBT_TO_ASSET_RATIO',
        deterministicReason: `Debt ratio (${Math.round(liabDiag.debtToAssetRatio)}%) is below 20% threshold`
      });
    }

    // 2. Single-Asset Concentration Diagnostic
    if (concentration.topAsset && concentration.topAsset.pct > 40) {
      insights.push({
        id: 'wi-asset-concentration',
        severity: 'WATCH',
        title: 'Single-Asset Concentration Risk',
        explanation: `"${concentration.topAsset.name}" constitutes ${concentration.topAsset.pct}% of total portfolio value. Review asset distribution across categories.`,
        sourceMetric: 'ASSET_CONCENTRATION',
        deterministicReason: `Top asset "${concentration.topAsset.name}" represents ${concentration.topAsset.pct}% (> 40% threshold) of total assets`
      });
    }

    // 3. Liquid Reserve Health Diagnostic
    if (health.totalAssets > 0 && health.liquidRatio < 5) {
      insights.push({
        id: 'wi-liquidity-low',
        severity: 'WATCH',
        title: 'Low Liquid Cash Reserves',
        explanation: `Liquid reserves (Cash & Savings) represent ${Math.round(health.liquidRatio)}% of total assets. Review short-term liquidity requirements.`,
        sourceMetric: 'LIQUIDITY_RATIO',
        deterministicReason: `Liquid cash ratio (${Math.round(health.liquidRatio)}%) is below 5% reference threshold`
      });
    } else if (health.liquidRatio >= 5 && health.liquidReserve > 0) {
      insights.push({
        id: 'wi-liquidity-healthy',
        severity: 'INFO',
        title: 'Healthy Liquid Cushion',
        explanation: `Cash & liquid savings represent ${Math.round(health.liquidRatio)}% of portfolio assets, providing reliable operational liquidity.`,
        sourceMetric: 'LIQUIDITY_RATIO',
        deterministicReason: `Liquid cash ratio is ${Math.round(health.liquidRatio)}% (>= 5%)`
      });
    }

    // 4. Net Worth Trajectory Diagnostic
    if (trend.status === 'TREND_ACTIVE' || trend.status === 'COMPOUNDING_ACTIVE') {
      if (trend.direction === 'UP') {
        insights.push({
          id: 'wi-nw-growth',
          severity: 'INFO',
          title: 'Positive Net Worth Trajectory',
          explanation: `Net worth expanded by ${trend.percentageChange !== undefined ? (trend.percentageChange > 0 ? '+' : '') + trend.percentageChange.toFixed(1) + '%' : 'growth'} compared to previous historical anchor.`,
          sourceMetric: 'NET_WORTH_TREND',
          deterministicReason: `Latest snapshot net worth is greater than previous snapshot`
        });
      } else if (trend.direction === 'DOWN') {
        insights.push({
          id: 'wi-nw-contraction',
          severity: 'WATCH',
          title: 'Net Worth Contraction Detected',
          explanation: `Net worth contracted by ${trend.percentageChange !== undefined ? trend.percentageChange.toFixed(1) + '%' : 'delta'} compared to previous historical anchor.`,
          sourceMetric: 'NET_WORTH_TREND',
          deterministicReason: `Latest snapshot net worth is lower than previous snapshot`
        });
      }
    } else if (trend.status === 'BASELINE_SET') {
      insights.push({
        id: 'wi-nw-baseline',
        severity: 'INFO',
        title: 'Single Milestone Recorded',
        explanation: 'Initial net worth snapshot is anchored. Capture periodic snapshots or add past entries to measure compounding trajectory.',
        sourceMetric: 'SNAPSHOT_COUNT',
        deterministicReason: '1 snapshot recorded; 2+ needed for multi-point trajectory'
      });
    }

    // 5. Data Quality Diagnostic (accounting for all tracked dimensions)
    if (dataQuality.status === 'NEEDS_ATTENTION') {
      const details: string[] = [];
      if (dataQuality.missingAssetTypeCount > 0) details.push(`${dataQuality.missingAssetTypeCount} assets missing type`);
      if (dataQuality.missingGeographyCount > 0) details.push(`${dataQuality.missingGeographyCount} assets missing geography`);
      if (dataQuality.missingCurrencyCount > 0) details.push(`${dataQuality.missingCurrencyCount} assets missing currency`);
      if (dataQuality.missingLiabilityTypeCount > 0) details.push(`${dataQuality.missingLiabilityTypeCount} liabilities missing loan type`);

      insights.push({
        id: 'wi-data-quality',
        severity: 'WATCH',
        title: 'Incomplete Metadata Across Balance Sheet',
        explanation: `Tracked metadata completeness is at ${dataQuality.completenessScore}%. Incomplete dimensions: ${details.join(', ')}.`,
        sourceMetric: 'DATA_QUALITY_SCORE',
        deterministicReason: `Data quality score (${dataQuality.completenessScore}%) is below 40% threshold`
      });
    }

    return insights;
  }
}

if (typeof window !== 'undefined') {
  (window as any).WealthIntelligenceService = WealthIntelligenceService;
}
