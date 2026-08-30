/**
 * D-06-F1-D UI acceptance — the persistent whole-ledger GLOBAL cleanup
 * surface + the F6 typed-count gate (Option D). Authority:
 * FINBOOM-D-06-F6-F1D-IMPLEMENTATION-AUTHORITY-REPORT.md (§§5-9).
 * Hermetic: real component, real store, real modal, real engine, real
 * persisted audit; NO mocks; no /home/user/uploads dependency.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, screen, within, act } from '@testing-library/react';

import { GlobalLedgerCleanupSection } from '../pages/GlobalLedgerCleanupSection';
import { ClosedPositionsCleanupSection } from '../pages/ClosedPositionsCleanupSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Holding, HoldingDeletionLogEntry } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const mk = (o: Partial<Holding>): Holding => ({
  id: o.id,
  broker: o.broker ?? 'Zerodha',
  account: o.account,
  instrumentName: o.instrumentName ?? o.id,
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
  ...o,
} as Holding);

const sync = () =>
  S().syncWithRepository({
    transactions: [], assets: [], liabilities: [], holdings: repo.holdingsData,
    snapshots: [], accounts: [], budgets: [], policies: [], goals: [], profile: null,
  });
const seed = (holdings: Holding[]) => {
  repo.holdingsData = holdings.map((h) => ({ ...h }));
  repo.holdingDeletionLogData = [];
  sync();
};
const settle = () => new Promise((r) => setTimeout(r, 100));
const drift = (fn: () => void) => {
  act(() => {
    fn();
    sync();
  });
};
const rows = () => S().holdings.map((h: Holding) => h.id);
const log = (): HoldingDeletionLogEntry[] => repo.holdingDeletionLogData;
const check = (id: string) => screen.getByTestId(`global-cleanup-check-${id}`) as HTMLInputElement;
const selectAll = () => screen.getByTestId('global-cleanup-select-all') as HTMLButtonElement;
const typed = () => screen.getByTestId('batch-modal-typed-input') as HTMLInputElement;
const typeCount = (n: string) => fireEvent.change(typed(), { target: { value: n } });
const confirmBtn = () => screen.getByTestId('batch-modal-confirm') as HTMLButtonElement;
const openReview = () => fireEvent.click(screen.getByTestId('global-cleanup-delete'));
const toConfirm = () => fireEvent.click(screen.getByTestId('batch-modal-review-next'));

describe('D06F1D — GLOBAL whole-ledger cleanup surface + F6 typed gate', () => {
  beforeEach(() => {
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    sync();
  });

  it('U1: eligible = ALL brokers/accounts live closed_absent; undefined-account rows INCLUDED; no broker/account predicate (AC-01)', () => {
    seed([
      mk({ id: 'z1', broker: 'Zerodha' }),
      mk({ id: 'd1', broker: 'Dhan', account: 'DA1', instrumentName: 'Dhan one' }),
      mk({ id: 'i1', broker: 'ICICI', instrumentName: 'Icici one' }),
      mk({ id: 'a1', broker: 'Zerodha', instrumentName: 'Active', status: 'active' as any }),
    ]);
    render(<GlobalLedgerCleanupSection />);
    for (const id of ['z1', 'd1', 'i1']) expect(screen.getByTestId(`global-cleanup-row-${id}`)).toBeTruthy();
    expect(screen.queryByTestId('global-cleanup-row-a1')).toBeNull(); // active NEVER eligible
    expect(screen.getByTestId('global-cleanup-scope-label').textContent).toContain('3 eligible');
    expect(screen.getByTestId('global-cleanup-row-z1').textContent).toContain('—'); // undefined account listed, not excluded
  });

  it('U2: zero eligible / zero ledger → informational only; NO destructive control (AC-02)', () => {
    seed([mk({ id: 'a1', status: 'active' as any })]);
    const { unmount } = render(<GlobalLedgerCleanupSection />);
    expect(screen.getByTestId('global-cleanup-empty')).toBeTruthy();
    expect(screen.queryByTestId('global-cleanup-select-all')).toBeNull();
    expect(screen.queryByTestId('global-cleanup-delete')).toBeNull();
    unmount();
    seed([]);
    render(<GlobalLedgerCleanupSection />);
    expect(screen.getByTestId('global-cleanup-empty')).toBeTruthy();
    expect(screen.queryByTestId('global-cleanup-delete')).toBeNull();
  });

  it('U3: never auto-selected; explicit per-row selection gates the destructive button (AC-03)', () => {
    seed([mk({ id: 'z1' }), mk({ id: 'z2', instrumentName: 'Two' })]);
    render(<GlobalLedgerCleanupSection />);
    expect(check('z1').checked).toBe(false);
    expect(check('z2').checked).toBe(false);
    expect(screen.queryByTestId('global-cleanup-delete')).toBeNull();
    fireEvent.click(check('z1'));
    expect(screen.getByTestId('global-cleanup-delete')).toBeTruthy();
    fireEvent.click(check('z1'));
    expect(screen.queryByTestId('global-cleanup-delete')).toBeNull();
  });

  it('U4: Select All is an opt-in over exactly the CURRENT live eligible set (AC-03)', () => {
    seed([
      mk({ id: 'z1' }),
      mk({ id: 'd1', broker: 'Dhan', instrumentName: 'Dhan one' }),
      mk({ id: 'g1', broker: 'Groww', instrumentName: 'Groww one' }),
      mk({ id: 'a1', instrumentName: 'Active', status: 'active' as any }),
    ]);
    render(<GlobalLedgerCleanupSection />);
    expect(selectAll().textContent).toContain('3');
    fireEvent.click(selectAll());
    for (const id of ['z1', 'd1', 'g1']) expect(check(id).checked).toBe(true);
    expect(screen.getByTestId('global-cleanup-selected-count').textContent).toContain('3');
  });

  it('U5: review enumerates the COMPLETE effective batch — no cap (N=15) with count + aggregate (AC-04)', () => {
    seed(Array.from({ length: 15 }, (_, i) => mk({ id: `n${i}`, broker: i % 2 ? 'Dhan' : 'Zerodha' })));
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(selectAll());
    openReview();
    const modal = screen.getByTestId('batch-delete-modal');
    expect(within(modal).getAllByTestId(/batch-modal-row-/)).toHaveLength(15);
    expect(screen.getByTestId('batch-modal-count').textContent).toContain('15');
    expect(screen.getByTestId('batch-modal-total').textContent).toMatch(/16,?500/); // 15 × 1100.00 (en-IN grouping)
  });

  it('U6: typed gate — only the exact LIVE count enables confirm; empty/wrong/non-numeric disable; trimmed match accepted (AC-06)', () => {
    seed([mk({ id: 'z1' }), mk({ id: 'z2', instrumentName: 'Two' }), mk({ id: 'z3', instrumentName: 'Three' })]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(selectAll());
    openReview();
    toConfirm();
    expect(screen.getByTestId('batch-modal-typed-input')).toBeTruthy();
    expect(confirmBtn().disabled).toBe(true); // empty
    typeCount('2');
    expect(confirmBtn().disabled).toBe(true); // wrong
    expect(screen.getByTestId('batch-modal-typed-state').textContent).toMatch(/Does not match/);
    typeCount('abc');
    expect(confirmBtn().disabled).toBe(true);
    typeCount('  3  ');
    expect(confirmBtn().disabled).toBe(false); // trim-exact match on live 3
  });

  it('U7: Enter NEVER submits — no form, button-only path (AC-06)', async () => {
    seed([mk({ id: 'z1' })]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(screen.getByTestId('global-cleanup-check-z1'));
    openReview();
    toConfirm();
    typeCount('1');
    fireEvent.keyDown(typed(), { key: 'Enter', code: 'Enter' });
    fireEvent.keyPress(typed(), { key: 'Enter', code: 'Enter' });
    await settle();
    expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('confirm');
    expect(rows()).toEqual(['z1']);
    expect(log()).toHaveLength(0);
  });

  it('U8: live drift re-derives the count and RE-LOCKS a stale typed value; remainder proceeds (AC-05/06)', async () => {
    seed([mk({ id: 'z1' }), mk({ id: 'z2', instrumentName: 'Two' }), mk({ id: 'z3', instrumentName: 'Three' })]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(selectAll());
    openReview();
    toConfirm();
    typeCount('3');
    expect(confirmBtn().disabled).toBe(false);
    // One selected row becomes active WHILE the confirm stage is open:
    drift(() => {
      repo.holdingsData = repo.holdingsData.map((h: Holding) =>
        h.id === 'z3' ? { ...h, status: 'active' as any } : h,
      );
    });
    expect(screen.getByTestId('batch-confirm-count').textContent).toBe('2');
    expect(confirmBtn().disabled).toBe(true); // stale '3' vs live 2 → re-locked
    typeCount('2');
    expect(confirmBtn().disabled).toBe(false);
    fireEvent.click(confirmBtn());
    await settle();
    expect(rows()).toEqual(['z3']); // drifted row SURVIVES — never deleted on stale confirmation
    const entries = log();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.batchScope === 'GLOBAL')).toBe(true);
  });

  it('U9: all rows vanish mid-modal → zero-guard holds; NO service call, NO audit (AC-06/zero-set)', async () => {
    seed([mk({ id: 'z1' })]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(screen.getByTestId('global-cleanup-check-z1'));
    openReview();
    toConfirm();
    typeCount('1');
    drift(() => {
      repo.holdingsData = []; // external wipe
    });
    // count 0: confirm stays disabled (zero-guard + typed mismatch); even a
    // programmatic click cannot reach the engine with an empty batch.
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(confirmBtn()); // no-op while disabled
    await settle();
    expect(log()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it('U10: broker/account drift neither broadens nor restricts GLOBAL eligibility; audit carries LIVE attribution (AC-01)', async () => {
    seed([mk({ id: 'z1', broker: 'Zerodha' }), mk({ id: 'z2', broker: 'Dhan', instrumentName: 'Two' })]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(selectAll());
    openReview();
    toConfirm();
    // z1 changes broker (Zerodha → Groww) while confirm stage is open:
    drift(() => {
      repo.holdingsData = repo.holdingsData.map((h: Holding) =>
        h.id === 'z1' ? { ...h, broker: 'Groww' as any } : h,
      );
    });
    // GLOBAL: no scope predicate ⇒ count unchanged, typed '2' stays valid.
    expect(screen.getByTestId('batch-confirm-count').textContent).toBe('2');
    typeCount('2');
    expect(confirmBtn().disabled).toBe(false);
    fireEvent.click(confirmBtn());
    await settle();
    expect(rows()).toHaveLength(0);
    const e1 = log().find((e) => e.holdingId === 'z1')!;
    expect(e1.broker).toBe('Groww'); // honest LIVE attribution, not the stale snapshot
    expect(e1.batchScope).toBe('GLOBAL');
  });

  it('U11: successful GLOBAL batch — per-row entries, one shared hdlb- id, heterogeneous attribution, account-less row included (AC-08)', async () => {
    seed([
      mk({ id: 'h1', broker: 'Zerodha' }),
      mk({ id: 'h2', broker: 'Dhan', account: 'DA9', instrumentName: 'Two' }),
      mk({ id: 'h3', broker: 'ICICI', instrumentName: 'Three' }),
    ]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(selectAll());
    openReview();
    toConfirm();
    typeCount('3');
    fireEvent.click(confirmBtn());
    await settle();
    expect(rows()).toHaveLength(0);
    const entries = log();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.batchScope === 'GLOBAL')).toBe(true);
    const ids = new Set(entries.map((e) => e.batchId));
    expect(ids.size).toBe(1);
    expect([...ids][0].startsWith('hdlb-')).toBe(true);
    expect(entries.map((e) => e.broker).sort()).toEqual(['Dhan', 'ICICI', 'Zerodha']);
    expect(entries.find((e) => e.holdingId === 'h2')!.account).toBe('DA9');
    expect(entries.find((e) => e.holdingId === 'h3')!.account).toBeUndefined();
    expect(entries.every((e) => e.instrumentName && typeof e.currentValueAtDeletion === 'number')).toBe(true);
  });

  it('U12: Cancel at either stage deletes nothing; typed input state dies with the modal', async () => {
    seed([mk({ id: 'z1' }), mk({ id: 'z2', instrumentName: 'Two' })]);
    render(<GlobalLedgerCleanupSection />);
    fireEvent.click(selectAll());
    openReview();
    fireEvent.click(screen.getByTestId('batch-modal-cancel'));
    expect(rows()).toEqual(['z1', 'z2']);
    openReview();
    toConfirm();
    typeCount('2');
    fireEvent.click(screen.getByTestId('batch-modal-cancel-confirm'));
    await settle();
    expect(rows()).toEqual(['z1', 'z2']);
    expect(log()).toHaveLength(0);
    // reopen → fresh gate, empty input
    openReview();
    toConfirm();
    expect(typed().value).toBe('');
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('batch-modal-cancel-confirm'));
  });

  it('U13: selection + typed state are component-local — unmount discards everything (no persistence)', () => {
    seed([mk({ id: 'z1' })]);
    const { unmount } = render(<GlobalLedgerCleanupSection />);
    fireEvent.click(screen.getByTestId('global-cleanup-check-z1'));
    expect(screen.getByTestId('global-cleanup-delete')).toBeTruthy();
    unmount();
    render(<GlobalLedgerCleanupSection />);
    expect(screen.getByTestId('global-cleanup-check-z1').hasAttribute('checked')).toBe(false);
    expect((screen.getByTestId('global-cleanup-check-z1') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('global-cleanup-delete')).toBeNull();
  });

  it('U14: NO retro-fit — coexisting F1-B surface is behaviorally untouched (no typed gate, independent selection) (AC-11)', async () => {
    seed([mk({ id: 'z1' }), mk({ id: 'z2', broker: 'Dhan', instrumentName: 'Dhan one' })]);
    render(
      <>
        <ClosedPositionsCleanupSection />
        <GlobalLedgerCleanupSection />
      </>,
    );
    // Global-side selection:
    fireEvent.click(check('z1'));
    // B/C-side selection (broker defaults to alphabetically-first: Dhan → z2):
    fireEvent.click(screen.getByTestId('closed-cleanup-check-z2'));
    // B/C modal must NOT acquire the typed gate — checked at the CONFIRM
    // stage (where the gate would live if it were retro-fitted):
    fireEvent.click(screen.getByTestId('closed-cleanup-delete'));
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    expect(screen.queryByTestId('batch-modal-typed-input')).toBeNull();
    fireEvent.click(screen.getByTestId('batch-modal-cancel-confirm'));
    // GLOBAL modal DOES have the gate at the same stage:
    openReview();
    toConfirm();
    expect(screen.getByTestId('batch-modal-typed-input')).toBeTruthy();
    expect(confirmBtn().disabled).toBe(true); // and it GATES confirmation
    fireEvent.click(screen.getByTestId('batch-modal-cancel-confirm'));
    await settle();
    expect(rows()).toEqual(['z1', 'z2']);
    expect(log()).toHaveLength(0);
  });
});
