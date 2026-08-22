/**
 * WP-FB-DATA-06b — Transfer atomicity.
 *
 * Target invariant:
 *   A persisted transfer is either a valid balanced two-leg economic
 *   operation, or it does not exist.
 *
 * The WP-FB-DATA-06b discovery gate ran eight adversarial scenarios against the
 * pre-06b code. ALL EIGHT WERE ACCEPTED WITHOUT A SINGLE REJECTION — a missing
 * leg created or destroyed ₹2,000, unequal legs created ₹1,000, a duplicated
 * leg destroyed ₹2,000, and a lone leg could be persisted through a public
 * store API. Those exact scenarios are the regression suite below.
 *
 *   §1  the pure authority           TransferIntegrityService
 *   §2  S0–S9 adversarial scenarios  every one must now be refused
 *   §3  T1-b account deletion        allowed, derived BROKEN, reported
 *   §4  T2-a load-time detection     report only, never repair
 *   §5  T3-a / T3-b write paths      manual pairs complete; import guarded
 *   §6  error surfacing              a rejection is visible, not swallowed
 *   §7  scope boundary               no lifecycle shipped here
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  TransferIntegrityService,
  TransferIntegrityError
} from '../services/TransferIntegrityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialCommands } from '../application/commands';
import { repository } from '../repositories';
import { PrismaTransactionRepository } from '../repositories/PrismaRepository';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: any[];
  brokenTransfersAtLoad: any[];
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
const transferRows = () => repo.transactionsData.filter(t => t.type === 'Transfer');

function pair(A: any, B: any, amount = 2000) {
  return TransactionFactory.createTransferPair({
    source: 'A', destination: 'B', amount,
    sourceAccountId: A ? A.id : null,
    destinationAccountId: B ? B.id : null
  });
}

/** Attempts a write and reports whether the invariant refused it. */
async function attempt(fn: () => Promise<any>) {
  try { await fn(); return { rejected: false, error: null as any }; }
  catch (e: any) { return { rejected: true, error: e }; }
}

describe('WP-FB-DATA-06b — transfer atomicity', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ══════════════════════════ §1 the pure authority ════════════════════════ */
  describe('§1 TransferIntegrityService', () => {
    it('accepts a well-formed pair as BALANCED', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(d.transferId!, [d, c]);
      expect(v.status).toBe('BALANCED');
      expect(v.violations).toHaveLength(0);
      expect(v.net).toBe(0);
    });

    it('flags a leg count other than two', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(d.transferId!, [d]);
      expect(v.status).toBe('INVALID');
      expect(v.violations.map(x => x.code)).toContain('LEG_COUNT');
    });

    it('flags two debits', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(d.transferId!, [d, { ...d, id: 'x' }]);
      expect(v.violations.map(x => x.code)).toContain('DIRECTION_COMPOSITION');
    });

    it('flags unequal amounts', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(d.transferId!, [d, { ...c, amount: 3000 }]);
      expect(v.violations.map(x => x.code)).toContain('AMOUNT_MISMATCH');
    });

    it('flags an invalid direction value', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(
        d.transferId!, [{ ...d, direction: 'SIDEWAYS' as any }, c]
      );
      expect(v.violations.map(x => x.code)).toContain('INVALID_DIRECTION');
    });

    it('flags a non-positive amount', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(
        d.transferId!, [{ ...d, amount: 0 }, { ...c, amount: 0 }]
      );
      expect(v.violations.map(x => x.code)).toContain('NON_POSITIVE_AMOUNT');
    });

    it('flags both legs on the same account', () => {
      const A = acct('A', 10000);
      const [d, c] = pair(A, A);
      const v = TransferIntegrityService.validateGroup(d.transferId!, [d, c]);
      expect(v.violations.map(x => x.code)).toContain('SAME_ACCOUNT');
    });

    it('does NOT treat two unmapped legs as a same-account transfer', () => {
      const [d, c] = pair(null, null);
      const v = TransferIntegrityService.validateGroup(d.transferId!, [d, c]);
      expect(v.violations.map(x => x.code)).not.toContain('SAME_ACCOUNT');
    });

    it('does NOT require the legs to share a date — real transfers settle across days', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const v = TransferIntegrityService.validateGroup(
        d.transferId!, [{ ...d, date: '2026-08-10' }, { ...c, date: '2026-08-12' }]
      );
      expect(v.status).toBe('BALANCED');
    });

    it('groups only rows that carry a transferId', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const income = TransactionFactory.createIncome({
        title: 'Salary', amount: 100, account: 'A', accountId: A.id, category: 'SALARY'
      });
      const groups = TransferIntegrityService.groupByTransferId([d, c, income]);
      expect(groups.size).toBe(1);
      expect(groups.get(d.transferId!)).toHaveLength(2);
    });
  });

  /* ═══════════════ §2 the eight adversarial discovery scenarios ════════════ */
  describe('§2 adversarial scenarios — all were accepted before 06b', () => {

    it('S0 a valid balanced transfer is still admitted and nets to zero', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      expect(transferRows()).toHaveLength(2);
      expect(bal(A)).toBe(8000);
      expect(bal(B)).toBe(7000);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('S1 missing DEBIT leg is REFUSED (was: +₹2,000 created)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [, credit] = pair(A, B);
      const r = await attempt(() => repository.transactions.append(credit));
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(TransferIntegrityError);
      expect(transferRows()).toHaveLength(0);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('S2 missing CREDIT leg is REFUSED (was: −₹2,000 destroyed)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit] = pair(A, B);
      const r = await attempt(() => repository.transactions.append(debit));
      expect(r.rejected).toBe(true);
      expect(transferRows()).toHaveLength(0);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('S3 unequal amounts are REFUSED (was: +₹1,000 created)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = pair(A, B);
      const r = await attempt(() =>
        repository.transactions.appendMany([debit, { ...credit, amount: 3000 }])
      );
      expect(r.rejected).toBe(true);
      expect(transferRows()).toHaveLength(0);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('S4 a duplicated leg is REFUSED (was: −₹2,000 destroyed)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = pair(A, B);
      const r = await attempt(() =>
        repository.transactions.appendMany([debit, { ...debit, id: debit.id + '-dup' }, credit])
      );
      expect(r.rejected).toBe(true);
      expect(transferRows()).toHaveLength(0);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('S5 mismatched transferId is REFUSED (balances looked right; the pair was orphaned)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = pair(A, B);
      const r = await attempt(() =>
        repository.transactions.appendMany([debit, { ...credit, transferId: 'tr-DIFFERENT-99' }])
      );
      expect(r.rejected).toBe(true);
      expect(transferRows()).toHaveLength(0);
    });

    it('S6 an invalid direction is REFUSED (was: silently repaired by the narration fallback)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = pair(A, B);
      const r = await attempt(() =>
        repository.transactions.appendMany([{ ...debit, direction: 'SIDEWAYS' as any }, credit])
      );
      expect(r.rejected).toBe(true);
      expect(transferRows()).toHaveLength(0);
    });

    it('S7 one-leg persistence is REFUSED through EVERY public write API', async () => {
      const A = acct('A', 10000); acct('B', 5000);
      const [debit] = pair(A, null);

      const viaAppend = await attempt(() => repository.transactions.append({ ...debit, id: 'solo-1' }));
      const viaAppendMany = await attempt(() => repository.transactions.appendMany([{ ...debit, id: 'solo-2' }]));
      const viaImport = S().commitImportedRows([{ ...debit, id: 'solo-3', fingerprint: undefined } as any]);

      expect(viaAppend.rejected).toBe(true);
      expect(viaAppendMany.rejected).toBe(true);
      expect(viaImport.appended).toBe(0);
      expect(viaImport.rejectedTransferRows).toBe(1);
      expect(repo.transactionsData.filter(t => String(t.id).startsWith('solo-'))).toHaveLength(0);
    });

    it('S9 the FinancialCommands path enforces the same invariant', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await FinancialCommands.recordTransfer('A', 'B', 2000);
      expect(transferRows()).toHaveLength(2);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('a transfer row with no transferId at all is REFUSED', async () => {
      const A = acct('A', 10000); acct('B', 5000);
      const [debit] = pair(A, null);
      const r = await attempt(() =>
        repository.transactions.append({ ...debit, transferId: undefined })
      );
      expect(r.rejected).toBe(true);
      expect((r.error as TransferIntegrityError).validations[0].violations[0].code)
        .toBe('MISSING_TRANSFER_ID');
    });

    it('a refused write leaves memory untouched — no half-applied state', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      const snapshot = [...repo.transactionsData];

      const [debit] = pair(A, B);
      await attempt(() => repository.transactions.append({ ...debit, id: 'bad-1' }));

      expect(repo.transactionsData).toEqual(snapshot);
      expect(bal(A)).toBe(8000);
      expect(bal(B)).toBe(7000);
    });

    it('ordinary income and expense writes are unaffected by the gate', async () => {
      const A = acct('A', 10000);
      await repository.transactions.append(TransactionFactory.createIncome({
        title: 'Salary', amount: 500, account: 'A', accountId: A.id, category: 'SALARY'
      }));
      await repository.transactions.append(TransactionFactory.createExpense({
        title: 'Rent', amount: 200, account: 'A', accountId: A.id, category: 'HOUSING'
      }));
      expect(repo.transactionsData).toHaveLength(2);
    });
  });

  /* ═══════════════════ §3 T1-b — account deletion is allowed ═══════════════ */
  describe('§3 Decision T1-b — deletion allowed, transfer marked BROKEN, reported', () => {
    it('permits deleting an account that a transfer references', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      const r = await attempt(() => repository.accounts.remove(B.id));
      expect(r.rejected).toBe(false);
      expect(S().accounts.map((a: any) => a.name)).toEqual(['A']);
    });

    it('keeps BOTH legs stored — no financial data is deleted', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      await repository.accounts.remove(B.id);
      expect(transferRows()).toHaveLength(2);
      expect(transferRows()[0].transferId).toBe(transferRows()[1].transferId);
    });

    it('derives BROKEN with an ORPHANED_ACCOUNT_REFERENCE violation', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      await repository.accounts.remove(B.id);

      const broken = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(broken).toHaveLength(1);
      expect(broken[0].status).toBe('BROKEN');
      expect(broken[0].violations.map(v => v.code)).toContain('ORPHANED_ACCOUNT_REFERENCE');
    });

    it('BROKEN is derived, so re-registering the account clears it without a write', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      await repository.accounts.remove(B.id);
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(1);

      acct('B', 5000);                       // re-register; remapAccounts re-resolves
      (repository as any).remapAccounts?.();
      const after = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(after).toHaveLength(0);
    });

    it('a BROKEN transfer does not block recording new transfers', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      await repository.accounts.remove(B.id);

      const C = acct('C', 1000);
      const r = await attempt(() => repository.transactions.appendMany(
        TransactionFactory.createTransferPair({
          source: 'A', destination: 'C', amount: 500,
          sourceAccountId: A.id, destinationAccountId: C.id
        })
      ));
      expect(r.rejected).toBe(false);
    });

    it('deleting an account does NOT silently change the other account balance', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      const before = bal(A);
      await repository.accounts.remove(B.id);
      expect(bal(A)).toBe(before);   // T1-c would have moved this; T1-b must not
    });
  });

  /* ══════════════════ §4 T2-a — load-time detection, report only ═══════════ */
  describe('§4 Decision T2-a — detect and report, never repair', () => {
    it('findBrokenTransfers reports a pre-existing one-legged transfer', () => {
      const A = acct('A', 10000);
      const [debit] = pair(A, null);
      repo.transactionsData = [debit];       // legacy data, bypassing admission
      const broken = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(broken).toHaveLength(1);
      expect(broken[0].status).toBe('INVALID');
      expect(broken[0].violations.map(v => v.code)).toContain('LEG_COUNT');
    });

    it('reporting does not mutate, repair or drop anything', () => {
      const A = acct('A', 10000);
      const [debit] = pair(A, null);
      repo.transactionsData = [debit];
      const snapshot = JSON.parse(JSON.stringify(repo.transactionsData));
      TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(repo.transactionsData).toEqual(snapshot);
      expect(repo.transactionsData).toHaveLength(1);   // no synthesised second leg
    });

    it('returns an empty report for a clean ledger', async () => {
      acct('A', 10000); acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(0);
    });

    it('reports both BROKEN and INVALID transfers together', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      await repository.accounts.remove(B.id);
      const [orphan] = pair(A, null);
      repo.transactionsData = [...repo.transactionsData, { ...orphan, id: 'legacy-solo' }];

      const broken = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(broken.map(b => b.status).sort()).toEqual(['BROKEN', 'INVALID']);
    });

    it('describe() produces a readable reconciliation line', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      await repository.accounts.remove(B.id);
      const [v] = TransferIntegrityService.findBrokenTransfers(repo.transactionsData);
      expect(TransferIntegrityService.describe(v)).toContain('BROKEN');
      expect(TransferIntegrityService.describe(v)).toContain('no longer references an account');
    });
  });

  /* ═════════════════════ §5 T3-a manual / T3-b import ══════════════════════ */
  describe('§5 Decisions T3-a and T3-b', () => {
    it('T3-a the factory path always produces a complete admissible pair', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const r = await attempt(() => repository.transactions.appendMany(pair(A, B)));
      expect(r.rejected).toBe(false);
      expect(transferRows()).toHaveLength(2);
    });

    it('T3-b a lone imported transfer leg is rejected AND reported', () => {
      const A = acct('A', 10000);
      const [debit] = pair(A, null);
      const res = S().commitImportedRows([{ ...debit, id: 'imp-solo', fingerprint: undefined } as any]);
      expect(res.appended).toBe(0);
      expect(res.rejectedTransferRows).toBe(1);
      expect(res.rejectedTransferReasons.join(' ')).toMatch(/expected exactly 2 legs/);
    });

    it('T3-b rejects rather than silently reclassifying to Income/Expense', () => {
      const A = acct('A', 10000);
      const [debit] = pair(A, null);
      S().commitImportedRows([{ ...debit, id: 'imp-solo-2', fingerprint: undefined } as any]);
      expect(repo.transactionsData.filter(t => t.id === 'imp-solo-2')).toHaveLength(0);
      expect(repo.transactionsData.some(t => t.type === 'Income')).toBe(false);
    });

    it('T3-b ordinary Income/Expense imports are completely unaffected', () => {
      const A = acct('A', 10000);
      const row: any = {
        id: 'imp-1', date: '2026-08-10', dateStr: '10 Aug 2026',
        title: 'Dividend', narration: 'ACH/C/DIV', account: 'A', accountId: A.id,
        type: 'Income', direction: 'CREDIT', category: 'GENERAL',
        amount: 500, status: 'CLEARED'
      };
      const res = S().commitImportedRows([row]);
      expect(res.appended).toBe(1);
      expect(res.rejectedTransferRows).toBe(0);
    });

    it('T3-b a COMPLETE imported pair is still admitted', () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = pair(A, B);
      const res = S().commitImportedRows([
        { ...d, fingerprint: undefined } as any,
        { ...c, fingerprint: undefined } as any
      ]);
      expect(res.rejectedTransferRows).toBe(0);
      expect(res.appended).toBe(2);
    });
  });

  /* ════════════════════════ §6 the rejection is visible ════════════════════ */
  describe('§6 error surfacing (F-06b-2)', () => {
    it('addTransfer returns a promise so a caller can await it', () => {
      acct('A', 10000); acct('B', 5000);
      const result = S().addTransfer('A', 'B', 2000);
      expect(typeof (result as any)?.then).toBe('function');
    });

    it('recordTransfer returns a promise too', () => {
      acct('A', 10000); acct('B', 5000);
      const result = FinancialCommands.recordTransfer('A', 'B', 2000);
      expect(typeof (result as any)?.then).toBe('function');
    });

    /**
     * MUTATION-DRIVEN TEST.
     *
     * The two tests above only prove addTransfer returns *a* promise. A mutation
     * that discarded the real promise and returned `Promise.resolve()` survived
     * them — the modal would close on a refused transfer and the user would
     * believe their money was recorded. This asserts the returned promise
     * actually carries the rejection.
     *
     * A same-account transfer is the user-reachable way to trigger it: picking
     * the same account as source and destination is a real mis-click, and it is
     * not a transfer.
     */
    it('addTransfer REJECTS a same-account transfer and persists nothing', async () => {
      const A = acct('A', 10000);
      acct('B', 5000);
      const r = await attempt(() => S().addTransfer('A', 'A', 2000));
      expect(r.rejected).toBe(true);
      expect(r.error).toBeInstanceOf(TransferIntegrityError);
      expect(transferRows()).toHaveLength(0);
      expect(bal(A)).toBe(10000);
    });

    it('recordTransfer REJECTS a same-account transfer too', async () => {
      acct('A', 10000);
      const r = await attempt(() => FinancialCommands.recordTransfer('A', 'A', 2000));
      expect(r.rejected).toBe(true);
      expect(transferRows()).toHaveLength(0);
    });

    it('the rejection carries actionable detail, not a bare failure', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [debit, credit] = pair(A, B);
      const r = await attempt(() =>
        repository.transactions.appendMany([debit, { ...credit, amount: 3000 }])
      );
      const err = r.error as TransferIntegrityError;
      expect(err.name).toBe('TransferIntegrityError');
      expect(err.message).toContain('legs carry different amounts');
      expect(err.validations[0].violations[0].code).toBe('AMOUNT_MISMATCH');
    });
  });

  /* ═══════════ §6b the second repository implementation (F-06b-3) ══════════ */
  describe('§6b PrismaTransactionRepository mirrors the invariant', () => {
    /**
     * MUTATION-DRIVEN TEST. Removing the Prisma mirror survived the whole suite,
     * because nothing exercised the second implementation. An invariant that
     * lives in only one of two TransactionRepository implementations is not an
     * invariant — it is a coincidence of which adapter happens to be wired.
     */
    it('rejects a lone transfer leg through append', async () => {
      const repo2 = new PrismaTransactionRepository();
      const [debit] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: 'acc-a', destinationAccountId: 'acc-b'
      });
      await expect(repo2.append(debit)).rejects.toBeInstanceOf(TransferIntegrityError);
    });

    it('rejects an unequal pair through appendMany', async () => {
      const repo2 = new PrismaTransactionRepository();
      const [debit, credit] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: 'acc-a', destinationAccountId: 'acc-b'
      });
      await expect(repo2.appendMany([debit, { ...credit, amount: 3000 }]))
        .rejects.toBeInstanceOf(TransferIntegrityError);
    });

    it('admits a valid balanced pair', async () => {
      const repo2 = new PrismaTransactionRepository();
      const legs = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: 'acc-a', destinationAccountId: 'acc-b'
      });
      await expect(repo2.appendMany(legs)).resolves.toBeUndefined();
    });
  });

  /* ════════════════════════════ §7 scope boundary ══════════════════════════ */
  describe('§7 scope boundary — 06b ships no lifecycle', () => {
    it('still no transaction remove/update/replace API', () => {
      const txRepo = repository.transactions as any;
      expect(typeof txRepo.remove).toBe('undefined');
      expect(typeof txRepo.update).toBe('undefined');
      expect(typeof txRepo.replace).toBe('undefined');
    });

    it('no reversal or tombstone capability was introduced', () => {
      const txRepo = repository.transactions as any;
      expect(typeof txRepo.reverse).toBe('undefined');
      expect(typeof txRepo.tombstone).toBe('undefined');
    });

    it('the fingerprint definition is untouched by 06b', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      for (const leg of transferRows()) {
        expect(leg.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
