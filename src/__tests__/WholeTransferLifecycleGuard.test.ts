/**
 * WP-FB-DATA-06c-1a — Whole-transfer exclusion & edit guard (Decision D8).
 *
 *   "A transfer must never be amended, excluded, deleted, superseded, restored,
 *    or otherwise lifecycle-mutated one leg at a time."
 *
 * THE GAP THIS CLOSES
 *
 * DATA-06b validates STRUCTURE. Excluding a leg adds and removes no rows,
 * changes no amount and no direction — so a half-excluded transfer is
 * structurally perfect while money quietly leaves the system. The 06c decision
 * gate measured it: one leg excluded -> system total 15,000 -> 13,000, with
 * TransferIntegrityService reporting the transfer clean.
 *
 *   §1  detection — partial exclusion is now a transfer defect
 *   §2  the whole-transfer gate refuses partial application
 *   §3  the gate is wired into the live lifecycle write path
 *   §4  pre-existing partial exclusion is reported, never repaired
 *   §5  whole-transfer operations remain permitted
 *   §6  upstream authorities unchanged
 *   §7  scope boundary — no decision resolved implicitly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  TransferIntegrityService,
  PartialTransferLifecycleError,
  TransferIntegrityError
} from '../services/TransferIntegrityService';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { ImportBatchRollbackService, BatchRollbackError } from '../services/ImportBatchRollbackService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { PrismaTransactionRepository } from '../repositories/PrismaRepository';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: any[];
  partiallyExcludedTransfersAtLoad: any[];
  syncStore: () => void;
};
const S = () => useCanonicalLedger.getState();
const EXCL = { excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const };

function reset() {
  repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  });
}
function acct(n: string, o = 0) {
  S().addAccount({ name: n, type: 'Bank' as any, openingBalance: o, asOfDate: '2026-08-01' });
  return S().accounts.find((a: any) => a.name === n)!;
}
const bal = (a: any) =>
  AccountBalanceService.balance(a.id, S().accounts, S().transactions, ASOF).balance;
const force = (n: Transaction[]) => { repo.transactionsData = n; repo.syncStore(); };
const drain = () => new Promise(r => setTimeout(r, 20));

function pair(A: any, B: any, amount = 2000, over: Partial<Transaction> = {}) {
  const [d, c] = TransactionFactory.createTransferPair({
    source: A.name, destination: B.name, amount,
    sourceAccountId: A.id, destinationAccountId: B.id
  });
  return [{ ...d, ...over }, { ...c, ...over }] as Transaction[];
}
async function seedTransfer(A: any, B: any, amount = 2000, over: Partial<Transaction> = {}) {
  const legs = pair(A, B, amount, over);
  await repository.transactions.appendMany(legs);
  return legs;
}
async function attempt(fn: () => Promise<any>) {
  try { const v = await fn(); return { ok: true, value: v, error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}

describe('WP-FB-DATA-06c-1a — whole-transfer lifecycle guard', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ════════════════════════════ §1 detection ═══════════════════════════════ */
  describe('§1 partial exclusion is a transfer defect', () => {
    it('a fully live transfer is clean', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(0);
    });

    it('a fully EXCLUDED transfer is clean — all-or-nothing is fine', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      force(repo.transactionsData.map(t => ({ ...t, ...EXCL })));
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(0);
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
    });

    it('a HALF-excluded transfer is now reported (was invisible)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      force(repo.transactionsData.map(t => t.direction === 'CREDIT' ? { ...t, ...EXCL } : t));

      const broken = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(broken).toHaveLength(1);
      expect(broken[0].status).toBe('BROKEN');
      expect(broken[0].violations.map(v => v.code)).toContain('PARTIALLY_EXCLUDED');
      // and the money really did leave
      expect(bal(A) + bal(B)).toBe(13000);
    });

    it('findPartiallyExcludedTransfers isolates exactly this defect', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData)).toHaveLength(0);
      force(repo.transactionsData.map(t => t.direction === 'DEBIT' ? { ...t, ...EXCL } : t));
      const found = TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData);
      expect(found).toHaveLength(1);
      expect(found[0].violations[0].message).toContain('excluded as a whole or not at all');
    });

    it('the defect is reported for either leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      for (const dir of ['DEBIT', 'CREDIT']) {
        force(repo.transactionsData.map(t => ({ ...t, excludedAt: undefined, excludedReason: undefined })));
        force(repo.transactionsData.map(t => t.direction === dir ? { ...t, ...EXCL } : t));
        expect(TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData)).toHaveLength(1);
      }
    });

    it('an ordinary excluded non-transfer row is NOT reported', async () => {
      const A = acct('A', 10000);
      const tx = TransactionFactory.createIncome({
        title: 'X', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.append(tx);
      force(repo.transactionsData.map(t => ({ ...t, ...EXCL })));
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData)).toHaveLength(0);
    });
  });

  /* ═══════════════════════ §2 the gate refuses ═════════════════════════════ */
  describe('§2 assertWholeTransferLifecycle', () => {
    it('permits a change that excludes BOTH legs', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      const prev = [...repo.transactionsData];
      const next = prev.map(t => ({ ...t, ...EXCL }));
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, next)).not.toThrow();
    });

    it('REFUSES a change that excludes only one leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      const prev = [...repo.transactionsData];
      const next = prev.map(t => t.direction === 'CREDIT' ? { ...t, ...EXCL } : t);
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, next))
        .toThrow(PartialTransferLifecycleError);
    });

    it('the refusal names the transfer and cites D8', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = await seedTransfer(A, B);
      const prev = [...repo.transactionsData];
      const next = prev.map(t => t.direction === 'DEBIT' ? { ...t, ...EXCL } : t);
      try {
        TransferIntegrityService.assertWholeTransferLifecycle(prev, next);
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(PartialTransferLifecycleError);
        expect(e.transferIds).toEqual([d.transferId]);
        expect(e.message).toContain('Decision D8');
        expect(e.message).toContain('whole');
      }
    });

    it('permits a no-op change', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      const prev = [...repo.transactionsData];
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, [...prev])).not.toThrow();
    });

    it('permits changes to unrelated non-transfer rows', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      const income = TransactionFactory.createIncome({
        title: 'X', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.append(income);
      const prev = [...repo.transactionsData];
      const next = prev.map(t => t.id === income.id ? { ...t, ...EXCL } : t);
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, next)).not.toThrow();
    });

    it('does NOT freeze a ledger that was ALREADY partly excluded', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      // pre-existing bad state, not caused by the operation under test
      force(repo.transactionsData.map(t => t.direction === 'CREDIT' ? { ...t, ...EXCL } : t));
      const prev = [...repo.transactionsData];
      const next = [...prev];   // an unrelated later operation
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, next)).not.toThrow();
    });

    it('a group that is not exactly two legs is left to assertAdmissible', () => {
      const lone: any = {
        id: 'x', transferId: 'tr-1', date: '2026-08-10', dateStr: 'x', title: 't',
        narration: 'n', account: 'A', accountId: 'a', type: 'Transfer', direction: 'DEBIT',
        category: 'TRANSFER', amount: 100, status: 'CLEARED', ...EXCL
      };
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle([], [lone])).not.toThrow();
    });
  });

  /* ══════════════ §3 wired into the live lifecycle write path ══════════════ */
  describe('§3 the live write path is gated', () => {
    it('a batch rollback that would split a transfer is refused', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'b1', origin: 'IMPORT' },
        { ...c, importBatchId: 'b2', origin: 'IMPORT' }
      ]);
      const before = bal(A) + bal(B);
      const r = await attempt(() => repository.transactions.rollbackBatch('b1'));
      expect(r.ok).toBe(false);
      expect(bal(A) + bal(B)).toBe(before);
      expect(repo.transactionsData.every(t => !LedgerExclusionService.isExcluded(t))).toBe(true);
    });

    it('a whole-transfer batch rollback still succeeds', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'bt', origin: 'IMPORT' },
        { ...c, importBatchId: 'bt', origin: 'IMPORT' }
      ]);
      const res = await repository.transactions.rollbackBatch('bt');
      expect(res.excludedCount).toBe(2);
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData)).toHaveLength(0);
    });

    it('the gate runs BEFORE anything is mutated or persisted', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'b1', origin: 'IMPORT' },
        { ...c, importBatchId: 'b2', origin: 'IMPORT' }
      ]);
      await drain();
      const snapshot = JSON.parse(JSON.stringify(repo.transactionsData));
      await attempt(() => repository.transactions.rollbackBatch('b1'));
      expect(repo.transactionsData).toEqual(snapshot);
    });

    /**
     * MUTATION-DRIVEN (M9/M10).
     *
     * For the ONLY lifecycle write path that exists today, this gate is
     * redundant: ImportBatchRollbackService.plan() already refuses a
     * split-batch rollback before the gate is reached. Removing the repository
     * call therefore changed nothing observable and the mutation survived.
     *
     * The call is still worth keeping — it is what will catch the FIRST future
     * primitive (UPDATE, REMOVE, restore) that forgets D8, and it reasons about
     * the resulting exclusion state rather than batch membership. So rather
     * than delete it, these prove the repository actually consults it, and that
     * a refusal from it aborts the write with nothing applied.
     */
    it('the repository consults the whole-transfer gate on every rollback', async () => {
      const A = acct('A', 10000);
      const r: any = {
        id: 'g-1', date: '2026-08-10', dateStr: 'x', title: 'D', narration: 'ACH/C/G',
        account: 'A', accountId: A.id, type: 'Income', direction: 'CREDIT',
        category: 'DIVIDEND', amount: 100, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bg', sourceProvider: 'SBI Bank', sourceFile: 'S.xlsx'
      };
      r.fingerprint = TransactionIdentityService.fingerprint(r);
      await repository.transactions.appendMany([r]);

      const spy = vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle');
      await repository.transactions.rollbackBatch('bg');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('a refusal from the gate aborts the rollback with nothing applied', async () => {
      const A = acct('A', 10000);
      const r: any = {
        id: 'g-2', date: '2026-08-10', dateStr: 'x', title: 'D', narration: 'ACH/C/G2',
        account: 'A', accountId: A.id, type: 'Income', direction: 'CREDIT',
        category: 'DIVIDEND', amount: 100, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bg2', sourceProvider: 'SBI Bank', sourceFile: 'S.xlsx'
      };
      r.fingerprint = TransactionIdentityService.fingerprint(r);
      await repository.transactions.appendMany([r]);
      await drain();

      const spy = vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle')
        .mockImplementation(() => {
          throw new PartialTransferLifecycleError([{ transferId: 'tr-x', message: 'forced' }]);
        });
      const res = await attempt(() => repository.transactions.rollbackBatch('bg2'));
      expect(res.ok).toBe(false);
      expect(res.error).toBeInstanceOf(PartialTransferLifecycleError);
      expect(LedgerExclusionService.isExcluded(repo.transactionsData[0])).toBe(false);
      expect(bal(A)).toBe(10100);
      spy.mockRestore();
    });

    it('PrismaTransactionRepository consults the gate too', async () => {
      const spy = vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle');
      const r2 = new PrismaTransactionRepository();
      // findAllSync() is [] in the stub, so the plan refuses first; force a
      // reachable path by asserting the gate is wired for an admissible plan.
      const planSpy = vi.spyOn(ImportBatchRollbackService, 'plan').mockReturnValue({
        batchId: 'p1', status: 'ADMISSIBLE', targetIds: [], alreadyExcludedIds: []
      } as any);
      await r2.rollbackBatch('p1');
      expect(spy).toHaveBeenCalled();
      planSpy.mockRestore();
      spy.mockRestore();
    });

    it('PrismaTransactionRepository mirrors the gate', async () => {
      const r2 = new PrismaTransactionRepository();
      await expect(r2.rollbackBatch('anything')).rejects.toBeInstanceOf(BatchRollbackError);
    });
  });

  /* ══════════ §4 pre-existing partial exclusion: report, never repair ══════ */
  describe('§4 detection is report-only', () => {
    it('the repository exposes a load-time report field', () => {
      expect(Array.isArray(repo.partiallyExcludedTransfersAtLoad)).toBe(true);
    });

    it('detection modifies nothing', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      force(repo.transactionsData.map(t => t.direction === 'CREDIT' ? { ...t, ...EXCL } : t));
      const snapshot = JSON.parse(JSON.stringify(repo.transactionsData));
      TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData);
      TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(repo.transactionsData).toEqual(snapshot);
    });

    it('no row is auto-excluded or auto-restored to fix the imbalance', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      force(repo.transactionsData.map(t => t.direction === 'CREDIT' ? { ...t, ...EXCL } : t));
      TransferIntegrityService.findPartiallyExcludedTransfers(repo.transactionsData);
      const excluded = repo.transactionsData.filter(t => LedgerExclusionService.isExcluded(t));
      expect(excluded).toHaveLength(1);      // still exactly one — untouched
      expect(repo.transactionsData).toHaveLength(2);
    });
  });

  /* ══════════════ §5 whole-transfer operations remain permitted ════════════ */
  describe('§5 whole-transfer operations still work', () => {
    it('excluding both legs preserves the system total', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      expect(bal(A) + bal(B)).toBe(15000);
      force(repo.transactionsData.map(t => ({ ...t, ...EXCL })));
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('both legs stay visible in the Ledger when excluded (DATA-02)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      const visible = () => S().getFilteredTransactions({ dateRange: 'YTD', type: 'All' } as any).length;
      expect(visible()).toBe(2);
      force(repo.transactionsData.map(t => ({ ...t, ...EXCL })));
      expect(visible()).toBe(2);
      expect(repo.transactionsData).toHaveLength(2);
    });

    it('ordinary income/expense exclusion is unaffected by the gate', async () => {
      const A = acct('A', 10000);
      const tx = TransactionFactory.createIncome({
        title: 'X', amount: 500, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.append(tx);
      const prev = [...repo.transactionsData];
      const next = prev.map(t => ({ ...t, ...EXCL }));
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, next)).not.toThrow();
    });
  });

  /* ═════════════════ §6 upstream authorities unchanged ═════════════════════ */
  describe('§6 upstream authorities unchanged', () => {
    it('DATA-06b still refuses a lone transfer leg at append', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = pair(A, B);
      await expect(repository.transactions.append(d)).rejects.toBeInstanceOf(TransferIntegrityError);
    });

    it('DATA-06b still refuses an unequal pair', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      await expect(repository.transactions.appendMany([d, { ...c, amount: 3000 }]))
        .rejects.toBeInstanceOf(TransferIntegrityError);
    });

    it('DATA-06c-0 id uniqueness unchanged', async () => {
      const A = acct('A', 10000);
      const tx = TransactionFactory.createIncome({
        title: 'X', amount: 100, account: 'A', accountId: A.id, category: 'G'
      });
      await repository.transactions.append(tx);
      await expect(repository.transactions.append({ ...tx, amount: 5 })).rejects.toThrow();
    });

    /* SUPERSEDED became recognised in WP-FB-DATA-06c-2 (D11 = B). An
     * unrecognised reason must still report UNKNOWN rather than being guessed. */
    it('DATA-06c-1 exclusion vocabulary resolves only decided reasons', () => {
      const row: any = { id: 'x', amount: 1, narration: 'n', ...EXCL };
      expect(LedgerExclusionService.reasonOf(row)).toBe('IMPORT_ROLLBACK');
      expect(LedgerExclusionService.reasonOf({ ...row, excludedReason: 'SUPERSEDED' } as any)).toBe('SUPERSEDED');
      expect(LedgerExclusionService.reasonOf({ ...row, excludedReason: 'DELETED' } as any)).toBe('UNKNOWN');
      expect(LedgerExclusionService.reasonOf({ ...row, excludedReason: 'REVERSED' } as any)).toBe('UNKNOWN');
    });

    it('BROKEN from a deleted account is still reported independently', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      await repository.accounts.remove(B.id);
      const broken = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(broken[0].violations.map(v => v.code)).toContain('ORPHANED_ACCOUNT_REFERENCE');
      expect(broken[0].violations.map(v => v.code)).not.toContain('PARTIALLY_EXCLUDED');
    });

    it('ImportBatchRollbackService planning is unchanged', async () => {
      const A = acct('A', 10000);
      const r: any = {
        id: 'i-1', date: '2026-08-10', dateStr: 'x', title: 'D', narration: 'ACH/C/D',
        account: 'A', accountId: A.id, type: 'Income', direction: 'CREDIT',
        category: 'DIVIDEND', amount: 400, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bz', sourceProvider: 'SBI Bank', sourceFile: 'S.xlsx'
      };
      r.fingerprint = TransactionIdentityService.fingerprint(r);
      await repository.transactions.appendMany([r]);
      const plan = ImportBatchRollbackService.plan('bz', repo.transactionsData);
      expect(plan.status).toBe('ADMISSIBLE');
    });
  });

  /* ═══════════════════════════ §7 scope boundary ═══════════════════════════ */
  describe('§7 no decision resolved implicitly', () => {
    /* WP-FB-DATA-06c-2 NARROWED THIS TEST — deliberately, and by exactly one
     * name. `supersede` was authorised by Decisions D3/D5/D10/D12, so it is now
     * asserted PRESENT rather than absent. Every other name stays forbidden,
     * and `restore` in particular stays forbidden because Q2 = d deferred it to
     * WP-FB-DATA-06c-2b. Widening this list is how an unmade decision gets made
     * by accident. */
    it('the ONLY lifecycle primitive added is supersede (D12 = C)', () => {
      const t = repository.transactions as any;
      expect(typeof t.supersede).toBe('function');
      // 06c-2b added `restoreBatch` (D6-1 = R5). A bare `restore` stays absent.
      expect(typeof t.restoreBatch).toBe('function');
      for (const k of ['update', 'remove', 'replace', 'patch', 'amend', 'reverse',
                       'tombstone', 'restore', 'unsupersede', 'removeBatch']) {
        expect(typeof t[k]).toBe('undefined');
      }
    });

    it('still no GENERAL undo surface (D6-7 keeps it withheld)', () => {
      expect(typeof (S() as any).undo).toBe('undefined');
      expect(typeof (S() as any).restoreTransaction).toBe('undefined');
      // batch restore is the one authorised exception
      expect(typeof (S() as any).restoreImportBatch).toBe('function');
    });

    it('DELETED is still not an exclusion reason (D11 = B added SUPERSEDED only)', () => {
      const row: any = { id: 'x', amount: 1, narration: 'n',
        excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'DELETED' };
      expect(LedgerExclusionService.reasonOf(row)).toBe('UNKNOWN');
    });

    it('a newly recorded row carries no lifecycle or link state (D10 = C is backward-only)', async () => {
      const A = acct('A', 10000);
      const tx: any = TransactionFactory.createIncome({
        title: 'X', amount: 1, account: 'A', accountId: A.id, category: 'G'
      });
      // D10 = C chose a BACKWARD pointer; a forward one must never appear.
      expect(tx.supersededById).toBeUndefined();
      // and an ORIGINAL is never born a correction
      expect(tx.supersedes).toBeUndefined();
      expect(tx.provenanceDiverged).toBeUndefined();
      expect(tx.amendedAt).toBeUndefined();
      expect(tx.deletedAt).toBeUndefined();
      expect(tx.lifecycleState).toBeUndefined();
      expect(tx.excludedAt).toBeUndefined();
    });

    it('the guard REFUSES rather than repairing (D5/D6/D9 unresolved)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransfer(A, B);
      const prev = [...repo.transactionsData];
      const next = prev.map(t => t.direction === 'CREDIT' ? { ...t, ...EXCL } : t);
      expect(() => TransferIntegrityService.assertWholeTransferLifecycle(prev, next)).toThrow();
      // it did not "helpfully" exclude the other leg to make it whole
      expect(next.filter(t => LedgerExclusionService.isExcluded(t))).toHaveLength(1);
    });
  });
});
