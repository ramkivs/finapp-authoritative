/**
 * D-06-F1-C UI acceptance — the ACCOUNT_WIDE (broker, account PAIR) cleanup
 * surface (D-06-F1-B UI acceptance
 * (ClosedPositionsCleanupSection + the reused F1-A batch modal).
 *
 * Synthetic seeding through the public store/repository surface only (the
 * ratified pattern from D12.UI.4); /tmp and /home/user/uploads must NOT be
 * read by any test here. The modal's internals stay pinned by the frozen
 * F1-A suites — this suite proves only the broker-wide SCOPING, selection,
 * live re-resolution and audit tagging layered on top.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, screen, within, act } from '@testing-library/react';

import { ClosedPositionsCleanupSection } from '../pages/ClosedPositionsCleanupSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Holding, HoldingDeletionLogEntry } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const mk = (overrides: Partial<Holding>): Holding =>
  ({
    id: overrides.id,
    broker: overrides.broker ?? 'Zerodha',
    account: overrides.account,
    instrumentName: overrides.instrumentName ?? overrides.id,
    isin: 'INE000000000',
    quantity: 10,
    averageCost: 100,
    investedValue: 1000,
    currentPrice: 110,
    currentValue: 1100,
    unrealisedPnL: 100,
    status: 'closed_absent',
    sourceFile: 'seed.csv',
    importedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  }) as Holding;

let seedAssets: any[] = [];
// Deterministic seeding straight on repository memory fields + store sync —
// the ratified pattern from the frozen F1-A suites (synchronous; no
// saveMany/IDB race, identity checks are bypassed because the cleanup
// surface only READS canonical state — all MUTATION still flows through the
// real engine via the modal).
const sync = () =>
  S().syncWithRepository({
    transactions: [], assets: seedAssets, liabilities: [], holdings: repo.holdingsData,
    snapshots: [], accounts: [], budgets: [], policies: [], goals: [], profile: null,
  });
const seed = (holdings: Holding[], assets: any[] = []) => {
  seedAssets = assets;
  repo.holdingsData = holdings.map((h) => ({ ...h }));
  repo.holdingDeletionLogData = [];
  sync();
};


const settle = () => new Promise((r) => setTimeout(r, 100));
const rows = () => S().holdings.map((h: Holding) => h.id);
const log = (): HoldingDeletionLogEntry[] => repo.holdingDeletionLogData;
const brokerSelect = () => screen.getByTestId('closed-cleanup-broker') as HTMLSelectElement;
const accountSelect = () => screen.getByTestId('closed-cleanup-account') as HTMLSelectElement;
const selectAll = () => screen.getByTestId('closed-cleanup-select-all') as HTMLButtonElement;
const check = (id: string) => screen.getByTestId(`closed-cleanup-check-${id}`) as HTMLInputElement;
const pickBroker = (b: string) => fireEvent.change(brokerSelect(), { target: { value: b } });
const pickAccount = (a: string) => fireEvent.change(accountSelect(), { target: { value: a } });
const drift = (fn: () => void) => {
  act(() => {
    fn();
    sync();
  });
};

describe('D06F1C — account-wide (broker, account pair) cleanup surface', () => {
  beforeEach(() => {
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    seedAssets = [];
    sync();
  });

  it('C1: account selector = DISTINCT DEFINED account strings of the selected broker, sorted; sentinel default is broker-wide (AC-10)', () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha', account: 'IQCX20' }),
      mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two', account: 'ACC1' }),
      mk({ id: 'z3', broker: 'Zerodha', instrumentName: 'Three', account: 'IQCX20' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    const opts = Array.from(accountSelect().options).map((o) => o.value);
    expect(opts).toEqual(['__BROKER_WIDE__', 'ACC1', 'IQCX20']); // sorted, deduped, sentinel first
    expect(accountSelect().value).toBe('__BROKER_WIDE__');
    expect(screen.getByTestId('closed-cleanup-scope-label').textContent).toBe('Broker-wide: Zerodha');
    pickAccount('IQCX20');
    expect(screen.getByTestId('closed-cleanup-scope-label').textContent).toBe('Account scope: Zerodha · IQCX20');
  });

  it('C2: eligibility is the (broker, account) PAIR — never account alone across brokers (AC-11)', () => {
    seed([
      mk({ id: 'd1', broker: 'Dhan', account: 'ACC1' }),
      mk({ id: 'z1', broker: 'Zerodha', account: 'ACC1', instrumentName: 'Zeta one' }),
      mk({ id: 'z2', broker: 'Zerodha', account: 'ACC2', instrumentName: 'Zeta two' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Dhan');
    pickAccount('ACC1');
    expect(screen.getByTestId('closed-cleanup-row-d1')).toBeTruthy();
    expect(screen.queryByTestId('closed-cleanup-row-z1')).toBeNull(); // same account, other broker
    expect(screen.queryByTestId('closed-cleanup-row-z2')).toBeNull();
  });

  it('C3 (product C-3): a broker with NO account-bearing holdings exposes NO account-wide control (AC-12)', () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha' }),
      mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two', account: '   ' as any }), // blank ≠ defined
      mk({ id: 'd1', broker: 'Dhan', instrumentName: 'Dhan one', account: 'DA1' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Zerodha');
    expect(screen.queryByTestId('closed-cleanup-account')).toBeNull(); // no pseudo-scope, no "not recorded" group
    expect(screen.getByTestId('closed-cleanup-scope-label').textContent).toBe('Broker-wide: Zerodha');
    // Both rows still reachable broker-wide (undefined/blank accounts are
    // handled by F1-B scope, never fabricated into an account scope):
    expect(screen.getByTestId('closed-cleanup-row-z1')).toBeTruthy();
    expect(screen.getByTestId('closed-cleanup-row-z2')).toBeTruthy();
    pickBroker('Dhan');
    expect(screen.getByTestId('closed-cleanup-account')).toBeTruthy(); // other brokers unaffected
  });

  it('C4: account-wide Select-All + confirm — ONLY pair rows deleted; audit ACCOUNT_WIDE with broker+account retained (AC-13)', async () => {
    seed([
      mk({ id: 'a1', broker: 'Groww', account: 'G1' }),
      mk({ id: 'a2', broker: 'Groww', account: 'G1', instrumentName: 'Two' }),
      mk({ id: 'a3', broker: 'Groww', account: 'G2', instrumentName: 'Three' }),
      mk({ id: 'a4', broker: 'Groww', account: 'G1', instrumentName: 'Four', status: 'active' as any }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Groww');
    pickAccount('G1');
    fireEvent.click(selectAll());
    expect(check('a1').checked && check('a2').checked).toBe(true);
    expect(screen.queryByTestId('closed-cleanup-check-a3')).toBeNull(); // not even listed — scoped to the pair
    expect(screen.queryByTestId('closed-cleanup-row-a4')).toBeNull();
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await settle();
    expect(rows().sort()).toEqual(['a3', 'a4']);
    const entries = log();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.batchScope === 'ACCOUNT_WIDE' && e.broker === 'Groww' && e.account === 'G1')).toBe(true);
    expect(new Set(entries.map((e) => e.batchId)).size).toBe(1);
  });

  it('C5: switching broker resets the account refinement to broker-wide and drops selection (AC-09)', async () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha', account: 'SHARED' }),
      mk({ id: 'd1', broker: 'Dhan', account: 'SHARED', instrumentName: 'Dhan one' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Zerodha');
    pickAccount('SHARED');
    fireEvent.click(check('z1'));
    pickBroker('Dhan');
    expect((screen.getByTestId('closed-cleanup-account') as HTMLSelectElement).value).toBe('__BROKER_WIDE__');
    expect(check('d1').checked).toBe(false); // same account string, other broker: carries nothing
    expect(screen.queryByTestId('closed-cleanup-delete')).toBeNull();
    await settle();
    expect(log()).toHaveLength(0);
  });

  it('C6: NO FinancialAccount linkage — selector lists ONLY distinct account strings from canonical Holdings (AC-12)', () => {
    seed([mk({ id: 'z1', broker: 'Zerodha', account: 'REAL-1' })]);
    // A FinancialAccount entity (store `accounts` slice) that does NOT match
    // any holding account: must never appear as a cleanup scope.
    S().syncWithRepository({
      transactions: [], assets: [], liabilities: [], holdings: repo.holdingsData,
      snapshots: [], budgets: [], policies: [], goals: [], profile: null,
      accounts: [{ id: 'fa-x', institution: 'Zerodha', label: 'FA-ONLY' }] as any,
    });
    render(<ClosedPositionsCleanupSection />);
    const opts = Array.from(accountSelect().options).map((o) => o.value);
    expect(opts).toEqual(['__BROKER_WIDE__', 'REAL-1']);
    expect(document.body.textContent).not.toMatch(/FA-ONLY/);
  });

  it('C7: account-scope row drifting OUT of the pair mid-modal is EXCLUDED at confirm; the rest proceeds (ratified B-4 drift semantics)', async () => {
    seed([
      mk({ id: 'a1', broker: 'Dhan', account: 'X1' }),
      mk({ id: 'a2', broker: 'Dhan', account: 'X1', instrumentName: 'Two' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Dhan');
    pickAccount('X1');
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    // External import re-attributes a2 to another account while the modal is open.
    drift(() => {
      repo.holdingsData = repo.holdingsData.map((h: Holding) =>
        h.id === 'a2' ? { ...h, account: 'X2' } : h,
      );
    });
    expect(within(screen.getByTestId('batch-delete-modal')).getAllByTestId(/batch-modal-row-/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await settle();
    expect(rows()).toEqual(['a2']);
    const entries = log();
    expect(entries).toHaveLength(1);
    expect(entries[0].holdingId).toBe('a1');
    expect(entries[0].batchScope).toBe('ACCOUNT_WIDE');
    expect(entries[0].account).toBe('X1');
  });

  it('C8: account scope with zero eligible rows → informational only, NO destructive control (AC-05 analogue)', () => {
    seed([mk({ id: 'z1', broker: 'Zerodha', account: 'A1' }), mk({ id: 'z2', broker: 'Zerodha', account: 'A2', instrumentName: 'Two', status: 'active' as any })]);
    render(<ClosedPositionsCleanupSection />);
    pickAccount('A2');
    expect(screen.getByTestId('closed-cleanup-empty')).toBeTruthy();
    expect(screen.queryByTestId('closed-cleanup-select-all')).toBeNull();
    expect(screen.queryByTestId('closed-cleanup-delete')).toBeNull();
  });

  it('C9: broker-wide default on an ACCOUNT-BEARING broker still spans all accounts and tags BROKER_WIDE (F1-B unchanged)', async () => {
    seed([
      mk({ id: 'b1', broker: 'ICICI', account: 'I1' }),
      mk({ id: 'b2', broker: 'ICICI', account: 'I2', instrumentName: 'Two' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('ICICI');
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await settle();
    expect(rows()).toHaveLength(0);
    const entries = log();
    expect(entries.every((e) => e.batchScope === 'BROKER_WIDE')).toBe(true);
    expect(entries.map((e) => e.account).sort()).toEqual(['I1', 'I2']);
  });

  it('C10: account scope is never GLOBAL — rows of OTHER brokers are never enumerated or deleted (AC-03/11)', () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha', account: 'SHARED' }),
      mk({ id: 'd1', broker: 'Dhan', account: 'SHARED', instrumentName: 'Dhan one' }),
      mk({ id: 'g1', broker: 'Groww', account: 'SHARED', instrumentName: 'Groww one' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Dhan');
    pickAccount('SHARED');
    const listed = Array.from(document.querySelectorAll('[data-testid^="closed-cleanup-row-"]'));
    expect(listed.map((el) => el.getAttribute('data-testid'))).toEqual(['closed-cleanup-row-d1']);
    expect(screen.getByTestId('closed-cleanup-scope-label').textContent).toBe('Account scope: Dhan · SHARED');
  });
});
