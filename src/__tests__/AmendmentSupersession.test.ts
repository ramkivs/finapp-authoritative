/**
 * WP-FB-DATA-06c-2 — Amendment / supersession.
 *
 * Decisions implemented: D3 = B, D4 = D, D5 = C, D10 = C, D11 = B, D12 = C,
 * Q1 = a, Q1b = c, Q2 = d.
 *
 * THE CAPABILITY THIS ADDS
 *
 * Until now the ledger had three write primitives — append, appendMany,
 * rollbackBatch — and no way to say "that recorded figure is wrong". A user who
 * mistyped ₹5,000 as ₹500 had no remedy that did not destroy the audit trail.
 * 06c-2 adds exactly one more primitive: `supersede`, which records a
 * CORRECTION and retires the original without touching a byte of it.
 *
 *   §1  the correction — new id, backward pointer, divergence marker
 *   §2  the original — pristine but excluded as SUPERSEDED
 *   §3  exactly one included version, and chains (v1 -> v2 -> v3)
 *   §4  whole-transfer amendment (D8)
 *   §5  refusals — Q1 = a, immutable fields, duplicates, no-op, not found
 *   §6  atomicity — one write, no double-counted intermediate, READFAIL
 *   §7  Q1b = c — correction provenance is retained but is not a rollback target
 *   §8  no migration; legacy rows are untouched
 *   §9  scope boundary — restore is deferred, D6/D9 not resolved
 *  §10  the guards are wired, not merely present (mutation-escape closure)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  TransactionAmendmentService,
  AmendmentRefusedError,
  AMENDABLE_FIELDS
} from '../services/TransactionAmendmentService';
import {
  TransferIntegrityService,
  PartialTransferLifecycleError,
  TransferIntegrityError
} from '../services/TransferIntegrityService';
import { LedgerExclusionService, KNOWN_EXCLUSION_REASONS } from '../services/LedgerExclusionService';
import { ImportBatchRollbackService, BatchRollbackError } from '../services/ImportBatchRollbackService';
import {
  TransactionIdentityService,
  DuplicateTransactionIdError
} from '../services/TransactionIdentityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountBalanceService } from '../services/AccountBalanceService';
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
const S = () => useCanonicalLedger.getState();

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
const rows = () => repo.transactionsData;
const byId = (id: string) => rows().find(t => t.id === id) as Transaction;

/** Total money across every account — the figure a leak shows up in. */
const systemTotal = () => S().accounts.reduce((s: number, a: any) => s + bal(a), 0);

async function seedIncome(A: any, amount: number, title = 'Salary') {
  const tx = TransactionFactory.createIncome({
    title, amount, account: A.name, accountId: A.id, category: 'Income'
  });
  await repository.transactions.append(tx);
  return tx;
}
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
const amend = (targetId: string, changes: any) =>
  repository.transactions.supersede([{ targetId, changes }]);

describe('WP-FB-DATA-06c-2 — amendment / supersession', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => {
    resetAsOfDateOverride();
    IndexedDBStorageService.simulateFailureOnce = false;
    IndexedDBStorageService.simulateReadFailureOnce = false;
    vi.restoreAllMocks();
    reset();
  });

  /* ═══════════════════════════ §1 the correction ═════════════════════════ */
  describe('§1 the correction row (D3 = B, D10 = C, D4 = D)', () => {
    it('ACCEPTANCE 1 — the correction gets a NEW id, never the original one', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);

      const res = await amend(v1.id, { amount: 5500 });

      expect(res.correctionCount).toBe(1);
      expect(res.supersededCount).toBe(1);
      const correctionId = res.outcomes[0].correctionId;
      expect(correctionId).not.toBe(v1.id);
      expect(byId(correctionId)).toBeTruthy();
      // the original still answers to its own name — nothing was overwritten
      expect(byId(v1.id).id).toBe(v1.id);
      expect(rows()).toHaveLength(2);
    });

    it('ACCEPTANCE 2 — the correction carries a BACKWARD `supersedes` pointer', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const { outcomes } = await amend(v1.id, { amount: 5500 });

      const v2 = byId(outcomes[0].correctionId);
      expect(v2.supersedes).toBe(v1.id);
      // D10 = C — and NO forward pointer was written onto the original
      expect((byId(v1.id) as any).supersededBy).toBeUndefined();
      expect((byId(v1.id) as any).supersededById).toBeUndefined();
      expect(byId(v1.id).supersedes).toBeUndefined();
    });

    it('ACCEPTANCE 3 — the correction carries `provenanceDiverged`', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const { outcomes } = await amend(v1.id, { amount: 5500 });

      expect(byId(outcomes[0].correctionId).provenanceDiverged).toBe(true);
      // absent, not false, on the original
      expect(byId(v1.id).provenanceDiverged).toBeUndefined();
    });

    it('D4 = D — the correction INHERITS source provenance rather than being reborn manual', async () => {
      const A = acct('A', 10000);
      const imported: Transaction = {
        ...TransactionFactory.createIncome({
          title: 'ATM', amount: 1000, account: A.name, accountId: A.id, category: 'Income'
        }),
        origin: 'IMPORT',
        importBatchId: 'batch-1',
        sourceProvider: 'SBI',
        sourceFile: 'SBI_Statement.xlsx',
        sourceRowNumber: 7
      };
      await repository.transactions.append(imported);

      const { outcomes } = await amend(imported.id, { amount: 4000 });
      const c = byId(outcomes[0].correctionId);

      expect(c.origin).toBe('IMPORT');
      expect(c.importBatchId).toBe('batch-1');
      expect(c.sourceProvider).toBe('SBI');
      expect(c.sourceFile).toBe('SBI_Statement.xlsx');
      expect(c.sourceRowNumber).toBe(7);
      // ...and it admits the figures are no longer what that provenance produced
      expect(c.provenanceDiverged).toBe(true);
    });

    it('the correction is BORN LIVE — never inherits an exclusion stamp', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const { outcomes } = await amend(v1.id, { amount: 5500 });
      const c = byId(outcomes[0].correctionId);
      expect(LedgerExclusionService.isExcluded(c)).toBe(false);
      expect(c.excludedAt).toBeUndefined();
      expect(c.excludedReason).toBeUndefined();
    });

    /* MUTATION-ESCAPE CLOSURE (M8).
     *
     * `apply()` explicitly strips the exclusion stamps off the correction. That
     * line is UNREACHABLE through the public path today, because Q1 = a makes
     * `plan()` refuse an excluded target before `apply()` ever runs — so a
     * mutation removing it survived the whole suite.
     *
     * An unreachable guard with no coverage is not defence in depth, it is dead
     * code that will be deleted by the next maintainer as "obviously
     * redundant". If Q1 is ever relaxed (Q1 options b/c/d were all live at the
     * decision gate) this line is the only thing standing between a correction
     * and inheriting `excludedAt: SUPERSEDED` — which would produce a
     * correction that is born already excluded, silently deleting the money.
     *
     * So it is exercised directly, with a hand-built ADMISSIBLE plan that
     * `plan()` would never emit. */
    it('apply() strips exclusion stamps even if handed an excluded target (M8)', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      force(rows().map(t => t.id === v1.id
        ? { ...t, excludedAt: '2026-08-22T00:00:00.000Z', excludedReason: 'SUPERSEDED' as const }
        : t));

      // plan() refuses this outright — that is Q1 = a, asserted elsewhere.
      expect(TransactionAmendmentService.plan(
        [{ targetId: v1.id, changes: { amount: 5500 } }], rows()
      ).refusalCode).toBe('TARGET_ALREADY_EXCLUDED');

      // Bypass it to reach the second guard directly.
      const forcedPlan: any = {
        status: 'ADMISSIBLE',
        targetIds: [v1.id],
        touchedTransferIds: [],
        requests: [{ targetId: v1.id, changes: { amount: 5500 } }]
      };
      const { corrections } = TransactionAmendmentService.apply(
        forcedPlan, rows(), '2026-08-23T00:00:00.000Z', () => 'FIXED'
      );

      expect(corrections).toHaveLength(1);
      expect(corrections[0].excludedAt).toBeUndefined();
      expect(corrections[0].excludedReason).toBeUndefined();
      expect(LedgerExclusionService.isExcluded(corrections[0])).toBe(false);
      // and the keys are genuinely absent, not present-and-undefined
      expect(Object.prototype.hasOwnProperty.call(corrections[0], 'excludedAt')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(corrections[0], 'excludedReason')).toBe(false);
    });

    it('identity follows content — the correction is re-fingerprinted', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      expect(v1.fingerprint).toBeTruthy();

      const { outcomes } = await amend(v1.id, { amount: 5500 });
      const c = byId(outcomes[0].correctionId);

      expect(c.fingerprint).toBeTruthy();
      expect(c.fingerprint).not.toBe(v1.fingerprint);
      expect(c.fingerprint).toBe(TransactionIdentityService.fingerprint({
        account: c.account, date: c.date, amount: c.amount, narration: c.narration
      }));
      // the original's identity is untouched
      expect(byId(v1.id).fingerprint).toBe(v1.fingerprint);
    });

    it('a row that never had a fingerprint does not gain an invented one', async () => {
      const A = acct('A', 10000);
      const legacy: any = {
        id: 'legacy-1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'Old',
        narration: 'OLD', account: A.name, accountId: A.id, direction: 'CREDIT',
        type: 'Income', category: 'Income', amount: 900, status: 'CLEARED'
      };
      await repository.transactions.append(legacy);
      const { outcomes } = await amend('legacy-1', { amount: 950 });
      expect(byId(outcomes[0].correctionId).fingerprint).toBeUndefined();
    });

    it('amending `date` re-derives `dateStr` so display cannot drift from value date', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const { outcomes } = await amend(v1.id, { date: '2026-08-05' });
      const c = byId(outcomes[0].correctionId);
      expect(c.date).toBe('2026-08-05');
      expect(c.dateStr).not.toBe(byId(v1.id).dateStr);
      expect(c.dateStr).toContain('2026');
    });
  });

  /* ═══════════════════════════ §2 the original ═══════════════════════════ */
  describe('§2 the original stays pristine (D4 = D, D11 = B)', () => {
    it('ACCEPTANCE 4 — the original is excluded with reason SUPERSEDED', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      await amend(v1.id, { amount: 5500 });

      const o = byId(v1.id);
      expect(LedgerExclusionService.isExcluded(o)).toBe(true);
      expect(o.excludedReason).toBe('SUPERSEDED');
      expect(LedgerExclusionService.reasonOf(o)).toBe('SUPERSEDED');
      expect(typeof o.excludedAt).toBe('string');
    });

    it('SUPERSEDED is a RECOGNISED reason, not UNKNOWN (D11 = B)', () => {
      expect(KNOWN_EXCLUSION_REASONS).toContain('SUPERSEDED');
      expect(KNOWN_EXCLUSION_REASONS).toContain('IMPORT_ROLLBACK');
    });

    it('D11 = B — DELETED was NOT added to the vocabulary', () => {
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('DELETED' as any);
      const row: any = { id: 'x', amount: 1, narration: 'n',
        excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'DELETED' };
      expect(LedgerExclusionService.reasonOf(row)).toBe('UNKNOWN');
    });

    it('EVERY other field of the original is byte-identical after amendment', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const before = JSON.parse(JSON.stringify(byId(v1.id)));

      await amend(v1.id, { amount: 5500, narration: 'CORRECTED', category: 'Bonus' });

      const after: any = byId(v1.id);
      const { excludedAt, excludedReason, ...rest } = after;
      expect(rest).toEqual(before);
    });

    it('EXCLUDED IS NOT HIDDEN — the superseded original stays visible in the Ledger', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      await amend(v1.id, { amount: 5500 });

      const visible = S().getFilteredTransactions();
      expect(visible.map((t: Transaction) => t.id)).toContain(v1.id);
      expect(visible).toHaveLength(2);
      // ...but derivation drops it
      expect(LedgerExclusionService.forDerivation(rows())).toHaveLength(1);
    });
  });

  /* ═════════════════════ §3 one included version, chains ═════════════════ */
  describe('§3 exactly one included version (D5 = C)', () => {
    it('ACCEPTANCE 5 — after one amendment exactly one version is counted', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      expect(bal(A)).toBe(15000);

      const { outcomes } = await amend(v1.id, { amount: 5500 });

      const chain = TransactionAmendmentService.chainOf(byId(v1.id), rows());
      expect(chain).toHaveLength(2);
      expect(chain.filter(t => !LedgerExclusionService.isExcluded(t))).toHaveLength(1);
      expect(TransactionAmendmentService.activeVersionOf(byId(v1.id), rows())!.id)
        .toBe(outcomes[0].correctionId);

      // 10,000 + 5,500 — the old 5,000 is gone, not added to
      expect(bal(A)).toBe(15500);
    });

    it('ACCEPTANCE 6 — v1 -> v2 -> v3 is correct and walkable', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);

      const r2 = await amend(v1.id, { amount: 5500 });
      const v2Id = r2.outcomes[0].correctionId;
      expect(bal(A)).toBe(15500);

      const r3 = await amend(v2Id, { amount: 5750 });
      const v3Id = r3.outcomes[0].correctionId;

      // the measured gate figure
      expect(bal(A)).toBe(15750);

      const chain = TransactionAmendmentService.chainOf(byId(v1.id), rows());
      expect(chain.map(t => t.id)).toEqual([v1.id, v2Id, v3Id]);
      expect(chain.map(t => t.amount)).toEqual([5000, 5500, 5750]);

      // exactly one included
      expect(chain.filter(t => !LedgerExclusionService.isExcluded(t)).map(t => t.id)).toEqual([v3Id]);
      // all three remain visible
      expect(S().getFilteredTransactions()).toHaveLength(3);
      // and the chain is walkable from ANY version
      for (const t of chain) {
        expect(TransactionAmendmentService.chainOf(t, rows()).map(x => x.id))
          .toEqual([v1.id, v2Id, v3Id]);
      }
    });

    it('the whole chain traces back to the original provenance', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const v2 = (await amend(v1.id, { amount: 5500 })).outcomes[0].correctionId;
      const v3 = (await amend(v2, { amount: 5750 })).outcomes[0].correctionId;

      expect(byId(v2).supersedes).toBe(v1.id);
      expect(byId(v3).supersedes).toBe(v2);
      expect(byId(v3).provenanceDiverged).toBe(true);
    });

    it('chainOf terminates on a corrupted pointer cycle instead of hanging', () => {
      const a: any = { id: 'a', supersedes: 'b', amount: 1, narration: 'a' };
      const b: any = { id: 'b', supersedes: 'a', amount: 1, narration: 'b' };
      const chain = TransactionAmendmentService.chainOf(a, [a, b]);
      expect(chain.length).toBeLessThanOrEqual(2);
    });

    it('activeVersionOf reports null when the whole chain is excluded', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const v2 = (await amend(v1.id, { amount: 5500 })).outcomes[0].correctionId;
      force(rows().map(t => t.id === v2
        ? { ...t, excludedAt: '2026-08-22T00:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const }
        : t));
      expect(TransactionAmendmentService.activeVersionOf(byId(v1.id), rows())).toBeNull();
    });
  });

  /* ═════════════════════ §4 whole-transfer amendment ═════════════════════ */
  describe('§4 whole-transfer amendment (D8)', () => {
    it('ACCEPTANCE 7 — amending ONE leg of a transfer is REFUSED', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit] = await seedTransfer(A, B, 2000);
      const before = systemTotal();

      const r = await attempt(() => amend(debit.id, { amount: 2500 }));

      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(AmendmentRefusedError);
      expect(r.error.code).toBe('PARTIAL_TRANSFER_AMENDMENT');
      // nothing moved
      expect(rows()).toHaveLength(2);
      expect(systemTotal()).toBe(before);
      expect(rows().every(t => !LedgerExclusionService.isExcluded(t))).toBe(true);
    });

    it('ACCEPTANCE 7 — amending BOTH legs together is accepted atomically', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = await seedTransfer(A, B, 2000);
      expect(systemTotal()).toBe(15000);

      const res = await repository.transactions.supersede([
        { targetId: debit.id, changes: { amount: 2500 } },
        { targetId: credit.id, changes: { amount: 2500 } }
      ]);

      expect(res.supersededCount).toBe(2);
      expect(res.correctionCount).toBe(2);
      // a transfer moves money between accounts; it never changes the total
      expect(systemTotal()).toBe(15000);
      expect(bal(A)).toBe(7500);
      expect(bal(B)).toBe(7500);
    });

    it('the corrections form a NEW transfer group — the old pair stays intact', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = await seedTransfer(A, B, 2000);
      const oldTransferId = debit.transferId;

      const res = await repository.transactions.supersede([
        { targetId: debit.id, changes: { amount: 2500 } },
        { targetId: credit.id, changes: { amount: 2500 } }
      ]);

      const newTransferId = res.outcomes[0].transferId;
      expect(newTransferId).toBeTruthy();
      expect(newTransferId).not.toBe(oldTransferId);
      // BOTH corrections share ONE fresh transferId
      expect(res.outcomes[1].transferId).toBe(newTransferId);

      // four rows, two groups of exactly two — no LEG_COUNT violation
      expect(rows()).toHaveLength(4);
      const groups = TransferIntegrityService.groupByTransferId(rows());
      expect(groups.size).toBe(2);
      for (const [, legs] of groups) expect(legs).toHaveLength(2);
      expect(TransferIntegrityService.findBrokenTransfers(rows())).toHaveLength(0);
    });

    it('the OLD pair is wholly excluded and the NEW pair wholly live', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = await seedTransfer(A, B, 2000);
      await repository.transactions.supersede([
        { targetId: debit.id, changes: { amount: 2500 } },
        { targetId: credit.id, changes: { amount: 2500 } }
      ]);

      expect(LedgerExclusionService.isExcluded(byId(debit.id))).toBe(true);
      expect(LedgerExclusionService.isExcluded(byId(credit.id))).toBe(true);
      expect(byId(debit.id).excludedReason).toBe('SUPERSEDED');
      // never half-excluded at any point
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(rows())).toHaveLength(0);
    });

    it('amending both legs to DIFFERENT amounts is refused by the 06b authority', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = await seedTransfer(A, B, 2000);

      const r = await attempt(() => repository.transactions.supersede([
        { targetId: debit.id, changes: { amount: 2500 } },
        { targetId: credit.id, changes: { amount: 3000 } }
      ]));

      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(TransferIntegrityError);
      expect(rows()).toHaveLength(2);
      expect(systemTotal()).toBe(15000);
    });

    it('amending a leg whose sibling is already excluded is refused', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = await seedTransfer(A, B, 2000);
      force(rows().map(t => t.id === credit.id
        ? { ...t, excludedAt: '2026-08-22T00:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const }
        : t));

      const r = await attempt(() => amend(debit.id, { amount: 2500 }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('PARTIAL_TRANSFER_AMENDMENT');
    });
  });

  /* ═══════════════════════════ §5 refusals ═══════════════════════════════ */
  describe('§5 refusals', () => {
    it('ACCEPTANCE 10 — amending an already-EXCLUDED row is refused (Q1 = a)', async () => {
      const A = acct('A', 10000);
      const imported: Transaction = {
        ...TransactionFactory.createIncome({
          title: 'Imported', amount: 1000, account: A.name, accountId: A.id, category: 'Income'
        }),
        origin: 'IMPORT', importBatchId: 'bx'
      };
      await repository.transactions.append(imported);
      await repository.transactions.rollbackBatch('bx');
      const afterRollback = bal(A);
      expect(afterRollback).toBe(10000);

      const r = await attempt(() => amend(imported.id, { amount: 4000 }));

      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(AmendmentRefusedError);
      expect(r.error.code).toBe('TARGET_ALREADY_EXCLUDED');
      expect(r.error.message).toContain('rolled back');
      // THE MEASURED HAZARD: no ₹4,000 resurrection
      expect(bal(A)).toBe(afterRollback);
      expect(rows()).toHaveLength(1);
    });

    it('Q1 = a — an already-SUPERSEDED row cannot be amended again', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      await amend(v1.id, { amount: 5500 });

      const r = await attempt(() => amend(v1.id, { amount: 9999 }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('TARGET_ALREADY_EXCLUDED');
      expect(r.error.message).toContain('already been superseded');
      // the chain never forks — still exactly two rows, one included
      expect(rows()).toHaveLength(2);
      expect(bal(A)).toBe(15500);
    });

    it('an unknown target is refused', async () => {
      acct('A', 10000);
      const r = await attempt(() => amend('nope', { amount: 1 }));
      expect(r.error.code).toBe('TARGET_NOT_FOUND');
    });

    it('an empty request is refused', async () => {
      const r = await attempt(() => repository.transactions.supersede([]));
      expect(r.error.code).toBe('EMPTY_REQUEST');
    });

    it('targeting the same row twice in one call is refused', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const r = await attempt(() => repository.transactions.supersede([
        { targetId: v1.id, changes: { amount: 1 } },
        { targetId: v1.id, changes: { amount: 2 } }
      ]));
      expect(r.error.code).toBe('DUPLICATE_TARGET');
      expect(rows()).toHaveLength(1);
    });

    it('an amendment that changes nothing is refused', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const r = await attempt(() => amend(v1.id, { amount: 5000 }));
      expect(r.error.code).toBe('NO_EFFECTIVE_CHANGE');
      expect(rows()).toHaveLength(1);
      expect(LedgerExclusionService.isExcluded(byId(v1.id))).toBe(false);
    });

    it('identity, lifecycle and provenance fields are NOT amendable', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);

      for (const field of ['id', 'fingerprint', 'excludedAt', 'excludedReason', 'supersedes',
                           'provenanceDiverged', 'origin', 'recordedAt', 'importBatchId',
                           'sourceProvider', 'sourceFile', 'sourceRowNumber', 'transferId',
                           'dateStr']) {
        const r = await attempt(() => amend(v1.id, { [field]: 'hacked' }));
        expect(r.ok).toBe(false);
        expect(r.error.code).toBe('IMMUTABLE_FIELD');
      }
      expect(rows()).toHaveLength(1);
    });

    it('the amendable allowlist is exactly the agreed content surface', () => {
      expect([...AMENDABLE_FIELDS].sort()).toEqual([
        'account', 'accountId', 'amount', 'category', 'date',
        'direction', 'narration', 'notes', 'status', 'title', 'type'
      ]);
    });

    it('ACCEPTANCE 8 — a correction colliding with an existing id is refused', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);

      // Plant a row already occupying the id the minter is about to produce.
      // The injectable minter is exactly why this is testable at all: a
      // hard-coded Math.random() inside `apply` could not be made to collide.
      force([{ ...v1, id: 'tx-cor-COLLIDE' }, ...rows()]);

      const plan = TransactionAmendmentService.plan(
        [{ targetId: v1.id, changes: { amount: 5500 } }], rows()
      );
      const { corrections } = TransactionAmendmentService.apply(
        plan, rows(), '2026-08-22T00:00:00.000Z', () => 'COLLIDE'
      );
      expect(corrections[0].id).toBe('tx-cor-COLLIDE');

      // the gate the repository runs on exactly these corrections
      expect(() => TransactionIdentityService.assertUniqueIds(corrections, rows()))
        .toThrow(DuplicateTransactionIdError);
    });

    it('ACCEPTANCE 8 — two corrections in one call can never share an id', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = await seedTransfer(A, B, 2000);
      const res = await repository.transactions.supersede([
        { targetId: debit.id, changes: { amount: 2500 } },
        { targetId: credit.id, changes: { amount: 2500 } }
      ]);
      const [c1, c2] = res.outcomes.map(o => o.correctionId);
      expect(c1).not.toBe(c2);
      expect(new Set(rows().map(t => t.id)).size).toBe(rows().length);
    });
  });

  /* ═══════════════════════════ §6 atomicity ══════════════════════════════ */
  describe('§6 atomicity — one write (D12 = C)', () => {
    it('ACCEPTANCE 13 — exactly ONE saveAll for an amendment', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);

      const save = vi.spyOn(IndexedDBStorageService, 'persist');
      await amend(v1.id, { amount: 5500 });
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('ACCEPTANCE 13 — the persisted state never double-counts', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);

      const seen: number[] = [];
      const save = vi.spyOn(IndexedDBStorageService, 'persist')
        .mockImplementation(async (_lease: any, state: any) => {
          // the ONLY state ever handed to persistence
          seen.push(LedgerExclusionService.forDerivation(state.transactions).length);
        });

      await amend(v1.id, { amount: 5500 });

      expect(save).toHaveBeenCalledTimes(1);
      // one included version in every persisted snapshot — never two
      expect(seen).toEqual([1]);
    });

    it('ACCEPTANCE 9 — a persistence failure rolls memory back entirely', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const before = JSON.parse(JSON.stringify(rows()));

      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => amend(v1.id, { amount: 5500 }));

      expect(r.ok).toBe(false);
      expect(rows()).toEqual(before);
      expect(rows()).toHaveLength(1);
      expect(LedgerExclusionService.isExcluded(byId(v1.id))).toBe(false);
      expect(bal(A)).toBe(15000);
    });

    it('ACCEPTANCE 9 — READFAIL: an amendment cannot be written over unread data', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const before = JSON.parse(JSON.stringify(rows()));

      vi.spyOn(IndexedDBStorageService, 'persist').mockRejectedValueOnce(
        new Error('Refusing to persist: the last IndexedDB load failed, so the in-memory ledger ' +
                  'may be empty or partial and writing it would destroy stored data.')
      );

      const r = await attempt(() => amend(v1.id, { amount: 5500 }));
      expect(r.ok).toBe(false);
      expect(r.error.message).toContain('Refusing to persist');
      expect(rows()).toEqual(before);
    });

    it('the store action surfaces the refusal to the caller (not just the console)', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      await amend(v1.id, { amount: 5500 });

      const r = await attempt(() => S().supersedeTransactions([
        { targetId: v1.id, changes: { amount: 1 } }
      ]));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(AmendmentRefusedError);
    });

    it('the store action performs a real amendment end to end', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const res = await S().supersedeTransactions([{ targetId: v1.id, changes: { amount: 5500 } }]);
      expect(res.correctionCount).toBe(1);
      expect(bal(A)).toBe(15500);
    });
  });

  /* ═════════════════ §7 Q1b = c — provenance vs rollback target ══════════ */
  describe('§7 Q1b = c — correction provenance retained, not a rollback target', () => {
    async function importedRow(A: any, amount: number, batch: string, title: string) {
      const tx: Transaction = {
        ...TransactionFactory.createIncome({
          title, amount, account: A.name, accountId: A.id, category: 'Income'
        }),
        origin: 'IMPORT', importBatchId: batch, sourceProvider: 'SBI', sourceFile: 'SBI.xlsx'
      };
      await repository.transactions.append(tx);
      return tx;
    }

    it('ACCEPTANCE 11 — the correction RETAINS importBatchId', async () => {
      const A = acct('A', 10000);
      const r1 = await importedRow(A, 1000, 'bx', 'Row1');
      const { outcomes } = await amend(r1.id, { amount: 1500 });
      expect(byId(outcomes[0].correctionId).importBatchId).toBe('bx');
    });

    it('ACCEPTANCE 11 — the correction is NOT a rollback target', async () => {
      const A = acct('A', 10000);
      const r1 = await importedRow(A, 1000, 'bx', 'Row1');
      const r2 = await importedRow(A, 2000, 'bx', 'Row2');
      const { outcomes } = await amend(r1.id, { amount: 1500 });
      const correctionId = outcomes[0].correctionId;

      const plan = ImportBatchRollbackService.plan('bx', rows());
      expect(plan.status).toBe('ADMISSIBLE');
      expect(plan.targetIds).toContain(r2.id);
      expect(plan.targetIds).not.toContain(correctionId);

      await repository.transactions.rollbackBatch('bx');
      expect(LedgerExclusionService.isExcluded(byId(r2.id))).toBe(true);
      expect(LedgerExclusionService.isExcluded(byId(correctionId))).toBe(false);
      // the user's own corrected figure survives the rollback
      expect(bal(A)).toBe(11500);
    });

    it('the retained correction is DISCLOSED, never implied', async () => {
      const A = acct('A', 10000);
      const r1 = await importedRow(A, 1000, 'bx', 'Row1');
      await amend(r1.id, { amount: 1500 });
      await repository.transactions.rollbackBatch('bx').catch(() => undefined);

      const [summary] = ImportBatchRollbackService.listBatches(rows());
      expect(summary.batchId).toBe('bx');
      expect(summary.correctionCount).toBe(1);
      // it does NOT claim the batch was fully rolled back
      expect(summary.status).toBe('PARTIALLY_EXCLUDED');
      expect(summary.rollbackEligible).toBe(false);
      expect(summary.rollbackBlockedReason).toContain('correction');
    });

    it('a batch of ONLY corrections refuses rollback and says why', async () => {
      const A = acct('A', 10000);
      const r1 = await importedRow(A, 1000, 'bx', 'Row1');
      await amend(r1.id, { amount: 1500 });

      const plan = ImportBatchRollbackService.plan('bx', rows());
      expect(plan.status).toBe('REFUSED');
      expect(plan.refusalCode).toBe('ALREADY_ROLLED_BACK');
      expect(plan.refusalReason).toContain('correction');
    });

    it('LEGACY EQUIVALENCE — batches with no corrections behave exactly as before', async () => {
      const A = acct('A', 10000);
      const r1 = await importedRow(A, 1000, 'bx', 'Row1');
      const r2 = await importedRow(A, 2000, 'bx', 'Row2');

      const plan = ImportBatchRollbackService.plan('bx', rows());
      expect(plan.status).toBe('ADMISSIBLE');
      expect(plan.targetIds.sort()).toEqual([r1.id, r2.id].sort());
      expect(ImportBatchRollbackService.listBatches(rows())[0].correctionCount).toBe(0);
    });

    it('LEGACY EQUIVALENCE — the split-transfer guard still refuses a split batch', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const legs = pair(A, B, 2000);
      await repository.transactions.appendMany([
        { ...legs[0], importBatchId: 'b1', origin: 'IMPORT' },
        { ...legs[1], importBatchId: 'b2', origin: 'IMPORT' }
      ]);

      const plan = ImportBatchRollbackService.plan('b1', rows());
      expect(plan.status).toBe('REFUSED');
      expect(plan.refusalCode).toBe('WOULD_SPLIT_TRANSFER');
    });

    it('a CORRECTED transfer pair does not block rollback of unrelated batch rows', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const legs = pair(A, B, 2000);
      await repository.transactions.appendMany([
        { ...legs[0], importBatchId: 'bx', origin: 'IMPORT' },
        { ...legs[1], importBatchId: 'bx', origin: 'IMPORT' }
      ]);
      const other = await importedRow(A, 900, 'bx', 'Other');

      await repository.transactions.supersede([
        { targetId: legs[0].id, changes: { amount: 2500 } },
        { targetId: legs[1].id, changes: { amount: 2500 } }
      ]);

      // the two live corrections form a valid transfer that merely inherited 'bx'
      const plan = ImportBatchRollbackService.plan('bx', rows());
      expect(plan.status).toBe('ADMISSIBLE');
      expect(plan.targetIds).toEqual([other.id]);

      await repository.transactions.rollbackBatch('bx');
      expect(TransferIntegrityService.findPartiallyExcludedTransfers(rows())).toHaveLength(0);
    });

    it('isCorrection has ONE definition, and rollback consults it', () => {
      const plain: any = { id: 'a', amount: 1, narration: 'n' };
      const corr: any = { id: 'b', amount: 1, narration: 'n', supersedes: 'a' };
      expect(TransactionAmendmentService.isCorrection(plain)).toBe(false);
      expect(TransactionAmendmentService.isCorrection(corr)).toBe(true);
      expect(TransactionAmendmentService.isCorrection({ ...corr, supersedes: '' })).toBe(false);
    });
  });

  /* ═══════════════════════════ §8 no migration ═══════════════════════════ */
  describe('§8 no migration (ACCEPTANCE 12)', () => {
    it('DB_VERSION was not bumped', () => {
      expect((IndexedDBStorageService as any).DB_VERSION ?? 4).toBe(4);
    });

    it('a legacy row with neither new field is fully usable', async () => {
      const A = acct('A', 10000);
      const legacy: any = {
        id: 'legacy-2', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'Old',
        narration: 'OLD', account: A.name, accountId: A.id, direction: 'CREDIT',
        type: 'Income', category: 'Income', amount: 900, status: 'CLEARED'
      };
      await repository.transactions.append(legacy);

      expect(legacy.supersedes).toBeUndefined();
      expect(legacy.provenanceDiverged).toBeUndefined();
      expect(TransactionAmendmentService.isCorrection(legacy)).toBe(false);
      expect(LedgerExclusionService.isExcluded(legacy)).toBe(false);
      expect(bal(A)).toBe(10900);
      expect(TransactionAmendmentService.chainOf(legacy, rows()).map(t => t.id)).toEqual(['legacy-2']);

      const { outcomes } = await amend('legacy-2', { amount: 950 });
      expect(byId(outcomes[0].correctionId).supersedes).toBe('legacy-2');
      expect(bal(A)).toBe(10950);
    });

    it('both new fields are OPTIONAL — no row is required to carry them', async () => {
      const A = acct('A', 10000);
      const tx = TransactionFactory.createIncome({
        title: 'X', amount: 1, account: A.name, accountId: A.id, category: 'Income'
      });
      expect(Object.prototype.hasOwnProperty.call(tx, 'supersedes')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(tx, 'provenanceDiverged')).toBe(false);
    });
  });

  /* ═══════════════════════ §9 scope boundary ═════════════════════════════ */
  describe('§9 scope boundary — nothing else was resolved', () => {
    /* WP-FB-DATA-06c-2b NARROWED THIS LIST — by exactly the two authorised
     * names. Decision D6-1 = R5 permits `restoreBatch` (whole import batch,
     * IMPORT_ROLLBACK only) and its store seam `restoreImportBatch`. Every
     * other name stays forbidden, and a BARE `restore` in particular stays
     * forbidden because D6-7 withholds general undo. Widening this list any
     * further is how an unmade decision gets made by accident. */
    it('the only restore capability is whole-batch restoreBatch (D6-1 = R5)', () => {
      const t = repository.transactions as any;
      expect(typeof t.restoreBatch).toBe('function');
      for (const k of ['restore', 'unsupersede', 'revert', 'undo',
                       'restoreTransaction', 'amend', 'update', 'remove', 'replace',
                       'patch', 'reverse', 'tombstone', 'removeBatch', 'deleteTransaction']) {
        expect(typeof t[k]).toBe('undefined');
      }
      expect(typeof t.supersede).toBe('function');
    });

    it('the store exposes batch restore ONLY — no general undo (D6-7)', () => {
      const s = S() as any;
      expect(typeof s.restoreImportBatch).toBe('function');
      expect(typeof s.undo).toBe('undefined');
      expect(typeof s.restoreTransaction).toBe('undefined');
      expect(typeof s.unsupersedeTransaction).toBe('undefined');
      expect(typeof s.deleteTransaction).toBe('undefined');
      expect(typeof s.supersedeTransactions).toBe('function');
    });

    it('the amendment service exposes no restore helper', () => {
      const svc = TransactionAmendmentService as any;
      for (const k of ['restore', 'unapply', 'undo', 'revert']) {
        expect(typeof svc[k]).toBe('undefined');
      }
    });

    it('no REVERSED / AMENDED / DELETED reason was minted (D6, D9 OPEN)', () => {
      expect([...KNOWN_EXCLUSION_REASONS].sort()).toEqual(['IMPORT_ROLLBACK', 'SUPERSEDED']);
    });

    it('the write surface is now exactly FOUR primitives', () => {
      const t = repository.transactions as any;
      const writes = ['append', 'appendMany', 'rollbackBatch', 'supersede']
        .filter(k => typeof t[k] === 'function');
      expect(writes).toHaveLength(4);
    });
  });

  /* ═════════════════ §10 the guards are WIRED, not just present ══════════ */
  describe('§10 the repository consults each authority', () => {
    it('supersede consults TransactionAmendmentService.plan', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const spy = vi.spyOn(TransactionAmendmentService, 'plan');
      await amend(v1.id, { amount: 5500 });
      expect(spy).toHaveBeenCalled();
    });

    it('supersede consults assertUniqueIds (06c-0 / P-1)', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const spy = vi.spyOn(TransactionIdentityService, 'assertUniqueIds');
      await amend(v1.id, { amount: 5500 });
      expect(spy).toHaveBeenCalled();
    });

    it('supersede consults assertAdmissible (06b)', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const spy = vi.spyOn(TransferIntegrityService, 'assertAdmissible');
      await amend(v1.id, { amount: 5500 });
      expect(spy).toHaveBeenCalled();
    });

    it('supersede consults assertWholeTransferLifecycle (06c-1a / D8)', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const spy = vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle');
      await amend(v1.id, { amount: 5500 });
      expect(spy).toHaveBeenCalled();
    });

    it('the whole-transfer gate is LOAD-BEARING, not redundant', async () => {
      // Forcing the gate to trip must abort the write even though `plan`
      // already approved it — proving the second door is real.
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle')
        .mockImplementationOnce(() => {
          throw new PartialTransferLifecycleError([{ transferId: 'forced', message: 'forced' }]);
        });

      const r = await attempt(() => amend(v1.id, { amount: 5500 }));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(PartialTransferLifecycleError);
      expect(rows()).toHaveLength(1);
      expect(LedgerExclusionService.isExcluded(byId(v1.id))).toBe(false);
    });

    it('the id-uniqueness gate is LOAD-BEARING', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      vi.spyOn(TransactionIdentityService, 'assertUniqueIds').mockImplementationOnce(() => {
        throw new DuplicateTransactionIdError([
          { id: 'x', count: 2, scope: 'AGAINST_EXISTING', message: 'forced' }
        ]);
      });
      const r = await attempt(() => amend(v1.id, { amount: 5500 }));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(DuplicateTransactionIdError);
      expect(rows()).toHaveLength(1);
    });

    it('nothing is persisted when a gate refuses', async () => {
      const A = acct('A', 10000);
      const v1 = await seedIncome(A, 5000);
      const save = vi.spyOn(IndexedDBStorageService, 'persist');
      await attempt(() => amend(v1.id, { amount: 5000 }));   // NO_EFFECTIVE_CHANGE
      await attempt(() => amend('nope', { amount: 1 }));      // TARGET_NOT_FOUND
      expect(save).not.toHaveBeenCalled();
    });

    it('the PRISMA adapter mirrors every guard (a rule in one adapter is not a rule)', async () => {
      const prisma = new PrismaTransactionRepository();
      const uniq = vi.spyOn(TransactionIdentityService, 'assertUniqueIds');
      const adm = vi.spyOn(TransferIntegrityService, 'assertAdmissible');
      const whole = vi.spyOn(TransferIntegrityService, 'assertWholeTransferLifecycle');

      // findAllSync() is [] here (pre-existing), so a target is never found
      const r = await attempt(() => prisma.supersede([{ targetId: 'x', changes: { amount: 1 } }]));
      expect(r.ok).toBe(false);
      expect(r.error).toBeInstanceOf(AmendmentRefusedError);
      expect(r.error.code).toBe('TARGET_NOT_FOUND');

      // and the structural gates are present in the code path
      expect(typeof prisma.supersede).toBe('function');
      uniq.mockRestore(); adm.mockRestore(); whole.mockRestore();
    });

    it('the PRISMA adapter refuses an excluded target too (Q1 = a mirrored)', async () => {
      const prisma = new PrismaTransactionRepository();
      const excluded: any = {
        id: 'e1', amount: 100, narration: 'n', account: 'A', date: '2026-08-01',
        excludedAt: '2026-08-02T00:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK'
      };
      vi.spyOn(prisma, 'findAllSync').mockReturnValue([excluded]);
      const r = await attempt(() => prisma.supersede([{ targetId: 'e1', changes: { amount: 1 } }]));
      expect(r.error.code).toBe('TARGET_ALREADY_EXCLUDED');
    });
  });
});
