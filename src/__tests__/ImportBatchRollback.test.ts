/**
 * WP-FB-DATA-06c-6 — Import batch rollback (Decision 13-b).
 *
 * Rolls back an import batch by EXCLUDING its rows, never removing them.
 *
 *   §1  the pure planning authority
 *   §2  refusal conditions
 *   §3  the split-batch transfer guard
 *   §4  applying a rollback
 *   §5  unrelated data preserved
 *   §6  persistence + failure propagation
 *   §7  upstream authorities unchanged
 *   §8  scope boundary — no other lifecycle operation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  ImportBatchRollbackService,
  BatchRollbackError
} from '../services/ImportBatchRollbackService';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { FinancialMetricService } from '../services/FinancialMetricService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { PrismaTransactionRepository } from '../repositories/PrismaRepository';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: any[];
  syncStore: () => void;
};

function reset() {
  repo.transactionsData = []; repo.accountsData = [];
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  });
}
const S = () => useCanonicalLedger.getState();
function acct(name: string, opening = 0) {
  S().addAccount({ name, type: 'Bank' as any, openingBalance: opening, asOfDate: '2026-08-01' });
  return S().accounts.find((a: any) => a.name === name)!;
}
const bal = (a: any) =>
  AccountBalanceService.balance(a.id, S().accounts, S().transactions, ASOF).balance;
const drain = () => new Promise(r => setTimeout(r, 20));
const force = (next: Transaction[]) => { repo.transactionsData = next; repo.syncStore(); };

function importedRow(A: any, over: Partial<Transaction> = {}): Transaction {
  const r: any = {
    id: 'imp-' + Math.random().toString(36).slice(2, 9),
    date: '2026-08-10', dateStr: '10 Aug 2026', title: 'Dividend',
    narration: 'ACH/C/DIV ' + Math.random().toString(36).slice(2, 6),
    account: A.name, accountId: A.id, type: 'Income', direction: 'CREDIT',
    category: 'DIVIDEND', amount: 100, status: 'CLEARED', origin: 'IMPORT',
    recordedAt: '2026-08-22T00:00:00.000Z', importBatchId: 'batch-A',
    sourceProvider: 'SBI Bank', sourceFile: 'SBI.xlsx', sourceRowNumber: 1, ...over
  };
  r.fingerprint = TransactionIdentityService.fingerprint(r);
  return r;
}

async function seedBatch(A: any, batchId: string, amounts: number[]) {
  const rows = amounts.map((amt, i) =>
    importedRow(A, { id: `${batchId}-${i}`, amount: amt, narration: `ACH/C/${batchId}-${i}`, importBatchId: batchId })
  );
  await repository.transactions.appendMany(rows);
  return rows;
}

async function attempt(fn: () => Promise<any>) {
  try { const v = await fn(); return { ok: true, value: v, error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}

describe('WP-FB-DATA-06c-6 — import batch rollback', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => {
    resetAsOfDateOverride(); reset();
    IndexedDBStorageService.simulateFailureOnce = false;
  });

  /* ══════════════════════ §1 the pure planning authority ═══════════════════ */
  describe('§1 ImportBatchRollbackService.plan', () => {
    it('admits a batch of live rows', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      const plan = ImportBatchRollbackService.plan('batch-A', repo.transactionsData);
      expect(plan.status).toBe('ADMISSIBLE');
      expect(plan.targetIds.sort()).toEqual(['batch-A-0', 'batch-A-1']);
      expect(plan.alreadyExcludedIds).toEqual([]);
    });

    it('apply() stamps only the exclusion fields', async () => {
      const A = acct('A', 10000);
      const [row] = await seedBatch(A, 'batch-A', [100]);
      const plan = ImportBatchRollbackService.plan('batch-A', repo.transactionsData);
      const next = ImportBatchRollbackService.apply(plan, repo.transactionsData, '2026-08-22T10:00:00.000Z');
      const after = next.find(t => t.id === row.id)!;
      expect(after.excludedAt).toBe('2026-08-22T10:00:00.000Z');
      expect(after.excludedReason).toBe('IMPORT_ROLLBACK');
      // everything else byte-identical
      const strip = (t: any) => { const c = { ...t }; delete c.excludedAt; delete c.excludedReason; return c; };
      expect(strip(after)).toEqual(strip(row));
    });

    it('apply() does not mutate its input', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const snapshot = JSON.parse(JSON.stringify(repo.transactionsData));
      const plan = ImportBatchRollbackService.plan('batch-A', repo.transactionsData);
      ImportBatchRollbackService.apply(plan, repo.transactionsData, '2026-08-22T10:00:00.000Z');
      expect(repo.transactionsData).toEqual(snapshot);
    });

    it('apply() is a no-op for a refused plan', () => {
      const plan = ImportBatchRollbackService.plan('nope', []);
      expect(ImportBatchRollbackService.apply(plan, [], 'now')).toEqual([]);
    });
  });

  /* ════════════════════════ §2 refusal conditions ══════════════════════════ */
  describe('§2 refusals', () => {
    it('refuses an empty batch id', async () => {
      const r = await attempt(() => repository.transactions.rollbackBatch(''));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(BatchRollbackError);
      expect(r.error.code).toBe('EMPTY_BATCH_ID');
    });

    it('refuses a whitespace-only batch id', async () => {
      const r = await attempt(() => repository.transactions.rollbackBatch('   '));
      expect(r.error.code).toBe('EMPTY_BATCH_ID');
    });

    it('refuses an unknown batch', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const r = await attempt(() => repository.transactions.rollbackBatch('batch-DOES-NOT-EXIST'));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('BATCH_NOT_FOUND');
      expect(repo.transactionsData.every(t => !LedgerExclusionService.isExcluded(t))).toBe(true);
    });

    it('refuses a second rollback of the same batch', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      await repository.transactions.rollbackBatch('batch-A');
      const r = await attempt(() => repository.transactions.rollbackBatch('batch-A'));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('ALREADY_ROLLED_BACK');
    });

    it('a refusal changes nothing at all', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const snapshot = JSON.parse(JSON.stringify(repo.transactionsData));
      await attempt(() => repository.transactions.rollbackBatch('unknown'));
      expect(repo.transactionsData).toEqual(snapshot);
      expect(bal(A)).toBe(10100);
    });

    it('the refusal message is actionable', async () => {
      const r = await attempt(() => repository.transactions.rollbackBatch('ghost-batch'));
      expect(r.error.message).toContain('no transactions belong to import batch "ghost-batch"');
      expect(r.error.batchId).toBe('ghost-batch');
    });
  });

  /* ═══════════════════ §3 the split-batch transfer guard ═══════════════════ */
  describe('§3 split-batch transfer guard', () => {
    /** A pair whose legs deliberately carry DIFFERENT importBatchIds. */
    async function seedSplitPair(A: any, B: any) {
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'batch-1', origin: 'IMPORT' },
        { ...c, importBatchId: 'batch-2', origin: 'IMPORT' }
      ]);
      return [d, c];
    }

    it('REFUSES a rollback that would exclude only one leg of a transfer', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedSplitPair(A, B);
      const before = bal(A) + bal(B);

      const r = await attempt(() => repository.transactions.rollbackBatch('batch-1'));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(BatchRollbackError);
      expect(r.error.code).toBe('WOULD_SPLIT_TRANSFER');
      expect(r.error.message).toContain('A transfer must be rolled back whole');

      // the ₹2,000 the discovery gate watched appear is NOT created
      expect(bal(A) + bal(B)).toBe(before);
      expect(repo.transactionsData.every(t => !LedgerExclusionService.isExcluded(t))).toBe(true);
    });

    it('ALLOWS a rollback when both legs share the batch', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'batch-TR', origin: 'IMPORT' },
        { ...c, importBatchId: 'batch-TR', origin: 'IMPORT' }
      ]);
      expect(bal(A)).toBe(8000);
      expect(bal(B)).toBe(7000);

      const res = await repository.transactions.rollbackBatch('batch-TR');
      expect(res.excludedCount).toBe(2);
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
      expect(bal(A) + bal(B)).toBe(15000);   // system total preserved
    });

    it('the guard also fires when the stranded leg is a MANUAL transfer row', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      // one leg imported, the other manual (no importBatchId at all)
      await repository.transactions.appendMany([{ ...d, importBatchId: 'batch-X', origin: 'IMPORT' }, c]);
      const r = await attempt(() => repository.transactions.rollbackBatch('batch-X'));
      expect(r.error.code).toBe('WOULD_SPLIT_TRANSFER');
    });

    it('a batch containing ordinary rows AND a whole transfer is allowed', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'batch-M', origin: 'IMPORT' },
        { ...c, importBatchId: 'batch-M', origin: 'IMPORT' },
        importedRow(A, { id: 'plain-1', amount: 300, importBatchId: 'batch-M' })
      ]);
      const res = await repository.transactions.rollbackBatch('batch-M');
      expect(res.excludedCount).toBe(3);
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
    });
  });

  /* ═══════════════════════ §4 applying a rollback ══════════════════════════ */
  describe('§4 a successful rollback', () => {
    it('excludes every row in the batch and reports the count', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200, 300]);
      const res = await repository.transactions.rollbackBatch('batch-A');
      expect(res.batchId).toBe('batch-A');
      expect(res.excludedCount).toBe(3);
      expect(res.excludedIds.sort()).toEqual(['batch-A-0', 'batch-A-1', 'batch-A-2']);
      expect(res.alreadyExcludedCount).toBe(0);
    });

    it('REMOVES NOTHING — every row is still stored', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200, 300]);
      await repository.transactions.rollbackBatch('batch-A');
      expect(repo.transactionsData).toHaveLength(3);
      expect(repo.transactionsData.map(t => t.amount).sort((x, y) => x - y)).toEqual([100, 200, 300]);
    });

    it('rows remain VISIBLE in the Ledger (DATA-02)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      const visible = () => S().getFilteredTransactions({ dateRange: 'YTD', type: 'All' } as any).length;
      expect(visible()).toBe(2);
      await repository.transactions.rollbackBatch('batch-A');
      expect(visible()).toBe(2);
    });

    it('rows are excluded from the balance', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      expect(bal(A)).toBe(10300);
      await repository.transactions.rollbackBatch('batch-A');
      expect(bal(A)).toBe(10000);
    });

    it('rows are excluded from reports', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      const ttm = () => FinancialMetricService.getMetric(
        'TTM_REALIZED_DIVIDEND', repo.transactionsData, [], [], [], ASOF).value;
      expect(ttm()).toBe(300);
      await repository.transactions.rollbackBatch('batch-A');
      expect(ttm()).toBe(0);
    });

    it('provenance and identity survive the rollback untouched', async () => {
      const A = acct('A', 10000);
      const [row] = await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      const after = repo.transactionsData[0];
      expect(after.importBatchId).toBe('batch-A');
      expect(after.sourceProvider).toBe('SBI Bank');
      expect(after.sourceFile).toBe('SBI.xlsx');
      expect(after.origin).toBe('IMPORT');
      expect(after.recordedAt).toBe(row.recordedAt);
      expect(after.fingerprint).toBe(row.fingerprint);
      expect(after.amount).toBe(100);
      expect(after.status).toBe('CLEARED');     // status NOT overloaded
    });

    it('the exclusion reason is IMPORT_ROLLBACK', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      expect(LedgerExclusionService.reasonOf(repo.transactionsData[0])).toBe('IMPORT_ROLLBACK');
    });

    it('the store action returns a promise and resolves with the result', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const p = S().rollbackImportBatch('batch-A');
      expect(typeof (p as any).then).toBe('function');
      await expect(p).resolves.toMatchObject({ batchId: 'batch-A', excludedCount: 1 });
    });

    it('the store action REJECTS visibly on refusal', async () => {
      await expect(S().rollbackImportBatch('nope')).rejects.toBeInstanceOf(BatchRollbackError);
    });
  });

  /* ═══════════════════ §5 unrelated data is preserved ══════════════════════ */
  describe('§5 unrelated data preserved', () => {
    it('an unrelated batch is untouched', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      await seedBatch(A, 'batch-KEEP', [500]);
      await repository.transactions.rollbackBatch('batch-A');

      const kept = repo.transactionsData.filter(t => t.importBatchId === 'batch-KEEP');
      expect(kept).toHaveLength(1);
      expect(LedgerExclusionService.isExcluded(kept[0])).toBe(false);
      expect(bal(A)).toBe(10500);
    });

    it('manual transactions with no batch id are untouched', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'Manual', amount: 400, account: 'A', accountId: A.id, category: 'G'
      }));
      await repository.transactions.rollbackBatch('batch-A');
      const manual = repo.transactionsData.find(t => t.title === 'Manual')!;
      expect(LedgerExclusionService.isExcluded(manual)).toBe(false);
      expect(bal(A)).toBe(10400);
    });

    it('rolling back two batches independently works', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'b1', [100]);
      await seedBatch(A, 'b2', [200]);
      await repository.transactions.rollbackBatch('b1');
      expect(bal(A)).toBe(10200);
      await repository.transactions.rollbackBatch('b2');
      expect(bal(A)).toBe(10000);
      expect(repo.transactionsData).toHaveLength(2);   // still nothing removed
    });
  });

  /* ══════════════════ §6 persistence + failure propagation ═════════════════ */
  describe('§6 persistence', () => {
    it('a persistence failure REJECTS and rolls memory back', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      await drain();
      IndexedDBStorageService.simulateFailureOnce = true;

      const r = await attempt(() => repository.transactions.rollbackBatch('batch-A'));
      expect(r.ok).toBe(false);
      expect(repo.transactionsData.every(t => !LedgerExclusionService.isExcluded(t))).toBe(true);
      expect(bal(A)).toBe(10300);      // unchanged
    });

    it('the rollback survives a repeat call after a failed one', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await drain();
      IndexedDBStorageService.simulateFailureOnce = true;
      await attempt(() => repository.transactions.rollbackBatch('batch-A'));
      await repository.transactions.rollbackBatch('batch-A');
      expect(bal(A)).toBe(10000);
    });

    it('operates on the repository array, not the Zustand projection', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      // the repository source of truth carries the stamp
      expect(repo.transactionsData[0].excludedAt).toBeTruthy();
      // and the store projection agrees, because syncStore ran
      expect(S().transactions[0].excludedAt).toBeTruthy();
    });
  });

  /* ═══════════════════ §7 upstream authorities unchanged ═══════════════════ */
  describe('§7 upstream authorities unchanged', () => {
    it('structural transfer integrity is unchanged by a rollback', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'batch-TR' }, { ...c, importBatchId: 'batch-TR' }
      ]);
      const before = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      await repository.transactions.rollbackBatch('batch-TR');
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toEqual(before);
    });

    /**
     * MUTATION-DRIVEN (M9).
     *
     * The repository's structural-integrity assertion is a tripwire that cannot
     * fire today: exclusion never adds or removes rows, so structure cannot
     * change. Removing the call therefore broke nothing and the mutation
     * survived the whole suite — the tripwire was real code with zero coverage.
     *
     * It is worth keeping (it is precisely what would catch a future change that
     * made rollback start removing rows), so instead of deleting it, this proves
     * the repository actually consults it on every rollback.
     */
    it('the repository consults the structural-integrity tripwire on every rollback', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const spy = vi.spyOn(ImportBatchRollbackService, 'structuralIntegrityUnchanged');
      await repository.transactions.rollbackBatch('batch-A');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('the rollback ABORTS if the tripwire ever reports a structural change', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const spy = vi.spyOn(ImportBatchRollbackService, 'structuralIntegrityUnchanged')
        .mockReturnValue(false);
      const r = await attempt(() => repository.transactions.rollbackBatch('batch-A'));
      expect(r.ok).toBe(false);
      expect(String(r.error.message)).toContain('structural integrity would change');
      // and nothing was applied
      expect(LedgerExclusionService.isExcluded(repo.transactionsData[0])).toBe(false);
      expect(bal(A)).toBe(10100);
      spy.mockRestore();
    });

    it('structuralIntegrityUnchanged detects a row actually disappearing', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      const before = [...repo.transactionsData];
      const after = before.filter(t => t.direction !== 'CREDIT');
      expect(ImportBatchRollbackService.structuralIntegrityUnchanged(before, after)).toBe(false);
      expect(ImportBatchRollbackService.structuralIntegrityUnchanged(before, [...before])).toBe(true);
    });

    it('DATA-06c-0 id uniqueness still enforced', async () => {
      const A = acct('A', 10000);
      const [row] = await seedBatch(A, 'batch-A', [100]);
      await expect(repository.transactions.append({ ...row, amount: 5 })).rejects.toThrow();
    });

    it('DATA-06b still refuses a lone transfer leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await expect(repository.transactions.append(d)).rejects.toThrow();
    });

    it('PrismaTransactionRepository mirrors the rollback guard', async () => {
      const r2 = new PrismaTransactionRepository();
      await expect(r2.rollbackBatch('')).rejects.toBeInstanceOf(BatchRollbackError);
      await expect(r2.rollbackBatch('anything')).rejects.toBeInstanceOf(BatchRollbackError);
    });
  });

  /* ══════════════ §8 scope boundary — no other lifecycle op ════════════════ */
  describe('§8 scope boundary', () => {
    it('still NO hard-removal API — rollbackBatch removes nothing', () => {
      const t = repository.transactions as any;
      expect(typeof t.remove).toBe('undefined');
      expect(typeof t.removeBatch).toBe('undefined');   // deliberately absent
      expect(typeof t.rollbackBatch).toBe('function');  // the 06c-6 capability
    });

    it('still no amendment / supersession / reversal / undo API', () => {
      const t = repository.transactions as any;
      expect(typeof t.update).toBe('undefined');
      expect(typeof t.replace).toBe('undefined');
      expect(typeof t.amend).toBe('undefined');
      expect(typeof t.reverse).toBe('undefined');
      expect(typeof t.tombstone).toBe('undefined');
      expect(typeof t.restore).toBe('undefined');
      expect(typeof (S() as any).undo).toBe('undefined');
    });

    /* WP-FB-DATA-06c-2b REVERSED THIS TEST, deliberately. It asserted that a
     * rollback could not be undone, which was true while D6 was open. Decision
     * D6-1 = R5 resolved it: a WHOLE import batch may be restored. The scope
     * boundary it was really protecting — no per-row restore, no general undo,
     * no deletion — is asserted here instead. */
    it('rollback can be undone at BATCH granularity only (D6-1 = R5, D6-2)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      const t = repository.transactions as any;
      expect(typeof t.restoreBatch).toBe('function');
      expect(typeof (S() as any).restoreImportBatch).toBe('function');
      // no per-row restore, no general undo, no deletion
      for (const k of ['restore', 'restoreTransaction', 'undo', 'revert',
                       'remove', 'removeBatch', 'deleteTransaction']) {
        expect(typeof t[k]).toBe('undefined');
      }
    });

    it('the exclusion reason vocabulary is still only IMPORT_ROLLBACK', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      // no lifecycle field encoding an unresolved decision appeared
      const row: any = repo.transactionsData[0];
      expect(row.deletedAt).toBeUndefined();
      expect(row.supersededById).toBeUndefined();
      expect(row.amendedAt).toBeUndefined();
      expect(row.lifecycleState).toBeUndefined();
    });

    it('no transaction date, amount or direction was changed', async () => {
      const A = acct('A', 10000);
      const [row] = await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      const after = repo.transactionsData[0];
      expect(after.date).toBe(row.date);
      expect(after.amount).toBe(row.amount);
      expect(after.direction).toBe(row.direction);
      expect(after.accountId).toBe(row.accountId);
    });
  });
});
