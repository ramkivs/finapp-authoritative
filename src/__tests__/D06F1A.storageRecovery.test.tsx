/**
 * D-06-F1-A — CONFIRM PERSISTENCE REFUSAL → RECOVERY → RETRY.
 *
 * What the diagnosis proved and this suite locks in:
 *   after a genuine IndexedDB LOAD failure the write guard in
 *   `IndexedDBStorageService.performSave` refuses EVERY save
 *   ("Refusing to persist: the last IndexedDB load failed…"), `MemoryRepository.write`
 *   rolls the import back (`revertDelta`), `handleConfirm`'s `.catch` keeps the
 *   preview mounted, and the ClosureTable checkboxes stay `disabled` because the
 *   canonical rows are `active` again. The checkbox was NEVER the defect; the
 *   dead end was that nothing in the Confirm failure path could run the one
 *   legitimate recovery — a successful load — and the user could not tell a
 *   saved import from a refused one.
 *
 * The correction under test:
 *   - `IndexedDBStorageService.isLedgerLoadRefusal()` — latch-derived
 *     classification of the refusal (no message sniffing). The latch itself is
 *     untouched by the correction: it still clears ONLY inside a successful
 *     `loadAll()`;
 *   - `useCanonicalLedger.recoverStorage()` — runs the legitimate full load via
 *     `repository.initialize()`; reports the real outcome; fabricates nothing;
 *   - `BrokerImportSection` — on a refusal-class Confirm failure the commit
 *     notice stays an ERROR notice and a `Retry storage` affordance appears;
 *     after a successful recovery the user EXPLICITLY re-clicks `Confirm import`
 *     (never an automatic replay).
 *
 * Deliberately NOT tested as "native": the load failures here are injected
 * through the shipped test hook onto REAL fake-indexeddb storage, so the
 * persistence BRANCH (queue, guard, rollback, recovery, retry, re-persist) is
 * real, while the physical cause (Chrome refusing `open()`/`transaction()`)
 * remains a Windows validation item.
 *
 * Contract preserved and asserted: eligibility is exactly
 * `status === 'closed_absent'`; whole-batch atomicity; explicit confirm;
 * irreversible, batch-attributable audit; DB_VERSION 7, no migration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// Must be imported BEFORE the app modules: it installs `window.indexedDB`
// so the REAL persistence branch (guard, queue, transactions) executes.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';

import { BrokerImportSection } from '../pages/BrokerImportSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import type { Holding } from '../domain/types';

// ---------------------------------------------------------------------------
// The REAL Dhan "Stock Holdings" sample — the shape the Windows failure was
// reported on: 9 rows, then the same statement minus the last two rows
// (State Bank of India, Wipro) with every LTP +1 → 7 UPDATED + 2 CLOSED_ABSENT.
// ---------------------------------------------------------------------------
const FIXTURE = resolve(__dirname, 'fixtures/cr_broker_bank_import/dhan-stock-holdings.csv');
const RAW = readFileSync(FIXTURE, 'utf8');
const LINES = RAW.split(/\r?\n/).filter((l) => l.trim() !== '');
const HEADER = LINES[0];
const DATA = LINES.slice(1);

/** Re-value one row (LTP +1 → Current Value / P&L recomputed), verbatim columns. */
const bumped = (line: string) => {
  const f = line.match(/("[^"]*"|[^,]+)/g)!.map((x) => x.replace(/^"|"$/g, ''));
  const qty = Number(f[1]);
  const avg = Number(f[2].replace(/,/g, ''));
  const ltp = Number(f[3].replace(/,/g, '')) + 1;
  const inv = qty * avg;
  const cur = qty * ltp;
  const pnl = cur - inv;
  return `"${f[0]}",${f[1]},"${f[2]}","${ltp.toFixed(2)}","${inv.toFixed(2)}","${cur.toFixed(2)}","${pnl.toFixed(2)}","${((pnl / inv) * 100).toFixed(2)}%"`;
};

const FILE1_TEXT = `${HEADER}\r\n${DATA.join('\r\n')}\r\n`;              // 9 rows
const FILE2_TEXT = `${HEADER}\r\n${DATA.slice(0, 7).map(bumped).join('\r\n')}\r\n`; // 7 rows → 2 closures

const CLOSED_INSTRUMENTS = ['State Bank of India', 'Wipro'];

function csvFile(content: string, name: string): File {
  const file = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => content });
  return file;
}

// ---------------------------------------------------------------------------
// DOM helpers — ids are parser-generated, so rows are found by instrument.
// ---------------------------------------------------------------------------
const rowBoxFor = (instrument: string) =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-testid^="batch-select-checkbox-"]'))
    .find((el) => (el.closest('tr')?.textContent ?? '').includes(instrument)) ?? null;

const rowDeleteFor = (instrument: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-testid^="delete-holding-button-"]'))
    .find((el) => (el.closest('tr')?.textContent ?? '').includes(instrument)) ?? null;

const confirmButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => /Confirm import/i.test(b.textContent ?? '')) ?? null;

const statusOf = (instrument: string): Holding['status'] | undefined =>
  useCanonicalLedger.getState().holdings.find((h) => h.instrumentName === instrument)?.status;

const storeRows = () => useCanonicalLedger.getState().holdings.length;

async function upload(content: string, name: string) {
  fireEvent.change(screen.getByTestId('broker-file-input'), {
    target: { files: [csvFile(content, name)] },
  });
  await waitFor(() => expect(document.body.textContent).toContain('Step 4: Broker Import — Preview'));
}

async function clickConfirm() {
  const btn = confirmButton();
  if (!btn) throw new Error('Confirm import button not rendered');
  expect(btn.disabled, 'a mutation-bearing preview must be confirmable').toBe(false);
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByTestId('broker-import-commit-notice')).toBeTruthy());
}

/** Arm the failed-load state exactly as a real browser does: a load that is
 *  ATTEMPTED and FAILS. Nothing else can raise the guard (`performSave` reads
 *  only `lastLoadFailed`). */
async function armRefusalByFailingOneLoad() {
  (IndexedDBStorageService as unknown as { simulateReadFailureOnce: boolean }).simulateReadFailureOnce = true;
  await expect(IndexedDBStorageService.loadAll()).rejects.toThrow('Simulated IndexedDB read failure');
  expect(IndexedDBStorageService.loadFailed).toBe(true);
  expect(IndexedDBStorageService.isLedgerLoadRefusal()).toBe(true);
}

async function clearRefusalByRealLoad() {
  await useCanonicalLedger.getState().initialize();
  expect(IndexedDBStorageService.loadFailed).toBe(false);
}

// ---------------------------------------------------------------------------

describe('D-06-F1-A — Confirm persistence refusal, recovery and explicit retry', () => {
  beforeEach(async () => {
    cleanup();
    await IndexedDBStorageService.clearAll();
    const repo = repository as unknown as {
      holdingsData: Holding[];
      holdingDeletionLogData: unknown[];
      syncStore: () => void;
      initialize: () => Promise<void>;
    };
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [], holdingDeletionLog: [] } as never);
    await repo.initialize();
  });

  afterEach(async () => {
    cleanup();
    (IndexedDBStorageService as unknown as { simulateReadFailureOnce: boolean }).simulateReadFailureOnce = false;
    (IndexedDBStorageService as unknown as { simulateFailureOnce: boolean }).simulateFailureOnce = false;
    await clearRefusalByRealLoad();
    await IndexedDBStorageService.clearAll();
  });

  // -------------------------------------------------------------------------
  // T1 — healthy path: normal load → Confirm → persistence succeeds →
  //      closed_absent → selectable.
  // -------------------------------------------------------------------------
  it('T1: healthy persistence closes the rows and makes them selectable', async () => {
    render(<BrokerImportSection />);
    await upload(FILE1_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    expect(screen.getByTestId('broker-import-commit-notice').textContent)
      .toContain('Imported 9 new, 0 updated, 0 closed-absent, 0 unchanged.');
    expect(storeRows()).toBe(9);
    expect(IndexedDBStorageService.loadFailed).toBe(false);

    await upload(FILE2_TEXT, 'dhan-stock-holdings.csv');
    for (const name of CLOSED_INSTRUMENTS) {
      const box = rowBoxFor(name)!;
      expect(box.disabled, `${name} disabled pre-confirm (preview phase)`).toBe(true);
    }
    await clickConfirm();
    expect(screen.getByTestId('broker-import-commit-notice').getAttribute('data-notice-kind'))
      .toBe('success');
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name)).toBe('closed_absent');
      const box = rowBoxFor(name)!;
      expect(box.disabled, `${name} selectable after a SAVED confirm`).toBe(false);
      expect(rowDeleteFor(name)!.disabled).toBe(false);
    }
    expect(screen.queryByTestId('storage-recovery-panel')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T2 — failed-load refusal: load fails → Confirm refused → canonical
  //      rollback → active → checkbox DISABLED → affordance offered.
  // T3 — recovery: recovery load succeeds → refusal cleared.
  // T4 — retry: explicit Confirm after recovery → persisted → closed_absent
  //      → selectable.
  // -------------------------------------------------------------------------
  it('T2+T3+T4: refusal keeps rows disabled and honest; recovery then an EXPLICIT retry lands the commit', async () => {
    render(<BrokerImportSection />);

    // A prior session persisted a real ledger — the store has data at rest.
    await upload(FILE1_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    expect(storeRows()).toBe(9);

    // The user reloads and THAT load fails. Failed load → guard armed.
    await armRefusalByFailingOneLoad();

    // The second import: 7 updated + 2 closures — the exact Windows shape.
    await upload(FILE2_TEXT, 'dhan-stock-holdings.csv');
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name)).toBe('active');
      expect(rowBoxFor(name)!.disabled).toBe(true);
    }

    // CONFIRM → refused at the persistence boundary.
    await clickConfirm();
    const notice = screen.getByTestId('broker-import-commit-notice');
    expect(notice.getAttribute('data-notice-kind'), 'refusal is an ERROR notice, never success')
      .toBe('error');
    expect(notice.textContent).toContain('Refusing to persist: the last IndexedDB load failed');

    // The canonical mutation rolled back; the ledger still says `active`;
    // the checkboxes stay DISABLED — correct behaviour, unchanged.
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name), `${name} rolled back to active`).toBe('active');
      const box = rowBoxFor(name)!;
      expect(box.disabled, `${name} stays disabled while the commit did not land`).toBe(true);
      expect(box.checked).toBe(false);
      expect(rowDeleteFor(name)!.disabled, 'no deletion path opens either').toBe(true);
    }
    expect(storeRows(), 'no row was lost or fabricated').toBe(9);
    // Preview is still mounted (documented, expected) — and the row tooltip is
    // now HONEST about it: it must not promise selection "after confirmation"
    // while the confirmation actually failed.
    const sbiBox = rowBoxFor('State Bank of India')!;
    expect(sbiBox.title).toContain('the Confirm FAILED');
    expect(sbiBox.title).not.toMatch(/becomes selectable after the import is confirmed$/);

    // The recovery affordance is shown for exactly this failure class.
    const panel = screen.getByTestId('storage-recovery-panel');
    expect(panel.getAttribute('data-recovery-state')).toBe('offered');
    expect(panel.textContent).toContain('Import could not be saved because local storage could not be read');
    expect(screen.getByTestId('storage-retry-button').textContent).toContain('Retry storage');

    // T3 — recovery: the legitimate load runs; the latch clears inside it.
    fireEvent.click(screen.getByTestId('storage-retry-button'));
    await waitFor(() =>
      expect(screen.getByTestId('storage-recovery-panel').getAttribute('data-recovery-state'))
        .toBe('recovered'));
    expect(IndexedDBStorageService.loadFailed).toBe(false);
    expect(IndexedDBStorageService.isLedgerLoadRefusal()).toBe(false);
    expect(storeRows(), 'recovery re-read the SAME stored ledger').toBe(9);
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name), 'recovery alone does not import anything').toBe('active');
    }
    // Recovery must NOT have re-labelled the failed commit as a success.
    expect(screen.getByTestId('broker-import-commit-notice').getAttribute('data-notice-kind'))
      .toBe('error');
    expect(screen.getByTestId('storage-recovery-panel').textContent)
      .toContain('Your import was NOT saved');

    // T4 — EXPLICIT retry: the user clicks Confirm again. Nothing was
    // replayed automatically, and this time the write goes through.
    await clickConfirm();
    expect(screen.getByTestId('broker-import-commit-notice').getAttribute('data-notice-kind'))
      .toBe('success');
    expect(screen.getByTestId('broker-import-commit-notice').textContent)
      .toContain('Imported 0 new, 7 updated, 2 closed-absent, 0 unchanged.');
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name)).toBe('closed_absent');
      expect(rowBoxFor(name)!.disabled).toBe(false);
      expect(rowDeleteFor(name)!.disabled).toBe(false);
    }
    // And it is really ON DISK now — a reload keeps the closed state.
    await repository.initialize();
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name), 'persistence actually landed').toBe('closed_absent');
    }
  });

  // -------------------------------------------------------------------------
  // T5 — recovery failure: the recovery load FAILS → the refusal REMAINS,
  //      a real error is reported, no false success, no mutation possible.
  // -------------------------------------------------------------------------
  it('T5: a failed recovery keeps the refusal armed and fabricates nothing', async () => {
    render(<BrokerImportSection />);
    await upload(FILE1_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    await armRefusalByFailingOneLoad();
    await upload(FILE2_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    expect(screen.getByTestId('storage-recovery-panel').getAttribute('data-recovery-state'))
      .toBe('offered');

    // The storage is still broken: the recovery load itself fails.
    (IndexedDBStorageService as unknown as { simulateReadFailureOnce: boolean }).simulateReadFailureOnce = true;
    fireEvent.click(screen.getByTestId('storage-retry-button'));
    await waitFor(() =>
      expect(screen.getByTestId('storage-recovery-panel').textContent).toContain('Recovery failed:'));
    expect(screen.getByTestId('storage-recovery-panel').getAttribute('data-recovery-state'))
      .toBe('offered');
    expect(IndexedDBStorageService.loadFailed, 'the refusal REMAINS armed').toBe(true);
    expect(useCanonicalLedger.getState().initStatus).toBe('failed');
    for (const name of CLOSED_INSTRUMENTS) {
      expect(statusOf(name), 'a failed recovery changed nothing').toBe('active');
      expect(rowBoxFor(name)!.disabled).toBe(true);
      expect(rowDeleteFor(name)!.disabled).toBe(true);
    }
    expect(screen.getByTestId('broker-import-commit-notice').getAttribute('data-notice-kind'))
      .toBe('error');

    // Confirming again is still refused — honestly, not silently swallowed.
    await clickConfirm();
    expect(screen.getByTestId('broker-import-commit-notice').textContent)
      .toContain('Refusing to persist');
    expect(storeRows()).toBe(9);

    // A real load fixes it (recovery is repeatable until it succeeds).
    await clearRefusalByRealLoad();
    expect(useCanonicalLedger.getState().initStatus).toBe('ready');
  });

  // -------------------------------------------------------------------------
  // T6 — batch safety after a RECOVERED confirm: the recovered commit is
  //      indistinguishable from a healthy one — select two → batch delete →
  //      atomic deletion, batch-attributable audit, no asset effect.
  // -------------------------------------------------------------------------
  it('T6: a recovered Confirm leaves the full D-06-F1-A batch contract intact', async () => {
    render(<BrokerImportSection />);
    await upload(FILE1_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    await armRefusalByFailingOneLoad();
    await upload(FILE2_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    fireEvent.click(screen.getByTestId('storage-retry-button'));
    await waitFor(() =>
      expect(screen.getByTestId('storage-recovery-panel').getAttribute('data-recovery-state'))
        .toBe('recovered'));
    await clickConfirm();

    // Explicit user multi-select (unchanged scope: only what they ticked).
    const boxes = CLOSED_INSTRUMENTS.map((n) => rowBoxFor(n)!);
    expect(boxes.every((b) => !b.disabled)).toBe(true);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(screen.getByTestId('batch-delete-count').textContent).toContain('2 closed_absent holdings selected');
    fireEvent.click(screen.getByTestId('batch-delete-button'));

    // Two-stage review → explicit confirmation (unchanged).
    await waitFor(() => expect(screen.getByTestId('batch-delete-modal')).toBeTruthy());
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));
    await waitFor(() => expect(screen.queryByTestId('batch-delete-modal')).toBeNull());

    // Atomic whole-batch deletion + batch-attributable audit.
    expect(storeRows(), 'the whole batch went, nothing else').toBe(7);
    for (const name of CLOSED_INSTRUMENTS) expect(statusOf(name)).toBeUndefined();
    const log = useCanonicalLedger.getState().holdingDeletionLog;
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.batchId && e.batchScope === 'MULTI_SELECT')).toBe(true);
    expect(new Set(log.map((e) => e.batchId))).toHaveLength(1);

    // D-06-F10-C — no asset effect; transactions/snapshots untouched.
    expect(useCanonicalLedger.getState().assets).toHaveLength(0);
    expect(useCanonicalLedger.getState().transactions).toHaveLength(0);
    expect(useCanonicalLedger.getState().snapshots).toHaveLength(0);

    // The deletion persisted through the SAME recovered path.
    await repository.initialize();
    expect(useCanonicalLedger.getState().holdingDeletionLog).toHaveLength(2);
    expect(useCanonicalLedger.getState().holdings.find((h) => h.instrumentName === 'Wipro')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // §7 concurrency — the recovery load must not wait forever on the refused
  // write: `enqueueSave` releases the mutex when the task REJECTS, so the
  // recovery `loadAll()` that lands behind the refusal always starts.
  // -------------------------------------------------------------------------
  it('the refused write releases the queue — a recovery load settles promptly', async () => {
    await upload1();
    await armRefusalByFailingOneLoad();

    // A write attempted while the guard is armed REJECTS with the refusal —
    // it settles, it does not wedge `enqueueSave`'s mutex.
    let writeOutcome = 'resolved';
    try {
      await (repository as unknown as { write: (m: () => void) => Promise<void> }).write(() => { /* no-op */ });
    } catch (e) {
      writeOutcome = `rejected: ${e instanceof Error ? e.message : String(e)}`;
    }
    expect(writeOutcome).toContain('Refusing to persist');

    // So the recovery load that lands on the SAME queue cannot wait forever
    // on the poisoned operation: it starts and settles. (If it wedged, this
    // test would hit the vitest timeout — that is the assertion.)
    const t1 = Date.now();
    const outcome = await useCanonicalLedger.getState().recoverStorage();
    expect(outcome.recovered).toBe(true);
    expect(Date.now() - t1, 'recovery queued behind a REFUSED (settled) write still completes').toBeLessThan(2000);
  });

  async function upload1() {
    render(<BrokerImportSection />);
    await upload(FILE1_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
  }

  // -------------------------------------------------------------------------
  // §12 data safety — recovery never clears/recreates the database:
  // DB_VERSION stays 7 and `holdings` survive a refusal + recovery cycle.
  // -------------------------------------------------------------------------
  it('recovery does not clear or migrate the database', async () => {
    const before = await IndexedDBStorageService.loadAll();
    expect(before.holdings).toHaveLength(0);
    await uploadHelper();
    const mid = await IndexedDBStorageService.loadAll();
    expect(mid.holdings).toHaveLength(9);

    await armRefusalByFailingOneLoad();
    const outcome = await useCanonicalLedger.getState().recoverStorage();
    expect(outcome.recovered).toBe(true);

    const after = await IndexedDBStorageService.loadAll();
    expect(after.holdings).toHaveLength(9);
    const version = await new Promise<number>((res, rej) => {
      const rq = indexedDB.open('finboom_db');
      rq.onsuccess = () => { const v = rq.result.version; rq.result.close(); res(v); };
      rq.onerror = () => rej(rq.error);
    });
    expect(version, 'DB_VERSION untouched — no migration happened').toBe(7);
  });

  async function uploadHelper() {
    render(<BrokerImportSection />);
    await upload(FILE1_TEXT, 'dhan-stock-holdings.csv');
    await clickConfirm();
    cleanup();
  }

  // -------------------------------------------------------------------------
  // Source-text promotion guards — the correction must not drift into the
  // eligibility logic or weaken the guard it sits behind.
  // -------------------------------------------------------------------------
  it('promotion guards: eligibility predicate and the persistence guard remain verbatim', () => {
    const ui = readFileSync(resolve(__dirname, '../pages/BrokerImportSection.tsx'), 'utf8');
    const svc = readFileSync(resolve(__dirname, '../services/IndexedDBStorageService.ts'), 'utf8');
    const store = readFileSync(resolve(__dirname, '../store/useCanonicalLedger.ts'), 'utf8');

    // Eligibility untouched — exactly the canonical predicate, nowhere looser.
    expect(ui).toContain('const isDeletionEligible = (h: Holding) => h.status === \'closed_absent\';');
    expect(ui.match(/status\s*!==\s*'active'/g) ?? [], 'never broadened to "not ACTIVE"').toHaveLength(0);
    // `disabled` is driven ONLY by eligibility — no preview/phase/recovery term.
    expect(ui).toContain('disabled={!isDeletionEligible(live)}');
    expect(ui).toContain('checked={isDeletionEligible(live) && selectedIds.has(live.id)}');
    // The guard still reads the latch; recovery never resets it directly.
    expect(svc).toContain('if (this.lastLoadFailed) {');
    const svcCode = svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(svcCode.match(/this\.lastLoadFailed\s*=\s*false/g) ?? [],
      'only the two LOAD paths may clear the latch')
      .toHaveLength(2);
    expect(svcCode.match(/this\.lastLoadFailed\s*=/g) ?? []).toHaveLength(4); // 2× true (failure paths), 2× false (load paths)
    expect(svc).toContain('return this.lastLoadFailed;');
    // The store recovery routes through the legitimate load and re-checks the
    // latch instead of asserting success.
    expect(store).toContain('await get().initialize();');
    expect(store).toContain('recovered: !IndexedDBStorageService.loadFailed');
    // No recovery term may ever touch the closure CHECKBOX expression — the
    // only `disabled` that may gate selection is `!isDeletionEligible(live)`.
    const cbStart = ui.indexOf('batch-select-checkbox');
    const cbBlock = ui.slice(cbStart, ui.indexOf('onChange', cbStart));
    expect(cbBlock).toContain('disabled={!isDeletionEligible(live)}');
    expect(cbBlock).not.toContain('storageRecovery');
    // Dhan fixture sanity: the closure rows are exactly the last two rows.
    expect(CLOSED_INSTRUMENTS.every((n) => RAW.includes(n))).toBe(true);
  });
});
