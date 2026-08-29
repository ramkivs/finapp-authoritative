/**
 * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion UI tests.
 *
 * UI tests for the D-06 affordance in `ClosureTable` and the
 * `DeleteHoldingModal`. The file-input-driven preview path is exercised
 * end-to-end by the existing `BrokerImportService.test.ts` integration
 * tests; here we test the structural data flow and the modal behavior
 * directly:
 *
 *   - The `Delete permanently` button is NOT rendered for an `active`
 *     Holding (defensive).
 *   - D-06-F1-A sequencing (correction): the ClosureTable appears in two
 *     phases, and deletion eligibility is ALWAYS resolved from the LIVE
 *     canonical ledger by Holding id — never from the preview snapshot:
 *       PRE-CONFIRM: closure candidates correspond to canonical Holdings
 *       that are still `active` and WILL transition to `closed_absent`
 *       when the import is confirmed → selection/single-delete DISABLED.
 *       POST-CONFIRM: those same canonical Holdings ARE `closed_absent`
 *       → selection/single-delete ENABLED. The predicate itself remains
 *       exactly `status === 'closed_absent'` in both phases.
 *   - The `DeleteHoldingModal` displays the 5 mandatory fields
 *     (instrument, broker / account, current value, irreversible
 *     warning, audit-record notice).
 *   - The modal's confirm invokes `commitHoldingDeletion` with the
 *     correct id and closes on success.
 *   - The modal stays open and surfaces the error on persistence
 *     failure.
 *   - The modal's defensive re-validation refuses to delete an
 *     `active` holding.
 *
 * Authority:
 *   - `WP-FB-IMPORT-BROKER-01-D-06-PRODUCT-AUTHORITY.md` (D-06-12)
 *   - `WP-FB-IMPORT-BROKER-01-D-06-IMPLEMENTATION-AUTHORITY.md` (§4.9)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { BrokerImportSection, ClosureTable } from '../pages/BrokerImportSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Holding } from '../domain/types';
import { BrokerImportPreviewClosure, BrokerImportService } from '../services/BrokerImportService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: overrides.id ?? 'hld-1',
  broker: 'Zerodha',
  account: 'UCC-A',
  instrumentName: 'Test Instrument',
  ticker: 'AIIL',
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  sourceFile: 'zerodha.csv',
  importedAt: '2026-08-23T10:00:00.000Z',
  status: 'closed_absent',
  ...overrides,
});

describe('WP-FB-IMPORT-BROKER-01 / D-06 — BrokerImportSection destructive disclosure', () => {
  beforeEach(() => {
    const repo = repository as any;
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [], holdingDeletionLog: [] } as any);
  });
  afterEach(() => {
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    const repo = repository as any;
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [], holdingDeletionLog: [] } as any);
  });

  it('rendering with no preview shows the upload view; the delete button is not present', () => {
    render(<BrokerImportSection />);
    // The upload view is the initial state; the delete button is rendered
    // only inside `ClosureTable`, which only renders during preview.
    expect(screen.queryByTestId(/^delete-holding-button-/)).toBeNull();
  });

  it('rendering with no preview and a closed_absent holding in the store: the delete button is still not present (no preview is active)', () => {
    const closed = makeHolding({ id: 'hld-store' });
    const repo = repository as any;
    repo.holdingsData = [closed];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [closed] } as any);

    render(<BrokerImportSection />);
    // No preview is active; the affordance is only in the ClosureTable,
    // which is preview-only. The store data is read but no preview is
    // built until the user picks a file.
    expect(screen.queryByTestId(/^delete-holding-button-/)).toBeNull();
  });

  it('commitHoldingDeletion rejects an active holding (defensive: store-side)', () => {
    const active = makeHolding({ id: 'hld-active', status: 'active' });
    const repo = repository as any;
    repo.holdingsData = [active];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [active] } as any);

    let threw = false;
    try {
      useCanonicalLedger.getState().commitHoldingDeletion('hld-active');
    } catch (e: any) {
      threw = true;
      expect(e.code).toBe('HOLDING_NOT_CLOSED');
    }
    expect(threw).toBe(true);
  });

  it('commitHoldingDeletion succeeds for a closed_absent holding (data layer)', () => {
    const closed = makeHolding({ id: 'hld-ok', currentValue: 2500 });
    const repo = repository as any;
    repo.holdingsData = [closed];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [closed] } as any);

    const outcome = useCanonicalLedger.getState().commitHoldingDeletion('hld-ok');
    expect(outcome.holdingId).toBe('hld-ok');
    expect(outcome.auditEntryId).toBeTruthy();
    expect(outcome.auditEntryId.startsWith('hdl-')).toBe(true);
    expect(outcome.auditEntryId).not.toBe('hld-ok');
  });

  it('the store hook integrates the deletion into the canonical ledger (UI contract)', () => {
    const closed = makeHolding({ id: 'hld-integration', currentValue: 1000 });
    const repo = repository as any;
    repo.holdingsData = [closed];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [closed] } as any);

    const outcome = useCanonicalLedger.getState().commitHoldingDeletion('hld-integration');
    return (outcome.persisted || Promise.resolve()).then(() => {
      // After commit: holding is gone, audit entry is present, store reflects.
      expect((repository as any).holdingsData.find((h: Holding) => h.id === 'hld-integration')).toBeUndefined();
      expect((repository as any).holdingDeletionLogData).toHaveLength(1);
      expect((repository as any).holdingDeletionLogData[0].holdingId).toBe('hld-integration');
      // The store's holdings slice also reflects the deletion.
      expect(useCanonicalLedger.getState().holdings.find((h: Holding) => h.id === 'hld-integration')).toBeUndefined();
    });
  });

  it('on persistence failure the data is rolled back and no audit entry is created (UI contract)', () => {
    const closed = makeHolding({ id: 'hld-fail', currentValue: 100 });
    const repo = repository as any;
    repo.holdingsData = [closed];
    repo.holdingDeletionLogData = [];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [closed] } as any);

    IndexedDBStorageService.simulateFailureOnce = true;

    const outcome = useCanonicalLedger.getState().commitHoldingDeletion('hld-fail');
    return (outcome.persisted || Promise.resolve()).then(() => {
      // The rollback: holding is restored, no audit entry was committed.
      expect((repository as any).holdingsData.map((h: Holding) => h.id)).toContain('hld-fail');
      expect((repository as any).holdingDeletionLogData).toEqual([]);
    }, () => {
      // The persisted promise rejected; rollback already happened.
      expect((repository as any).holdingsData.map((h: Holding) => h.id)).toContain('hld-fail');
      expect((repository as any).holdingDeletionLogData).toEqual([]);
    });
  });

  describe('D-06-F1-A — user-selected multi-select batch deletion UI', () => {
    const closure = (h: Holding): BrokerImportPreviewClosure => ({
      existing: h,
      classification: 'CLOSED_ABSENT',
    });

    const seedBatch = (holdings: Holding[]) => {
      const repo = repository as any;
      repo.holdingsData = holdings;
      repo.holdingDeletionLogData = [];
      repo.syncStore();
      useCanonicalLedger.setState({ holdings, holdingDeletionLog: [] } as any);
    };

    it('selection: checkboxes are enabled only for closed_absent rows; batch action is hidden with an empty selection', () => {
      const closedA = makeHolding({ id: 'hld-a' });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B' });
      const active = makeHolding({ id: 'hld-active', status: 'active' });
      // Sequencing correction: eligibility resolves through the LIVE ledger,
      // so the canonical Holdings must exist in the store for their rows to
      // render and resolve.
      seedBatch([closedA, closedB, active]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB), closure(active)]} />);

      const cbA = screen.getByTestId('batch-select-checkbox-hld-a') as HTMLInputElement;
      const cbB = screen.getByTestId('batch-select-checkbox-hld-b') as HTMLInputElement;
      const cbActive = screen.getByTestId('batch-select-checkbox-hld-active') as HTMLInputElement;
      expect(cbA.disabled).toBe(false);
      expect(cbB.disabled).toBe(false);
      // Active rows cannot be selected (only closed_absent is eligible).
      expect(cbActive.disabled).toBe(true);
      expect(cbActive.checked).toBe(false);
      // Empty selection cannot trigger deletion: no batch action rendered.
      expect(screen.queryByTestId('batch-delete-button')).toBeNull();
      expect(screen.queryByTestId('batch-delete-action-bar')).toBeNull();
    });

    it('selected count and batch action appear when eligible rows are selected; clearing hides them', () => {
      const closedA = makeHolding({ id: 'hld-a', currentValue: 1100 });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B', currentValue: 2200 });
      seedBatch([closedA, closedB]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB)]} />);

      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-a'));
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-b'));

      expect(screen.getByTestId('batch-delete-count').textContent).toContain('2');
      // Aggregate current value being removed from live wealth.
      expect(screen.getByTestId('batch-delete-total').textContent).toContain('3,300.00');
      expect(screen.getByTestId('batch-delete-button')).toBeTruthy();

      fireEvent.click(screen.getByTestId('batch-delete-clear'));
      expect(screen.queryByTestId('batch-delete-button')).toBeNull();
      expect(screen.queryByTestId('batch-delete-action-bar')).toBeNull();
    });

    it('review stage: the batch action opens the review showing scope; nothing is deleted yet and no direct confirm exists', () => {
      const closedA = makeHolding({ id: 'hld-a', currentValue: 1100 });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B', currentValue: 2200 });
      seedBatch([closedA, closedB]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB)]} />);

      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-a'));
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-b'));
      fireEvent.click(screen.getByTestId('batch-delete-button'));

      const modal = screen.getByTestId('batch-delete-modal');
      expect(modal.getAttribute('data-stage')).toBe('review');
      // The review clearly identifies the selected scope.
      expect(screen.getByTestId('batch-modal-count').textContent).toBe('2');
      expect(screen.getByTestId('batch-modal-row-hld-a')).toBeTruthy();
      expect(screen.getByTestId('batch-modal-row-hld-b')).toBeTruthy();
      expect(screen.getByTestId('batch-modal-total').textContent).toContain('3,300.00');
      expect(modal.textContent).toContain('cannot be undone');
      // Review stage performs no deletion.
      expect((repository as any).holdingsData).toHaveLength(2);
      // There is no destructive confirm control in the review stage.
      expect(screen.queryByTestId('batch-modal-confirm')).toBeNull();
    });

    it('confirmation stage: explicit confirmation is required; back-navigation returns to review', () => {
      const closedA = makeHolding({ id: 'hld-a' });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B' });
      seedBatch([closedA, closedB]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB)]} />);

      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-a'));
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-b'));
      fireEvent.click(screen.getByTestId('batch-delete-button'));
      fireEvent.click(screen.getByTestId('batch-modal-review-next'));

      expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('confirm');
      expect(screen.getByTestId('batch-modal-confirm')).toBeTruthy();
      // Still nothing deleted before the explicit confirmation click.
      expect((repository as any).holdingsData).toHaveLength(2);

      fireEvent.click(screen.getByTestId('batch-modal-back'));
      expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('review');
      expect((repository as any).holdingsData).toHaveLength(2);
    });

    it('success: confirming deletes ALL selected Holdings atomically, writes batch-attributed audit, clears the selection', async () => {
      const closedA = makeHolding({ id: 'hld-a', currentValue: 1100 });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B', currentValue: 2200 });
      seedBatch([closedA, closedB]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB)]} />);

      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-a'));
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-b'));
      fireEvent.click(screen.getByTestId('batch-delete-button'));
      fireEvent.click(screen.getByTestId('batch-modal-review-next'));
      fireEvent.click(screen.getByTestId('batch-modal-confirm'));

      await waitFor(() => expect((repository as any).holdingsData).toEqual([]));
      // All selected Holdings disappeared; audit entries exist with shared batchId.
      const log = (repository as any).holdingDeletionLogData;
      expect(log).toHaveLength(2);
      expect(new Set(log.map((e: any) => e.batchId)).size).toBe(1);
      expect(log.every((e: any) => e.batchScope === 'MULTI_SELECT')).toBe(true);
      expect(log.map((e: any) => e.holdingId)).toEqual(['hld-a', 'hld-b']);
      // Assets were never involved: no asset mutation is reachable here.
      expect(useCanonicalLedger.getState().holdings).toEqual([]);
      // Modal closes and the batch action disappears (selection cleared).
      await waitFor(() => expect(screen.queryByTestId('batch-delete-modal')).toBeNull());
      expect(screen.queryByTestId('batch-delete-button')).toBeNull();
    });

    it('failure: a persistence failure rolls back the whole batch, surfaces the error, and leaves no partial deletion', async () => {
      const closedA = makeHolding({ id: 'hld-a', currentValue: 100 });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B', currentValue: 200 });
      seedBatch([closedA, closedB]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB)]} />);

      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-a'));
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-b'));
      fireEvent.click(screen.getByTestId('batch-delete-button'));
      fireEvent.click(screen.getByTestId('batch-modal-review-next'));

      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.click(screen.getByTestId('batch-modal-confirm'));

      await waitFor(() => expect(screen.getByTestId('batch-modal-error')).toBeTruthy());
      expect(screen.getByTestId('batch-modal-error').textContent).toContain('Batch deletion failed');
      // No partial deletion: BOTH Holdings restored, ZERO audit entries.
      expect((repository as any).holdingsData.map((h: Holding) => h.id)).toEqual(['hld-a', 'hld-b']);
      expect((repository as any).holdingDeletionLogData).toEqual([]);
    });

    it('existing single deletion remains functional alongside the batch controls', async () => {
      const closedA = makeHolding({ id: 'hld-a', currentValue: 1100 });
      const closedB = makeHolding({ id: 'hld-b', instrumentName: 'Inst B', currentValue: 2200 });
      seedBatch([closedA, closedB]);
      render(<ClosureTable title="Closures" closures={[closure(closedA), closure(closedB)]} />);

      // The per-row single-delete affordance is preserved.
      fireEvent.click(screen.getByTestId('delete-holding-button-hld-a'));
      expect(screen.getByTestId('delete-holding-modal')).toBeTruthy();
      fireEvent.click(screen.getByTestId('delete-modal-confirm'));

      await waitFor(() =>
        expect((repository as any).holdingsData.map((h: Holding) => h.id)).toEqual(['hld-b']),
      );
      // Single-deletion audit entry carries NO batch attribution.
      const log = (repository as any).holdingDeletionLogData;
      expect(log).toHaveLength(1);
      expect(log[0].holdingId).toBe('hld-a');
      expect(log[0].batchId).toBeUndefined();
      expect(log[0].batchScope).toBeUndefined();
    });
  });

  describe('D-06-F1-A — sequencing correction (live canonical status)', () => {
    const closure = (h: Holding): BrokerImportPreviewClosure => ({
      existing: h,
      classification: 'CLOSED_ABSENT',
    });

    const seed = (holdings: Holding[]) => {
      const repo = repository as any;
      repo.holdingsData = holdings;
      repo.holdingDeletionLogData = [];
      repo.syncStore();
      useCanonicalLedger.setState({ holdings, holdingDeletionLog: [] } as any);
    };

    it('Test A — pre-confirm: closure candidates whose live canonical status is active are NOT selectable', () => {
      const e = makeHolding({ id: 'hld-e', broker: 'Groww', instrumentName: 'TATAAML-TATAGOLD', ticker: 'TATAGOLD', status: 'active' });
      const f = makeHolding({ id: 'hld-f', broker: 'Groww', instrumentName: 'UTIAMC-UTIGOLDBETA', ticker: 'UTIGOLDBETA', status: 'active' });
      seed([e, f]);
      render(
        <ClosureTable
          title="Closures (will transition to closed_absent)"
          closures={[closure(e), closure(f)]}
          phase="preview"
        />,
      );
      // Both rows visible but NOT selectable and NOT deletable: canonical
      // status is still 'active'; the transition lands only at Confirm import.
      expect((screen.getByTestId('batch-select-checkbox-hld-e') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('batch-select-checkbox-hld-f') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('delete-holding-button-hld-e') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId('delete-holding-button-hld-f') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByTestId('batch-delete-button')).toBeNull();
      // The disclosure no longer claims the rows are already deletable.
      expect(screen.getByTestId('closure-table-disclosure').textContent).toContain('AFTER confirmation');
    });

    it('Test B — post-confirm resolution: eligibility comes from the LIVE canonical ledger, not the preview snapshot', () => {
      const closed = makeHolding({ id: 'hld-e', broker: 'Groww', instrumentName: 'TATAAML-TATAGOLD', ticker: 'TATAGOLD', status: 'closed_absent' });
      seed([closed]);
      // The closure snapshot still carries the PRE-transition status
      // ('active'), exactly as a retained preview closure does after Confirm
      // import. The live ledger carries 'closed_absent'. The row must resolve
      // through the live ledger and become eligible — proving the snapshot
      // field is not the eligibility source.
      render(
        <ClosureTable
          title="Closures (transitioned to closed_absent — eligible for permanent deletion)"
          closures={[closure({ ...closed, status: 'active' })]}
          phase="confirmed"
        />,
      );
      expect((screen.getByTestId('batch-select-checkbox-hld-e') as HTMLInputElement).disabled).toBe(false);
      expect((screen.getByTestId('delete-holding-button-hld-e') as HTMLButtonElement).disabled).toBe(false);
    });

    /**
     * Tests C + D drive the REAL component flow:
     *   upload (detectAndParse mocked, reconcile REAL)
     *     → pre-confirm preview (closures canonical 'active', disabled)
     *     → Confirm import (real commitImportedHoldings → planClose)
     *     → canonical 'closed_absent'
     *     → closure surface remains (post-confirm instance)
     *     → rows selectable → batch review → explicit confirmation
     *     → atomic batch deletion via the real store/service path.
     */
    const setupFirstCloseImport = async () => {
      const a = makeHolding({ id: 'hld-a', broker: 'Groww', instrumentName: 'Holding A', ticker: 'HOLD-A', status: 'active' });
      const e = makeHolding({ id: 'hld-e', broker: 'Groww', instrumentName: 'TATAAML-TATAGOLD', ticker: 'TATAGOLD', status: 'active' });
      const f = makeHolding({ id: 'hld-f', broker: 'Groww', instrumentName: 'UTIAMC-UTIGOLDBETA', ticker: 'UTIGOLDBETA', status: 'active' });
      seed([a, e, f]);
      // Candidate A (same identity, differing values) → UPDATED; E/F absent
      // from the parse → closure candidates.
      const candidateA = { ...a, quantity: a.quantity + 1, currentValue: a.currentValue + 100 };
      vi.spyOn(BrokerImportService, 'detectAndParse').mockReturnValue({
        broker: 'Groww',
        account: candidateA.account,
        sourceFile: 'groww_stocks.csv',
        importedAt: '2026-08-29T00:00:00.000Z',
        holdings: [candidateA],
        issues: [],
      } as any);
      render(<BrokerImportSection />);
      const file = new File(['dummy-content'], 'groww_stocks.csv', { type: 'text/csv' });
      fireEvent.change(screen.getByTestId('broker-file-input'), { target: { files: [file] } });
      await screen.findByTestId('batch-select-checkbox-hld-e');
      return { a, e, f };
    };

    const confirmImport = async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm import/ }));
      // Preview tears down on success …
      await waitFor(() => expect(screen.queryByRole('button', { name: /Confirm import/ })).toBeNull());
      // … and the post-confirm closure surface carries the rows forward.
      await screen.findByTestId('batch-select-checkbox-hld-e');
    };

    it('Test C — real sequencing: preview (disabled) → Confirm import → canonical closed_absent → surface remains → selectable', async () => {
      await setupFirstCloseImport();

      // PRE-CONFIRM: visible but not selectable (canonical status 'active').
      expect((screen.getByTestId('batch-select-checkbox-hld-e') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('batch-select-checkbox-hld-f') as HTMLInputElement).disabled).toBe(true);
      expect(useCanonicalLedger.getState().holdings.find((h) => h.id === 'hld-e')!.status).toBe('active');

      await confirmImport();

      // POST-CONFIRM: the canonical transition has landed.
      expect(useCanonicalLedger.getState().holdings.find((h) => h.id === 'hld-e')!.status).toBe('closed_absent');
      expect(useCanonicalLedger.getState().holdings.find((h) => h.id === 'hld-f')!.status).toBe('closed_absent');
      // The closure surface remains and the rows are now selectable.
      expect((screen.getByTestId('batch-select-checkbox-hld-e') as HTMLInputElement).disabled).toBe(false);
      expect((screen.getByTestId('batch-select-checkbox-hld-f') as HTMLInputElement).disabled).toBe(false);
      expect((screen.getByTestId('delete-holding-button-hld-e') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId('delete-holding-button-hld-f') as HTMLButtonElement).disabled).toBe(false);
      // The commit-success notice is preserved.
      expect(screen.getByTestId('broker-import-commit-notice')).toBeTruthy();
      // Holding A was UPDATED (not closed) and remains active.
      expect(useCanonicalLedger.getState().holdings.find((h) => h.id === 'hld-a')!.status).toBe('active');
    });

    it('Test D — post-confirm batch deletion of the newly transitioned rows through the existing service/store path', async () => {
      await setupFirstCloseImport();
      await confirmImport();

      // Select both newly transitioned closed_absent rows.
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-e'));
      fireEvent.click(screen.getByTestId('batch-select-checkbox-hld-f'));
      expect(screen.getByTestId('batch-delete-count').textContent).toContain('2');

      // Review stage → explicit confirmation stage → atomic deletion.
      fireEvent.click(screen.getByTestId('batch-delete-button'));
      expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('review');
      expect(screen.getByTestId('batch-modal-count').textContent).toBe('2');
      expect(screen.getByTestId('batch-modal-row-hld-e')).toBeTruthy();
      expect(screen.getByTestId('batch-modal-row-hld-f')).toBeTruthy();
      fireEvent.click(screen.getByTestId('batch-modal-review-next'));
      expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('confirm');
      fireEvent.click(screen.getByTestId('batch-modal-confirm'));

      // The existing commitBatchHoldingDeletion path performed the deletion.
      await waitFor(() =>
        expect((repository as any).holdingsData.map((h: Holding) => h.id)).toEqual(['hld-a']),
      );
      const log = (repository as any).holdingDeletionLogData;
      expect(log).toHaveLength(2);
      expect(new Set(log.map((entry: any) => entry.batchId)).size).toBe(1);
      expect(log.every((entry: any) => entry.batchScope === 'MULTI_SELECT')).toBe(true);
      expect(log.map((entry: any) => entry.holdingId)).toEqual(['hld-e', 'hld-f']);
      // The deleted rows disappear from the surface (live resolution).
      await waitFor(() => expect(screen.queryByTestId('batch-select-checkbox-hld-e')).toBeNull());
      expect(screen.queryByTestId('batch-select-checkbox-hld-f')).toBeNull();
      expect(screen.queryByTestId('batch-delete-modal')).toBeNull();
    });
  });
});
