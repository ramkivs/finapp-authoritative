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
