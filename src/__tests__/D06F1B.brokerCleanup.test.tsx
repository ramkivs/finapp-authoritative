/**
 * D-06-F1-B UI acceptance — the BROKER_WIDE cleanup surface
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
/** Apply external ledger drift + store sync INSIDE act so React re-renders. */
const drift = (fn: () => void) => {
  act(() => {
    fn();
    sync();
  });
};
const rows = () => S().holdings.map((h: Holding) => h.id);
const log = (): HoldingDeletionLogEntry[] => repo.holdingDeletionLogData;
const brokerSelect = () => screen.getByTestId('closed-cleanup-broker') as HTMLSelectElement;
const selectAll = () => screen.getByTestId('closed-cleanup-select-all') as HTMLButtonElement;
const check = (id: string) => screen.getByTestId(`closed-cleanup-check-${id}`) as HTMLInputElement;
const pickBroker = (b: string) => fireEvent.change(brokerSelect(), { target: { value: b } });
const openConfirmFlow = () => {
  fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
  fireEvent.click(screen.getByTestId('batch-modal-review-next'));
};

describe('D06F1B — broker-wide cleanup surface', () => {
  beforeEach(() => {
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    seedAssets = [];
    sync();
  });

  it('B1: default scope is broker-wide and NO global scope exists anywhere (AC-03)', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' })]);
    render(<ClosedPositionsCleanupSection />);
    expect(screen.getByTestId('closed-cleanup-scope-label').textContent).toBe('Broker-wide: Zerodha');
    expect(document.body.textContent).not.toMatch(/GLOBAL|All brokers|every broker/i);
  });

  it('B2: list = closed_absent rows of the broker from the LIVE ledger; active rows never appear; drift re-derives live (AC-04)', async () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha' }),
      mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two' }),
      mk({ id: 'd1', broker: 'Dhan', instrumentName: 'Dhan one' }),
      mk({ id: 'zA', broker: 'Zerodha', instrumentName: 'Zeta active', status: 'active' as any }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Zerodha'); // default broker is the alphabetically-first option
    expect(screen.getByTestId('closed-cleanup-row-z1')).toBeTruthy();
    expect(screen.getByTestId('closed-cleanup-row-z2')).toBeTruthy();
    expect(screen.queryByTestId('closed-cleanup-row-d1')).toBeNull();
    expect(screen.queryByTestId('closed-cleanup-row-zA')).toBeNull();
    // A later re-import FLIPS z2 back to active → it leaves the list with no remount.
    drift(() => {
      repo.holdingsData = repo.holdingsData.map((h: Holding) =>
        h.id === 'z2' ? { ...h, status: 'active' as any } : h,
      );
    });
    expect(screen.queryByTestId('closed-cleanup-row-z2')).toBeNull();
    expect(screen.getByTestId('closed-cleanup-row-z1')).toBeTruthy();
  });

  it('B3: zero eligible → informational state only, NO destructive control (AC-05)', async () => {
    seed([mk({ id: 'zA', broker: 'Zerodha', status: 'active' as any })]);
    render(<ClosedPositionsCleanupSection />);
    expect(screen.getByTestId('closed-cleanup-empty')).toBeTruthy();
    expect(screen.getByTestId('closed-cleanup-empty').textContent).toMatch(/No closed positions/i);
    expect(screen.queryByTestId('closed-cleanup-select-all')).toBeNull();
    expect(screen.queryByTestId('closed-cleanup-delete')).toBeNull();
  });

  it('B4: selection is explicit — rows never pre-checked; delete appears only with a selection; Select-All opts into ALL live rows (AC-06)', async () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha' }),
      mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two' }),
      mk({ id: 'z3', broker: 'Zerodha', instrumentName: 'Three' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    expect(check('z1').checked).toBe(false);
    expect(check('z2').checked).toBe(false);
    expect(screen.queryByTestId('closed-cleanup-delete')).toBeNull(); // nothing deletable yet
    fireEvent.click(check('z1'));
    expect(screen.getByTestId('closed-cleanup-delete')).toBeTruthy();
    fireEvent.click(check('z1')); // explicit deselection → control disappears again
    expect(screen.queryByTestId('closed-cleanup-delete')).toBeNull();
    fireEvent.click(selectAll());
    for (const id of ['z1', 'z2', 'z3']) expect(check(id).checked).toBe(true);
    expect(screen.getByTestId('closed-cleanup-select-all').textContent).toContain('3');
  });

  it('B5: review = COMPLETE enumeration (no cap); confirm deletes ALL atomically; audit BROKER_WIDE + one shared batchId (AC-07/08)', async () => {
    seed(Array.from({ length: 12 }, (_, i) => mk({ id: `m${i}`, broker: 'Zerodha' })));
    render(<ClosedPositionsCleanupSection />);
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    const modal = screen.getByTestId('batch-delete-modal');
    expect(within(modal).getAllByTestId(/batch-modal-row-/)).toHaveLength(12);
    expect(screen.getByTestId('batch-modal-count').textContent).toContain('12');
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    expect(screen.getByTestId('batch-confirm-count').textContent).toContain('12');
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await settle();
    expect(rows()).toHaveLength(0);
    const entries = log();
    expect(entries).toHaveLength(12);
    expect(entries.every((e) => e.batchScope === 'BROKER_WIDE')).toBe(true);
    const batchIds = new Set(entries.map((e) => e.batchId));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0].startsWith('hdlb-')).toBe(true);
  });

  it('B6: Cancel at review stage AND at confirm stage deletes nothing', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' }), mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two' })]);
    render(<ClosedPositionsCleanupSection />);
    fireEvent.click(check('z1'));
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    fireEvent.click(screen.getByTestId('batch-modal-cancel'));
    await settle();
    expect(rows()).toEqual(['z1', 'z2']);
    expect(log()).toHaveLength(0);
    expect(document.querySelector('[data-testid="batch-delete-modal"]')).toBeNull();
    // confirm-stage cancel:
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    fireEvent.click(screen.getByTestId('batch-modal-cancel-confirm'));
    await settle();
    expect(rows()).toEqual(['z1', 'z2']);
    expect(log()).toHaveLength(0);
  });

  it('B7: confirmation-time re-resolution — row re-imported ACTIVE mid-modal is EXCLUDED; the rest proceeds (AC-14, ratified B-4)', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' }), mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two' })]);
    render(<ClosedPositionsCleanupSection />);
    fireEvent.click(selectAll());
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    // External re-import flips z2 ACTIVE while the modal is open, before the
    // second explicit confirmation click:
    drift(() => {
      repo.holdingsData = repo.holdingsData.map((h: Holding) =>
        h.id === 'z2' ? { ...h, status: 'active' as any } : h,
      );
    });
    // The open modal re-enumerates from live state → z2 dropped at REVIEW.
    expect(within(screen.getByTestId('batch-delete-modal')).getAllByTestId(/batch-modal-row-/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await settle();
    expect(rows()).toEqual(['z2']); // drifted row SURVIVES
    const entries = log();
    expect(entries).toHaveLength(1);
    expect(entries[0].holdingId).toBe('z1');
    expect(entries[0].batchScope).toBe('BROKER_WIDE');
  });

  it('B8: selected rows all vanished mid-modal → zero enumerated; NO audit written by us (AC-17)', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' })]);
    render(<ClosedPositionsCleanupSection />);
    fireEvent.click(check('z1'));
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    drift(() => {
      repo.holdingsData = []; // external wipe while modal open
    });
    expect(screen.getByTestId('closed-cleanup-empty')).toBeTruthy(); // section degraded to info state
    expect(log()).toHaveLength(0);
    expect(rows()).toHaveLength(0); // gone via the external actor — not via a blind empty-batch delete
  });

  it('B9: selection lives ONLY in component state — unmount discards it; nothing but holdings+audit is touched (AC-15)', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' }), mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two' })], [
      { id: 'asset-x' },
    ]);
    const { unmount } = render(<ClosedPositionsCleanupSection />);
    fireEvent.click(check('z1'));
    unmount();
    render(<ClosedPositionsCleanupSection />);
    expect(check('z1').checked).toBe(false); // never persisted, never restored
    expect(S().assets.map((a: any) => a.id)).toEqual(['asset-x']);
    expect(repo.assetsData ?? []).toHaveLength(0);
    expect(repo.transactionsData ?? []).toHaveLength(0);
    expect(repo.snapshotData ?? []).toHaveLength(0);
    await settle();
  });

  it('B10: broker list = DISTINCT HOLDING STRINGS only — never the SupportedBroker enum, no empty-broker entries (AC-04)', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' }), mk({ id: 'z2', broker: 'Zerodha', instrumentName: 'Two' })]);
    render(<ClosedPositionsCleanupSection />);
    const opts = Array.from(brokerSelect().options).map((o) => o.value);
    expect(opts).toEqual(['Zerodha']);
    for (const b of ['Dhan', 'AngelOne', 'ICICI', 'Groww', 'Upstox']) {
      expect(opts).not.toContain(b);
    }
    // Zero-broker ledger → no cleanup table at all, info only:
  });

  it('B11: switching broker scope structurally drops the prior selection (AC-09)', async () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha' }),
      mk({ id: 'd1', broker: 'Dhan', instrumentName: 'Dhan one' }),
    ]);
    render(<ClosedPositionsCleanupSection />);
    pickBroker('Zerodha');
    fireEvent.click(check('z1'));
    pickBroker('Dhan');
    expect(screen.getByTestId('closed-cleanup-scope-label').textContent).toBe('Broker-wide: Dhan');
    expect(check('d1').checked).toBe(false);
    expect(screen.queryByTestId('closed-cleanup-delete')).toBeNull();
    await settle();
    expect(log()).toHaveLength(0);
    expect(rows()).toEqual(['z1', 'd1']);
  });

  it('B12: broker-wide flow is independent of the transient ClosureTable preview — cleanup works with NO import ever run in this session (AC-01/02)', async () => {
    // Ledger-only seeding (no BrokerImportService, no preview state anywhere);
    // the section still enumerates and deletes through the single engine.
    seed([mk({ id: 'z1', broker: 'Groww' })]);
    render(<ClosedPositionsCleanupSection />);
    expect(screen.getByTestId('closed-cleanup')).toBeTruthy();
    pickBroker('Groww');
    fireEvent.click(check('z1'));
    openConfirmFlow();
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await settle();
    expect(rows()).toHaveLength(0);
    expect(log()[0].batchScope).toBe('BROKER_WIDE');
  });
});
