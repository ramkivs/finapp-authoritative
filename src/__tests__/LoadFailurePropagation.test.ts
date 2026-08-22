/**
 * WP-FB-DATA-06c-READFAIL — IndexedDB loadAll failure propagation.
 *
 * THE DESTRUCTIVE SEQUENCE THIS CLOSES
 *
 *   1. a real ledger is persisted
 *   2. the IndexedDB read fails
 *   3. loadAll silently returns an empty ledger
 *   4. the application believes there is nothing stored
 *   5. the next successful saveAll clears the store and writes that emptiness
 *   6. the user's financial data is destroyed, with no error anywhere
 *
 * Propagating the read failure alone does NOT close it — after a failed load
 * the in-memory ledger is still empty, and one write still wipes the store.
 * Step 5 is closed by refusing to persist after a failed read.
 *
 *   §1  a genuine read failure rejects
 *   §2  legitimate empty-ledger behaviour is preserved
 *   §3  the no-IndexedDB environment fallback is preserved
 *   §4  the destructive sequence is closed
 *   §5  recovery
 *   §6  unrelated semantics unchanged
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: any[];
  syncStore: () => void;
};
const S = () => useCanonicalLedger.getState();

function reset() {
  repo.transactionsData = []; repo.accountsData = [];
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  });
}
function acct(name: string, opening = 0) {
  S().addAccount({ name, type: 'Bank' as any, openingBalance: opening, asOfDate: '2026-08-01' });
  return S().accounts.find((a: any) => a.name === name)!;
}
const bal = (a: any) =>
  AccountBalanceService.balance(a.id, S().accounts, S().transactions, ASOF).balance;
const drain = () => new Promise(r => setTimeout(r, 20));

async function attempt(fn: () => Promise<any>) {
  try { const v = await fn(); return { ok: true, value: v, error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}

/**
 * A `window.indexedDB` whose per-store `getAll()` FAILS while `open()` succeeds.
 *
 * This is the dangerous shape: the failure never reaches the outer catch,
 * because the pre-fix code resolved such a read as `[]`. jsdom has no
 * IndexedDB, so `loadAll` would otherwise take its environment fallback and
 * never exercise the real read path at all.
 */
async function withFailingStoreRead(fn: () => Promise<any>) {
  const original = (globalThis as any).window?.indexedDB;
  (globalThis as any).window.indexedDB = {
    open() {
      const req: any = { onerror: null, onsuccess: null, onupgradeneeded: null, error: null };
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({
              getAll() {
                const r: any = { onsuccess: null, onerror: null, error: new Error('store read failed') };
                setTimeout(() => r.onerror && r.onerror(), 0);
                return r;
              }
            })
          }),
          close() {}
        };
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    }
  };
  try { return await fn(); }
  finally {
    if (original === undefined) delete (globalThis as any).window.indexedDB;
    else (globalThis as any).window.indexedDB = original;
  }
}

/**
 * A `window.indexedDB` whose reads all SUCCEED (returning empty stores).
 *
 * MUTATION-DRIVEN (M5). Recovery in jsdom goes through the *environment*
 * fallback, which clears the latch at a different line from the real read path.
 * A mutation removing the real-path clear therefore survived the whole suite.
 * This stub drives an actual successful IndexedDB read.
 */
async function withSucceedingIndexedDB(fn: () => Promise<any>) {
  const original = (globalThis as any).window?.indexedDB;
  (globalThis as any).window.indexedDB = {
    open() {
      const req: any = { onerror: null, onsuccess: null, onupgradeneeded: null, error: null };
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({
              getAll() {
                const r: any = { onsuccess: null, onerror: null, result: [] };
                setTimeout(() => r.onsuccess && r.onsuccess(), 0);
                return r;
              }
            })
          }),
          close() {}
        };
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    }
  };
  try { return await fn(); }
  finally {
    if (original === undefined) delete (globalThis as any).window.indexedDB;
    else (globalThis as any).window.indexedDB = original;
  }
}

/** A `window.indexedDB` whose `open()` itself fails. */
async function withFailingOpen(fn: () => Promise<any>) {
  const original = (globalThis as any).window?.indexedDB;
  (globalThis as any).window.indexedDB = {
    open() {
      const req: any = { onerror: null, onsuccess: null, onupgradeneeded: null, error: new Error('open failed') };
      setTimeout(() => req.onerror && req.onerror(), 0);
      return req;
    }
  };
  try { return await fn(); }
  finally {
    if (original === undefined) delete (globalThis as any).window.indexedDB;
    else (globalThis as any).window.indexedDB = original;
  }
}

describe('WP-FB-DATA-06c-READFAIL — loadAll failure propagation', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(async () => {
    resetAsOfDateOverride();
    IndexedDBStorageService.simulateFailureOnce = false;
    IndexedDBStorageService.simulateReadFailureOnce = false;
    // clear the refusal latch so one test cannot leak into the next
    await IndexedDBStorageService.loadAll().catch(() => {});
    reset();
  });

  /* ═══════════════════ §1 a genuine read failure rejects ═══════════════════ */
  describe('§1 read failures propagate', () => {
    it('A. a failing IndexedDB open makes loadAll REJECT', async () => {
      await withFailingOpen(async () => {
        await expect(IndexedDBStorageService.loadAll()).rejects.toThrow();
      });
    });

    it('A. a failing per-store read makes loadAll REJECT (was silently [])', async () => {
      await withFailingStoreRead(async () => {
        await expect(IndexedDBStorageService.loadAll()).rejects.toThrow();
      });
    });

    it('loadAll does NOT resolve on failure', async () => {
      await withFailingStoreRead(async () => {
        let resolved = false;
        try { await IndexedDBStorageService.loadAll(); resolved = true; } catch { /* expected */ }
        expect(resolved).toBe(false);
      });
    });

    it('the failure reaches the repository caller', async () => {
      await withFailingOpen(async () => {
        const r = await attempt(() => (repository as any).initialize());
        expect(r.ok).toBe(false);
      });
    });

    it('a failed load does NOT populate the ledger with an empty result', async () => {
      await withFailingOpen(async () => {
        await attempt(() => (repository as any).initialize());
        expect(repo.transactionsData).toHaveLength(0);
      });
    });

    it('loadFailed is reported after a failure', async () => {
      await withFailingStoreRead(async () => {
        await attempt(() => IndexedDBStorageService.loadAll());
        expect(IndexedDBStorageService.loadFailed).toBe(true);
      });
    });

    it('the injectable read-failure seam also rejects', async () => {
      IndexedDBStorageService.simulateReadFailureOnce = true;
      await expect(IndexedDBStorageService.loadAll()).rejects.toThrow(/read failure/i);
    });
  });

  /* ══════════════ §2 legitimate empty ledger is NOT a failure ══════════════ */
  describe('§2 an empty ledger still loads successfully', () => {
    it('an empty store resolves, and does not set loadFailed', async () => {
      const res = await IndexedDBStorageService.loadAll();
      expect(res.transactions).toEqual([]);
      expect(IndexedDBStorageService.loadFailed).toBe(false);
    });

    it('an empty load does not block subsequent writes', async () => {
      await IndexedDBStorageService.loadAll();
      const A = acct('A', 10000);
      await expect(repository.transactions.append(TransactionFactory.createIncome({
        title: 'X', amount: 100, account: 'A', accountId: A.id, category: 'G'
      }))).resolves.toBeUndefined();
      expect(bal(A)).toBe(10100);
    });
  });

  /* ═══════════ §3 the no-IndexedDB environment fallback is intact ══════════ */
  describe('§3 environment fallback preserved', () => {
    it('an environment with no IndexedDB still resolves (not a failure)', async () => {
      // jsdom: window exists, window.indexedDB does not
      await expect(IndexedDBStorageService.loadAll()).resolves.toBeTruthy();
      expect(IndexedDBStorageService.loadFailed).toBe(false);
    });

    it('the whole existing suite path — append/persist — still works here', async () => {
      const A = acct('A', 10000);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'X', amount: 250, account: 'A', accountId: A.id, category: 'G'
      }));
      expect(repo.transactionsData).toHaveLength(1);
    });
  });

  /* ═════════════════ §4 the destructive sequence is closed ═════════════════ */
  describe('§4 no write may overwrite data that was never read', () => {
    it('saveAll REFUSES after a failed load', async () => {
      await withFailingOpen(async () => {
        await attempt(() => IndexedDBStorageService.loadAll());
      });
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      })).rejects.toThrow(/Refusing to persist/i);
    });

    it('the refusal message explains the risk and the remedy', async () => {
      await withFailingOpen(async () => { await attempt(() => IndexedDBStorageService.loadAll()); });
      const r = await attempt(() => IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      }));
      expect(r.error.message).toContain('could overwrite stored data that was never read');
      expect(r.error.message).toContain('Reload the application');
    });

    it('an append after a failed load is refused, not silently persisted', async () => {
      const A = acct('A', 10000);
      await drain();
      await withFailingOpen(async () => { await attempt(() => IndexedDBStorageService.loadAll()); });

      const r = await attempt(() => repository.transactions.append(TransactionFactory.createIncome({
        title: 'X', amount: 100, account: 'A', accountId: A.id, category: 'G'
      })));
      expect(r.ok).toBe(false);
      expect(repo.transactionsData).toHaveLength(0);   // memory rolled back too
    });

    it('the full destructive sequence cannot complete', async () => {
      // 1. a real ledger exists in the fallback store
      const A = acct('A', 10000);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'Salary', amount: 5000, account: 'A', accountId: A.id, category: 'G'
      }));
      await drain();
      expect(repo.transactionsData).toHaveLength(1);

      // 2-3. the read fails
      await withFailingOpen(async () => { await attempt(() => (repository as any).initialize()); });

      // 4. initialize() rethrows BEFORE assigning, so whatever was already in
      //    memory is left untouched rather than replaced by an empty result.
      //    (Discovered by this test: the pre-existing rows survive. At real
      //    application startup memory is empty anyway, which the §1 case covers.)
      expect(repo.transactionsData).toHaveLength(1);

      // 5. the write that would have destroyed the stored data is REFUSED
      const r = await attempt(() => IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      }));
      expect(r.ok).toBe(false);
    });
  });

  /* ══════════════════════════════ §5 recovery ══════════════════════════════ */
  describe('§5 recovery needs no new API', () => {
    it('a subsequent successful load clears the refusal', async () => {
      await withFailingOpen(async () => { await attempt(() => IndexedDBStorageService.loadAll()); });
      expect(IndexedDBStorageService.loadFailed).toBe(true);

      await IndexedDBStorageService.loadAll();          // succeeds in this environment
      expect(IndexedDBStorageService.loadFailed).toBe(false);

      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      })).resolves.toBeUndefined();
    });

    it('a successful REAL IndexedDB read clears the latch', async () => {
      await withFailingOpen(async () => { await attempt(() => IndexedDBStorageService.loadAll()); });
      expect(IndexedDBStorageService.loadFailed).toBe(true);

      await withSucceedingIndexedDB(async () => {
        await expect(IndexedDBStorageService.loadAll()).resolves.toBeTruthy();
        expect(IndexedDBStorageService.loadFailed).toBe(false);
      });
    });

    it('a real successful read re-enables writes', async () => {
      await withFailingOpen(async () => { await attempt(() => IndexedDBStorageService.loadAll()); });
      await withSucceedingIndexedDB(async () => {
        await IndexedDBStorageService.loadAll();
      });
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      })).resolves.toBeUndefined();
    });

    it('writes work normally again after recovery', async () => {
      await withFailingOpen(async () => { await attempt(() => IndexedDBStorageService.loadAll()); });
      await IndexedDBStorageService.loadAll();
      const A = acct('A', 10000);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'X', amount: 300, account: 'A', accountId: A.id, category: 'G'
      }));
      expect(bal(A)).toBe(10300);
    });
  });

  /* ══════════════════ §6 nothing else changed ══════════════════════════════ */
  describe('§6 unrelated semantics unchanged', () => {
    it('saveAll still propagates its own write failure (P-5 intact)', async () => {
      IndexedDBStorageService.simulateFailureOnce = true;
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      })).rejects.toThrow(/persistence failure/i);
    });

    it('a write failure does not latch the read refusal', async () => {
      IndexedDBStorageService.simulateFailureOnce = true;
      await attempt(() => IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      }));
      expect(IndexedDBStorageService.loadFailed).toBe(false);
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      })).resolves.toBeUndefined();
    });

    it('DATA-06b transfer admission unchanged', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await expect(repository.transactions.append(d)).rejects.toThrow();
      await S().addTransfer('A', 'B', 2000);
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(0);
    });

    it('DATA-06c-0 id uniqueness unchanged', async () => {
      const A = acct('A', 10000);
      const tx = TransactionFactory.createIncome({
        title: 'X', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.append(tx);
      await expect(repository.transactions.append({ ...tx, amount: 5 })).rejects.toThrow();
    });

    it('DATA-06c-1 exclusion semantics unchanged', () => {
      const row: any = { id: 'x', amount: 1, excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' };
      expect(LedgerExclusionService.isExcluded(row)).toBe(true);
      expect(LedgerExclusionService.reasonOf(row)).toBe('IMPORT_ROLLBACK');
    });

    it('DATA-06c-6 import rollback unchanged', async () => {
      const A = acct('A', 10000);
      const r: any = {
        id: 'imp-1', date: '2026-08-10', dateStr: 'x', title: 'D', narration: 'ACH/C/D',
        account: 'A', accountId: A.id, type: 'Income', direction: 'CREDIT',
        category: 'DIVIDEND', amount: 400, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'batch-1', sourceProvider: 'SBI Bank', sourceFile: 'S.xlsx'
      };
      r.fingerprint = TransactionIdentityService.fingerprint(r);
      S().commitImportedRows([r]);
      await drain();
      const res = await repository.transactions.rollbackBatch('batch-1');
      expect(res.excludedCount).toBe(1);
      expect(bal(A)).toBe(10000);
      expect(repo.transactionsData).toHaveLength(1);
    });

    it('no lifecycle API was introduced', () => {
      const t = repository.transactions as any;
      expect(typeof t.remove).toBe('undefined');
      expect(typeof t.update).toBe('undefined');
      expect(typeof t.amend).toBe('undefined');
      expect(typeof t.reverse).toBe('undefined');
      expect(typeof t.restore).toBe('undefined');
      expect(typeof (S() as any).undo).toBe('undefined');
    });
  });
});
