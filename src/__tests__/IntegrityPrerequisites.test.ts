/**
 * WP-FB-DATA-06c-0 — Integrity prerequisites.
 *
 * Two prerequisites from the DATA-06c discovery gate. NO lifecycle semantics.
 *
 *   P-1  Transaction.id uniqueness
 *        Discovery proved in real Chromium that two rows sharing an id hold
 *        ₹350 in memory and ₹250 in IndexedDB, silently destroying ₹100 on
 *        reload, because saveAll mirrors with put() on a keyPath:'id' store.
 *
 *   P-5  IndexedDB saveAll error propagation
 *        A genuine persistence failure resolved SUCCESSFULLY into an in-memory
 *        fallback, so a caller could not distinguish "saved" from "lost".
 *
 *   §1  P-1 the pure guard
 *   §2  P-1 at the repository admission boundary
 *   §3  P-1 existing-data detection (report only)
 *   §4  P-1 interaction with DATA-06a / DATA-06b (must be unchanged)
 *   §5  P-5 persistence failure propagation
 *   §6  scope boundary — still no lifecycle
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  TransactionIdentityService,
  DuplicateTransactionIdError
} from '../services/TransactionIdentityService';
import { TransferIntegrityService, TransferIntegrityError } from '../services/TransferIntegrityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { PrismaTransactionRepository } from '../repositories/PrismaRepository';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: any[];
  duplicateTransactionIdsAtLoad: any[];
  syncStore: () => void;
};

function reset() {
  repo.transactionsData = [];
  repo.accountsData = [];
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

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'Salary',
    narration: 'ACME PAYROLL', account: 'A', accountId: null,
    type: 'Income' as any, direction: 'CREDIT', category: 'SALARY',
    amount: 500, status: 'CLEARED' as any, ...over
  };
}

/**
 * Drains the IndexedDBStorageService mutex queue.
 *
 * Store actions such as addAccount fire their save without awaiting it, so a
 * pending save would otherwise consume `simulateFailureOnce` before the
 * operation under test runs. (Diagnosed during this package: the flag was
 * observed flipping true -> false during the drain.)
 */
const drain = () => new Promise(r => setTimeout(r, 20));

/**
 * Installs a `window.indexedDB` whose `open()` fails, then restores the
 * original.
 *
 * MUTATION-DRIVEN. Without this, the P-5 fix was UNTESTED: jsdom has no
 * IndexedDB, so `saveAll` takes its `!window.indexedDB` early return and never
 * reaches the try/catch that the fix actually changes. `simulateFailureOnce`
 * throws BEFORE that try block, so it proves the caller sees a rejection but
 * proves nothing about the real IndexedDB error path. Mutations M6 and M8
 * (re-swallowing the catch) survived the whole suite because of exactly this
 * gap. This stub drives a genuine `getDB()` failure through the real path.
 */
async function withFailingIndexedDB(fn: () => Promise<any>) {
  const original = (globalThis as any).window?.indexedDB;
  (globalThis as any).window.indexedDB = {
    open() {
      const req: any = { onerror: null, onsuccess: null, onupgradeneeded: null, error: new Error('IDB open failed') };
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

async function attempt(fn: () => Promise<any>) {
  try { await fn(); return { rejected: false, error: null as any }; }
  catch (e: any) { return { rejected: true, error: e }; }
}

describe('WP-FB-DATA-06c-0 — integrity prerequisites', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => { resetAsOfDateOverride(); reset(); IndexedDBStorageService.simulateFailureOnce = false; });

  /* ═══════════════════════ §1 P-1 the pure guard ═══════════════════════════ */
  describe('§1 assertUniqueIds', () => {
    it('accepts a batch of unique ids', () => {
      expect(() => TransactionIdentityService.assertUniqueIds(
        [row({ id: 'a' }), row({ id: 'b' })], [row({ id: 'c' })]
      )).not.toThrow();
    });

    it('rejects a duplicate WITHIN the incoming batch', () => {
      expect(() => TransactionIdentityService.assertUniqueIds(
        [row({ id: 'dup' }), row({ id: 'dup' })], []
      )).toThrow(DuplicateTransactionIdError);
    });

    it('rejects a duplicate AGAINST existing stored rows', () => {
      expect(() => TransactionIdentityService.assertUniqueIds(
        [row({ id: 'x' })], [row({ id: 'x' })]
      )).toThrow(DuplicateTransactionIdError);
    });

    it('labels the collision scope so the message is actionable', () => {
      try {
        TransactionIdentityService.assertUniqueIds([row({ id: 'd' }), row({ id: 'd' })], []);
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(DuplicateTransactionIdError);
        expect(e.duplicates[0].scope).toBe('WITHIN_BATCH');
        expect(e.message).toContain('only one row would survive persistence');
      }
      try {
        TransactionIdentityService.assertUniqueIds([row({ id: 'e' })], [row({ id: 'e' })]);
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e.duplicates[0].scope).toBe('AGAINST_EXISTING');
        expect(e.message).toContain('already exists in the ledger');
      }
    });

    it('reports every colliding id, not just the first', () => {
      try {
        TransactionIdentityService.assertUniqueIds(
          [row({ id: 'p' }), row({ id: 'p' }), row({ id: 'q' }), row({ id: 'q' })], []
        );
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e.duplicates.map((d: any) => d.id).sort()).toEqual(['p', 'q']);
      }
    });

    it('an empty batch is trivially fine', () => {
      expect(() => TransactionIdentityService.assertUniqueIds([], [row()])).not.toThrow();
    });

    it('does NOT regenerate a supplied id — it refuses', () => {
      const incoming = [row({ id: 'keep-me' })];
      try { TransactionIdentityService.assertUniqueIds(incoming, [row({ id: 'keep-me' })]); } catch { /* expected */ }
      expect(incoming[0].id).toBe('keep-me');   // untouched
    });
  });

  /* ══════════════ §2 P-1 at the repository admission boundary ══════════════ */
  describe('§2 repository admission', () => {
    it('append rejects an id that already exists', async () => {
      const A = acct('A', 10000);
      const first = TransactionFactory.createIncome({
        title: 'One', amount: 500, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.append(first);

      const r = await attempt(() => repository.transactions.append({ ...first, amount: 999 }));
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(DuplicateTransactionIdError);
      expect(repo.transactionsData).toHaveLength(1);
      expect(repo.transactionsData[0].amount).toBe(500);   // original intact
    });

    it('appendMany rejects a duplicate WITHIN the batch', async () => {
      const A = acct('A', 10000);
      const a = TransactionFactory.createIncome({
        title: 'One', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      const r = await attempt(() =>
        repository.transactions.appendMany([a, { ...a, amount: 250 }])
      );
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(DuplicateTransactionIdError);
      expect(repo.transactionsData).toHaveLength(0);   // nothing partially persisted
    });

    it('appendMany rejects a duplicate AGAINST existing data', async () => {
      const A = acct('A', 10000);
      const a = TransactionFactory.createIncome({
        title: 'One', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.appendMany([a]);
      const b = TransactionFactory.createIncome({
        title: 'Two', amount: 200, account: 'A', accountId: A.id, category: 'G'
      });
      const r = await attempt(() =>
        repository.transactions.appendMany([b, { ...a, amount: 999 }])
      );
      expect(r.rejected).toBe(true);
      expect(repo.transactionsData).toHaveLength(1);    // b was NOT partially written
      expect(repo.transactionsData[0].id).toBe(a.id);
    });

    it('the exact discovery scenario no longer loses money', async () => {
      const A = acct('A', 10000);
      const mk = (n: number, amt: number): any => ({
        ...row({ id: 'SAME-ID', amount: amt, narration: 'NARR' + n, accountId: A.id, account: 'A' })
      });
      const res = S().commitImportedRows([mk(1, 100), mk(2, 250)]);
      // Neither row is admitted; nothing can collapse on reload, AND the
      // reported outcome matches what actually happened.
      expect(res.appended).toBe(0);
      expect(res.rejectedDuplicateIdRows).toBe(2);
      expect(repo.transactionsData).toHaveLength(0);
      expect(bal(A)).toBe(10000);
    });

    /**
     * MUTATION-DRIVEN (M10). Removing the duplicate-id `continue` in
     * commitImportedRows left the reported counts accidentally correct, because
     * the repository then refused the WHOLE batch. The user-visible difference
     * is this case: a mixed import must still land its good rows instead of
     * being rejected wholesale by two bad ones.
     */
    it('a mixed import keeps the valid rows and rejects only the colliding ids', async () => {
      const A = acct('A', 10000);
      const dup = (n: number, amt: number): any => row({
        id: 'COLLIDE', amount: amt, narration: 'DUP' + n, accountId: A.id, account: 'A'
      });
      const good: any = row({ id: 'GOOD-1', amount: 400, narration: 'GENUINE ROW', accountId: A.id, account: 'A' });

      const res = S().commitImportedRows([dup(1, 100), good, dup(2, 250)]);
      await drain();

      expect(res.rejectedDuplicateIdRows).toBe(2);
      expect(res.appended).toBe(1);
      expect(repo.transactionsData.map(t => t.id)).toEqual(['GOOD-1']);
      expect(bal(A)).toBe(10400);
    });

    it('valid unique transactions remain accepted', async () => {
      const A = acct('A', 10000);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'One', amount: 500, account: 'A', accountId: A.id, category: 'G'
      }));
      await repository.transactions.append(TransactionFactory.createExpense({
        title: 'Two', amount: 200, account: 'A', accountId: A.id, category: 'G'
      }));
      expect(repo.transactionsData).toHaveLength(2);
    });

    it('PrismaTransactionRepository mirrors the guard', async () => {
      const r2 = new PrismaTransactionRepository();
      await expect(r2.appendMany([row({ id: 'z' }), row({ id: 'z' })]))
        .rejects.toBeInstanceOf(DuplicateTransactionIdError);
      await expect(r2.appendMany([row({ id: 'z1' }), row({ id: 'z2' })]))
        .resolves.toBeUndefined();
    });
  });

  /* ═════════════ §3 P-1 existing-data detection (report only) ══════════════ */
  describe('§3 existing-data detection', () => {
    it('detects duplicate ids present in stored data', () => {
      const txs = [row({ id: 'dup' }), row({ id: 'dup', amount: 250 }), row({ id: 'ok' })];
      const found = TransactionIdentityService.findDuplicateIds(txs);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('dup');
      expect(found[0].count).toBe(2);
      expect(found[0].scope).toBe('IN_STORED_DATA');
    });

    it('reports a clean ledger as clean', () => {
      expect(TransactionIdentityService.findDuplicateIds([row({ id: 'a' }), row({ id: 'b' })]))
        .toHaveLength(0);
    });

    it('detection does NOT delete, repair, merge or pick a winner', () => {
      const txs = [row({ id: 'dup', amount: 100 }), row({ id: 'dup', amount: 250 })];
      const snapshot = JSON.parse(JSON.stringify(txs));
      TransactionIdentityService.findDuplicateIds(txs);
      expect(txs).toEqual(snapshot);
      expect(txs).toHaveLength(2);
      expect(txs.map(t => t.amount)).toEqual([100, 250]);
    });

    it('the report states that nothing was modified', () => {
      const [d] = TransactionIdentityService.findDuplicateIds([row({ id: 'x' }), row({ id: 'x' })]);
      expect(d.message).toContain('no row was modified or removed');
    });

    it('the repository exposes a load-time duplicate-id report field', () => {
      expect(Array.isArray(repo.duplicateTransactionIdsAtLoad)).toBe(true);
    });
  });

  /* ══════════ §4 DATA-06a / DATA-06b semantics must be UNCHANGED ═══════════ */
  describe('§4 upstream authorities unchanged', () => {
    it('the fingerprint canonical string and digest are untouched', () => {
      expect(TransactionIdentityService.canonicalString({
        account: 'HDFC Bank', date: '2026-06-01', amount: 5000, narration: 'ACME PAYROLL JUN'
      })).toBe('HDFC Bank|2026-06-01|5000|acme payroll jun');
    });

    it('id and fingerprint stay independent — same event, different rows', () => {
      const a = row({ id: 'row-1' });
      const b = row({ id: 'row-2' });
      // identical economic event, different ids: fingerprints match by design
      expect(TransactionIdentityService.fingerprintOf(a))
        .toBe(TransactionIdentityService.fingerprintOf(b));
      // and uniqueness does not object, because the IDS differ
      expect(() => TransactionIdentityService.assertUniqueIds([a, b], [])).not.toThrow();
    });

    it('valid transfer pairs with unique ids are still accepted', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      expect(repo.transactionsData.filter(t => t.type === 'Transfer')).toHaveLength(2);
      expect(bal(A)).toBe(8000);
      expect(bal(B)).toBe(7000);
    });

    it('duplicate-ID transfer legs are rejected with NO partial persistence', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      const r = await attempt(() =>
        repository.transactions.appendMany([d, { ...c, id: d.id }])
      );
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(DuplicateTransactionIdError);
      expect(repo.transactionsData).toHaveLength(0);
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
    });

    it('DATA-06b invariants remain intact — a lone leg is still refused', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      const r = await attempt(() => repository.transactions.append(d));
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(TransferIntegrityError);
    });

    it('DATA-06b unequal-amount refusal is unchanged', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      const r = await attempt(() =>
        repository.transactions.appendMany([d, { ...c, amount: 3000 }])
      );
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(TransferIntegrityError);
    });
  });

  /* ══════════════ §5 P-5 persistence failure must propagate ════════════════ */
  describe('§5 persistence failure propagation', () => {
    it('a save failure REJECTS rather than resolving', async () => {
      IndexedDBStorageService.simulateFailureOnce = true;
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [], liabilities: [], snapshots: []
      })).rejects.toThrow(/persistence failure/i);
    });

    it('the rejection reaches the APPLICATION caller through the repository', async () => {
      const A = acct('A', 10000); await drain();
      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => repository.transactions.append(
        TransactionFactory.createIncome({
          title: 'Salary', amount: 500, account: 'A', accountId: A.id, category: 'G'
        })
      ));
      expect(r.rejected).toBe(true);            // caller sees failure, not success
    });

    it('a failed save does not leave the row applied in memory (rollback intact)', async () => {
      const A = acct('A', 10000); await drain();
      IndexedDBStorageService.simulateFailureOnce = true;
      await attempt(() => repository.transactions.append(
        TransactionFactory.createIncome({
          title: 'Salary', amount: 500, account: 'A', accountId: A.id, category: 'G'
        })
      ));
      expect(repo.transactionsData).toHaveLength(0);
      expect(bal(A)).toBe(10000);
    });

    it('a failed appendMany rolls back BOTH transfer legs together', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000); await drain();
      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => S().addTransfer('A', 'B', 2000));
      expect(r.rejected).toBe(true);
      expect(repo.transactionsData).toHaveLength(0);
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
    });

    it('successful save behaviour is unchanged', async () => {
      const A = acct('A', 10000);
      await expect(repository.transactions.append(
        TransactionFactory.createIncome({
          title: 'Salary', amount: 500, account: 'A', accountId: A.id, category: 'G'
        })
      )).resolves.toBeUndefined();
      expect(repo.transactionsData).toHaveLength(1);
      expect(bal(A)).toBe(10500);
    });

    it('the failure flag is one-shot — the next save succeeds', async () => {
      const A = acct('A', 10000); await drain();
      IndexedDBStorageService.simulateFailureOnce = true;
      await attempt(() => repository.transactions.append(TransactionFactory.createIncome({
        title: 'A', amount: 100, account: 'A', accountId: A.id, category: 'G'
      })));
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'B', amount: 200, account: 'A', accountId: A.id, category: 'G'
      }));
      expect(repo.transactionsData).toHaveLength(1);
      expect(bal(A)).toBe(10200);
    });

    it('appendMany remains atomic — a rejected batch persists nothing', async () => {
      const A = acct('A', 10000);
      const a = TransactionFactory.createIncome({ title: 'A', amount: 100, account: 'A', accountId: A.id, category: 'G' });
      const b = TransactionFactory.createIncome({ title: 'B', amount: 200, account: 'A', accountId: A.id, category: 'G' });
      await drain();
      IndexedDBStorageService.simulateFailureOnce = true;
      await attempt(() => repository.transactions.appendMany([a, b]));
      expect(repo.transactionsData).toHaveLength(0);
    });

    it('clearAll also propagates its failure instead of reporting success', async () => {
      IndexedDBStorageService.simulateFailureOnce = true;
      await expect(IndexedDBStorageService.clearAll()).rejects.toThrow(/persistence failure/i);
    });

    /* ---- the REAL IndexedDB error path (mutation-driven, see stub above) ---- */

    it('a genuine IndexedDB failure makes saveAll REJECT (not silently fall back)', async () => {
      await withFailingIndexedDB(async () => {
        await expect(IndexedDBStorageService.saveAll({
          transactions: [], assets: [], liabilities: [], snapshots: []
        })).rejects.toThrow();
      });
    });

    it('a genuine IndexedDB failure makes clearAll REJECT', async () => {
      await withFailingIndexedDB(async () => {
        await expect(IndexedDBStorageService.clearAll()).rejects.toThrow();
      });
    });

    it('a genuine IndexedDB failure propagates all the way to the repository caller', async () => {
      const A = acct('A', 10000); await drain();
      await withFailingIndexedDB(async () => {
        const r = await attempt(() => repository.transactions.append(
          TransactionFactory.createIncome({
            title: 'Salary', amount: 500, account: 'A', accountId: A.id, category: 'G'
          })
        ));
        expect(r.rejected).toBe(true);
        // and the optimistic in-memory write is rolled back
        expect(repo.transactionsData).toHaveLength(0);
      });
    });

    it('a genuine IndexedDB failure does NOT silently populate the in-memory fallback as success', async () => {
      await withFailingIndexedDB(async () => {
        let resolvedSuccessfully = false;
        try {
          await IndexedDBStorageService.saveAll({
            transactions: [row({ id: 'ghost' })], assets: [], liabilities: [], snapshots: []
          });
          resolvedSuccessfully = true;
        } catch { /* expected */ }
        expect(resolvedSuccessfully).toBe(false);
      });
    });
  });

  /* ══════════════════ §6 scope boundary — no lifecycle ═════════════════════ */
  describe('§6 scope boundary — 06c-0 ships no lifecycle', () => {
    it('still no transaction remove/update/replace API', () => {
      const t = repository.transactions as any;
      expect(typeof t.remove).toBe('undefined');
      expect(typeof t.update).toBe('undefined');
      expect(typeof t.replace).toBe('undefined');
    });

    it('still no reversal / amendment / tombstone / restore API', () => {
      const t = repository.transactions as any;
      expect(typeof t.reverse).toBe('undefined');
      expect(typeof t.amend).toBe('undefined');
      expect(typeof t.tombstone).toBe('undefined');
      expect(typeof t.restore).toBe('undefined');
    });

    it('still no import-batch rollback API', () => {
      const t = repository.transactions as any;
      expect(typeof t.removeBatch).toBe('undefined');
      expect(typeof (S() as any).rollbackImport).toBe('undefined');
    });

    /**
     * NARROWED BY WP-FB-DATA-06c-1.
     *
     * Previously titled "no soft-delete or lifecycle field was added". That is
     * no longer accurate: 06c-1 added `excludedAt`/`excludedReason` under the
     * resolved Decision 13-b. The assertion itself never covered those names, so
     * it did not fail — but a test whose title outruns what it checks is worse
     * than no test. Narrowed to what it actually guards: the fields that would
     * encode an UNRESOLVED decision still do not exist.
     */
    it('no UNRESOLVED-decision lifecycle field was added to the model', () => {
      const A = acct('A', 10000);
      const tx = TransactionFactory.createIncome({
        title: 'S', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      expect((tx as any).deletedAt).toBeUndefined();       // Decision 1
      expect((tx as any).supersededById).toBeUndefined();  // Decision 5
      expect((tx as any).amendedAt).toBeUndefined();       // Decision 2
      expect((tx as any).lifecycleState).toBeUndefined();  // Decision 1
      // and 06c-1 writes nothing, even for the reason it DOES know about
      expect((tx as any).excludedAt).toBeUndefined();
    });
  });
});
