import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { repository } from '../repositories';
import { MemoryRepository } from '../repositories/MemoryRepository';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialQueries } from '../application/queries';
import { FinancialCommands } from '../application/commands';
import { WealthIntelligenceService } from '../services/WealthIntelligenceService';
import { FinancialMetricService } from '../services/FinancialMetricService';
import { classifyHolding } from '../services/HoldingAnalyticsClassifier';
import { AssetLifecycleError } from '../services/AssetLifecycleService';
import { Sidebar } from '../components/Sidebar';
import { OverviewPage } from '../pages/OverviewPage';
import { WealthPage } from '../pages/WealthPage';
import { EssentialsPage } from '../pages/EssentialsPage';
import { AddAssetModal } from '../components/wealth/AddAssetModal';
import type { Asset, Holding, Liability, Transaction } from '../domain/types';

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: overrides.id ?? 'hld-zerodha-1',
    broker: overrides.broker ?? 'Zerodha',
    account: overrides.account ?? 'ZR0001',
    instrumentName: overrides.instrumentName ?? 'Infosys Limited',
    ticker: overrides.ticker ?? 'INFY',
    isin: overrides.isin ?? 'INE009A01021',
    productScope: overrides.productScope ?? 'EQUITY',
    quantity: overrides.quantity ?? 1000,
    averageCost: overrides.averageCost ?? 2000,
    investedValue: overrides.investedValue ?? 2_000_000,
    currentPrice: overrides.currentPrice ?? 2500,
    currentValue: overrides.currentValue ?? 2_500_000,
    unrealisedPnL: overrides.unrealisedPnL ?? 500_000,
    sourceFile: overrides.sourceFile ?? 'zerodha_holdings.csv',
    importedAt: overrides.importedAt ?? '2026-08-20T10:00:00.000Z',
    status: overrides.status ?? 'active',
    ...overrides,
  };
}

async function resetCanonicalEnvironment(): Promise<void> {
  await IndexedDBStorageService.clearAll();
  await repository.initialize();
  useCanonicalLedger.setState({
    transactions: [],
    assets: [],
    liabilities: [],
    holdings: [],
    holdingDeletionLog: [],
    snapshots: [],
    accounts: [],
    budgets: [],
    policies: [],
    goals: [],
    profile: null,
  } as any);
}

describe('Batch 3 — Step 5: Protect Personal Holdings in Storage and Demo Safeguards (DEF-05, DEF-21a)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetCanonicalEnvironment();
  });

  it('DEF-05 Acceptance: Seed IndexedDB with 1 Holding and 0 records in the other 9 collections -> Load Demo Data is refused before mutation and Holding survives reinitialisation', async () => {
    const seededHolding = makeHolding({
      id: 'hld-seed-only-1',
      broker: 'Zerodha',
      instrumentName: 'Reliance Industries',
      ticker: 'RELIANCE',
      isin: 'INE002A01018',
      currentValue: 400_000,
    });

    await IndexedDBStorageService.saveAll({
      transactions: [],
      assets: [],
      liabilities: [],
      holdings: [seededHolding],
      holdingDeletionLog: [],
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });

    await useCanonicalLedger.getState().initialize();
    expect(useCanonicalLedger.getState().holdings).toHaveLength(1);
    expect(useCanonicalLedger.getState().assets).toHaveLength(0);
    expect(useCanonicalLedger.getState().transactions).toHaveLength(0);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<Sidebar activeTab="overview" setActiveTab={() => {}} />);

    fireEvent.click(container.querySelector('#btn-load-demo-data')!);

    await waitFor(() => {
      const notice = container.querySelector('#devtools-notice');
      expect(notice).toBeTruthy();
      expect(notice?.getAttribute('data-devtools-kind')).toBe('error');
      expect(notice?.textContent).toContain('Demo data was not loaded.');
      expect(notice?.textContent).toContain('holdings');
    });

    // Refused before any destructive prompt or mutation
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useCanonicalLedger.getState().holdings).toHaveLength(1);
    expect(useCanonicalLedger.getState().holdings[0].id).toBe('hld-seed-only-1');
    expect(useCanonicalLedger.getState().transactions).toHaveLength(0);

    // Reinitialise from IndexedDB and verify the Holding remains intact in both memory and IndexedDB
    await useCanonicalLedger.getState().initialize();
    expect(useCanonicalLedger.getState().holdings).toHaveLength(1);
    expect(useCanonicalLedger.getState().holdings[0]).toEqual(seededHolding);

    const reloaded = await IndexedDBStorageService.loadAll();
    expect(reloaded.holdings).toHaveLength(1);
    expect(reloaded.holdings?.[0]).toEqual(seededHolding);
    expect(reloaded.transactions).toHaveLength(0);
    expect(reloaded.assets).toHaveLength(0);
  });

  it('DEF-05 Acceptance: Seed IndexedDB with 1 holdingDeletionLog entry and 0 records in all other collections -> Load Demo Data is refused and deletion log survives reinitialisation', async () => {
    const deletionEntry = {
      id: 'hdl-seed-only-1',
      holdingId: 'hld-old-1',
      broker: 'Groww',
      instrumentName: 'Axis Bluechip Fund',
      currentValueAtDeletion: 150_000,
      sourceFile: 'groww_mf.xlsx',
      importedAt: '2026-08-10T10:00:00.000Z',
      deletedAt: '2026-08-12T10:00:00.000Z',
      note: 'User removed closed position',
    };

    await IndexedDBStorageService.saveAll({
      transactions: [],
      assets: [],
      liabilities: [],
      holdings: [],
      holdingDeletionLog: [deletionEntry],
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });

    await useCanonicalLedger.getState().initialize();
    expect(useCanonicalLedger.getState().holdingDeletionLog).toHaveLength(1);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<Sidebar activeTab="overview" setActiveTab={() => {}} />);

    fireEvent.click(container.querySelector('#btn-load-demo-data')!);

    await waitFor(() => {
      const notice = container.querySelector('#devtools-notice');
      expect(notice).toBeTruthy();
      expect(notice?.getAttribute('data-devtools-kind')).toBe('error');
      expect(notice?.textContent).toContain('holding deletion log');
    });

    expect(confirmSpy).not.toHaveBeenCalled();

    await useCanonicalLedger.getState().initialize();
    expect(useCanonicalLedger.getState().holdingDeletionLog).toEqual([deletionEntry]);

    const reloaded = await IndexedDBStorageService.loadAll();
    expect(reloaded.holdingDeletionLog).toEqual([deletionEntry]);
  });

  it('DEF-21a: MemoryHoldingDeletionLogRepository returns current copied data across commitHoldingDeletion, initialize, and caller array/object mutation', async () => {
    const h = makeHolding({
      id: 'hld-del-sync-1',
      instrumentName: 'TCS Limited',
      ticker: 'TCS',
      status: 'closed_absent',
    });
    await repository.holdings.add(h);
    useCanonicalLedger.setState({ holdings: repository.holdings.findAllSync() } as any);
    expect(repository.holdingDeletionLog.findAllSync()).toEqual([]);

    const outcome = useCanonicalLedger.getState().commitHoldingDeletion('hld-del-sync-1');
    if (outcome.persisted) {
      await outcome.persisted;
    }
    const { auditEntryId } = outcome;

    // Live visibility through repository.holdingDeletionLog (previously broken due to detached array ref)
    const syncList = repository.holdingDeletionLog.findAllSync();
    expect(syncList).toHaveLength(1);
    expect(syncList[0].id).toBe(auditEntryId);
    expect(syncList[0].holdingId).toBe('hld-del-sync-1');
    expect(syncList[0].instrumentName).toBe('TCS Limited');

    const asyncList = await repository.holdingDeletionLog.findAll();
    expect(asyncList).toEqual(syncList);

    const foundById = repository.holdingDeletionLog.findByIdSync(auditEntryId);
    expect(foundById?.instrumentName).toBe('TCS Limited');

    // Mutating returned array and entry must NOT corrupt internal repository state
    syncList[0].broker = 'CORRUPTED_BROKER';
    syncList.push({
      id: 'hdl-injected',
      holdingId: 'hld-x',
      broker: 'Fake',
      instrumentName: 'Fake',
      currentValueAtDeletion: 0,
      sourceFile: 'x',
      importedAt: '2026-08-01',
      deletedAt: '2026-08-02',
    });

    const freshList = repository.holdingDeletionLog.findAllSync();
    expect(freshList).toHaveLength(1);
    expect(freshList[0].broker).toBe('Zerodha');

    // Fresh repository reinitialised from storage also sees current deletion log via findAllSync()
    const reloadedRepo = new MemoryRepository();
    await reloadedRepo.initialize();
    expect(reloadedRepo.holdingDeletionLog.findAllSync()).toHaveLength(1);
    expect(reloadedRepo.holdingDeletionLog.findAllSync()[0].id).toBe(auditEntryId);
  });
});

describe('Batch 3 — Step 6: Unify Holdings Valuation, Classification and Collision Prevention (DEF-08, DEF-10, DEF-11, DEF-12)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetCanonicalEnvironment();
  });

  async function seedAcceptancePortfolio(): Promise<{
    manualAsset: Asset;
    zerodhaEquityHolding: Holding;
    growwMfHolding: Holding;
    liability: Liability;
  }> {
    // ₹10L manual assets (India / INR)
    await useCanonicalLedger.getState().addAssetWithMetadata({
      name: 'HDFC Savings Reserve',
      amount: 1_000_000,
      type: 'Cash & Savings',
      geography: 'India',
      currency: 'INR',
    });
    const manualAsset = repository.assets.findAllSync()[0];

    // ₹40L imported holdings: ₹25L Zerodha Equity + ₹15L Groww Debt MF (lowercase category)
    const zerodhaEquityHolding = makeHolding({
      id: 'hld-zerodha-eq',
      broker: 'Zerodha',
      account: 'ZR1234',
      instrumentName: 'Infosys Limited',
      ticker: 'INFY',
      isin: 'INE009A01021',
      productScope: 'EQUITY',
      securityClassification: undefined,
      quantity: 1000,
      averageCost: 2000,
      investedValue: 2_000_000,
      currentPrice: 2500,
      currentValue: 2_500_000,
      unrealisedPnL: 500_000,
    });

    const growwMfHolding = makeHolding({
      id: 'hld-groww-mf',
      broker: 'Groww',
      account: 'GW9999',
      instrumentName: 'HDFC Liquid Direct Plan Growth',
      ticker: undefined,
      isin: 'INF179KB1HP9',
      productScope: 'MUTUAL_FUND',
      securityClassification: 'debt',
      quantity: 300,
      averageCost: 4500,
      investedValue: 1_350_000,
      currentPrice: 5000,
      currentValue: 1_500_000,
      unrealisedPnL: 150_000,
    });

    await repository.holdings.add(zerodhaEquityHolding);
    await repository.holdings.add(growwMfHolding);

    // ₹5L liabilities
    await useCanonicalLedger.getState().addLiability('Personal Loan', 500_000);
    const liability = repository.liabilities.findAllSync()[0];

    return { manualAsset, zerodhaEquityHolding, growwMfHolding, liability };
  }

  it('Acceptance 1–3: ₹10L manual assets + ₹40L imported holdings + ₹5L liabilities -> Overview, Wealth, and Snapshot Net Worth all equal ₹45L; Essentials Debt-to-Asset equals 10%', async () => {
    await seedAcceptancePortfolio();

    // Query-level Net Worth & Total Assets
    expect(FinancialQueries.getMetric('TOTAL_ASSETS').value).toBe(5_000_000);
    expect(FinancialQueries.getMetric('NET_WORTH').value).toBe(4_500_000);
    expect(FinancialQueries.getLiabilityDiagnostics().debtToAssetRatio).toBe(10);
    expect(FinancialQueries.getWealthHealthSummary().debtToAssetRatio).toBe(10);

    // Snapshot Net Worth (default & labelled) both equal ₹45L (totalAssets ₹50L - totalLiabilities ₹5L)
    await useCanonicalLedger.getState().captureSnapshot();
    const defaultSnap = repository.snapshots.findAllSync()[0];
    expect(defaultSnap.totalAssets).toBe(5_000_000);
    expect(defaultSnap.totalLiabilities).toBe(500_000);
    expect(defaultSnap.netWorth).toBe(4_500_000);

    await FinancialCommands.createSnapshot('Batch 3 Audit');
    const labelledSnap = repository.snapshots.findAllSync()[0];
    expect(labelledSnap.label).toBe('Batch 3 Audit');
    expect(labelledSnap.totalAssets).toBe(5_000_000);
    expect(labelledSnap.totalLiabilities).toBe(500_000);
    expect(labelledSnap.netWorth).toBe(4_500_000);

    // OverviewPage displays ₹45,00,000 Net Worth
    const overviewRender = render(<OverviewPage navigateTo={() => {}} />);
    expect(overviewRender.container.textContent).toContain('₹45,00,000');
    overviewRender.unmount();

    // WealthPage displays ₹45L Net Worth and ₹50L Total Assets
    const wealthRender = render(<WealthPage />);
    expect(wealthRender.container.textContent).toMatch(/₹4,500,000|₹45,00,000/);
    expect(wealthRender.container.textContent).toMatch(/₹5,000,000|₹50,00,000/);
    wealthRender.unmount();

    // EssentialsPage displays 10% Debt-to-Asset ratio (₹5L / ₹50L = 10%)
    const essentialsRender = render(<EssentialsPage />);
    expect(essentialsRender.container.textContent).toContain('Debt to Assets');
    expect(essentialsRender.container.textContent).toContain('10%');
    expect(essentialsRender.container.textContent).not.toContain('50%');
    essentialsRender.unmount();
  });

  it('DEF-08: DIVIDEND_YIELD_TTM and generateInsights incorporate imported holdings', async () => {
    await seedAcceptancePortfolio();

    // Add ₹1,00,000 cleared dividend within trailing 12M of effective as-of date (2026-08-23)
    const dividendTx: Transaction = {
      id: 'tx-div-1',
      date: '2026-07-15',
      dateStr: '15 Jul 2026',
      title: 'Infosys Final Dividend',
      narration: 'ACH C INFOSYS DIVIDEND',
      account: 'Cash',
      amount: 100_000,
      type: 'Income',
      category: 'DIVIDEND',
      status: 'CLEARED',
    };
    const yieldMetric = FinancialMetricService.getMetric(
      'DIVIDEND_YIELD_TTM',
      [dividendTx],
      repository.assets.findAllSync(), // Only Cash & Savings (₹10L) -> 0 manual brokerage assets
      repository.liabilities.findAllSync(),
      [],
      '2026-08-23',
      repository.holdings.findAllSync(), // ₹40L imported holdings
    );
    expect(yieldMetric.status).toBe('RECONCILED');
    // 100,000 / 4,000,000 * 100 = 2.5%
    expect(yieldMetric.value).toBe(2.5);

    // generateInsights & FinancialQueries.getWealthInsights use holdings-inclusive debt ratio (10%)
    const insights = FinancialQueries.getWealthInsights();
    const titles = insights.map(i => i.title);
    expect(titles).not.toContain('Elevated Debt-to-Asset Ratio');
    expect(titles).toContain('Conservative Debt Profile');
  });

  it('Acceptance 4 (DEF-10): Geography and Currency concentration totals 100% of ₹50L using Not Specified where holding metadata is absent', async () => {
    await seedAcceptancePortfolio();

    const concentration = FinancialQueries.getAssetConcentration();

    // Geography: Not Specified = ₹40L (80%), India = ₹10L (20%) -> Total ₹50L (100%)
    const geoAmountSum = concentration.byGeography.reduce((s, b) => s + b.amount, 0);
    const geoPctSum = concentration.byGeography.reduce((s, b) => s + b.pct, 0);
    expect(geoAmountSum).toBe(5_000_000);
    expect(geoPctSum).toBe(100);
    expect(concentration.byGeography).toEqual([
      { geography: 'Not Specified', amount: 4_000_000, pct: 80 },
      { geography: 'India', amount: 1_000_000, pct: 20 },
    ]);

    // Currency: Not Specified = ₹40L (80%), INR = ₹10L (20%) -> Total ₹50L (100%)
    const currAmountSum = concentration.byCurrency.reduce((s, b) => s + b.amount, 0);
    const currPctSum = concentration.byCurrency.reduce((s, b) => s + b.pct, 0);
    expect(currAmountSum).toBe(5_000_000);
    expect(currPctSum).toBe(100);
    expect(concentration.byCurrency).toEqual([
      { currency: 'Not Specified', amount: 4_000_000, pct: 80 },
      { currency: 'INR', amount: 1_000_000, pct: 20 },
    ]);
  });

  it('Acceptance 5 & 6 (DEF-11): Equity and MF holdings classify into canonical AssetType buckets while preserving raw Holding.securityClassification', () => {
    const cases: Array<{ holding: Holding; expected: string; rawSecClass: string | undefined }> = [
      // Equity via productScope / INE ISIN / ticker (Dhan / Zerodha / Angel One equity exports)
      {
        holding: makeHolding({ id: 'h-eq-scope', productScope: 'EQUITY', isin: 'INE009A01021', securityClassification: undefined }),
        expected: 'Equity',
        rawSecClass: undefined,
      },
      {
        holding: makeHolding({ id: 'h-eq-isin', productScope: undefined, ticker: undefined, isin: 'INE467B01029', securityClassification: undefined }),
        expected: 'Equity',
        rawSecClass: undefined,
      },
      // Groww / Dhan MF case-insensitive & sub-category classifications
      {
        holding: makeHolding({ id: 'h-mf-eq-lower', productScope: 'MUTUAL_FUND', isin: 'INF846K01EW2', ticker: undefined, securityClassification: 'equity' }),
        expected: 'Equity',
        rawSecClass: 'equity',
      },
      {
        holding: makeHolding({ id: 'h-mf-elss', productScope: 'MUTUAL_FUND', isin: 'INF846K01EW2', ticker: undefined, securityClassification: 'ELSS' }),
        expected: 'Equity',
        rawSecClass: 'ELSS',
      },
      {
        holding: makeHolding({ id: 'h-mf-debt-lower', productScope: 'MUTUAL_FUND', isin: 'INF179KB1HP9', ticker: undefined, securityClassification: 'debt' }),
        expected: 'Debt',
        rawSecClass: 'debt',
      },
      {
        holding: makeHolding({ id: 'h-mf-liquid', productScope: 'MUTUAL_FUND', isin: 'INF179KB1HP9', ticker: undefined, securityClassification: 'Liquid Fund' }),
        expected: 'Debt',
        rawSecClass: 'Liquid Fund',
      },
      {
        holding: makeHolding({ id: 'h-mf-gold-scheme', productScope: 'MUTUAL_FUND', isin: 'INF0R8F01034', ticker: undefined, instrumentName: 'Zerodha Gold ETF FoF Direct Growth', securityClassification: undefined }),
        expected: 'Commodities',
        rawSecClass: undefined,
      },
      {
        holding: makeHolding({ id: 'h-mf-hybrid', productScope: 'MUTUAL_FUND', isin: 'INF109K01Z48', ticker: undefined, securityClassification: 'Hybrid' }),
        expected: 'Other',
        rawSecClass: 'Hybrid',
      },
    ];

    for (const { holding, expected, rawSecClass } of cases) {
      expect(classifyHolding(holding)).toBe(expected);
      expect(holding.securityClassification).toBe(rawSecClass);
    }

    // Also verify WealthIntelligenceService leaves raw securityClassification untouched
    const holdingsList = cases.map(c => c.holding);
    const concentration = WealthIntelligenceService.getAssetConcentration([], holdingsList);
    expect(concentration.byType.find(b => b.type === 'Unclassified')).toBeUndefined();
    for (const { holding, rawSecClass } of cases) {
      expect(holding.securityClassification).toBe(rawSecClass);
    }
  });

  it('Acceptance 7 (DEF-12): Adding or renaming a manual asset to "Zerodha Equity" when Zerodha holdings exist is refused via HOLDING_COLLISION across store, repository, and AddAssetModal', async () => {
    await seedAcceptancePortfolio();
    expect(repository.assets.findAllSync()).toHaveLength(1); // Only HDFC Savings Reserve

    // 1. Direct store addAsset('Zerodha Equity', ...) is refused with HOLDING_COLLISION
    await expect(
      useCanonicalLedger.getState().addAsset('Zerodha Equity', 500_000)
    ).rejects.toMatchObject({
      name: 'AssetLifecycleError',
      code: 'HOLDING_COLLISION',
    } satisfies Partial<AssetLifecycleError>);
    expect(repository.assets.findAllSync()).toHaveLength(1);

    // 2. Direct store addAssetWithMetadata({ name: 'Zerodha Equity', ... }) is refused
    await expect(
      useCanonicalLedger.getState().addAssetWithMetadata({
        name: 'Zerodha Equity',
        amount: 500_000,
        type: 'Equity',
      })
    ).rejects.toMatchObject({
      code: 'HOLDING_COLLISION',
    });
    expect(repository.assets.findAllSync()).toHaveLength(1);

    // 3. Updating existing manual asset to "Zerodha Equity" via planUpdate/updateAsset is refused
    const existingSavings = repository.assets.findAllSync()[0];
    await expect(
      useCanonicalLedger.getState().updateAsset({
        ...existingSavings,
        id: existingSavings.id!,
        name: 'Zerodha Equity',
      })
    ).rejects.toMatchObject({
      code: 'HOLDING_COLLISION',
    });
    expect(repository.assets.findAllSync()[0].name).toBe('HDFC Savings Reserve');

    // 4. AddAssetModal surfaces refusal in UI and does not close or add the asset
    const onClose = vi.fn();
    render(<AddAssetModal isOpen={true} onClose={onClose} />);

    // Step 1: Select Equity category
    fireEvent.click(screen.getByText('Equity'));

    // Step 2: Fill name & valuation and submit
    fireEvent.change(screen.getByPlaceholderText(/HDFC Savings/i), {
      target: { value: 'Zerodha Equity' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '500000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Asset/i }));

    await waitFor(() => {
      const alertEl = screen.getByRole('alert');
      expect(alertEl.textContent).toMatch(/imported Zerodha holdings already exist|already represented as an imported Holding/i);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(repository.assets.findAllSync()).toHaveLength(1);

    // 5. Non-colliding manual asset ("Sovereign Gold Bond" or unimported broker "Angel One Equity") is still allowed
    await useCanonicalLedger.getState().addAssetWithMetadata({
      name: 'Physical Gold Bullion',
      amount: 250_000,
      type: 'Commodities',
    });
    expect(repository.assets.findAllSync()).toHaveLength(2);
  });
});
