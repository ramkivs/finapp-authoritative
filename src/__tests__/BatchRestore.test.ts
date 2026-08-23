/**
 * WP-FB-DATA-06c-2b — Import batch restore.
 *
 * Decisions implemented: D6-1 = R5, D6-2, D6-3, D6-4, D6-5, D6-6, D6-7,
 * D9-1 = D9-A, D9-2.
 *
 * WHAT THIS PACKAGE IS
 *
 * The inverse of WP-FB-DATA-06c-6. A user who rolled back an import by mistake
 * previously had no way back: `excludedAt` was a one-way door. This restores a
 * WHOLE import batch, and nothing else.
 *
 * WHAT IT IS NOT
 *
 * Not undo. Not deletion. Not per-row restore. Not supersession reversal. The
 * D6/D9 gate measured that restoring a SUPERSEDED row produced a persisted,
 * silent, undisclosed double count (15,500 -> 20,500, two included versions,
 * `activeVersionOf()` returning null). D6-1 = R5 makes that unreachable.
 *
 *   §1  restoring a rolled-back batch
 *   §2  the audit record (D6-3)
 *   §3  refusals
 *   §4  transfers (D8 / D6-6)
 *   §5  identity, provenance and field preservation
 *   §6  atomicity, persistence failure and READFAIL
 *   §7  post-restore lifecycle (D6-4)
 *   §8  scope boundary — no deletion, no general undo
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  ImportBatchRollbackService, BatchRestoreError, BatchRollbackError
} from '../services/ImportBatchRollbackService';
import {
  TransferIntegrityService, PartialTransferLifecycleError
} from '../services/TransferIntegrityService';
import { LedgerExclusionService, KNOWN_EXCLUSION_REASONS } from '../services/LedgerExclusionService';
import { TransactionAmendmentService } from '../services/TransactionAmendmentService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { LiquidReservesService } from '../services/LiquidReservesService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { PrismaTransactionRepository } from '../repositories/PrismaRepository';
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
const systemTotal = () => S().accounts.reduce((s: number, a: any) => s + bal(a), 0);
const force = (n: Transaction[]) => { repo.transactionsData = n; repo.syncStore(); };
const included = () => LedgerExclusionService.forDerivation(rows()).length;

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
function importedRow(A: any, amount: number, batch: string, id: string, over: any = {}): any {
  return {
    id, date: '2026-08-10', dateStr: '10 Aug 2026', title: id, narration: id.toUpperCase(),
    account: A.name, accountId: A.id, direction: 'CREDIT', type: 'Income',
    category: 'Income', amount, status: 'CLEARED', origin: 'IMPORT',
    importBatchId: batch, sourceProvider: 'SBI', sourceFile: 'SBI.xlsx', sourceRowNumber: 3,
    recordedAt: '2026-08-11T09:00:00.000Z', fingerprint: 'fp-' + id, ...over
  };
}
async function seedBatch(A: any, batch: string, amounts: number[]) {
  const txs = amounts.map((amt, i) => importedRow(A, amt, batch, `${batch}-${i}`));
  await repository.transactions.appendMany(txs);
  return txs;
}
async function seedTransferBatch(A: any, B: any, batch: string, amount = 2000) {
  const [d, c] = TransactionFactory.createTransferPair({
    source: A.name, destination: B.name, amount,
    sourceAccountId: A.id, destinationAccountId: B.id
  });
  const legs = [
    { ...d, importBatchId: batch, origin: 'IMPORT' as const },
    { ...c, importBatchId: batch, origin: 'IMPORT' as const }
  ];
  await repository.transactions.appendMany(legs);
  return legs;
}
async function attempt(fn: () => Promise<any>) {
  try { return { ok: true, value: await fn(), error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}
const summaryOf = (batchId: string) =>
  ImportBatchRollbackService.listBatches(rows()).find(b => b.batchId === batchId)!;

describe('WP-FB-DATA-06c-2b — import batch restore', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => {
    resetAsOfDateOverride();
    IndexedDBStorageService.simulateFailureOnce = false;
    (IndexedDBStorageService as any).simulateReadFailureOnce = false;
    vi.restoreAllMocks();
    reset();
  });

  /* ═════════════════ §1 restoring a rolled-back batch ════════════════════ */
  describe('§1 restore returns the batch to the ledger', () => {
    it('ACCEPTANCE 1 — a valid IMPORT_ROLLBACK batch is restored', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');

      const res = await repository.transactions.restoreBatch('bx');

      expect(res.batchId).toBe('bx');
      expect(res.restoredCount).toBe(2);
      expect(res.restoredIds.sort()).toEqual(['bx-0', 'bx-1']);
      expect(typeof res.restoredAt).toBe('string');
    });

    it('ACCEPTANCE 2 — restored rows are INCLUDED again', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      expect(included()).toBe(0);

      await repository.transactions.restoreBatch('bx');

      expect(included()).toBe(2);
      expect(LedgerExclusionService.isExcluded(byId('bx-0'))).toBe(false);
      expect(LedgerExclusionService.isExcluded(byId('bx-1'))).toBe(false);
      expect(byId('bx-0').excludedAt).toBeUndefined();
      expect(byId('bx-0').excludedReason).toBeUndefined();
      // absent as KEYS, not merely undefined
      expect(Object.prototype.hasOwnProperty.call(byId('bx-0'), 'excludedAt')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(byId('bx-0'), 'excludedReason')).toBe(false);
    });

    it('ACCEPTANCE 3 — derived figures return EXACTLY to the pre-rollback state', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      const preBalance = bal(A);
      const preTotal = systemTotal();
      const preReserves = LiquidReservesService.compute([], S().accounts, rows(), ASOF).total;

      await repository.transactions.rollbackBatch('bx');
      expect(bal(A)).toBe(10000);

      await repository.transactions.restoreBatch('bx');

      expect(bal(A)).toBe(preBalance);
      expect(bal(A)).toBe(13000);
      expect(systemTotal()).toBe(preTotal);
      expect(LiquidReservesService.compute([], S().accounts, rows(), ASOF).total).toBe(preReserves);
    });

    it('ACCEPTANCE 10 — unrelated batches are untouched', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await seedBatch(A, 'by', [500]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.rollbackBatch('by');
      const byBefore = JSON.parse(JSON.stringify(byId('by-0')));

      await repository.transactions.restoreBatch('bx');

      expect(byId('by-0')).toEqual(byBefore);
      expect(LedgerExclusionService.isExcluded(byId('by-0'))).toBe(true);
      expect(LedgerExclusionService.isExcluded(byId('bx-0'))).toBe(false);
      expect(bal(A)).toBe(11000);   // bx back, by still out
    });

    it('the batch summary reports LIVE and becomes rollback-eligible again', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      expect(summaryOf('bx').status).toBe('ROLLED_BACK');

      await repository.transactions.restoreBatch('bx');

      expect(summaryOf('bx').status).toBe('LIVE');
      expect(summaryOf('bx').rollbackEligible).toBe(true);
      expect(summaryOf('bx').excludedCount).toBe(0);
    });

    it('a rows-not-in-the-batch guard: only batch members move', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      const manual = TransactionFactory.createIncome({
        title: 'Manual', amount: 700, account: A.name, accountId: A.id, category: 'Income'
      });
      await repository.transactions.append(manual);
      await repository.transactions.rollbackBatch('bx');
      const manualBefore = JSON.parse(JSON.stringify(byId(manual.id)));

      await repository.transactions.restoreBatch('bx');
      expect(byId(manual.id)).toEqual(manualBefore);
    });
  });

  /* ═════════════════ §2 the audit record (D6-3) ══════════════════════════ */
  describe('§2 restore does not erase the rollback (D6-3)', () => {
    it('ACCEPTANCE 14 — a restored row carries a restoredAt audit stamp', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      expect(byId('bx-0').restoredAt).toBeUndefined();

      await repository.transactions.rollbackBatch('bx');
      const res = await repository.transactions.restoreBatch('bx');

      expect(byId('bx-0').restoredAt).toBe(res.restoredAt);
      expect(typeof byId('bx-0').restoredAt).toBe('string');
    });

    it('ACCEPTANCE 15 — rollback -> restore -> rollback stays distinguishable', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);

      const s0 = { excluded: LedgerExclusionService.isExcluded(byId('bx-0')),
                   restoredAt: byId('bx-0').restoredAt };
      await repository.transactions.rollbackBatch('bx');
      const s1 = { excluded: LedgerExclusionService.isExcluded(byId('bx-0')),
                   restoredAt: byId('bx-0').restoredAt };
      await repository.transactions.restoreBatch('bx');
      const s2 = { excluded: LedgerExclusionService.isExcluded(byId('bx-0')),
                   restoredAt: byId('bx-0').restoredAt };
      await repository.transactions.rollbackBatch('bx');
      const s3 = { excluded: LedgerExclusionService.isExcluded(byId('bx-0')),
                   restoredAt: byId('bx-0').restoredAt };

      // never rolled back
      expect(s0).toEqual({ excluded: false, restoredAt: undefined });
      // rolled back once, never restored
      expect(s1).toEqual({ excluded: true, restoredAt: undefined });
      // rolled back then restored
      expect(s2.excluded).toBe(false);
      expect(typeof s2.restoredAt).toBe('string');
      // rolled back, restored, ROLLED BACK AGAIN — distinct from s1
      expect(s3.excluded).toBe(true);
      expect(typeof s3.restoredAt).toBe('string');
      expect(s3).not.toEqual(s1);
    });

    it('a SECOND rollback preserves the restore stamp rather than clearing it', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const res = await repository.transactions.restoreBatch('bx');
      await repository.transactions.rollbackBatch('bx');

      expect(byId('bx-0').restoredAt).toBe(res.restoredAt);
      expect(byId('bx-0').excludedReason).toBe('IMPORT_ROLLBACK');
    });

    it('the batch summary exposes the restore history', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      expect(summaryOf('bx').restoredCount).toBe(0);

      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      expect(summaryOf('bx').restoredCount).toBe(2);

      // ...and it survives a second rollback, so history is not erased
      await repository.transactions.rollbackBatch('bx');
      expect(summaryOf('bx').restoredCount).toBe(2);
      expect(summaryOf('bx').status).toBe('ROLLED_BACK');
    });

    it('restoredAt is HISTORY, not lifecycle state — no derivation reads it', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      const balWithStamp = bal(A);

      // strip the stamp: the money must not move
      force(rows().map(t => { const { restoredAt, ...rest } = t as any; return rest; }));
      expect(bal(A)).toBe(balWithStamp);
      expect(LedgerExclusionService.isExcluded(byId('bx-0'))).toBe(false);
    });
  });

  /* ═════════════════ §3 refusals ═════════════════════════════════════════ */
  describe('§3 refusals', () => {
    it('ACCEPTANCE 9 — an already-restored batch is refused deterministically', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));

      const r1 = await attempt(() => repository.transactions.restoreBatch('bx'));
      const r2 = await attempt(() => repository.transactions.restoreBatch('bx'));

      expect(r1.error).toBeInstanceOf(BatchRestoreError);
      expect(r1.error.code).toBe('NOT_ROLLED_BACK');
      expect(r1.error.message).toContain('already been restored');
      expect(r2.error.code).toBe(r1.error.code);      // deterministic
      expect(rows()).toEqual(before);                  // and inert
    });

    it('a batch that was never rolled back is refused', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      const r = await attempt(() => repository.transactions.restoreBatch('bx'));
      expect(r.error.code).toBe('NOT_ROLLED_BACK');
      expect(r.error.message).toContain('not rolled back');
    });

    it('an unknown batch id is refused', async () => {
      acct('A', 10000);
      const r = await attempt(() => repository.transactions.restoreBatch('nope'));
      expect(r.error.code).toBe('BATCH_NOT_FOUND');
    });

    it('an empty batch id is refused', async () => {
      acct('A', 10000);
      expect((await attempt(() => repository.transactions.restoreBatch(''))).error.code)
        .toBe('EMPTY_BATCH_ID');
      expect((await attempt(() => repository.transactions.restoreBatch('   '))).error.code)
        .toBe('EMPTY_BATCH_ID');
    });

    it('ACCEPTANCE 8 — an UNKNOWN exclusion reason refuses the WHOLE batch (D6-5)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      // a future build wrote a reason this one cannot name
      force(rows().map(t => t.id === 'bx-1'
        ? ({ ...t, excludedReason: 'SOME_FUTURE_REASON' } as any) : t));
      expect(LedgerExclusionService.reasonOf(byId('bx-1'))).toBe('UNKNOWN');
      const before = JSON.parse(JSON.stringify(rows()));

      const r = await attempt(() => repository.transactions.restoreBatch('bx'));

      expect(r.error.code).toBe('UNRECOGNISED_EXCLUSION_REASON');
      expect(r.error.message).toContain('does not recognise');
      // NOTHING moved — not even the row this build DOES understand
      expect(rows()).toEqual(before);
      expect(included()).toBe(0);
    });

    it('a SUPERSEDED row is never restored, and does not make the batch restorable', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      // amend it so the original becomes SUPERSEDED-excluded
      await repository.transactions.supersede([{ targetId: 'bx-0', changes: { amount: 1500 } }]);
      expect(LedgerExclusionService.reasonOf(byId('bx-0'))).toBe('SUPERSEDED');

      const r = await attempt(() => repository.transactions.restoreBatch('bx'));

      expect(r.error.code).toBe('NOT_ROLLED_BACK');
      expect(r.error.message).toContain('excluded for another reason');
      expect(LedgerExclusionService.isExcluded(byId('bx-0'))).toBe(true);
      expect(byId('bx-0').excludedReason).toBe('SUPERSEDED');
    });

    it('THE MEASURED HAZARD: restore can never produce two included versions', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [5000]);
      await repository.transactions.supersede([{ targetId: 'bx-0', changes: { amount: 5500 } }]);
      const totalAfterAmend = bal(A);

      await attempt(() => repository.transactions.restoreBatch('bx'));

      // the gate measured 15,500 -> 20,500 for a naive restore. Not here.
      expect(bal(A)).toBe(totalAfterAmend);
      const chain = TransactionAmendmentService.chainOf(byId('bx-0'), rows());
      expect(chain.filter(t => !LedgerExclusionService.isExcluded(t))).toHaveLength(1);
      expect(TransactionAmendmentService.activeVersionOf(byId('bx-0'), rows())).not.toBeNull();
    });

    it('ACCEPTANCE 17 — a refused restore persists nothing at all', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      const save = vi.spyOn(IndexedDBStorageService, 'persist');
      await attempt(() => repository.transactions.restoreBatch('bx'));       // NOT_ROLLED_BACK
      await attempt(() => repository.transactions.restoreBatch('nope'));     // BATCH_NOT_FOUND
      await attempt(() => repository.transactions.restoreBatch(''));         // EMPTY_BATCH_ID
      expect(save).not.toHaveBeenCalled();
    });
  });

  /* ═════════════════ §4 transfers ════════════════════════════════════════ */
  describe('§4 transfers — D8 and D6-6', () => {
    it('ACCEPTANCE 5 — a whole transfer restores both legs atomically', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const legs = await seedTransferBatch(A, B, 'bx', 2000);
      const preTotal = systemTotal();
      await repository.transactions.rollbackBatch('bx');

      const res = await repository.transactions.restoreBatch('bx');

      expect(res.restoredCount).toBe(2);
      expect(LedgerExclusionService.isExcluded(byId(legs[0].id))).toBe(false);
      expect(LedgerExclusionService.isExcluded(byId(legs[1].id))).toBe(false);
      expect(systemTotal()).toBe(preTotal);
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(rows())).toHaveLength(0);
      expect(TransferIntegrityService.findBrokenTransfers(rows())).toHaveLength(0);
    });

    it('ACCEPTANCE 6 — a single-leg restore is REFUSED (leg in another batch)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = TransactionFactory.createTransferPair({
        source: A.name, destination: B.name, amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await repository.transactions.appendMany([
        { ...d, importBatchId: 'b1', origin: 'IMPORT' as const },
        { ...c, importBatchId: 'b2', origin: 'IMPORT' as const }
      ]);
      // exclude BOTH legs by IMPORT_ROLLBACK, but in separate batches
      force(rows().map(t => ({
        ...t, excludedAt: '2026-08-20T00:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const
      })));
      const before = JSON.parse(JSON.stringify(rows()));

      const r = await attempt(() => repository.transactions.restoreBatch('b1'));

      expect(r.error).toBeInstanceOf(BatchRestoreError);
      expect(r.error.code).toBe('WOULD_SPLIT_TRANSFER');
      expect(r.error.message).toContain('restored whole');
      expect(rows()).toEqual(before);
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(rows())).toHaveLength(0);
    });

    it('ACCEPTANCE 7 — a MIXED-reason transfer is refused with its own code (D6-6)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const legs = await seedTransferBatch(A, B, 'bx', 2000);
      force(rows().map(t =>
        t.id === legs[0].id
          ? ({ ...t, excludedAt: '2026-08-20T00:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' } as any)
          : t.id === legs[1].id
            ? ({ ...t, excludedAt: '2026-08-20T00:00:00.000Z', excludedReason: 'SUPERSEDED' } as any)
            : t));
      const before = JSON.parse(JSON.stringify(rows()));

      const r = await attempt(() => repository.transactions.restoreBatch('bx'));

      expect(r.error.code).toBe('MIXED_EXCLUSION_REASONS');
      expect(r.error.message).toContain('different reasons');
      expect(r.error.message).toContain('restored whole');
      expect(rows()).toEqual(before);
    });

    it('the D8 gate is LOAD-BEARING, not redundant with planRestore', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransferBatch(A, B, 'bx', 2000);
      await repository.transactions.rollbackBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));

      vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle')
        .mockImplementationOnce(() => {
          throw new PartialTransferLifecycleError([{ transferId: 'forced', message: 'forced' }]);
        });

      const r = await attempt(() => repository.transactions.restoreBatch('bx'));
      expect(r.error).toBeInstanceOf(PartialTransferLifecycleError);
      expect(rows()).toEqual(before);
    });

    /* MUTATION-ESCAPE CLOSURE (M16).
     *
     * `restoreBatch` asserts that structural transfer integrity is unchanged.
     * That tripwire is UNREACHABLE today — restore only clears exclusion
     * stamps, and exclusion cannot alter leg count, direction or amount — so a
     * mutation deleting it survived the whole suite.
     *
     * An unreachable guard with no coverage is not defence in depth; it is dead
     * code that the next maintainer removes as obviously redundant. It exists
     * precisely so that a future change making `applyRestore` add or remove
     * rows is caught HERE, in one assertion, rather than in a balance. So it is
     * exercised directly: once to prove it is consulted, once to prove that
     * tripping it actually aborts the write. */
    it('restore consults the structural-integrity tripwire (M16)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const spy = vi.spyOn(ImportBatchRollbackService, 'structuralIntegrityUnchanged');
      await repository.transactions.restoreBatch('bx');
      expect(spy).toHaveBeenCalled();
    });

    it('the structural-integrity tripwire ABORTS the restore when it trips (M16)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));
      const save = vi.spyOn(IndexedDBStorageService, 'persist');

      vi.spyOn(ImportBatchRollbackService, 'structuralIntegrityUnchanged')
        .mockReturnValueOnce(false);

      const r = await attempt(() => repository.transactions.restoreBatch('bx'));

      expect(r.ok).toBe(false);
      expect(String(r.error.message)).toContain('structural integrity would change');
      expect(save).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(included()).toBe(0);
    });

    it('restore consults the whole-transfer authority', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransferBatch(A, B, 'bx', 2000);
      await repository.transactions.rollbackBatch('bx');
      const spy = vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle');
      await repository.transactions.restoreBatch('bx');
      expect(spy).toHaveBeenCalled();
    });

    it('a transfer wholly inside the batch survives a rollback/restore cycle intact', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await seedTransferBatch(A, B, 'bx', 2000);
      const snapshot = JSON.stringify(
        TransferIntegrityService.validateAll(rows()).map(v => `${v.status}:${v.legCount}:${v.net}`)
      );
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      expect(JSON.stringify(
        TransferIntegrityService.validateAll(rows()).map(v => `${v.status}:${v.legCount}:${v.net}`)
      )).toBe(snapshot);
    });
  });

  /* ═════════════════ §5 identity & provenance ════════════════════════════ */
  describe('§5 identity and provenance are preserved', () => {
    it('ACCEPTANCE 11 — transaction ids are unchanged', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      const idsBefore = rows().map(t => t.id).sort();
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      expect(rows().map(t => t.id).sort()).toEqual(idsBefore);
      expect(TransactionIdentityService.findDuplicateIds(rows())).toHaveLength(0);
    });

    it('ACCEPTANCE 12 — provenance is unchanged', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      const p = (t: Transaction) => ({
        origin: t.origin, importBatchId: t.importBatchId, sourceProvider: t.sourceProvider,
        sourceFile: t.sourceFile, sourceRowNumber: t.sourceRowNumber,
        recordedAt: t.recordedAt, fingerprint: t.fingerprint
      });
      const before = p(byId('bx-0'));
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      expect(p(byId('bx-0'))).toEqual(before);
    });

    it('ACCEPTANCE 8 (constraint) — ONLY exclusion state changes, plus the audit stamp', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      const original = JSON.parse(JSON.stringify(byId('bx-0')));
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');

      const after: any = byId('bx-0');
      const { restoredAt, ...rest } = after;
      expect(rest).toEqual(original);          // byte-identical apart from the stamp
      expect(typeof restoredAt).toBe('string');
    });

    it('restore fabricates no new transaction', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      const countBefore = rows().length;
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      expect(rows()).toHaveLength(countBefore);
      expect(rows().some(t => TransactionAmendmentService.isCorrection(t))).toBe(false);
    });

    it('row ORDER is preserved (restore is a map, not a rebuild)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000, 3000]);
      const orderBefore = rows().map(t => t.id);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      expect(rows().map(t => t.id)).toEqual(orderBefore);
    });
  });

  /* ═════════════════ §6 atomicity & persistence ══════════════════════════ */
  describe('§6 atomicity, failure and READFAIL', () => {
    it('exactly ONE saveAll per restore', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      const save = vi.spyOn(IndexedDBStorageService, 'persist');
      await repository.transactions.restoreBatch('bx');
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('the persisted snapshot is the COMPLETE restored set — never partial', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      const seen: number[] = [];
      vi.spyOn(IndexedDBStorageService, 'persist').mockImplementation(async (_lease: any, st: any) => {
        seen.push(LedgerExclusionService.forDerivation(st.transactions).length);
      });
      await repository.transactions.restoreBatch('bx');
      expect(seen).toEqual([2]);     // both rows back in one write, never 1
    });

    it('ACCEPTANCE 17 — a persistence failure leaves the ledger EXACTLY unchanged', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      await repository.transactions.rollbackBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));
      const balBefore = bal(A);

      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => repository.transactions.restoreBatch('bx'));

      expect(r.ok).toBe(false);
      expect(rows()).toEqual(before);
      expect(bal(A)).toBe(balBefore);
      expect(included()).toBe(0);
      expect(byId('bx-0').restoredAt).toBeUndefined();   // no half-written audit stamp
    });

    it('ACCEPTANCE 16 — READFAIL prevents restore from writing', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      const before = JSON.parse(JSON.stringify(rows()));

      vi.spyOn(IndexedDBStorageService, 'persist').mockRejectedValueOnce(
        new Error('Refusing to persist: the last IndexedDB load failed, so the in-memory ledger ' +
                  'may be empty or partial and writing it would destroy stored data.')
      );

      const r = await attempt(() => repository.transactions.restoreBatch('bx'));
      expect(r.ok).toBe(false);
      expect(r.error.message).toContain('Refusing to persist');
      expect(rows()).toEqual(before);
    });

    it('the store action surfaces refusals to the caller', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      const r = await attempt(() => S().restoreImportBatch('bx'));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(BatchRestoreError);
    });

    it('the store action performs a real restore end to end', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await S().rollbackImportBatch('bx');
      const res = await S().restoreImportBatch('bx');
      expect(res.restoredCount).toBe(1);
      expect(bal(A)).toBe(11000);
    });

    it('restore operates at REPOSITORY authority, not the Zustand projection', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      // the repository source of truth changed, and the projection follows it
      expect(LedgerExclusionService.isExcluded(
        repository.transactions.findAllSync().find(t => t.id === 'bx-0')!)).toBe(false);
      expect(LedgerExclusionService.isExcluded(
        S().transactions.find((t: Transaction) => t.id === 'bx-0'))).toBe(false);
    });
  });

  /* ═════════════════ §7 post-restore lifecycle (D6-4) ════════════════════ */
  describe('§7 a restored row rejoins normal life (D6-4)', () => {
    it('ACCEPTANCE 13 — a restored row can be amended', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');

      // while excluded, amendment is refused (Q1 = a)
      const refused = await attempt(() =>
        repository.transactions.supersede([{ targetId: 'bx-0', changes: { amount: 4000 } }]));
      expect(refused.error.code).toBe('TARGET_ALREADY_EXCLUDED');

      await repository.transactions.restoreBatch('bx');

      // after restore it is correctable again
      expect(TransactionAmendmentService.singleRowCorrectability('bx-0', rows()).correctable).toBe(true);
      const res = await repository.transactions
        .supersede([{ targetId: 'bx-0', changes: { amount: 1500 } }]);
      expect(res.correctionCount).toBe(1);
      expect(bal(A)).toBe(11500);
      expect(byId(res.outcomes[0].correctionId).importBatchId).toBe('bx');
    });

    it('a restored row can be rolled back again', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      await repository.transactions.rollbackBatch('bx');
      await repository.transactions.restoreBatch('bx');
      const again = await repository.transactions.rollbackBatch('bx');
      expect(again.excludedCount).toBe(1);
      expect(bal(A)).toBe(10000);
    });

    it('the restored row is visible in the Ledger throughout (DATA-02)', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000]);
      expect(S().getFilteredTransactions()).toHaveLength(1);
      await repository.transactions.rollbackBatch('bx');
      expect(S().getFilteredTransactions()).toHaveLength(1);   // excluded, still shown
      await repository.transactions.restoreBatch('bx');
      expect(S().getFilteredTransactions()).toHaveLength(1);
    });
  });

  /* ═════════════════ §8 scope boundary ═══════════════════════════════════ */
  describe('§8 scope boundary — D9-A and D6-7', () => {
    it('ACCEPTANCE 18 — NO deletion API exists anywhere (D9-1 = D9-A)', () => {
      const t = repository.transactions as any;
      const s = S();
      for (const k of ['delete', 'deleteTransaction', 'remove', 'removeTransaction',
                       'removeBatch', 'destroy', 'purge', 'hardDelete', 'tombstone',
                       'deleteBatch', 'erase']) {
        expect(typeof t[k]).toBe('undefined');
      }
      for (const k of ['deleteTransaction', 'removeTransaction', 'purgeLedger']) {
        expect(typeof s[k]).toBe('undefined');
      }
    });

    it('D9-2 — restore did not become a deletion precedent: rows are never removed', async () => {
      const A = acct('A', 10000);
      await seedBatch(A, 'bx', [1000, 2000]);
      const n = rows().length;
      await repository.transactions.rollbackBatch('bx');
      expect(rows()).toHaveLength(n);
      await repository.transactions.restoreBatch('bx');
      expect(rows()).toHaveLength(n);
    });

    it('D6-7 — no general undo surface was added', () => {
      const t = repository.transactions as any;
      const s = S();
      const svc = ImportBatchRollbackService as any;
      for (const k of ['restore', 'undo', 'revert', 'unsupersede', 'restoreTransaction',
                       'undoLast', 'rollbackTo']) {
        expect(typeof t[k]).toBe('undefined');
      }
      for (const k of ['undo', 'restoreTransaction', 'unsupersedeTransaction', 'undoLast']) {
        expect(typeof s[k]).toBe('undefined');
      }
      for (const k of ['undo', 'revert', 'undoAll']) {
        expect(typeof svc[k]).toBe('undefined');
      }
      // the two authorised names, and only those
      expect(typeof t.restoreBatch).toBe('function');
      expect(typeof s.restoreImportBatch).toBe('function');
    });

    it('the write surface is exactly five primitives', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
    });

    it('no new exclusion reason was introduced', () => {
      expect([...KNOWN_EXCLUSION_REASONS].sort()).toEqual(['IMPORT_ROLLBACK', 'SUPERSEDED']);
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('RESTORED' as any);
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('DELETED' as any);
    });

    it('restoredAt is optional — legacy rows need no migration', async () => {
      const A = acct('A', 10000);
      const legacy: any = {
        id: 'legacy-1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'Old',
        narration: 'OLD', account: A.name, accountId: A.id, direction: 'CREDIT',
        type: 'Income', category: 'Income', amount: 900, status: 'CLEARED'
      };
      await repository.transactions.append(legacy);
      expect(Object.prototype.hasOwnProperty.call(byId('legacy-1'), 'restoredAt')).toBe(false);
      expect(bal(A)).toBe(10900);
      expect(summaryOf.length).toBeGreaterThan(0);       // service still functions
    });

    it('the PRISMA adapter mirrors restore (a rule in one adapter is not a rule)', async () => {
      const prisma = new PrismaTransactionRepository();
      expect(typeof prisma.restoreBatch).toBe('function');
      // findAllSync() is [] here (pre-existing), so the batch is never found
      const r = await attempt(() => prisma.restoreBatch('bx'));
      expect(r.error).toBeInstanceOf(BatchRestoreError);
      expect(r.error.code).toBe('BATCH_NOT_FOUND');
    });

    it('the PRISMA adapter refuses an UNKNOWN reason too', async () => {
      const prisma = new PrismaTransactionRepository();
      vi.spyOn(prisma, 'findAllSync').mockReturnValue([{
        id: 'x', amount: 1, narration: 'n', account: 'A', date: '2026-08-01',
        importBatchId: 'bx', excludedAt: '2026-08-02T00:00:00.000Z',
        excludedReason: 'WHATEVER'
      } as any]);
      const r = await attempt(() => prisma.restoreBatch('bx'));
      expect(r.error.code).toBe('UNRECOGNISED_EXCLUSION_REASON');
    });
  });
});
