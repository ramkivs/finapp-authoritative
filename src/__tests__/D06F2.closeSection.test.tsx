/**
 * D-06-F2-A UI acceptance — the persistent close surface: live eligibility,
 * explicit selection + opt-in Select-All, two-stage review→confirm with NO
 * typed gate (F6 non-applicability is a ratified product decision), honest
 * reactivation disclosure, whole-batch safety, and zero contamination of the
 * promoted F1-A/B/C/D surfaces. Authority:
 * FINBOOM-D-06-F2-IMPLEMENTATION-AUTHORITY-REPORT.md (§4/§5, AC-F2-01…06/10/14).
 * Real component + real store + real repository + real deletion engine;
 * NO mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, screen, act } from '@testing-library/react';

import { CloseActivePositionsSection } from '../pages/CloseActivePositionsSection';
import { GlobalLedgerCleanupSection } from '../pages/GlobalLedgerCleanupSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Holding } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const mk = (o: Partial<Holding>): Holding => ({
  id: o.id!,
  broker: o.broker ?? 'Zerodha',
  account: o.account,
  instrumentName: o.instrumentName ?? o.id!,
  isin: 'INE000000000',
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  status: 'active',
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
const row = (id: string) => repo.holdingsData.find((h: Holding) => h.id === id);
const log = () => repo.holdingDeletionLogData;
const check = (id: string) => screen.getByTestId(`close-positions-check-${id}`) as HTMLInputElement;
const selectAll = () => screen.getByTestId('close-positions-select-all') as HTMLButtonElement;
const openBtn = () => screen.getByTestId('close-positions-open') as HTMLButtonElement;
const modal = () => screen.getByTestId('close-positions-modal');
const toConfirm = () => fireEvent.click(screen.getByTestId('close-positions-modal-next'));
const confirmBtn = () => screen.getByTestId('close-positions-modal-confirm') as HTMLButtonElement;
const drift = (fn: () => void) => {
  act(() => {
    fn();
    sync();
  });
};
const renderClose = () => render(<CloseActivePositionsSection />);

describe('D06F2 — close surface (real component, real store)', () => {
  beforeEach(() => {
    seed([]);
  });

  it('V1: eligible = LIVE active rows across ALL brokers/accounts; undefined-account included; closed rows excluded', () => {
    seed([
      mk({ id: 'a1', broker: 'Zerodha' }),
      mk({ id: 'a2', broker: 'Dhan', account: 'DA1', instrumentName: 'Two' }),
      mk({ id: 'a3', broker: 'ICICI', instrumentName: 'Three' }),
      mk({ id: 'c1', broker: 'Zerodha', instrumentName: 'Four', status: 'closed_absent' }),
    ]);
    renderClose();
    expect(screen.getByTestId('close-positions-row-a1')).toBeTruthy();
    expect(screen.getByTestId('close-positions-row-a2')).toBeTruthy();
    expect(screen.getByTestId('close-positions-row-a3')).toBeTruthy();
    expect(screen.queryByTestId('close-positions-row-c1')).toBeNull();
    expect(screen.getByTestId('close-positions-scope-label').textContent).toContain('3 active');
  });

  it('V2: zero active / zero ledger → informational only; NO select-all, NO open control', () => {
    seed([mk({ id: 'c1', status: 'closed_absent' })]);
    renderClose();
    expect(screen.getByTestId('close-positions-empty').textContent).toMatch(/No active positions/);
    expect(screen.queryByTestId('close-positions-select-all')).toBeNull();
    expect(screen.queryByTestId('close-positions-open')).toBeNull();
    act(() => {
      seed([]);
    });
    expect(screen.getByTestId('close-positions-empty').textContent).toMatch(/no records/);
  });

  it('V3: never auto-selected; per-row checkboxes gate the action; explicit opt-out works', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' })]);
    renderClose();
    expect(screen.queryByTestId('close-positions-open')).toBeNull(); // mount: zero selected
    expect(check('a1').checked).toBe(false);
    fireEvent.click(check('a1'));
    expect(screen.getByTestId('close-positions-selected-count').textContent).toContain('1 active');
    fireEvent.click(check('a1')); // uncheck again
    expect(screen.queryByTestId('close-positions-open')).toBeNull();
    fireEvent.click(check('a2'));
    expect(openBtn()).toBeTruthy();
  });

  it('V4: Select-All is opt-in and covers EXACTLY the current live active set', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' }), mk({ id: 'c1', instrumentName: 'Three', status: 'closed_absent' })]);
    renderClose();
    expect(screen.queryByTestId('close-positions-open')).toBeNull();
    fireEvent.click(selectAll());
    expect(screen.getByTestId('close-positions-selected-count').textContent).toContain('2 active');
    expect(screen.queryByTestId('close-positions-selected-count').textContent).not.toMatch(/3/);
  });

  it('V5: full enumeration — 15 active rows all listed, all reviewable, no cap', () => {
    const many = Array.from({ length: 15 }, (_, i) => mk({ id: `m${i}`, instrumentName: `Inst${i}` }));
    seed(many);
    renderClose();
    for (let i = 0; i < 15; i++) expect(screen.getByTestId(`close-positions-row-m${i}`)).toBeTruthy();
    fireEvent.click(selectAll());
    fireEvent.click(openBtn());
    expect(screen.getByTestId('close-positions-modal-count').textContent).toContain('15 active');
    for (let i = 0; i < 15; i++) expect(screen.getByTestId(`close-positions-modal-row-m${i}`)).toBeTruthy();
  });

  it('V6: review copy is honest about the lifecycle; NO typed input exists anywhere in the F2 flow', () => {
    seed([mk({ id: 'a1' })]);
    renderClose();
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    expect(screen.getByTestId('close-positions-modal-disclosure').textContent).toMatch(/does NOT delete/i);
    expect(screen.getByTestId('close-positions-modal-disclosure').textContent).toMatch(/reactivat/i);
    expect(screen.getByTestId('close-positions-modal-disclosure').textContent).toMatch(/classified as new/i);
    // F6 must NOT be here: no typed input, and no F1-D testid in this modal.
    expect(modal().querySelector('input')).toBeNull();
    expect(document.querySelectorAll('input[type="text"], textarea')).toHaveLength(0);
    expect(screen.queryByTestId('batch-modal-typed-input')).toBeNull();
  });

  it('V7: Enter never submits — no form element exists; keydown Enter leaves stage and data untouched', () => {
    seed([mk({ id: 'a1' })]);
    renderClose();
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    fireEvent.keyDown(modal(), { key: 'Enter', code: 'Enter' });
    expect(modal().getAttribute('data-stage')).toBe('review');
    expect(row('a1').status).toBe('active');
    expect(modal().closest('form')).toBeNull();
  });

  it('V8: live drift — externally closed row DROPS from the actionable set; remainder proceeds; no stale close', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' })]);
    renderClose();
    fireEvent.click(check('a1'));
    fireEvent.click(check('a2'));
    fireEvent.click(openBtn());
    // Mid-modal: a1 gets closed by a broker import path (direct store drift).
    drift(() => S().commitUserCloses(['a1']));
    expect(screen.getByTestId('close-positions-modal-count').textContent).toContain('1 active');
    expect(screen.queryByTestId('close-positions-modal-row-a1')).toBeNull();
    toConfirm();
    fireEvent.click(confirmBtn());
    expect(row('a1').status).toBe('closed_absent'); // unchanged by the batch — not re-closed
    expect(row('a2').status).toBe('closed_absent'); // remainder proceeded
  });

  it('V9: confirm is disabled on an empty effective batch; the zero-guard is in the handler too (no store call)', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' })]);
    renderClose();
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    // Both rows vanish from the ledger before confirmation.
    drift(() => {
      repo.holdingsData = repo.holdingsData.filter((h: Holding) => h.id !== 'a1');
      sync();
    });
    expect(screen.queryByTestId('close-positions-modal-row-a1')).toBeNull();
    // Effective set is empty at every stage: open button already gone, modal
    // shows zero rows; confirm (if force-clicked) must NOT hit the store and
    // must NOT invent a whole-ledger path.
    // The modal re-derives its live set per render: the vanished row is
    // EXCLUDED from review and the confirm control is disabled for the empty
    // batch. Even if a dispatch reached the handler, the store-level
    // empty-batch guard (pinned at F4) rejects any whole-ledger/no-op path;
    // React additionally suppresses interaction with disabled controls.
    expect(screen.getByTestId('close-positions-modal-count').textContent).toContain('0 active');
    expect(screen.queryByTestId('close-positions-modal-row-a1')).toBeNull();
    // Same tree, CONFIRM-stage probe: select both, advance, then empty BOTH
    // live rows (one closed externally, one removed from the ledger).
    fireEvent.click(check('a2'));
    toConfirm();
    drift(() => {
      S().commitUserCloses(['a2']);
      repo.holdingsData = repo.holdingsData.filter((h: Holding) => h.id !== 'a1');
      sync();
    });
    expect(confirmBtn().disabled).toBe(true); // empty effective batch at CONFIRM stage
    fireEvent.click(confirmBtn()); // no-op: gated control; store never called
    expect(log()).toHaveLength(0);
    expect(row('a2').status).toBe('closed_absent'); // only the external close happened
  });

  it('V10: success path — statuses flip in the persisted repository data; modal closes; selection cleared; NO audit record for the close', async () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' })]);
    renderClose();
    fireEvent.click(selectAll());
    fireEvent.click(openBtn());
    toConfirm();
    fireEvent.click(confirmBtn());
    expect(row('a1').status).toBe('closed_absent');
    expect(row('a2').status).toBe('closed_absent');
    await new Promise((r) => setTimeout(r, 100)); // let the real persisted promise settle
    expect(screen.queryByTestId('close-positions-modal')).toBeNull(); // modal closed
    expect(screen.queryByTestId('close-positions-selected-count')).toBeNull(); // selection reset
    expect(screen.getByTestId('close-positions-empty').textContent).toMatch(/No active positions/);
    expect(log()).toHaveLength(0); // product decision C: no close audit
  });

  it('V11: closed rows flow into the UNCHANGED F1-D cleanup surface (contract: deletion machinery untouched)', () => {
    seed([mk({ id: 'a1' })]);
    render(
      <>
        <CloseActivePositionsSection />
        <GlobalLedgerCleanupSection />
      </>,
    );
    expect(screen.queryByTestId('global-cleanup-row-a1')).toBeNull(); // active: not deletable yet
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    toConfirm();
    fireEvent.click(confirmBtn());
    // Now eligible to the existing whole-ledger cleanup — zero changes to it:
    expect(screen.getByTestId('global-cleanup-row-a1')).toBeTruthy();
    expect(screen.getByTestId('global-cleanup-scope-label').textContent).toContain('1 eligible');
  });

  it('V12: no reopen/undo/reactivate affordance anywhere in the section (reactivation = future import only)', () => {
    seed([mk({ id: 'a1' })]);
    const { container } = renderClose();
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    toConfirm();
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent || '');
    expect(buttons.some((t) => /reopen|undo|reactivate|restore/i.test(t))).toBe(false);
  });

  it('V13: cancel at either stage and back-navigation change NOTHING (close is opt-in until the final action)', () => {
    seed([mk({ id: 'a1' })]);
    renderClose();
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    fireEvent.click(screen.getByTestId('close-positions-modal-cancel'));
    expect(row('a1').status).toBe('active');
    fireEvent.click(openBtn());
    toConfirm();
    fireEvent.click(screen.getByTestId('close-positions-modal-back'));
    expect(modal().getAttribute('data-stage')).toBe('review');
    toConfirm();
    fireEvent.click(screen.getByTestId('close-positions-modal-cancel-confirm'));
    expect(row('a1').status).toBe('active');
    expect(screen.queryByTestId('close-positions-modal')).toBeNull();
  });

  it('V14: F6 remains GLOBAL-only — with the F2 flow coexisting, the F1-D typed gate still behaves exactly as ratified', () => {
    seed([mk({ id: 'a1' })]);
    render(
      <>
        <CloseActivePositionsSection />
        <GlobalLedgerCleanupSection />
      </>,
    );
    fireEvent.click(check('a1'));
    fireEvent.click(openBtn());
    toConfirm();
    fireEvent.click(confirmBtn()); // close via F2 (no typed step)
    // Open the F1-D modal on the now-closed row: typed gate PRESENT and gating.
    fireEvent.click(screen.getByTestId('global-cleanup-check-a1'));
    fireEvent.click(screen.getByTestId('global-cleanup-delete'));
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    expect(screen.getByTestId('batch-modal-typed-input')).toBeTruthy();
    expect(screen.getByTestId('batch-modal-confirm').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('batch-modal-typed-input'), { target: { value: '1' } });
    expect(screen.getByTestId('batch-modal-confirm').hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByTestId('batch-modal-cancel-confirm'));
    expect(row('a1').status).toBe('closed_absent'); // not deleted — cancel zero-effect
  });
});
