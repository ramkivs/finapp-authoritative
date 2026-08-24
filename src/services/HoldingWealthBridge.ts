/**
 * WP-FB-IMPORT-BROKER-01 — D-04 Wealth integration.
 *
 * Authority decision: imported Holdings contribute their `currentValue` to
 * Wealth / net worth. `investedValue` does NOT independently contribute.
 *
 * This module is the single authority on the net-worth sum. The 7 historical
 * sites in WealthIntelligenceService / FinancialMetricService / useCanonicalLedger
 * that previously did `assets.reduce((s, a) => s + a.amount, 0)` are updated
 * to call `aggregateAssetsAndHoldings(assets, holdings)` instead.
 *
 * Manual non-broker Assets (e.g. "my house") and imported Holdings coexist
 * freely; the aggregation simply sums both contributions.
 */

import { Asset, Holding } from '../domain/types';

export class HoldingWealthBridge {
  /**
   * Authority rule:
   *   Wealth = Σ Asset.amount + Σ Holding.currentValue
   *
   * investedValue is intentionally NOT included (D-04).
   */
  static aggregateAssetsAndHoldings(
    assets: readonly Asset[],
    holdings: readonly Holding[],
  ): number {
    const assetsSum = assets.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const holdingsSum = holdings.reduce((s, h) => s + (Number(h.currentValue) || 0), 0);
    return assetsSum + holdingsSum;
  }
}
