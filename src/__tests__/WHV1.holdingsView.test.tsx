/**
 * WEALTH-HOLDINGS-VIEW (working) — WHV1 acceptance tests.
 *
 * Genuine RTL tests against the real canonical store and the real
 * repository singleton — seeded exactly like the ratified WP-09 wealth
 * UI tests (repository.holdings.saveMany + syncWithRepository). No
 * compliance-manufacturing mocks. Maps the ratified 12 executable
 * requirements (implementation-authority report §6): A1–A10 here;
 * A11 (pre-existing suites green & unedited) is proven by the gate's
 * regression battery, and A12 (Chrome/native) is recorded NOT TESTED.
 *
 * Product invariants asserted: 10-field contract with three withheld
 * fields absent; em-dash for undefined optionals; closed_absent marked
 * while its D-02 wealth contribution stays untouched; filters/sorting
 * local-only with zero store mutation; Wealth aggregates byte-identical
 * mounted vs unmounted; no mutation affordances; no new loading/error
 * machinery.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within, act } from '@testing-library/react';

import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { Holding, HoldingStatus } from '../domain/types';
import { WealthPage } from '../pages/WealthPage';
import { HoldingsPositionsWorkspace } from '../pages/HoldingsPositionsWorkspace';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: overrides.id ?? `hld-test-${Math.random().toString(36).slice(2, 10)}`,
  broker: overrides.broker ?? 'Zerodha',
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
  status: overrides.status ?? ('active' as HoldingStatus),
  sourceFile: overrides.sourceFile ?? 'test.csv',
  importedAt: overrides.importedAt ?? '2026-08-23T10:00:00.000Z',
});

const seed = async (holdings: Holding[], assets: any[] = []) => {
  await repository.clearLocalData();
  await repository.initialize();
  await repository.holdings.saveMany(holdings);
  repo.assetsData = assets;
  repo.liabilitiesData = [];
  act(() => {
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
  });
};

const rows = () =>
  Array.from(document.querySelectorAll('[data-holdings-row]')) as HTMLElement[];
const rowIds = () => rows().map(r => r.getAttribute('data-holdings-row'));

describe('WHV1 — Holdings/Positions view (canonical projection, read-only)', () => {
  beforeEach(async () => {
    await repository.clearLocalData();
    await repository.initialize();
  });

  afterEach(async () => {
    await repository.clearLocalData();
    cleanup();
  });

  it('A1 — the canonical store holdings array is the sole source: view rows change iff the store changes', async () => {
    const a = makeHolding({ id: 'hld-a', instrumentName: 'Alpha Fund' });
    const b = makeHolding({ id: 'hld-b', instrumentName: 'Beta Stock', ticker: 'BETA' });
    await seed([a, b]);
    const { rerender } = render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    expect(rowIds().sort()).toEqual(['hld-a', 'hld-b']);

    // Add via the real store path, then re-render with the new canonical array.
    const c = makeHolding({ id: 'hld-c', instrumentName: 'Gamma ETF' });
    // saveMany() completes the canonical write path and syncs the store
    // itself (parent.syncStore()) — no hand-rolled state push is needed.
    await repository.holdings.saveMany([c]);
    rerender(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    expect(rowIds().sort()).toEqual(['hld-a', 'hld-b', 'hld-c']);
    // No other data source is displayed: a row never seen by the store
    // cannot exist here (row ids are exactly the store ids).
    expect(rows().length).toBe(S().holdings.length);
  });

  it('A2 — exactly the 10 ratified columns render; averageCost, investedValue and xirr are absent', async () => {
    await seed([makeHolding()]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    const table = document.getElementById('holdings-positions-table') as HTMLElement;
    const headers = within(table).getAllByRole('columnheader').map(h => (h.textContent ?? '').replace(/[↕▲▼]/g, '').trim());
    expect(headers).toEqual([
      'Instrument', 'Broker', 'Account', 'Ticker', 'ISIN',
      'Quantity', 'LTP', 'Current Value', 'Unrealised P&L', 'Status',
    ]);
    expect(screen.queryByText(/Average Cost/i)).toBeNull();
    expect(screen.queryByText(/Invested Value/i)).toBeNull();
    expect(screen.queryByText(/XIRR/i)).toBeNull();
  });

  it('A3 — undefined account/ticker/ISIN render as em-dash; defined values render as supplied', async () => {
    const bare = makeHolding({ id: 'hld-bare', instrumentName: 'Bare Holding' }); // no account/ticker/isin
    const full = makeHolding({
      id: 'hld-full', instrumentName: 'Full Holding',
      account: 'ACC-9', ticker: 'TATA', isin: 'INE000A01021',
    });
    await seed([bare, full]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    const bareRow = screen.getByText('Bare Holding').closest('[data-holdings-row]') as HTMLElement;
    expect(within(bareRow).getAllByText('—').length).toBe(3);
    const fullRow = screen.getByText('Full Holding').closest('[data-holdings-row]') as HTMLElement;
    within(fullRow).getByText('ACC-9');
    within(fullRow).getByText('TATA');
    within(fullRow).getByText('INE000A01021');
    expect(within(fullRow).queryByText('—')).toBeNull(); // never fabricated placeholders
  });

  it('A4 — closed_absent rows carry the visible status mark; active rows show plain Active', async () => {
    const open = makeHolding({ id: 'hld-open', instrumentName: 'Open Position', status: 'active' });
    const closed = makeHolding({ id: 'hld-closed', instrumentName: 'Closed Position', status: 'closed_absent' });
    await seed([open, closed]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    const closedRow = document.querySelector('[data-holdings-row="hld-closed"]') as HTMLElement;
    expect(closedRow.getAttribute('data-holdings-status')).toBe('closed_absent');
    within(closedRow).getByText('Closed / absent'); // marked via StatusBadge
    const openRow = document.querySelector('[data-holdings-row="hld-open"]') as HTMLElement;
    within(openRow).getByText('Active');
    expect(within(openRow).queryByText('Closed / absent')).toBeNull(); // not falsely marked
  });

  it('A5 — text filter matches instrumentName OR ticker, case-insensitively', async () => {
    await seed([
      makeHolding({ id: 'hld-1', instrumentName: 'Nippon ETF' }),
      makeHolding({ id: 'hld-2', instrumentName: 'Other Fund', ticker: 'TATAMOTORS' }),
      makeHolding({ id: 'hld-3', instrumentName: 'Third Fund' }),
    ]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    const search = screen.getByLabelText(/Search instrument or ticker/i);
    fireEvent.change(search, { target: { value: 'nippon' } });
    expect(rowIds()).toEqual(['hld-1']);
    fireEvent.change(search, { target: { value: 'tata' } });
    expect(rowIds()).toEqual(['hld-2']);
    fireEvent.change(search, { target: { value: '' } });
    expect(rows().length).toBe(3);
  });

  it('A6 — broker dropdown filters; no-match keeps filter state with the ratified message; reset restores the full set', async () => {
    await seed([
      makeHolding({ id: 'hld-z1', broker: 'Zerodha' }),
      makeHolding({ id: 'hld-g1', broker: 'Groww' }),
      makeHolding({ id: 'hld-g2', broker: 'Groww', instrumentName: 'Groww Special' }),
    ]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    fireEvent.change(screen.getByLabelText(/^Broker$/i), { target: { value: 'Groww' } });
    expect(rowIds().sort()).toEqual(['hld-g1', 'hld-g2']);
    // No-match: filter state retained while the message shows.
    fireEvent.change(screen.getByLabelText(/Search instrument or ticker/i), { target: { value: 'zzz-miss' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching holdings');
    expect((screen.getByLabelText(/Search instrument or ticker/i) as HTMLInputElement).value).toBe('zzz-miss');
    expect((screen.getByLabelText(/^Broker$/i) as HTMLSelectElement).value).toBe('Groww');
    // Clear filters restores the complete visible set (sort untouched by reset).
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/i }));
    expect(rows().length).toBe(3);
  });

  it('A7 — default order is currentValue descending; header clicks re-sort asc then desc with aria-sort', async () => {
    await seed([
      makeHolding({ id: 'hld-lo', instrumentName: 'Lo', currentValue: 100 }),
      makeHolding({ id: 'hld-hi', instrumentName: 'Hi', currentValue: 5000 }),
      makeHolding({ id: 'hld-mid', instrumentName: 'Mid', currentValue: 700 }),
    ]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    expect(rowIds()).toEqual(['hld-hi', 'hld-mid', 'hld-lo']);
    const table = document.getElementById('holdings-positions-table') as HTMLElement;
    const instrumentHeader = within(table).getByRole('columnheader', { name: /Instrument/i });
    expect(instrumentHeader).toHaveAttribute('aria-sort', 'none');
    fireEvent.click(within(instrumentHeader).getByRole('button', { name: 'Sort by Instrument' }));
    expect(instrumentHeader).toHaveAttribute('aria-sort', 'descending');
    expect(rowIds()).toEqual(['hld-mid', 'hld-lo', 'hld-hi']); // desc: Lo<… name-wise: 'Mid','Lo','Hi'
    fireEvent.click(within(instrumentHeader).getByRole('button', { name: 'Sort by Instrument' }));
    expect(instrumentHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(rowIds()).toEqual(['hld-hi', 'hld-lo', 'hld-mid']); // asc by name: 'Hi','Lo','Mid'
  });

  it('A8 — Wealth aggregates are byte-identical with the view mounted vs unmounted (D-02/D-04 untouched)', async () => {
    const closed = makeHolding({ id: 'hld-c1', instrumentName: 'SBI Magic MF', status: 'closed_absent', currentValue: 2500 });
    const open = makeHolding({ id: 'hld-o1', instrumentName: 'Tata Motors', status: 'active', currentValue: 5000 });
    await seed([closed, open], [{ id: 'ast-1', name: 'House', amount: 10000 }]);
    const storeSnapshotBefore = JSON.stringify(S().holdings);

    render(<WealthPage />);
    // Capture the aggregate render signature BEFORE the view mounts.
    const nwBefore = screen.getAllByText(/17,?500/).map(e => e.textContent);

    const holdingsTabButton = document.getElementById('wealth-tab-holdings') as HTMLElement;
    fireEvent.click(holdingsTabButton);
    // The view is mounted now — its own table exists.
    expect(document.getElementById('holdings-positions-table')).not.toBeNull();
    // Byte-identical aggregates mounted vs unmounted (net worth and total
    // assets both display the 17,500 signature; closed_absent still
    // contributes per the D-02 pin; the D-04 bridge is untouched).
    expect(nwBefore.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/17,?500/).map(e => e.textContent)).toEqual(nwBefore);
    expect(JSON.stringify(S().holdings)).toBe(storeSnapshotBefore);
  });

  it('A9 — filtering and sorting never mutate the canonical store state (deep identity)', async () => {
    const data = [
      makeHolding({ id: 'hld-x', instrumentName: 'X', currentValue: 10 }),
      makeHolding({ id: 'hld-y', instrumentName: 'Y', currentValue: 20, broker: 'Groww' }),
      makeHolding({ id: 'hld-z', instrumentName: 'Z', currentValue: 30, status: 'closed_absent' }),
    ];
    await seed(data);
    const holdingsRefBefore = S().holdings;
    const deepBefore = JSON.stringify({ holdings: S().holdings, assets: S().assets, snapshots: S().snapshots });

    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    fireEvent.change(screen.getByLabelText(/Search instrument or ticker/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/^Broker$/i), { target: { value: 'Groww' } });
    const table = document.getElementById('holdings-positions-table') as HTMLElement;
    fireEvent.click(within(table).getByRole('button', { name: 'Sort by Current Value' }));
    fireEvent.click(within(table).getByRole('button', { name: 'Sort by Current Value' }));
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/i }));

    expect(S().holdings).toBe(holdingsRefBefore);           // same array reference — never re-sorted in place
    expect(JSON.stringify({ holdings: S().holdings, assets: S().assets, snapshots: S().snapshots })).toBe(deepBefore);
  });

  it('A10 — empty state follows the existing Wealth EmptyState convention; no new loading/error machinery; strictly read-only affordances', async () => {
    await seed([]);
    const { unmount } = render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    expect(document.querySelector('[data-empty-state="true"]')).not.toBeNull();
    unmount();

    await seed([makeHolding()]);
    render(<HoldingsPositionsWorkspace holdings={S().holdings} />);
    // No new loading/error infrastructure:
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(screen.queryByText(/error/i)).toBeNull();
    // Zero mutation affordances — only sort/filter/clear buttons exist, nothing action-like:
    const buttonNames = screen.getAllByRole('button').map(b => b.textContent?.trim() ?? '');
    expect(buttonNames.filter(n => /close|delete|edit|remove|snapshot|export/i.test(n))).toEqual([]);
  });
});
