/**
 * WP-FB-DATA-06c-2c — Restore UI affordance.
 *
 * Decisions implemented: Q1 = (b) count-only history disclosure,
 * Q2 = (a) window.confirm. Scope: whole-batch IMPORT_ROLLBACK restore only.
 *
 * WHAT THIS PACKAGE IS
 *
 * 06c-2b built a restore capability that worked perfectly and that no user
 * could reach: Import History rendered zero restore controls. This exposes it.
 *
 * Every test asserts BEHAVIOUR through the rendered control — that clicking it
 * produces the write the services sanction, and that a blocked control cannot
 * be made to produce one. The WP-21 lesson applies: six controls once rendered
 * and none of them worked.
 *
 *   §1  eligibility parity — the control agrees with the authority
 *   §2  the confirmation tells the truth
 *   §3  the write path
 *   §4  refusals are rendered
 *   §5  restore history disclosure (Q1 = b)
 *   §6  transfers
 *   §7  scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { ImportPage } from '../pages/ImportPage';
import {
  ImportBatchRollbackService, BatchRestoreError
} from '../services/ImportBatchRollbackService';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const rows = (): Transaction[] => repo.transactionsData;
const byId = (id: string) => rows().find(t => t.id === id) as Transaction;
const bal = (a: any) =>
  AccountBalanceService.balance(a.id, S().accounts, S().transactions, ASOF).balance;
const force = (n: Transaction[]) => { repo.transactionsData = n; repo.syncStore(); };
const summaryOf = (id: string) =>
  ImportBatchRollbackService.listBatches(rows()).find(b => b.batchId === id)!;

function reset() {
  repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  } as any);
}
function acct(n: string, o = 0) {
  S().addAccount({ name: n, type: 'Bank', openingBalance: o, asOfDate: '2026-08-01' });
  return S().accounts.find((a: any) => a.name === n);
}
function mkRow(A: any, amount: number, batch: string, id: string, over: any = {}): any {
  return {
    id, date: '2026-08-10', dateStr: '10 Aug 2026', title: id, narration: id.toUpperCase(),
    account: A.name, accountId: A.id, direction: 'CREDIT', type: 'Income',
    category: 'Income', amount, status: 'CLEARED', origin: 'IMPORT',
    importBatchId: batch, sourceProvider: 'SBI', sourceFile: `${batch}.xlsx`,
    recordedAt: '2026-08-11T09:00:00.000Z', ...over
  };
}
async function seed(A: any, batch: string, amounts: number[]) {
  const txs = amounts.map((a, i) => mkRow(A, a, batch, `${batch}-${i}`));
  await repository.transactions.appendMany(txs);
  return txs;
}
async function attempt(fn: () => Promise<any>) {
  try { return { ok: true, value: await fn(), error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}

const renderImport = () => render(<ImportPage />);
const restoreBtn = (id: string) =>
  document.querySelector(`[data-restore-batch="${id}"]`) as HTMLButtonElement;
const rollbackBtn = (id: string) =>
  document.querySelector(`[data-rollback-batch="${id}"]`) as HTMLButtonElement;

/** Captures the confirm() text and answers `answer`. */
function stubConfirm(answer: boolean) {
  const seen: string[] = [];
  vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { seen.push(String(m)); return answer; });
  return seen;
}

describe('WP-FB-DATA-06c-2c — restore UI affordance', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => {
    cleanup();
    resetAsOfDateOverride();
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    reset();
  });

  /* ═══════════════ §1 eligibility parity ═════════════════════════════════ */
  describe('§1 the control agrees with the authority', () => {
    it('AC-1 a ROLLED_BACK batch renders an ENABLED Restore control', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      renderImport();
      expect(restoreBtn('bx')).toBeTruthy();
      expect(restoreBtn('bx').disabled).toBe(false);
      expect(restoreBtn('bx').getAttribute('title')).toContain('2 transaction');
    });

    it('AC-2 a LIVE batch renders a DISABLED Restore control with the reason', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      renderImport();
      expect(restoreBtn('bx').disabled).toBe(true);
      expect(restoreBtn('bx').getAttribute('title')).toContain('not rolled back');
    });

    it('AC-3 an already-restored batch is disabled and says so', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      renderImport();
      expect(restoreBtn('bx').disabled).toBe(true);
      expect(restoreBtn('bx').getAttribute('title')).toContain('already been restored');
    });

    it('AC-5 eligibility comes from the SERVICE, never re-derived', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const spy = vi.spyOn(ImportBatchRollbackService, 'planRestore');
      renderImport();
      expect(spy).toHaveBeenCalledWith('bx', expect.anything());
      // and the rendered state matches what the authority says
      expect(restoreBtn('bx').disabled).toBe(!summaryOf('bx').restoreEligible);
    });

    it('AC-6 Roll Back and Restore are NEVER both enabled', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);

      renderImport();                                     // LIVE
      expect(rollbackBtn('bx').disabled).toBe(false);
      expect(restoreBtn('bx').disabled).toBe(true);
      cleanup();

      await repository.transactions.rollbackBatch('bx');  // ROLLED_BACK
      renderImport();
      expect(rollbackBtn('bx').disabled).toBe(true);
      expect(restoreBtn('bx').disabled).toBe(false);
      cleanup();

      await repository.transactions.restoreBatch('bx');   // restored -> LIVE
      renderImport();
      expect(rollbackBtn('bx').disabled).toBe(false);
      expect(restoreBtn('bx').disabled).toBe(true);
    });

    it('the summary exposes restore eligibility mirroring rollback', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const s = summaryOf('bx');
      expect(s.restoreEligible).toBe(true);
      expect(s.restoreBlockedCode).toBeUndefined();
      expect(s.restoreTargetCount).toBe(1);
      expect(s.restoreUntouchedCount).toBe(0);
    });
  });

  /* ═══════════════ §2 the confirmation tells the truth ═══════════════════ */
  describe('§2 confirmation (Q2 = a)', () => {
    it('AC-7 the confirmation quotes the TARGET count, not the row count', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      // supersede one row -> it becomes SUPERSEDED-excluded and is NOT restorable
      await repository.transactions.supersede([{ targetId: 'bx-0', changes: { amount: 1500 } }]);
      await repository.transactions.rollbackBatch('bx');

      const s = summaryOf('bx');
      expect(s.rowCount).toBe(3);
      expect(s.restoreTargetCount).toBe(1);        // the measured 06c-2c hazard

      const seen = stubConfirm(false);
      renderImport();
      fireEvent.click(restoreBtn('bx'));

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('1 transaction will be returned');
      expect(seen[0]).not.toContain('3 transaction');
      // ...and it discloses the rows it will NOT touch
      expect(seen[0]).toContain('1 other row');
      expect(seen[0]).toContain('stay excluded');
    });

    it('the confirmation states that rollback history is kept', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const seen = stubConfirm(false);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      expect(seen[0]).toContain("rollback stays recorded");
    });

    it('the confirmation omits the untouched clause when there is nothing untouched', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      const seen = stubConfirm(false);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      expect(seen[0]).toContain('2 transactions will be returned');
      expect(seen[0]).not.toContain('stay excluded');
    });

    it('AC-8 DECLINING the confirmation performs no write at all', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));
      const save = vi.spyOn(IndexedDBStorageService, 'persist');
      const spy = vi.spyOn(repository.transactions, 'restoreBatch');
      stubConfirm(false);

      renderImport();
      fireEvent.click(restoreBtn('bx'));

      expect(spy).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(document.getElementById('restore-notice')).toBeNull();
    });
  });

  /* ═══════════════ §3 the write path ═════════════════════════════════════ */
  describe('§3 restoring through the UI', () => {
    it('AC-9 a UI-driven restore returns the money and reports success', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      const live = bal(A);
      await repository.transactions.rollbackBatch('bx');
      expect(bal(A)).toBe(10000);

      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));

      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      expect(document.getElementById('restore-notice')!.getAttribute('data-restore-kind'))
        .toBe('success');
      expect(document.getElementById('restore-notice')!.textContent).toContain('2 transactions');
      expect(bal(A)).toBe(live);
      expect(LedgerExclusionService.excluded(rows())).toHaveLength(0);
    });

    it('the UI goes through the STORE seam, never the repository directly', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const storeSpy = vi.spyOn(S(), 'restoreImportBatch');
      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      expect(storeSpy).toHaveBeenCalledWith('bx');
    });

    it('exactly ONE saveAll for a UI-driven restore', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      const save = vi.spyOn(IndexedDBStorageService, 'persist');
      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('the batch list reconciles itself after the restore', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      stubConfirm(true);
      renderImport();
      expect(document.querySelector('[data-import-batch="bx"]')!
        .getAttribute('data-batch-status')).toBe('ROLLED_BACK');

      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());

      expect(document.querySelector('[data-import-batch="bx"]')!
        .getAttribute('data-batch-status')).toBe('LIVE');
      expect(restoreBtn('bx').disabled).toBe(true);
      expect(rollbackBtn('bx').disabled).toBe(false);
    });

    it('AC-17 a UI-driven restore never changes the row count', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      const n = rows().length;
      await repository.transactions.rollbackBatch('bx');
      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      expect(rows()).toHaveLength(n);
    });
  });

  /* ═══════════════ §4 refusals ═══════════════════════════════════════════ */
  describe('§4 refusals are rendered', () => {
    it('AC-4 UNRECOGNISED_EXCLUSION_REASON disables with its own code and reason', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      force(rows().map(t => t.id === 'bx-1' ? ({ ...t, excludedReason: 'FUTURE' } as any) : t));
      renderImport();
      expect(restoreBtn('bx').disabled).toBe(true);
      const blocked = document.querySelector('[data-batch-restore-blocked]')!;
      expect(blocked.getAttribute('data-batch-restore-blocked')).toBe('UNRECOGNISED_EXCLUSION_REASON');
      expect(blocked.textContent).toContain('does not recognise');
    });

    it('AC-4 WOULD_SPLIT_TRANSFER disables with its own code', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: A.name, destination: B.name, amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'b1', origin: 'IMPORT' as const },
        { ...c, importBatchId: 'b2', origin: 'IMPORT' as const }
      ]);
      force(rows().map(t => ({ ...t, excludedAt: 'T', excludedReason: 'IMPORT_ROLLBACK' as const })));
      renderImport();
      expect(restoreBtn('b1').disabled).toBe(true);
      expect(document.querySelector('[data-import-batch="b1"] [data-batch-restore-blocked]')!
        .getAttribute('data-batch-restore-blocked')).toBe('WOULD_SPLIT_TRANSFER');
    });

    it('AC-4 MIXED_EXCLUSION_REASONS disables with its own code', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: A.name, destination: B.name, amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'bx', origin: 'IMPORT' as const },
        { ...c, importBatchId: 'bx', origin: 'IMPORT' as const }
      ]);
      force(rows().map(t => t.id === d.id
        ? ({ ...t, excludedAt: 'T', excludedReason: 'IMPORT_ROLLBACK' } as any)
        : ({ ...t, excludedAt: 'T', excludedReason: 'SUPERSEDED' } as any)));
      renderImport();
      expect(restoreBtn('bx').disabled).toBe(true);
      expect(document.querySelector('[data-batch-restore-blocked]')!
        .getAttribute('data-batch-restore-blocked')).toBe('MIXED_EXCLUSION_REASONS');
    });

    it('AC-10 a persistence failure renders an ERROR notice and changes nothing', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));
      IndexedDBStorageService.simulateFailureOnce = true;
      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));

      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      const n = document.getElementById('restore-notice')!;
      expect(n.getAttribute('data-restore-kind')).toBe('error');
      expect(n.textContent).toContain('Restore refused.');
      expect(rows()).toEqual(before);
      expect(bal(A)).toBe(10000);
    });

    /* THE MEASURED UI HAZARD (06c-2c gate §6.1). READFAIL and genuine storage
       failures arrive as a plain Error with NO `.code`. A notice keying on the
       code would print "undefined" on the one failure that matters most. */
    it('AC-14 READFAIL renders the MESSAGE and never the string "undefined"', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      vi.spyOn(IndexedDBStorageService, 'persist').mockRejectedValueOnce(
        new Error('Refusing to persist: the last IndexedDB load failed, so the in-memory ledger ' +
                  'may be empty or partial and writing it would destroy stored data.')
      );
      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));

      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      const text = document.getElementById('restore-notice')!.textContent || '';
      expect(text).toContain('Refusing to persist');
      expect(text).not.toContain('undefined');
    });

    it('a refusal thrown by the authority reaches the notice verbatim', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      vi.spyOn(repository.transactions, 'restoreBatch').mockRejectedValueOnce(
        new BatchRestoreError({
          batchId: 'bx', status: 'REFUSED', targetIds: [], untouchedExcludedIds: [],
          refusalCode: 'MIXED_EXCLUSION_REASONS', refusalReason: 'a very specific reason'
        })
      );
      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      expect(document.getElementById('restore-notice')!.textContent)
        .toContain('a very specific reason');
    });

    it('the two notices never contradict — starting a restore clears the rollback notice', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      stubConfirm(true);
      renderImport();
      fireEvent.click(rollbackBtn('bx'));
      await waitFor(() => expect(document.getElementById('rollback-notice')).toBeTruthy());
      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());
      expect(document.getElementById('rollback-notice')).toBeNull();
    });
  });

  /* ═══════════════ §5 restore history (Q1 = b) ═══════════════════════════ */
  describe('§5 restore history disclosure (Q1 = b)', () => {
    it('AC-19 a restored batch discloses "N rows previously restored"', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      renderImport();
      const el = document.querySelector('[data-batch-restored]')!;
      expect(el).toBeTruthy();
      expect(el.getAttribute('data-batch-restored')).toBe('2');
      expect(el.textContent).toContain('2 rows previously restored');
    });

    /* The measured 06c-2c gap: before this, rollback -> restore -> rollback
       rendered EXACTLY like a plain rollback. D6-3 held in the data and was
       invisible on screen. */
    it('AC-19 rollback -> restore -> rollback is now VISIBLY distinguishable', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      await repository.transactions.rollbackBatch('bx');
      renderImport();
      const row = document.querySelector('[data-import-batch="bx"]')!;
      expect(row.getAttribute('data-batch-status')).toBe('ROLLED_BACK');
      expect(row.querySelector('[data-batch-restored]')).toBeTruthy();
      expect(row.textContent).toContain('previously restored');
      cleanup();

      // a batch rolled back ONCE shows no such line
      reset();
      const A2 = acct('A', 10000);
      await seed(A2, 'by', [1000]);
      await repository.transactions.rollbackBatch('by');
      renderImport();
      const plain = document.querySelector('[data-import-batch="by"]')!;
      expect(plain.getAttribute('data-batch-status')).toBe('ROLLED_BACK');
      expect(plain.querySelector('[data-batch-restored]')).toBeNull();
      expect(plain.textContent).not.toContain('previously restored');
    });

    it('a never-restored batch renders no history line', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      renderImport();
      expect(document.querySelector('[data-batch-restored]')).toBeNull();
    });

    it('the history line uses singular for one row', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      renderImport();
      expect(document.querySelector('[data-batch-restored]')!.textContent)
        .toContain('1 row previously restored');
    });
  });

  /* ═══════════════ §6 transfers ══════════════════════════════════════════ */
  describe('§6 transfers', () => {
    it('AC-11 a whole transfer restores both legs from one click', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: A.name, destination: B.name, amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'bx', origin: 'IMPORT' as const },
        { ...c, importBatchId: 'bx', origin: 'IMPORT' as const }
      ]);
      const total = () => bal(A) + bal(B);
      const pre = total();
      await repository.transactions.rollbackBatch('bx');

      stubConfirm(true);
      renderImport();
      fireEvent.click(restoreBtn('bx'));
      await waitFor(() => expect(document.getElementById('restore-notice')).toBeTruthy());

      expect(LedgerExclusionService.isExcluded(byId(d.id))).toBe(false);
      expect(LedgerExclusionService.isExcluded(byId(c.id))).toBe(false);
      expect(total()).toBe(pre);
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(rows())).toHaveLength(0);
    });

    it('AC-11 no UI path can restore a single leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: A.name, destination: B.name, amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'b1', origin: 'IMPORT' as const },
        { ...c, importBatchId: 'b2', origin: 'IMPORT' as const }
      ]);
      force(rows().map(t => ({ ...t, excludedAt: 'T', excludedReason: 'IMPORT_ROLLBACK' as const })));
      const spy = vi.spyOn(repository.transactions, 'restoreBatch');
      stubConfirm(true);
      renderImport();

      expect(restoreBtn('b1').disabled).toBe(true);
      expect(restoreBtn('b2').disabled).toBe(true);
      fireEvent.click(restoreBtn('b1'));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════ §7 scope boundary ═════════════════════════════════════ */
  describe('§7 scope boundary', () => {
    it('AC-15 the restore control exists ONLY in Import History', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      renderImport();
      const all = [...document.querySelectorAll('[data-restore-batch]')];
      expect(all).toHaveLength(1);
      expect(all[0].closest('#import-history')).toBeTruthy();
    });

    it('AC-16 no delete / undo / revert / per-row restore control is rendered', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      renderImport();
      const labels = [...document.querySelectorAll('button')]
        .map(b => (b.textContent || '').trim().toLowerCase());
      expect(labels.filter(l => /delete|undo|revert|remove/.test(l))).toHaveLength(0);
      // the only restore control is the batch one
      expect(labels.filter(l => /restore/.test(l))).toEqual(['restore import']);
      expect(document.querySelector('[data-restore-transaction]')).toBeNull();
    });

    it('the UI added no write primitive — still exactly five', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
    });

    it('no deletion or general-undo surface exists on repo or store', () => {
      const t = repository.transactions as any; const s = S();
      for (const k of ['delete', 'deleteTransaction', 'remove', 'removeTransaction',
                       'removeBatch', 'purge', 'hardDelete', 'tombstone',
                       'restore', 'undo', 'revert', 'restoreTransaction']) {
        expect(typeof t[k]).toBe('undefined');
      }
      for (const k of ['undo', 'deleteTransaction', 'restoreTransaction', 'unsupersedeTransaction']) {
        expect(typeof s[k]).toBe('undefined');
      }
      expect(typeof t.restoreBatch).toBe('function');
      expect(typeof s.restoreImportBatch).toBe('function');
    });

    it('a SUPERSEDED row is never reachable from the restore control', async () => {
      const A = acct('A', 10000);
      await seed(A, 'bx', [1000]);
      await repository.transactions.supersede([{ targetId: 'bx-0', changes: { amount: 1500 } }]);
      renderImport();
      expect(restoreBtn('bx').disabled).toBe(true);
      expect(summaryOf('bx').restoreTargetCount).toBe(0);
      expect(LedgerExclusionService.reasonOf(byId('bx-0'))).toBe('SUPERSEDED');
    });
  });
});
