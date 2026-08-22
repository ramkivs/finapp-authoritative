/**
 * WP-FB-DATA-06c-1 — Lifecycle exclusion groundwork (Decision 13-b).
 *
 * Establishes ONE distinction that did not previously exist:
 *
 *     DERIVATION surfaces  -> exclude   (money)
 *     DISPLAY surfaces     -> show      (truth)
 *
 * DATA-02: "records exist but are filtered — never silently hidden."
 *
 * The DATA-06c discovery gate measured what happens without this: overloading
 * `status` with VOID excluded a ₹5,000 row from dividend income while
 * AccountBalanceService kept counting it. Seven surfaces, two behaviours, one
 * authority.
 *
 *   §1  the authority
 *   §2  the seven surfaces
 *   §3  visible, not hidden
 *   §4  ordinary status semantics unchanged
 *   §5  no divergence between balance and report
 *   §6  upstream authorities unchanged
 *   §7  scope boundary — groundwork only, no lifecycle
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  LedgerExclusionService,
  KNOWN_EXCLUSION_REASONS
} from '../services/LedgerExclusionService';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { LiquidReservesService } from '../services/LiquidReservesService';
import { FinancialMetricService } from '../services/FinancialMetricService';
import { DividendService } from '../services/DividendService';
import { EssentialsService } from '../services/EssentialsService';
import { FinancialQueries } from '../application/queries';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { TransactionFactory } from '../domain/TransactionFactory';
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
/** Data-layer write. 06c-1 ships NO writer for excludedAt — that is 06c-6. */
const force = (next: Transaction[]) => { repo.transactionsData = next; repo.syncStore(); };
const markExcluded = (id: string) => force(repo.transactionsData.map(t =>
  t.id === id ? { ...t, excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const } : t
));

async function seedDividend(A: any, amount = 5000, date = '2026-08-10') {
  const tx: any = TransactionFactory.createIncome({
    title: 'Acme Dividend', amount, account: A.name, accountId: A.id, category: 'DIVIDEND'
  });
  tx.date = date; tx.dateStr = date;
  tx.fingerprint = TransactionIdentityService.fingerprint({
    account: tx.account, date: tx.date, amount: tx.amount, narration: tx.narration
  });
  await repository.transactions.append(tx);
  return repo.transactionsData.find(t => t.id === tx.id)!;
}

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'X',
    narration: 'NARR', account: 'A', accountId: null, type: 'Income' as any,
    direction: 'CREDIT', category: 'DIVIDEND', amount: 100,
    status: 'CLEARED' as any, ...over
  };
}
const EXCLUDED = { excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'IMPORT_ROLLBACK' as const };

describe('WP-FB-DATA-06c-1 — ledger exclusion groundwork', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ═══════════════════════════ §1 the authority ════════════════════════════ */
  describe('§1 LedgerExclusionService', () => {
    it('a row with no excludedAt is live', () => {
      expect(LedgerExclusionService.isExcluded(row())).toBe(false);
      expect(LedgerExclusionService.reasonOf(row())).toBeNull();
    });

    it('a row with excludedAt is excluded', () => {
      expect(LedgerExclusionService.isExcluded(row(EXCLUDED))).toBe(true);
      expect(LedgerExclusionService.reasonOf(row(EXCLUDED))).toBe('IMPORT_ROLLBACK');
    });

    it('an empty excludedAt does not exclude', () => {
      expect(LedgerExclusionService.isExcluded(row({ excludedAt: '' }))).toBe(false);
    });

    it('keys on excludedAt, NOT on the reason — an unknown reason still excludes', () => {
      const r = row({ excludedAt: '2026-08-22T10:00:00.000Z', excludedReason: 'FROM_THE_FUTURE' as any });
      expect(LedgerExclusionService.isExcluded(r)).toBe(true);
      expect(LedgerExclusionService.reasonOf(r)).toBe('UNKNOWN');
    });

    it('never guesses a reason it does not recognise', () => {
      expect(LedgerExclusionService.reasonOf(row({ excludedAt: 'x' }))).toBe('UNKNOWN');
    });

    it('forDerivation drops excluded rows, keeps live ones', () => {
      const set = [row({ id: 'a' }), row({ id: 'b', ...EXCLUDED }), row({ id: 'c' })];
      expect(LedgerExclusionService.forDerivation(set).map(t => t.id)).toEqual(['a', 'c']);
      expect(LedgerExclusionService.excluded(set).map(t => t.id)).toEqual(['b']);
      expect(LedgerExclusionService.excludedCount(set)).toBe(1);
    });

    it('summarise produces disclosure detail', () => {
      const [x] = LedgerExclusionService.summarise([row({ id: 'b', amount: 250, ...EXCLUDED })]);
      expect(x.id).toBe('b');
      expect(x.reason).toBe('IMPORT_ROLLBACK');
      expect(x.message).toContain('rolled back with its import batch');
      expect(x.message).toContain('still recorded, not counted');
    });

    it('the reason vocabulary contains ONLY the resolved decision', () => {
      expect([...KNOWN_EXCLUSION_REASONS]).toEqual(['IMPORT_ROLLBACK']);
      // Decisions 1-8, 10, 12 unresolved => no lifecycle reasons yet.
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('DELETED' as any);
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('SUPERSEDED' as any);
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('REVERSED' as any);
    });
  });

  /* ══════════════════════ §2 all seven derived surfaces ════════════════════ */
  describe('§2 the seven surfaces', () => {
    it('[1] AccountBalanceService excludes it', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      expect(bal(A)).toBe(15000);
      markExcluded(tx.id);
      expect(bal(A)).toBe(10000);
    });

    it('[2] LiquidReservesService excludes it (via the balance authority)', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      expect(LiquidReservesService.total([], S().accounts, S().transactions, ASOF)).toBe(15000);
      markExcluded(tx.id);
      expect(LiquidReservesService.total([], S().accounts, S().transactions, ASOF)).toBe(10000);
    });

    it('[3] repository.findManySync excludes it BY DEFAULT', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      const q = { dateRange: 'YTD', type: 'All', asOfDateStr: '2026-08-21' } as any;
      expect(repository.transactions.findManySync(q)).toHaveLength(1);
      markExcluded(tx.id);
      expect(repository.transactions.findManySync(q)).toHaveLength(0);
    });

    it('[3b] findManySync returns it when a DISPLAY caller opts in', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      markExcluded(tx.id);
      const q = { dateRange: 'YTD', type: 'All', asOfDateStr: '2026-08-21', includeExcluded: true } as any;
      expect(repository.transactions.findManySync(q)).toHaveLength(1);
    });

    it('[4] FinancialMetricService dividend metrics exclude it', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      const ttm = () => FinancialMetricService.getMetric('TTM_REALIZED_DIVIDEND', repo.transactionsData, [], [], [], ASOF).value;
      const avg = () => FinancialMetricService.getMetric('MONTHLY_AVERAGE_DIVIDEND', repo.transactionsData, [], [], [], ASOF).value;
      expect(ttm()).toBe(5000);
      markExcluded(tx.id);
      expect(ttm()).toBe(0);
      expect(avg()).toBe(0);
    });

    it('[5] DividendService monthly series excludes it', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      const total = () => DividendService.getMonthlyTotals(repo.transactionsData, ASOF)
        .reduce((s, m) => s + m.amount, 0);
      expect(total()).toBe(5000);
      markExcluded(tx.id);
      expect(total()).toBe(0);
    });

    it('[6] getMoneyInsights excludes it', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      expect(FinancialQueries.getMoneyInsights('YTD').totalIncome).toBe(5000);
      markExcluded(tx.id);
      expect(FinancialQueries.getMoneyInsights('YTD').totalIncome).toBe(0);
    });

    it('[7] EssentialsService essential-expense derivation excludes it', async () => {
      const A = acct('A', 10000);
      const exp: any = TransactionFactory.createExpense({
        title: 'Rent', amount: 1200, account: 'A', accountId: A.id, category: 'HOUSING'
      });
      exp.date = '2026-08-10'; exp.dateStr = '2026-08-10';
      await repository.transactions.append(exp);
      const essentials = () => EssentialsService.calculateEmergencyFundAnalysis(
        [], S().accounts, S().transactions, [], 6, null as any
      ).monthlyEssentialExpenses;
      const before = essentials();
      expect(before).toBeGreaterThan(0);
      markExcluded(exp.id);
      expect(essentials()).not.toBe(before);
    });
  });

  /* ═══════════════════ §3 visible, not hidden (DATA-02) ════════════════════ */
  describe('§3 DATA-02 — excluded is NOT hidden', () => {
    it('the Ledger view still returns the excluded row', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      const visible = () => S().getFilteredTransactions({ dateRange: 'YTD', type: 'All' } as any).length;
      expect(visible()).toBe(1);
      markExcluded(tx.id);
      expect(visible()).toBe(1);          // <-- still visible
      expect(bal(A)).toBe(10000);         // <-- but not counted
    });

    it('the row is still persisted — nothing was deleted', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      markExcluded(tx.id);
      expect(repo.transactionsData).toHaveLength(1);
      expect(repo.transactionsData[0].id).toBe(tx.id);
      expect(repo.transactionsData[0].amount).toBe(5000);
    });

    it('an excluded row is discoverable for disclosure', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      markExcluded(tx.id);
      const summary = LedgerExclusionService.summarise(repo.transactionsData);
      expect(summary).toHaveLength(1);
      expect(summary[0].amount).toBe(5000);
    });

    it('provenance survives exclusion untouched', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      const before = { origin: tx.origin, recordedAt: tx.recordedAt, fingerprint: tx.fingerprint };
      markExcluded(tx.id);
      const after = repo.transactionsData[0];
      expect(after.origin).toBe(before.origin);
      expect(after.recordedAt).toBe(before.recordedAt);
      expect(after.fingerprint).toBe(before.fingerprint);
    });
  });

  /* ═════════════════ §4 ordinary status semantics unchanged ════════════════ */
  describe('§4 status is NOT overloaded', () => {
    it('CLEARED rows behave exactly as before', async () => {
      const A = acct('A', 10000);
      await seedDividend(A, 5000);
      expect(repo.transactionsData[0].status).toBe('CLEARED');
      expect(bal(A)).toBe(15000);
    });

    it('a PENDING row is still counted in the balance, as before', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      force(repo.transactionsData.map(t => t.id === tx.id ? { ...t, status: 'PENDING' as any } : t));
      expect(bal(A)).toBe(15000);         // unchanged behaviour
    });

    it('exclusion does not touch status, and status does not imply exclusion', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      markExcluded(tx.id);
      expect(repo.transactionsData[0].status).toBe('CLEARED');   // untouched
      expect(LedgerExclusionService.isExcluded(row({ status: 'PENDING' as any }))).toBe(false);
    });

    it('a PENDING row is NOT treated as excluded', () => {
      expect(LedgerExclusionService.isExcluded(row({ status: 'ESTIMATED' as any }))).toBe(false);
      expect(LedgerExclusionService.isExcluded(row({ status: 'RECONCILED' as any }))).toBe(false);
    });
  });

  /* ══════════════ §5 no divergence between balance and report ══════════════ */
  describe('§5 consistency across every derived surface', () => {
    it('all six derivation surfaces agree before AND after exclusion', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      const snapshot = () => ({
        balance: bal(A),
        liquid: LiquidReservesService.total([], S().accounts, S().transactions, ASOF),
        ttm: FinancialMetricService.getMetric('TTM_REALIZED_DIVIDEND', repo.transactionsData, [], [], [], ASOF).value,
        series: DividendService.getMonthlyTotals(repo.transactionsData, ASOF).reduce((s, m) => s + m.amount, 0),
        insights: FinancialQueries.getMoneyInsights('YTD').totalIncome,
        repoQuery: repository.transactions.findManySync({ dateRange: 'YTD', type: 'All', asOfDateStr: '2026-08-21' } as any).length
      });
      const before = snapshot();
      expect(before).toEqual({ balance: 15000, liquid: 15000, ttm: 5000, series: 5000, insights: 5000, repoQuery: 1 });

      markExcluded(tx.id);
      const after = snapshot();
      // every surface moved together — the discovery-gate split is gone
      expect(after).toEqual({ balance: 10000, liquid: 10000, ttm: 0, series: 0, insights: 0, repoQuery: 0 });
    });

    it('excluding one row does not disturb an unrelated live row', async () => {
      const A = acct('A', 10000);
      const a = await seedDividend(A, 5000, '2026-08-10');
      const b = await seedDividend(A, 700, '2026-08-12');
      expect(bal(A)).toBe(15700);
      markExcluded(a.id);
      expect(bal(A)).toBe(10700);
      expect(LedgerExclusionService.isExcluded(repo.transactionsData.find(t => t.id === b.id)!)).toBe(false);
    });
  });

  /* ═════════════════ §6 upstream authorities unchanged ═════════════════════ */
  describe('§6 DATA-04 → DATA-06c-0 unchanged', () => {
    it('exclusion does not affect the fingerprint', () => {
      const live = row();
      const excluded = row(EXCLUDED);
      expect(TransactionIdentityService.fingerprintOf(excluded))
        .toBe(TransactionIdentityService.fingerprintOf(live));
    });

    it('DATA-06b transfer integrity still evaluates an excluded pair structurally', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(0);
      force(repo.transactionsData.map(t => ({ ...t, ...EXCLUDED })));
      // both legs excluded together: still a structurally valid pair
      expect(TransferIntegrityService.findBrokenTransfers(repo.transactionsData)).toHaveLength(0);
    });

    it('excluding a whole transfer removes it from balances symmetrically', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      await S().addTransfer('A', 'B', 2000);
      expect(bal(A) + bal(B)).toBe(15000);
      force(repo.transactionsData.map(t => ({ ...t, ...EXCLUDED })));
      expect(bal(A)).toBe(10000);
      expect(bal(B)).toBe(5000);
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('DATA-06c-0 id uniqueness still enforced', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      await expect(repository.transactions.append({ ...tx, amount: 1 })).rejects.toThrow();
    });

    it('DATA-06b still refuses a lone transfer leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = TransactionFactory.createTransferPair({
        source: 'A', destination: 'B', amount: 2000,
        sourceAccountId: A.id, destinationAccountId: B.id
      });
      await expect(repository.transactions.append(d)).rejects.toThrow();
    });
  });

  /* ═════════════════ §7 scope boundary — groundwork only ═══════════════════ */
  describe('§7 scope boundary — no lifecycle shipped', () => {
    it('still no transaction remove/update/replace API', () => {
      const t = repository.transactions as any;
      expect(typeof t.remove).toBe('undefined');
      expect(typeof t.update).toBe('undefined');
      expect(typeof t.replace).toBe('undefined');
    });

    it('still no reversal / amendment / tombstone / restore / undo API', () => {
      const t = repository.transactions as any;
      expect(typeof t.reverse).toBe('undefined');
      expect(typeof t.amend).toBe('undefined');
      expect(typeof t.tombstone).toBe('undefined');
      expect(typeof t.restore).toBe('undefined');
      expect(typeof (S() as any).undo).toBe('undefined');
    });

    it('still no import-batch rollback API — 06c-6 is NOT implemented here', () => {
      const t = repository.transactions as any;
      expect(typeof t.removeBatch).toBe('undefined');
      expect(typeof (S() as any).rollbackImport).toBe('undefined');
    });

    it('nothing in this package WRITES excludedAt', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      expect(tx.excludedAt).toBeUndefined();
      const manual = TransactionFactory.createIncome({
        title: 'M', amount: 1, account: 'A', accountId: A.id, category: 'G'
      });
      expect(manual.excludedAt).toBeUndefined();
      expect((manual as any).excludedReason).toBeUndefined();
    });

    it('no unresolved-decision lifecycle field was added', async () => {
      const A = acct('A', 10000);
      const tx = await seedDividend(A, 5000);
      expect((tx as any).deletedAt).toBeUndefined();
      expect((tx as any).supersededById).toBeUndefined();
      expect((tx as any).amendedAt).toBeUndefined();
      expect((tx as any).lifecycleState).toBeUndefined();
    });
  });
});
