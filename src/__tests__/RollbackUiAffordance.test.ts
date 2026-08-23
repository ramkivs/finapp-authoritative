/**
 * WP-FB-DATA-06c-6a — Rollback UI affordance.
 *
 * Exposes the already-tested `rollbackImportBatch` capability on the Import
 * surface. No new lifecycle semantics; this is a usability layer.
 *
 *   §1  listBatches — the derived batch history
 *   §2  eligibility, computed by the same authority the write path uses
 *   §3  status derivation
 *   §4  refusal codes are surfaced BEFORE the click
 *   §5  the 06c-1 rule holds after a UI-driven rollback
 *   §6  scope boundary
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  ImportBatchRollbackService,
  BatchRollbackError
} from '../services/ImportBatchRollbackService';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
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

function importedRow(A: any, over: Partial<Transaction> = {}): Transaction {
  const r: any = {
    id: 'imp-' + Math.random().toString(36).slice(2, 9),
    date: '2026-08-10', dateStr: '10 Aug 2026', title: 'Dividend',
    narration: 'ACH/C/' + Math.random().toString(36).slice(2, 7),
    account: A.name, accountId: A.id, type: 'Income', direction: 'CREDIT',
    category: 'DIVIDEND', amount: 100, status: 'CLEARED', origin: 'IMPORT',
    recordedAt: '2026-08-22T10:00:00.000Z', importBatchId: 'batch-A',
    sourceProvider: 'SBI Bank', sourceFile: 'SBI.xlsx', sourceRowNumber: 1, ...over
  };
  r.fingerprint = TransactionIdentityService.fingerprint(r);
  return r;
}

async function seedBatch(A: any, batchId: string, amounts: number[], over: Partial<Transaction> = {}) {
  const rows = amounts.map((amt, i) => importedRow(A, {
    id: `${batchId}-${i}`, amount: amt, narration: `ACH/C/${batchId}-${i}`,
    importBatchId: batchId, ...over
  }));
  await repository.transactions.appendMany(rows);
  return rows;
}

describe('WP-FB-DATA-06c-6a — rollback UI affordance', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ══════════════════════ §1 the derived batch history ═════════════════════ */
  describe('§1 listBatches', () => {
    it('returns nothing when there are no imports', async () => {
      const A = acct('A', 10000);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'Manual', amount: 100, account: 'A', accountId: A.id, category: 'G'
      }));
      expect(ImportBatchRollbackService.listBatches(repo.transactionsData)).toEqual([]);
    });

    it('omits rows that carry no importBatchId', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'Manual', amount: 400, account: 'A', accountId: A.id, category: 'G'
      }));
      const list = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(list).toHaveLength(1);
      expect(list[0].rowCount).toBe(1);
    });

    it('summarises a batch from persisted fields only', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 250]);
      const [b] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(b.batchId).toBe('batch-A');
      expect(b.provider).toBe('SBI Bank');
      expect(b.file).toBe('SBI.xlsx');
      expect(b.rowCount).toBe(2);
      expect(b.totalAmount).toBe(350);
      expect(b.importedAt).toBe('2026-08-22T10:00:00.000Z');
    });

    it('lists multiple batches newest first', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'older', [100], { recordedAt: '2026-08-01T00:00:00.000Z', sourceFile: 'old.xlsx' });
      await seedBatch(A, 'newer', [200], { recordedAt: '2026-08-20T00:00:00.000Z', sourceFile: 'new.xlsx' });
      expect(ImportBatchRollbackService.listBatches(repo.transactionsData).map(b => b.batchId))
        .toEqual(['newer', 'older']);
    });

    it('never invents a source it does not have', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-X', [100], { sourceProvider: undefined, sourceFile: undefined });
      const [b] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(b.provider).toBe('Unknown source');
      expect(b.file).toBe('Unknown file');
      expect(b.importedAt).toBe('2026-08-22T10:00:00.000Z');
    });

    it('reports a mixed batch honestly rather than picking one', async () => {
      const A = acct('A', 10000);
      await repository.transactions.appendMany([
        importedRow(A, { id: 'm-1', importBatchId: 'mix', sourceProvider: 'SBI Bank', sourceFile: 'a.xlsx', narration: 'N1' }),
        importedRow(A, { id: 'm-2', importBatchId: 'mix', sourceProvider: 'ICICI Bank', sourceFile: 'b.xlsx', narration: 'N2' })
      ]);
      const [b] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(b.provider).toBe('Multiple sources');
      expect(b.file).toBe('2 files');
    });

    it('a batch with no timestamp sorts last and reports null', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'stamped', [100], { recordedAt: '2026-08-20T00:00:00.000Z' });
      await seedBatch(A, 'unstamped', [200], { recordedAt: undefined, narration: 'NOSTAMP' });
      const list = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(list.map(b => b.batchId)).toEqual(['stamped', 'unstamped']);
      expect(list[1].importedAt).toBeNull();
    });
  });

  /* ════════════════ §2 eligibility from the same authority ═════════════════ */
  describe('§2 eligibility', () => {
    it('a live batch is eligible', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const [b] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(b.rollbackEligible).toBe(true);
      expect(b.rollbackBlockedReason).toBeUndefined();
    });

    it('an already rolled-back batch is not eligible', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      await repository.transactions.rollbackBatch('batch-A');
      const [b] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(b.rollbackEligible).toBe(false);
      expect(b.rollbackBlockedCode).toBe('ALREADY_ROLLED_BACK');
    });

    it('eligibility matches what rollbackBatch actually does — no drift', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      const [before] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(before.rollbackEligible).toBe(true);
      await expect(repository.transactions.rollbackBatch('batch-A')).resolves.toBeTruthy();

      const [after] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(after.rollbackEligible).toBe(false);
      await expect(repository.transactions.rollbackBatch('batch-A')).rejects.toBeInstanceOf(BatchRollbackError);
    });
  });

  /* ═══════════════════════════ §3 status derivation ════════════════════════ */
  describe('§3 status', () => {
    it('LIVE before any rollback', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      expect(ImportBatchRollbackService.listBatches(repo.transactionsData)[0].status).toBe('LIVE');
    });

    it('ROLLED_BACK after a full rollback', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      await repository.transactions.rollbackBatch('batch-A');
      const [b] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(b.status).toBe('ROLLED_BACK');
      expect(b.excludedCount).toBe(2);
      expect(b.rowCount).toBe(2);           // still counted — nothing deleted
    });

    it('PARTIALLY_EXCLUDED when only some rows are excluded', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      repo.transactionsData = repo.transactionsData.map((t, i) =>
        i === 0 ? { ...t, excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const } : t
      );
      repo.syncStore();
      expect(ImportBatchRollbackService.listBatches(repo.transactionsData)[0].status)
        .toBe('PARTIALLY_EXCLUDED');
    });
  });

  /* ════════════ §4 refusals are surfaced BEFORE the user clicks ════════════ */
  describe('§4 refusal codes surfaced up front', () => {
    it('a split-batch transfer blocks the batch and explains why', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'batch-1', origin: 'IMPORT', sourceProvider: 'SBI Bank', sourceFile: 'a.xlsx' },
        { ...c, importBatchId: 'batch-2', origin: 'IMPORT', sourceProvider: 'SBI Bank', sourceFile: 'b.xlsx' }
      ]);
      const list = ImportBatchRollbackService.listBatches(repo.transactionsData);
      const b1 = list.find(b => b.batchId === 'batch-1')!;
      expect(b1.rollbackEligible).toBe(false);
      expect(b1.rollbackBlockedCode).toBe('WOULD_SPLIT_TRANSFER');
      expect(b1.rollbackBlockedReason).toContain('A transfer must be rolled back whole');
    });

    it('a whole-transfer batch stays eligible', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'batch-TR', origin: 'IMPORT', sourceProvider: 'SBI Bank', sourceFile: 'x.xlsx' },
        { ...c, importBatchId: 'batch-TR', origin: 'IMPORT', sourceProvider: 'SBI Bank', sourceFile: 'x.xlsx' }
      ]);
      expect(ImportBatchRollbackService.listBatches(repo.transactionsData)[0].rollbackEligible).toBe(true);
    });
  });

  /* ═════════ §5 the 06c-1 rule still holds after a UI-driven rollback ══════ */
  describe('§5 exclusion semantics preserved', () => {
    it('rolling back through the store action excludes from balances but keeps rows visible', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      const visible = () => S().getFilteredTransactions({ dateRange: 'YTD', type: 'All' } as any).length;

      expect(bal(A)).toBe(10300);
      expect(visible()).toBe(2);

      const res = await S().rollbackImportBatch('batch-A');
      expect(res.excludedCount).toBe(2);

      expect(bal(A)).toBe(10000);      // excluded from derivation
      expect(visible()).toBe(2);       // still visible (DATA-02)
      expect(repo.transactionsData).toHaveLength(2);
    });

    it('the batch list reconciles itself after the rollback', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100]);
      expect(ImportBatchRollbackService.listBatches(repo.transactionsData)[0].status).toBe('LIVE');
      await S().rollbackImportBatch('batch-A');
      const [after] = ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(after.status).toBe('ROLLED_BACK');
      expect(after.rollbackEligible).toBe(false);
    });

    it('an unrelated batch stays live and eligible', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100], { sourceFile: 'a.xlsx' });
      await seedBatch(A, 'batch-KEEP', [400], { sourceFile: 'keep.xlsx' });
      await S().rollbackImportBatch('batch-A');
      const keep = ImportBatchRollbackService.listBatches(repo.transactionsData)
        .find(b => b.batchId === 'batch-KEEP')!;
      expect(keep.status).toBe('LIVE');
      expect(keep.rollbackEligible).toBe(true);
      expect(bal(A)).toBe(10400);
    });

    it('the store action rejects visibly for an unknown batch', async () => {
      await expect(S().rollbackImportBatch('ghost')).rejects.toBeInstanceOf(BatchRollbackError);
    });
  });

  /* ═══════════════════════════ §6 scope boundary ═══════════════════════════ */
  describe('§6 scope boundary', () => {
    it('batch restore exists (06c-2b); general undo still does not', () => {
      const t = repository.transactions as any;
      expect(typeof t.restoreBatch).toBe('function');
      expect(typeof (S() as any).restoreImportBatch).toBe('function');
      expect(typeof (S() as any).undo).toBe('undefined');
      expect(typeof t.restore).toBe('undefined');
    });

    it('still no hard-removal or amendment API', () => {
      const t = repository.transactions as any;
      expect(typeof t.remove).toBe('undefined');
      expect(typeof t.removeBatch).toBe('undefined');
      expect(typeof t.update).toBe('undefined');
      expect(typeof t.amend).toBe('undefined');
    });

    it('listBatches is read-only — it mutates nothing', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'batch-A', [100, 200]);
      const snapshot = JSON.parse(JSON.stringify(repo.transactionsData));
      ImportBatchRollbackService.listBatches(repo.transactionsData);
      ImportBatchRollbackService.listBatches(repo.transactionsData);
      expect(repo.transactionsData).toEqual(snapshot);
    });

    it('a UI-driven rollback changes no financial field', async () => {
      const A = acct('A', 10000);
      const [row] = await seedBatch(A, 'batch-A', [100]);
      await S().rollbackImportBatch('batch-A');
      const after = repo.transactionsData[0];
      expect(after.amount).toBe(row.amount);
      expect(after.date).toBe(row.date);
      expect(after.direction).toBe(row.direction);
      expect(after.status).toBe('CLEARED');
      expect(after.sourceProvider).toBe('SBI Bank');
      expect(LedgerExclusionService.reasonOf(after)).toBe('IMPORT_ROLLBACK');
    });
  });
});
