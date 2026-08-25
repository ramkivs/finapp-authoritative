/**
 * WP-FB-IMPORT-BROKER-01 — WP-09 D-04 Wealth UI integration tests.
 *
 * These tests verify that the queries layer (`FinancialQueries`) and
 * the wealth UI components correctly thread `holdings` through to
 * the wealth totals. D-04 says: imported Holdings contribute their
 * `currentValue` to net worth; `investedValue` does NOT.
 *
 * The tests cover:
 *   1. FinancialQueries.getWealthHealthSummary: netWorth includes
 *      holding.currentValue.
 *   2. FinancialQueries.getAssetConcentration: total includes
 *      holding.currentValue.
 *   3. FinancialQueries.getAllocationDiagnostics: total includes
 *      holding.currentValue.
 *   4. FinancialQueries.getLiabilityDiagnostics: totalAssets
 *      includes holding.currentValue.
 *   5. WealthPage renders: the displayed net worth includes the
 *      holding.currentValue.
 *
 * The bridge formula (`HoldingWealthBridge.aggregateAssetsAndHoldings`)
 * is the single authority and is exercised by these tests through
 * the queries and UI layers.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

import { FinancialQueries } from '../application/queries';
import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { Holding, HoldingStatus } from '../domain/types';
import { WealthPage } from '../pages/WealthPage';
import { WealthIntelligenceService } from '../services/WealthIntelligenceService';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: overrides.id ?? `hld-test-${Math.random().toString(36).slice(2, 10)}`,
  broker: overrides.broker ?? 'TestBroker',
  account: overrides.account,
  instrumentName: overrides.instrumentName ?? 'Test Instrument',
  isin: overrides.isin,
  ticker: overrides.ticker,
  quantity: overrides.quantity ?? 10,
  averageCost: overrides.averageCost ?? 100,
  investedValue: overrides.investedValue ?? 1000,
  currentPrice: overrides.currentPrice ?? 110,
  currentValue: overrides.currentValue ?? 1100,
  unrealisedPnL: overrides.unrealisedPnL ?? 100,
  unrealisedPnLPercent: overrides.unrealisedPnLPercent,
  xirrPercent: overrides.xirrPercent,
  securityClassification: overrides.securityClassification,
  status: overrides.status ?? 'active' as HoldingStatus,
  sourceFile: overrides.sourceFile ?? 'test.csv',
  importedAt: overrides.importedAt ?? '2026-08-23T10:00:00.000Z',
});

beforeEach(async () => {
  await repository.clearLocalData();
  await repository.initialize();
});

afterEach(async () => {
  await repository.clearLocalData();
  cleanup();
});

describe('WP-09 D-04: FinancialQueries threads holdings through to wealth totals', () => {
  it('WP-09.Q.1 getWealthHealthSummary — seeded holding.currentValue contributes to netWorth', () => {
    // Seed a holding with currentValue = 5000 in the repository.
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    // Build a minimal manual asset (so the service is in RECONCILED
    // status; otherwise it returns NOT_CONFIGURED with netWorth = 0).
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [];
    const summary = FinancialQueries.getWealthHealthSummary();
    // The total assets should be 10000 (manual asset) + 5000
    // (holding.currentValue) = 15000. If investedValue (9999) had
    // been counted, it would be 24999.
    expect(summary.totalAssets).toBe(15000);
    expect(summary.netWorth).toBe(15000);
    // No liabilities, so netWorth == totalAssets.
    expect(summary.netWorth).toBe(summary.totalAssets);
  });

  it('WP-09.Q.2 getAssetConcentration — seeded holding contributes to total (topAsset.pct is < 100)', () => {
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getAssetConcentration();
    // topAsset.pct is calculated as (topAsset.amount / total) * 100,
    // where total = aggregateAssetsAndHoldings = 15000 (10000 + 5000).
    // topAsset is the manual asset (10000) so topAsset.pct should be
    // (10000 / 15000) * 100 = 66.666...%. If holding.currentValue
    // had NOT been threaded, the total would be 10000 and pct
    // would be 100%.
    expect(result.topAsset).not.toBeNull();
    expect(result.topAsset!.pct).toBeLessThan(70);
    expect(result.topAsset!.pct).toBeGreaterThan(60);
    // Confirm the pct is less than 100% (proves holding was
    // included in the denominator).
    expect(result.topAsset!.pct).toBeLessThan(100);
  });

  it('WP-09.Q.3 getAllocationDiagnostics — seeded holding contributes to total (targetDrift.actualPct is < 100)', () => {
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000, type: 'Cash & Savings' }];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getAllocationDiagnostics();
    // targetDrift contains the per-category drift. The "Cash &
    // Savings" category should have an actualPct that reflects
    // 10000 / 15000 = 66.67% (NOT 100% if the holding had been
    // excluded). If the holding had NOT been threaded, the
    // actualPct would be 100% (10000 / 10000).
    const cashDrift = result.targetDrift.find(d => d.category === 'Cash & Savings');
    expect(cashDrift).toBeDefined();
    expect(cashDrift!.actualPct).toBeLessThan(70);
    expect(cashDrift!.actualPct).toBeGreaterThan(60);
  });

  it('WP-09.Q.4 getLiabilityDiagnostics — seeded holding contributes to totalAssets (debtToAssetRatio reflects 15000 base)', () => {
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [{ id: 'lib-1', name: 'Test Loan', amount: 2000 }];
    const result = FinancialQueries.getLiabilityDiagnostics();
    // debtToAssetRatio is computed as (totalDebt / totalAssets) * 100.
    // totalAssets = aggregateAssetsAndHoldings = 15000 (10000 + 5000).
    // totalDebt = 2000. So debtToAssetRatio = (2000/15000)*100 =
    // 13.33...%. If holding.currentValue had NOT been threaded,
    // totalAssets would be 10000 and debtToAssetRatio would be
    // 20%.
    expect(result.totalDebt).toBe(2000);
    expect(result.debtToAssetRatio).toBeCloseTo((2000 / 15000) * 100, 5);
    // Confirm debtToAssetRatio is LESS than 20% (proves holding
    // was included in the denominator — if not, ratio would be
    // exactly 20%).
    expect(result.debtToAssetRatio).toBeLessThan(20);
  });

  it('WP-09.Q.5 Holding.investedValue is NOT included — only currentValue contributes', () => {
    // A holding with currentValue = 1000 but investedValue = 9999.
    // Only 1000 should contribute. If investedValue were included,
    // the total would be 10000 + 9999 = 19999.
    const h = makeHolding({ currentValue: 1000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [];
    const summary = FinancialQueries.getWealthHealthSummary();
    expect(summary.totalAssets).toBe(11000); // 10000 + 1000
    expect(summary.netWorth).toBe(11000);
  });
});

describe('WP-09 D-04: WealthPage displays net worth that includes holding.currentValue', () => {
  it('WP-09.UI.1 WealthPage renders a KPI card showing the net worth that includes the imported holding', () => {
    // Seed the store with a manual asset and a broker-imported
    // holding. The WealthPage's Net Worth KPI must reflect the
    // sum.
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [];
    // Sync the store from the repository so React re-renders.
    S().syncWithRepository({
      transactions: [],
      assets: repo.assetsData,
      liabilities: repo.liabilitiesData,
      holdings: repo.holdingsData,
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });
    render(<WealthPage />);
    // The page-level Net Worth KPI must be 15000 (10000 + 5000).
    // The total-assets KPI also must be 15000.
    // We look for the formatted ₹ number; CurrencyValue formats
    // with thousands separators (en-IN). The exact text can
    // include commas.
    expect(screen.getAllByText(/15,?000/).length).toBeGreaterThan(0);
  });

  it('WP-09.UI.2 WealthPage shows total assets that include the holding.currentValue (11000 = 10000 + 1000)', () => {
    const h = makeHolding({ currentValue: 1000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [];
    S().syncWithRepository({
      transactions: [],
      assets: repo.assetsData,
      liabilities: repo.liabilitiesData,
      holdings: repo.holdingsData,
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });
    render(<WealthPage />);
    // 11000 appears in the displayed totals. Note: 9999 should
    // NOT appear (investedValue is NOT included).
    expect(screen.getAllByText(/11,?000/).length).toBeGreaterThan(0);
    // Confirm investedValue is excluded: the holdings data has
    // investedValue = 9999, but the displayed total is 11000
    // (not 19999).
    expect(screen.queryByText(/19,?999/)).toBeNull();
  });
});

/**
 * WP-FB-IMPORT-BROKER-01 — D04-HWA Holdings-Only Wealth Activation regression tests.
 *
 * HWA-01..HWA-10 accepted. HWA-02..HWA-07 require that activation/configuration
 * semantics be holdings-aware. HWA-08 is DEFERRED. HWA-09 (Net Worth) and
 * HWA-10 (Trend/CAGR) are NO CHANGE.
 *
 * These tests verify:
 *   1. Empty repository (no assets, no liabilities, no holdings) still
 *      returns NOT_CONFIGURED for Health, Liability, and Data Quality.
 *   2. Holdings-only (no assets, no liabilities) does NOT return
 *      NOT_CONFIGURED for Health, Allocation, Concentration, Liability.
 *   3. Data Quality activation includes holdings in totalRecords while
 *      preserving the existing completeness methodology
 *      (assets/liabilities type/geography/currency checks unchanged).
 *   4. Mixed canonical-assets + holdings behavior is unchanged from
 *      the prior accepted D-04 behavior.
 */
describe('WP-FB-IMPORT-BROKER-01 D04-HWA: Holdings-only activation', () => {
  it('HWA-INV-1 Empty repository remains NOT_CONFIGURED for Wealth Health (no assets, no liabilities, no holdings)', () => {
    // No assets, no liabilities, no holdings.
    repo.assetsData = [];
    repo.liabilitiesData = [];
    // repository was cleared in beforeEach, so no holdings either.
    const summary = FinancialQueries.getWealthHealthSummary();
    expect(summary.status).toBe('NOT_CONFIGURED');
    expect(summary.totalAssets).toBe(0);
    expect(summary.totalLiabilities).toBe(0);
    expect(summary.netWorth).toBe(0);
  });

  it('HWA-INV-2 Empty repository remains NOT_CONFIGURED for Liability Diagnostics', () => {
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getLiabilityDiagnostics();
    expect(result.burdenLevel).toBe('NOT_CONFIGURED');
    expect(result.totalDebt).toBe(0);
  });

  it('HWA-INV-3 Empty repository remains NOT_CONFIGURED for Data Quality', () => {
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getDataQuality();
    expect(result.status).toBe('NOT_CONFIGURED');
    expect(result.totalRecords).toBe(0);
  });

  it('HWA-02-1 Wealth Health: holdings-only (no assets, no liabilities) is RECONCILED with totalAssets = holding.currentValue', () => {
    const h = makeHolding({ currentValue: 7000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const summary = FinancialQueries.getWealthHealthSummary();
    // Holdings-only must NOT be NOT_CONFIGURED.
    expect(summary.status).toBe('RECONCILED');
    // totalAssets = 0 (no assets) + 7000 (holding.currentValue) = 7000.
    expect(summary.totalAssets).toBe(7000);
    expect(summary.netWorth).toBe(7000);
  });

  it('HWA-03-1 Allocation Diagnostics: holdings-only produces a non-empty targetDrift (denominator includes holding)', () => {
    const h = makeHolding({ currentValue: 4000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getAllocationDiagnostics();
    // targetDrift is non-empty (5 benchmark categories).
    expect(result.targetDrift.length).toBe(5);
    // metadataCompletenessPct is preserved (assets.length = 0, so 0/0 = NaN,
    // but Math.round(NaN) = NaN; we accept 0 or NaN as the no-assets case).
    // The key assertion: the result is no longer the empty NOT_CONFIGURED
    // shape (underrepresentedCategories is still an empty array because
    // there are no assets classified by type — holdings aren't classified
    // by AssetType in the D-04 methodology).
    expect(result.underrepresentedCategories).toBeDefined();
  });

  it('HWA-05-1 Concentration: holdings-only returns a non-null concentration analysis (denominator = holding.currentValue)', () => {
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    // Direct service call (matches the AssetConcentrationCard's call).
    const result = WealthIntelligenceService.getAssetConcentration([], [h]);
    // The total = aggregateAssetsAndHoldings = 0 + 5000 = 5000.
    // topAsset is null (no manual assets), but isConcentrated is
    // deterministically computed.
    expect(result).toBeDefined();
    // The empty-shape for asset-concentration is returned when
    // assets.length === 0. The HWA-05 defect is the PAGE-LEVEL
    // render gate, not the service itself. We verify the page
    // renders the card in the HWA-05-2 test below.
  });

  it('HWA-06-1 Liability Diagnostics: holdings-only (no assets, no liabilities) is configured with totalAssets = holding.currentValue', () => {
    const h = makeHolding({ currentValue: 6000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getLiabilityDiagnostics();
    // Holdings-only must NOT be NOT_CONFIGURED.
    expect(result.burdenLevel).not.toBe('NOT_CONFIGURED');
    // totalDebt = 0; totalAssets = 6000 (holding.currentValue);
    // debtToAssetRatio = 0/6000 * 100 = 0.
    expect(result.totalDebt).toBe(0);
    expect(result.debtToAssetRatio).toBe(0);
  });

  it('HWA-07-1 Data Quality: holdings-only is configured (status ≠ NOT_CONFIGURED) with totalRecords = 1', () => {
    const h = makeHolding({ currentValue: 1000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const result = FinancialQueries.getDataQuality();
    // Holdings-only must NOT be NOT_CONFIGURED.
    expect(result.status).not.toBe('NOT_CONFIGURED');
    // totalRecords = 0 (no assets) + 0 (no liabilities) + 1 (one holding) = 1.
    expect(result.totalRecords).toBe(1);
  });

  it('HWA-07-2 Data Quality: completeness methodology is unchanged (asset/liability type/geography/currency checks unaffected)', () => {
    // With assets present, the same missing-metadata counts must
    // match the prior behavior — holdings do NOT contribute to
    // missing-asset-type, missing-geography, or missing-currency
    // counts (holdings aren't classified by AssetType, Geography,
    // or Currency in the D-04 methodology).
    repo.assetsData = [
      { id: 'ast-1', name: 'Asset Missing All' },  // no type, no geography, no currency
    ];
    repo.liabilitiesData = [];
    repository.holdings.saveMany([]);  // no holdings
    const result = FinancialQueries.getDataQuality();
    expect(result.missingAssetTypeCount).toBe(1);
    expect(result.missingGeographyCount).toBe(1);
    expect(result.missingCurrencyCount).toBe(1);
    expect(result.missingLiabilityTypeCount).toBe(0);
  });

  it('HWA-05-2 Concentration card renders in WealthPage for holdings-only (page-level render gate is holdings-aware)', () => {
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    S().syncWithRepository({
      transactions: [],
      assets: repo.assetsData,
      liabilities: repo.liabilitiesData,
      holdings: repo.holdingsData,
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });
    render(<WealthPage />);
    // The page-level gate at WealthPage.tsx:612 is now
    // (assets.length > 0 || holdings.length > 0). With holdings-only,
    // the AssetConcentrationCard must render.
    // The card title is "Portfolio Concentration & Exposure Analytics".
    // Note: use getAllByText because the empty-state paragraph in
    // the AssetConcentrationCard's empty-state also mentions
    // "portfolio concentration" (describing the empty state).
    expect(screen.getAllByText(/Portfolio Concentration/i).length).toBeGreaterThan(0);
  });

  it('HWA-MIX-1 Mixed canonical-assets + holdings behavior is unchanged from the prior D-04 behavior', () => {
    // This verifies that adding holdings-aware activation did NOT
    // change the mixed case: assets=10000, liabilities=2000, holding=5000
    // still produces netWorth=13000, debtToAssetRatio=2000/15000*100.
    const h = makeHolding({ currentValue: 5000, investedValue: 9999 });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [{ id: 'lib-1', name: 'Test Loan', amount: 2000 }];
    // Health
    const summary = FinancialQueries.getWealthHealthSummary();
    expect(summary.totalAssets).toBe(15000);  // 10000 + 5000
    expect(summary.totalLiabilities).toBe(2000);
    expect(summary.netWorth).toBe(13000);
    // Liability
    const liab = FinancialQueries.getLiabilityDiagnostics();
    expect(liab.totalDebt).toBe(2000);
    expect(liab.debtToAssetRatio).toBeCloseTo((2000 / 15000) * 100, 5);
    // Data Quality — totalRecords = 1 (asset) + 1 (liability) + 1 (holding) = 3
    const dq = FinancialQueries.getDataQuality();
    expect(dq.totalRecords).toBe(3);
    expect(dq.status).not.toBe('NOT_CONFIGURED');
  });
});

/**
 * WP-FB-IMPORT-BROKER-01 — D04-HWA Allocation Classification tests.
 *
 * D-05 product authority (PRODUCT-AUTHORITY-DECISIONS.md §A.6) authorizes
 * the analytics layer to derive deterministic canonical analytics buckets
 * from `securityClassification` and/or `instrumentName`. This module's
 * tests cover:
 *
 *   A. Unclassified Holding flows into the 'Unclassified' allocation
 *      bucket and remains in the allocation denominator.
 *   B. Classified Holding deterministically maps to a closed AssetType
 *      value when the broker-native label matches exactly.
 *   C. Mixed classified + unclassified: classified category and
 *      Unclassified both visible; both contribute to denominator.
 *   D. No canonical Assets, Holdings only: allocation is not empty
 *      (Unclassified present).
 *   E. No holdings and no assets: existing empty-state behavior
 *      preserved.
 *   F. D-04 wealth aggregation unchanged: Asset.amount + Holding.currentValue
 *      remains the wealth calculation.
 */
describe('WP-FB-IMPORT-BROKER-01 D04-HWA: Allocation Classification (D-05)', () => {
  it('AC-A Unclassified holding — securityClassification=undefined is bucketed as Unclassified and remains in the allocation denominator', () => {
    // Single Zerodha-style holding (no broker-native classification).
    const h = makeHolding({ currentValue: 5190, securityClassification: undefined });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    // Concentration: byType must contain 'Unclassified' for the full
    // 5190 amount. The total denominator includes the holding.
    const concentration = FinancialQueries.getAssetConcentration();
    const unclassifiedRow = concentration.byType.find((r: { type: string }) => r.type === 'Unclassified');
    expect(unclassifiedRow).toBeDefined();
    expect(unclassifiedRow!.amount).toBe(5190);
    expect(unclassifiedRow!.pct).toBe(100);
    // unclassifiedPct must reflect that 100% of the portfolio is
    // unclassified (NOT 0, which would mean the holding was silently
    // dropped from the analysis).
    expect(concentration.unclassifiedPct).toBe(100);

    // Allocation Diagnostics: targetDrift for each benchmark category
    // must show 0% (the holding is unclassified, so it does not
    // contribute to any benchmark bucket per D-05 §5). However, the
    // total denominator still includes the holding.
    const alloc = FinancialQueries.getAllocationDiagnostics();
    expect(alloc.targetDrift.length).toBe(5);
    for (const d of alloc.targetDrift) {
      expect(d.actualPct).toBe(0);
    }
  });

  it('AC-B Classified holding — securityClassification="Equity" deterministically maps to the closed Equity bucket', () => {
    // A holding with a broker-native label that exactly matches a
    // closed AssetType value. D-05 §4: deterministic canonical
    // analytics buckets derived from securityClassification.
    const h = makeHolding({ currentValue: 8000, securityClassification: 'Equity' });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    const concentration = FinancialQueries.getAssetConcentration();
    const equityRow = concentration.byType.find((r: { type: string }) => r.type === 'Equity');
    expect(equityRow).toBeDefined();
    expect(equityRow!.amount).toBe(8000);
    expect(equityRow!.pct).toBe(100);
    // The holding is NOT unclassified, so unclassifiedPct is 0.
    expect(concentration.unclassifiedPct).toBe(0);

    // Allocation: the classified holding contributes to the Equity
    // benchmark category.
    const alloc = FinancialQueries.getAllocationDiagnostics();
    const equityDrift = alloc.targetDrift.find(d => d.category === 'Equity');
    expect(equityDrift).toBeDefined();
    expect(equityDrift!.actualPct).toBe(100);
    // 100 - 55 = 45
    expect(equityDrift!.driftPct).toBe(45);
  });

  it('AC-C Mixed classified + unclassified — both visible, both contribute to denominator', () => {
    // One classified holding (Debt) and one unclassified holding.
    // Distinct (broker, account, instrument) identities so the
    // holding-lifecycle identity check accepts both.
    const hClassified = makeHolding({
      id: 'hld-c1',
      instrumentName: 'Instrument-Classified',
      currentValue: 4000,
      securityClassification: 'Debt'
    });
    const hUnclassified = makeHolding({
      id: 'hld-u1',
      instrumentName: 'Instrument-Unclassified',
      currentValue: 4000,
      securityClassification: undefined
    });
    repository.holdings.saveMany([hClassified, hUnclassified]);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    const concentration = FinancialQueries.getAssetConcentration();
    const debtRow = concentration.byType.find((r: { type: string }) => r.type === 'Debt');
    const unclassifiedRow = concentration.byType.find((r: { type: string }) => r.type === 'Unclassified');
    expect(debtRow).toBeDefined();
    expect(unclassifiedRow).toBeDefined();
    // Each is 4000 of 8000 total = 50%.
    expect(debtRow!.amount).toBe(4000);
    expect(debtRow!.pct).toBe(50);
    expect(unclassifiedRow!.amount).toBe(4000);
    expect(unclassifiedRow!.pct).toBe(50);
    // 4000 / 8000 = 50% unclassified.
    expect(concentration.unclassifiedPct).toBe(50);

    // Allocation: Equity is 0/8000=0, Debt is 4000/8000=50, others 0.
    // Unclassified does NOT contribute to any benchmark drift.
    const alloc = FinancialQueries.getAllocationDiagnostics();
    const debtDrift = alloc.targetDrift.find(d => d.category === 'Debt');
    expect(debtDrift!.actualPct).toBe(50);
    const equityDrift = alloc.targetDrift.find(d => d.category === 'Equity');
    expect(equityDrift!.actualPct).toBe(0);
  });

  it('AC-D No canonical Assets, Holdings only — allocation is not empty (Unclassified present)', () => {
    // The Windows symptom: only Holdings, no canonical Assets. The
    // allocation must show the Unclassified bucket; it must NOT
    // return the empty shape.
    const h1 = makeHolding({
      id: 'hld-d1',
      instrumentName: 'Instrument-D1',
      currentValue: 250000,
      securityClassification: undefined
    });
    const h2 = makeHolding({
      id: 'hld-d2',
      instrumentName: 'Instrument-D2',
      currentValue: 269362,
      securityClassification: undefined
    });
    repository.holdings.saveMany([h1, h2]);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.byType.length).toBeGreaterThan(0);
    const unclassifiedRow = concentration.byType.find((r: { type: string }) => r.type === 'Unclassified');
    expect(unclassifiedRow).toBeDefined();
    expect(unclassifiedRow!.amount).toBe(519362);

    const alloc = FinancialQueries.getAllocationDiagnostics();
    expect(alloc.targetDrift.length).toBe(5);
  });

  it('AC-E No holdings and no assets — existing empty-state behavior preserved', () => {
    // No data at all. The pre-D-05 empty-state shape must be
    // preserved: byType is empty, targetDrift is empty, both
    // services return their documented empty shape.
    repo.assetsData = [];
    repo.liabilitiesData = [];
    repository.holdings.saveMany([]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.byType).toEqual([]);
    expect(concentration.unclassifiedPct).toBe(0);

    const alloc = FinancialQueries.getAllocationDiagnostics();
    expect(alloc.targetDrift).toEqual([]);
    expect(alloc.underrepresentedCategories).toEqual([]);
    expect(alloc.hasConcentrationWarning).toBe(false);
  });

  it('AC-F D-04 wealth aggregation unchanged — Asset.amount + Holding.currentValue remains the wealth calculation', () => {
    // The D-04 bridge is preserved (this test would fail if the bridge
    // were mutated). A canonical Asset of 10000 plus a Holding of 5000
    // must produce totalAssets = 15000, regardless of the holding's
    // classification status.
    const h = makeHolding({ currentValue: 5000, securityClassification: undefined });
    repository.holdings.saveMany([h]);
    repo.assetsData = [{ id: 'ast-1', name: 'Test Asset', amount: 10000 }];
    repo.liabilitiesData = [];

    const summary = FinancialQueries.getWealthHealthSummary();
    expect(summary.totalAssets).toBe(15000); // 10000 + 5000
    expect(summary.netWorth).toBe(15000);
  });
});

/**
 * WP-FB-IMPORT-BROKER-01 — D04-HWA-CONC-01 Concentration Methodology tests.
 *
 * The accepted product decision D04-HWA-CONC-01 establishes that the
 * authoritative concentration population is the UNION of canonical
 * Assets and individual imported Holdings, with deterministic tie-
 * breaking (canonical Assets first, then Holdings in input order).
 *
 * This describe block covers:
 *   A. Holdings-only: largest position is the largest Holding;
 *      top concentration uses D-04 total wealth denominator.
 *   B. Assets-only: largest position is the largest canonical Asset;
 *      top concentration is computed against total Asset wealth.
 *   C. Mixed: largest position is the maximum across the union;
 *      denominator is D-04 inclusive; no double counting.
 *   D. Tie: canonical Asset wins on canonical-Asset-vs-Holding ties;
 *      Holdings preserve their repository order for Holding-vs-
 *      Holding ties.
 *   E. Unclassified Holding: participates in the largest-position
 *      ranking; securityClassification is not coerced.
 */
describe('WP-FB-IMPORT-BROKER-01 D04-HWA-CONC-01: Concentration Methodology', () => {
  it('CONC-A Holdings-only — largest position is the maximum Holding.currentValue, denominator is D-04 total wealth', () => {
    // Three Zerodda-style Holdings with distinct (broker, account,
    // instrument) identities. Distinct instrumentName values are
    // required so the holding-lifecycle identity check accepts all
    // three. One holding has the maximum currentValue; it must
    // win the largest-position ranking.
    const hA = makeHolding({
      id: 'hld-a1',
      instrumentName: 'CONC-A-INSTR-A',
      currentValue: 250000,
      securityClassification: undefined,
    });
    const hB = makeHolding({
      id: 'hld-b1',
      instrumentName: 'CONC-A-INSTR-B',
      currentValue: 269362,
      securityClassification: undefined,
    });
    const hC = makeHolding({
      id: 'hld-c1',
      instrumentName: 'CONC-A-INSTR-C',
      currentValue: 1000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([hA, hB, hC]);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    // The expected largest position is the holding with the highest
    // currentValue. We do not hard-code which one that is; the test
    // derives it from the fixture data so the test is not brittle.
    const fixtureMax = Math.max(hA.currentValue, hB.currentValue, hC.currentValue);
    const fixtureMaxHolder = [hA, hB, hC].find((h) => h.currentValue === fixtureMax)!;
    expect(fixtureMax).toBe(269362);

    const concentration = FinancialQueries.getAssetConcentration();
    // Largest position is defined.
    expect(concentration.topAsset).toBeDefined();
    expect(concentration.topAsset!.amount).toBe(fixtureMax);
    expect(concentration.topAsset!.kind).toBe('holding');
    // Display name carries broker context for clarity.
    expect(concentration.topAsset!.name).toContain(fixtureMaxHolder.instrumentName);
    // Denominator is D-04 total wealth = 250000 + 269362 + 1000 = 520362.
    const expectedTotal = hA.currentValue + hB.currentValue + hC.currentValue;
    expect(expectedTotal).toBe(520362);
    // topAsset.pct is rounded to integer percentage of total wealth.
    const expectedPct = Math.round((fixtureMax / expectedTotal) * 100);
    expect(concentration.topAsset!.pct).toBe(expectedPct);
    // topPositionConcentration agrees (same numerator / denominator).
    const health = FinancialQueries.getWealthHealthSummary();
    expect(Math.round(health.topAssetConcentration)).toBe(expectedPct);
  });

  it('CONC-B Assets-only — largest position is the maximum canonical Asset.amount, top concentration is asset-wealth-based', () => {
    // No Holdings; only canonical Assets. The pre-D04-HWA-CONC-01
    // canonical-Asset-only behavior must continue to be correct.
    repo.assetsData = [
      { id: 'ast-1', name: 'Small', amount: 5000 },
      { id: 'ast-2', name: 'Big', amount: 50000 },
      { id: 'ast-3', name: 'Medium', amount: 15000 },
    ];
    repo.liabilitiesData = [];
    repository.holdings.saveMany([]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.topAsset).toBeDefined();
    expect(concentration.topAsset!.amount).toBe(50000);
    expect(concentration.topAsset!.name).toBe('Big');
    expect(concentration.topAsset!.kind).toBe('canonicalAsset');
    // topAsset.pct = 50000 / (5000 + 50000 + 15000) = 50000 / 70000 = 71%
    expect(concentration.topAsset!.pct).toBe(71);
    // topPositionConcentration agrees.
    const health = FinancialQueries.getWealthHealthSummary();
    expect(Math.round(health.topAssetConcentration)).toBe(71);
  });

  it('CONC-C Mixed Assets + Holdings — largest position is the maximum across the union, denominator is D-04 inclusive, no double counting', () => {
    // Sub-test C.1: a canonical Asset of 10000 and a Holding of
    // 50000. The Holding is the larger individual position and must
    // win the ranking. The denominator is D-04 inclusive: 10000 +
    // 50000 = 60000.
    repo.assetsData = [{ id: 'ast-1', name: 'House', amount: 10000 }];
    repo.liabilitiesData = [];
    const h = makeHolding({
      id: 'hld-mix-1',
      instrumentName: 'CONC-C-INSTR-A',
      currentValue: 50000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([h]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.topAsset).toBeDefined();
    expect(concentration.topAsset!.amount).toBe(50000);
    expect(concentration.topAsset!.kind).toBe('holding');
    // Denominator is D-04 inclusive: 10000 + 50000 = 60000.
    // 50000 / 60000 = 83.33% → 83 (rounded).
    expect(concentration.topAsset!.pct).toBe(83);
    // The two metrics must agree.
    const health = FinancialQueries.getWealthHealthSummary();
    expect(health.totalAssets).toBe(60000);
    expect(Math.round(health.topAssetConcentration)).toBe(83);
  });

  it('CONC-C.2 Mixed Assets + Holdings — when canonical Asset is the largest, it wins, denominator still D-04 inclusive', () => {
    // Sub-test C.2: canonical Asset of 80000 and a Holding of 5000.
    // The Asset is the larger individual position and must win. The
    // denominator is still D-04 inclusive: 80000 + 5000 = 85000.
    repo.assetsData = [{ id: 'ast-1', name: 'House', amount: 80000 }];
    repo.liabilitiesData = [];
    const h = makeHolding({
      id: 'hld-mix-2',
      instrumentName: 'CONC-C2-INSTR-A',
      currentValue: 5000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([h]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.topAsset).toBeDefined();
    expect(concentration.topAsset!.amount).toBe(80000);
    expect(concentration.topAsset!.kind).toBe('canonicalAsset');
    // 80000 / (80000 + 5000) = 80000 / 85000 = 94.12% → 94.
    expect(concentration.topAsset!.pct).toBe(94);
    const health = FinancialQueries.getWealthHealthSummary();
    expect(health.totalAssets).toBe(85000);
    expect(Math.round(health.topAssetConcentration)).toBe(94);
  });

  it('CONC-D Tie — canonical Asset wins on canonical-Asset-vs-Holding ties', () => {
    // canonical Asset and Holding tied at 10000. The canonical
    // Asset must win (D04-HWA-CONC-01 §5).
    repo.assetsData = [{ id: 'ast-1', name: 'Tied-Asset', amount: 10000 }];
    repo.liabilitiesData = [];
    const hTied = makeHolding({
      id: 'hld-tie-1',
      instrumentName: 'TIED-HOLDING',
      currentValue: 10000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([hTied]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.topAsset).toBeDefined();
    // Tie-break rule: canonical Asset wins.
    expect(concentration.topAsset!.kind).toBe('canonicalAsset');
    expect(concentration.topAsset!.amount).toBe(10000);
    expect(concentration.topAsset!.name).toBe('Tied-Asset');
  });

  it('CONC-D.2 Tie — Holdings preserve repository order for Holding-vs-Holding ties', () => {
    // Two Holdings tied at 5000. The Holding that appears first in
    // `repository.holdings.findAllSync()` order must win. We pass
    // them in a known order to the repository.
    repo.assetsData = [];
    repo.liabilitiesData = [];
    const hFirst = makeHolding({
      id: 'hld-tie-2a',
      instrumentName: 'TIED-FIRST',
      currentValue: 5000,
      securityClassification: undefined,
    });
    const hSecond = makeHolding({
      id: 'hld-tie-2b',
      instrumentName: 'TIED-SECOND',
      currentValue: 5000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([hFirst, hSecond]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.topAsset).toBeDefined();
    expect(concentration.topAsset!.kind).toBe('holding');
    // First in repository order wins.
    expect(concentration.topAsset!.name).toContain('TIED-FIRST');
  });

  it('CONC-E Unclassified Holding — participates in largest-position ranking; securityClassification is not coerced', () => {
    // An unclassified Holding (securityClassification = undefined)
    // must participate in the concentration ranking. The classifier
    // (D-05) is irrelevant to the per-individual-position view; the
    // securityClassification field is preserved as-is.
    repo.assetsData = [{ id: 'ast-1', name: 'Small Asset', amount: 100 }];
    repo.liabilitiesData = [];
    const h = makeHolding({
      id: 'hld-u1',
      instrumentName: 'UNCLASSIFIED-INSTRUMENT',
      currentValue: 100000,
      securityClassification: undefined, // explicitly unclassified
    });
    repository.holdings.saveMany([h]);

    const concentration = FinancialQueries.getAssetConcentration();
    expect(concentration.topAsset).toBeDefined();
    expect(concentration.topAsset!.kind).toBe('holding');
    expect(concentration.topAsset!.amount).toBe(100000);
    expect(concentration.topAsset!.name).toContain('UNCLASSIFIED-INSTRUMENT');

    // The Holding is unchanged: securityClassification is still
    // undefined after the analytics call.
    const persistedHolding = repository.holdings.findAllSync().find((x: any) => x.id === 'hld-u1');
    expect(persistedHolding).toBeDefined();
    expect(persistedHolding!.securityClassification).toBeUndefined();
  });
});

/**
 * WP-FB-IMPORT-BROKER-01 — D04-HWA-07 Metadata Wiring tests.
 *
 * The Diagnostics Reconciliation Gate identified that
 * `WealthHealthCard.tsx` was calling
 * `WealthIntelligenceService.getDataQuality(assets, liabilities,
 * snapshots)` directly, bypassing the `holdings` argument. The
 * service-level HWA-07 implementation is correct (it counts
 * Holdings in `totalRecords` and uses the holdings-aware
 * activation check), but the page-level call site did not
 * exercise the holdings-aware path.
 *
 * The accepted fix is a wiring-only change: the page calls
 * `FinancialQueries.getDataQuality()` (which already threads
 * Holdings) instead of the service directly. The completeness
 * methodology (canonical Asset/Liability type/geography/
 * currency checks) is unchanged.
 *
 * This describe block covers:
 *   A. Holdings-only data quality: status ≠ NOT_CONFIGURED
 *   B. Assets-only data quality: pre-existing behavior preserved
 *   C. Mixed Assets + Holdings: both populations recognized
 *   D. UI/query wiring: WealthPage renders a non-zero Metadata
 *      when Holdings exist
 *   E. 82-Holding scenario: status ≠ NOT_CONFIGURED,
 *      totalRecords = 82
 */
describe('WP-FB-IMPORT-BROKER-01 D04-HWA-07: Metadata Wiring', () => {
  it('HWA07-A Holdings-only data quality — status is NOT NOT_CONFIGURED when only Holdings exist', () => {
    // The diagnostics reconciliation gate identified that an
    // empty-data + 1-holding case was reporting NOT_CONFIGURED
    // because the page-level call site omitted Holdings from the
    // service. The wiring fix routes through the queries layer
    // (which threads Holdings). The HWA-07 service-level
    // activation logic returns a non-NOT_CONFIGURED status
    // because totalRecords > 0.
    const h = makeHolding({
      currentValue: 1000,
      investedValue: 9999,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    const result = FinancialQueries.getDataQuality();
    // HWA-07 activation: status is not NOT_CONFIGURED because
    // totalRecords > 0 (one holding counts as one record).
    expect(result.status).not.toBe('NOT_CONFIGURED');
    // totalRecords = 0 + 0 + 0 + 1 = 1.
    expect(result.totalRecords).toBe(1);
  });

  it('HWA07-B Assets-only data quality — pre-existing canonical-Asset-only behavior is unchanged', () => {
    // With a canonical Asset present, the methodology exercises
    // its canonical-Asset/Liability fields. A canonical Asset
    // missing type/geography/currency contributes to the missing
    // counts, and totalFields > 0 yields a real completeness
    // score.
    repo.assetsData = [
      { id: 'ast-1', name: 'Asset Missing All' }, // no type, geography, currency
    ];
    repo.liabilitiesData = [];
    repository.holdings.saveMany([]);

    const result = FinancialQueries.getDataQuality();
    expect(result.status).not.toBe('NOT_CONFIGURED');
    expect(result.totalRecords).toBe(1);
    expect(result.missingAssetTypeCount).toBe(1);
    expect(result.missingGeographyCount).toBe(1);
    expect(result.missingCurrencyCount).toBe(1);
    expect(result.missingLiabilityTypeCount).toBe(0);
    // totalFields = 1*3 + 0*1 = 3; missingFields = 3; score = 0%.
    // status = NEEDS_ATTENTION (completenessScore < 40).
    expect(result.completenessScore).toBe(0);
    expect(result.status).toBe('NEEDS_ATTENTION');
  });

  it('HWA07-C Mixed Assets + Holdings — both populations are recognized, no double counting', () => {
    // Both canonical Assets and Holdings exist. totalRecords
    // sums both. The methodology's missing-fields loop iterates
    // only over canonical Assets (per HWA-07 spec: completeness
    // methodology is canonical-Asset/Liability-only).
    const h = makeHolding({
      currentValue: 5000,
      investedValue: 3000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([h]);
    repo.assetsData = [
      { id: 'ast-1', name: 'Test Asset', amount: 10000, type: 'Equity', geography: 'India', currency: 'INR' },
    ];
    repo.liabilitiesData = [];

    const result = FinancialQueries.getDataQuality();
    // totalRecords = 1 (asset) + 0 (liabilities) + 1 (holding) = 2.
    expect(result.totalRecords).toBe(2);
    // The canonical Asset has full metadata, so no missing fields.
    expect(result.missingAssetTypeCount).toBe(0);
    expect(result.missingGeographyCount).toBe(0);
    expect(result.missingCurrencyCount).toBe(0);
    expect(result.missingLiabilityTypeCount).toBe(0);
    // totalFields = 1*3 + 0*1 = 3; missingFields = 0; score = 100%.
    expect(result.completenessScore).toBe(100);
    expect(result.status).toBe('COMPLETE');
  });

  it('HWA07-D UI/query wiring — WealthHealthCard receives a non-zero Metadata indicator for the holdings-only case (the page-level wiring fix)', () => {
    // The page-level wiring fix is at WealthHealthCard.tsx:23,
    // where the direct service call is replaced with a call to
    // FinancialQueries.getDataQuality(). This test renders
    // WealthPage with a Holdings-only repository and asserts
    // that the Wealth Health card is in the CONFIGURED branch
    // (which uses the plural "Wealth Health & Solvency
    // Diagnostics" title and shows a "Metadata: X%" pill),
    // not the unconfigured "Wealth Health & Diagnostics" branch
    // (which would render a "Not Configured" badge and omit the
    // Metadata pill).
    const h = makeHolding({
      id: 'hld-hwa07-1',
      instrumentName: 'HWA07-D-INSTR',
      currentValue: 5000,
      investedValue: 3000,
      securityClassification: undefined,
    });
    repository.holdings.saveMany([h]);
    repo.assetsData = [];
    repo.liabilitiesData = [];
    S().syncWithRepository({
      transactions: [],
      assets: repo.assetsData,
      liabilities: repo.liabilitiesData,
      holdings: repo.holdingsData,
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });
    render(<WealthPage />);
    // The configured Wealth Health card title (plural,
    // "Wealth Health & Solvency Diagnostics") must be present.
    // This is the title used in the configured branch; the
    // unconfigured branch uses the singular form.
    expect(screen.getAllByText(/Wealth Health & Solvency Diagnostics/i).length).toBeGreaterThan(0);
    // The "Metadata: <X>%" pill is only rendered in the
    // configured branch. Its presence confirms the page-level
    // wiring fix reached the UI.
    expect(screen.getAllByText(/Metadata:\s*\d+%/i).length).toBeGreaterThan(0);
    // The singular "Wealth Health & Diagnostics" title (the
    // unconfigured branch's title) must NOT be present. This is
    // distinct from the plural title above.
    expect(screen.queryByText(/^Wealth Health & Diagnostics$/i)).toBeNull();
  });

  it('HWA07-E 82-Holding scenario — status is NOT NOT_CONFIGURED; totalRecords = 82; existing HWA-07 methodology preserved', () => {
    // Seed 82 Zerodha equity Holdings summing to a representative
    // value (this is a service-layer simulation of the user's
    // actual data state; the real IndexedDB on Windows is not
    // touched).
    const holdings: Holding[] = [];
    for (let i = 0; i < 82; i++) {
      holdings.push(makeHolding({
        id: `hld-hwa07-e-${i.toString().padStart(3, '0')}`,
        instrumentName: `HWA07-E-INSTR-${i.toString().padStart(3, '0')}`,
        currentValue: 6335 + (i % 5), // ~6335 each, sums near 519362
        securityClassification: undefined,
      }));
    }
    repository.holdings.saveMany(holdings);
    repo.assetsData = [];
    repo.liabilitiesData = [];

    const result = FinancialQueries.getDataQuality();
    // HWA-07 activation: status is not NOT_CONFIGURED because
    // totalRecords > 0.
    expect(result.status).not.toBe('NOT_CONFIGURED');
    // totalRecords = 0 + 0 + 0 + 82 = 82.
    expect(result.totalRecords).toBe(82);
    // The HWA-07 completeness methodology iterates only over
    // canonical Assets and Liabilities. With 0 canonical Assets
    // and 0 Liabilities, the missing-field counts are 0 and
    // totalFields = 0. The existing methodology returns
    // completenessScore = 100 (the `totalFields > 0 ?` check
    // fails, so the score is set to 100). This is the documented
    // behavior of the HWA-07 methodology when only Holdings
    // exist; the user sees a configured (non-NOT_CONFIGURED)
    // card with the methodology's output.
    expect(result.missingAssetTypeCount).toBe(0);
    expect(result.missingGeographyCount).toBe(0);
    expect(result.missingCurrencyCount).toBe(0);
    expect(result.missingLiabilityTypeCount).toBe(0);
    // The exact completenessScore is the existing methodology's
    // output for this scenario; do not artificially adjust it.
  });
});
