/**
 * WP-FB-DATA-05a — Canonical account balance derivation.
 *
 * AccountBalanceService is the sole authority for transaction-derived balances:
 *
 *   balance(accountId, asOf) = openingBalance
 *                            + Σ signedAmount(t)
 *                              where t.accountId === account.id
 *                                and t.date  >  account.asOfDate   (anchor)
 *                                and t.date <=  asOf
 *
 * Approved decisions under test:
 *   A  — NET_WORTH is NOT affected by account balances.
 *   B  — unmapped transactions are excluded, surfaced, never pseudo-accounted.
 *   B4 — the opening-balance anchor is authoritative; rows on/before it are
 *        already inside openingBalance and must not be added again.
 *
 * Out of scope (DATA-05b): Essentials liquid reserves, B5 asset dedup.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AccountBalanceService } from '../services/AccountBalanceService';
import { TransactionSignService } from '../services/TransactionSignService';
import { ImportPipelineService } from '../services/ImportPipelineService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { FinancialQueries } from '../application/queries';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Account, Transaction } from '../domain/types';

const FIXTURES = path.resolve(__dirname, '../../scripts/fixtures');
const TODAY = '2026-08-21';

const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: Account[];
  assetsData: any[];
  liabilitiesData: any[];
  syncStore: () => void;
};

function reset() {
  repo.transactionsData = [];
  repo.accountsData = [];
  repo.assetsData = [];
  repo.liabilitiesData = [];
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], assets: [], liabilities: [],
    filterType: 'All', dateRange: 'YTD', searchQuery: ''
  });
}
const S = () => useCanonicalLedger.getState();

/** Registers an account with an EXPLICIT opening-balance anchor (Decision B4). */
function account(name: string, openingBalance: number, asOfDate = '2026-01-01'): Account {
  const acc: Account = {
    id: `acc-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name, type: 'Bank' as any, openingBalance, asOfDate
  };
  repo.accountsData = [...repo.accountsData, acc];
  repo.syncStore();
  return acc;
}

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: `tx-${Math.random().toString(36).slice(2, 8)}`,
    date: '2026-06-01', dateStr: '01 Jun 2026',
    title: 'T', narration: 'N', account: 'legacy-name-should-be-ignored',
    accountId: null, type: 'Income' as any, direction: 'CREDIT',
    category: 'GENERAL', amount: 100, status: 'CLEARED' as any,
    ...over
  };
}
function put(...rows: Transaction[]) {
  repo.transactionsData = [...repo.transactionsData, ...rows];
  repo.syncStore();
}
const bal = (id: string, asOf = TODAY) =>
  AccountBalanceService.balance(id, S().accounts, S().transactions, asOf);

describe('WP-FB-DATA-05a — AccountBalanceService', () => {
  beforeEach(() => { reset(); setAsOfDateOverride(TODAY); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ============================ §21 core matrix ============================ */

  it('1. opening balance only', () => {
    const a = account('A', 10000);
    expect(bal(a.id)!.balance).toBe(10000);
    expect(bal(a.id)!.transactionCount).toBe(0);
  });

  it('2. income after the anchor increases the balance', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));
    expect(bal(a.id)!.balance).toBe(11000);
  });

  it('3. expense after the anchor decreases the balance', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Expense' as any, direction: 'DEBIT', amount: 300 }));
    expect(bal(a.id)!.balance).toBe(9700);
  });

  it('4. income BEFORE the anchor is excluded', () => {
    const a = account('A', 10000, '2026-01-01');
    put(tx({ accountId: a.id, date: '2025-12-31', type: 'Income' as any, direction: 'CREDIT', amount: 500 }));
    expect(bal(a.id)!.balance).toBe(10000);
  });

  it('4b. a transaction ON the anchor date is excluded (already in opening)', () => {
    const a = account('A', 10000, '2026-01-01');
    put(tx({ accountId: a.id, date: '2026-01-01', type: 'Income' as any, direction: 'CREDIT', amount: 500 }));
    expect(bal(a.id)!.balance).toBe(10000);
  });

  it('5. expense before the anchor is excluded', () => {
    const a = account('A', 10000, '2026-01-01');
    put(tx({ accountId: a.id, date: '2025-11-01', type: 'Expense' as any, direction: 'DEBIT', amount: 900 }));
    expect(bal(a.id)!.balance).toBe(10000);
  });

  it('6. historical as-of date is cumulative, not a windowed total', () => {
    const a = account('A', 10000, '2026-01-01');
    put(
      tx({ accountId: a.id, date: '2026-01-15', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }),
      tx({ accountId: a.id, date: '2026-02-01', type: 'Expense' as any, direction: 'DEBIT', amount: 300 })
    );
    expect(bal(a.id, '2026-01-31')!.balance).toBe(11000);   // §9 worked example
    expect(bal(a.id, '2026-02-28')!.balance).toBe(10700);
    expect(bal(a.id, '2026-01-14')!.balance).toBe(10000);
  });

  it('7. transactions after the requested asOf are excluded', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2027-01-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));
    expect(bal(a.id, '2026-12-31')!.balance).toBe(10000);
    expect(bal(a.id, '2027-01-01')!.balance).toBe(11000);
  });

  it('8. transfer DEBIT reduces the balance', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Transfer' as any, direction: 'DEBIT', amount: 2000 }));
    expect(bal(a.id)!.balance).toBe(8000);
  });

  it('9. transfer CREDIT increases the balance', () => {
    const b = account('B', 5000);
    put(tx({ accountId: b.id, date: '2026-06-01', type: 'Transfer' as any, direction: 'CREDIT', amount: 2000 }));
    expect(bal(b.id)!.balance).toBe(7000);
  });

  it('10+11. two-account transfer nets to zero across registered accounts', () => {
    const a = account('A', 10000);
    const b = account('B', 5000);
    put(
      tx({ accountId: a.id, transferId: 'tr1', date: '2026-06-01', type: 'Transfer' as any, direction: 'DEBIT', amount: 2000 }),
      tx({ accountId: b.id, transferId: 'tr1', date: '2026-06-01', type: 'Transfer' as any, direction: 'CREDIT', amount: 2000 })
    );
    expect(bal(a.id)!.balance).toBe(8000);
    expect(bal(b.id)!.balance).toBe(7000);
    expect(AccountBalanceService.total(S().accounts, S().transactions, TODAY)).toBe(15000);
  });

  it('12+13. unmapped transactions are excluded but surfaced', () => {
    const a = account('A', 10000);
    put(tx({ accountId: null, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));

    expect(bal(a.id)!.balance).toBe(10000);                       // excluded
    const rec = AccountBalanceService.reconciliation(S().accounts, S().transactions, TODAY);
    expect(rec.unmappedCount).toBe(1);                            // surfaced
    expect(rec.unmappedGross).toBe(1000);
    expect(rec.unmappedNet).toBe(1000);
    // No pseudo-account was created.
    expect(S().accounts).toHaveLength(1);
    expect(AccountBalanceService.balances(S().accounts, S().transactions, TODAY)).toHaveLength(1);
  });

  it('14. an unknown accountId yields no balance and is never name-resolved', () => {
    account('A', 10000);
    put(tx({ accountId: 'acc-does-not-exist', account: 'A', date: '2026-06-01', amount: 5000 }));

    expect(AccountBalanceService.balance('acc-does-not-exist', S().accounts, S().transactions, TODAY)).toBeNull();
    expect(bal('acc-a')!.balance).toBe(10000);                    // legacy name ignored
    expect(AccountBalanceService.reconciliation(S().accounts, S().transactions, TODAY).unmappedCount).toBe(1);
  });

  it('15. renaming an account preserves its derived balance', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));
    expect(bal(a.id)!.balance).toBe(11000);

    repo.accountsData = [{ ...a, name: 'A Renamed' }];
    repo.syncStore();

    expect(bal(a.id)!.balance).toBe(11000);
    expect(bal(a.id)!.name).toBe('A Renamed');
  });

  it('16. a deleted account no longer receives a balance; its rows reconcile', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));

    useCanonicalLedger.getState().removeAccount(a.id);            // DATA-04 unmaps

    expect(AccountBalanceService.balance(a.id, S().accounts, S().transactions, TODAY)).toBeNull();
    expect(AccountBalanceService.total(S().accounts, S().transactions, TODAY)).toBe(0);
    const rec = AccountBalanceService.reconciliation(S().accounts, S().transactions, TODAY);
    expect(rec.unmappedCount).toBe(1);
    expect(S().transactions).toHaveLength(1);                     // nothing deleted
  });

  it('17. accounts are isolated from one another', () => {
    const a = account('A', 10000);
    const b = account('B', 5000);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));
    expect(bal(a.id)!.balance).toBe(11000);
    expect(bal(b.id)!.balance).toBe(5000);
  });

  it('18. zero-balance account with offsetting activity', () => {
    const a = account('A', 0);
    put(
      tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 500 }),
      tx({ accountId: a.id, date: '2026-06-02', type: 'Expense' as any, direction: 'DEBIT', amount: 500 })
    );
    expect(bal(a.id)!.balance).toBe(0);
  });

  it('19. a derived balance may go negative', () => {
    const a = account('A', 100);
    put(tx({ accountId: a.id, date: '2026-06-01', type: 'Expense' as any, direction: 'DEBIT', amount: 900 }));
    expect(bal(a.id)!.balance).toBe(-800);
  });

  it('20. account with no transactions returns the opening balance', () => {
    const a = account('A', 7500);
    put(tx({ accountId: null, date: '2026-06-01', amount: 999 }));
    expect(bal(a.id)!.balance).toBe(7500);
    expect(bal(a.id)!.transactionCount).toBe(0);
  });

  it('21. calculation is deterministic across repeated calls', () => {
    const a = account('A', 10000);
    put(
      tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }),
      tx({ accountId: a.id, date: '2026-06-02', type: 'Expense' as any, direction: 'DEBIT', amount: 300 })
    );
    const runs = [bal(a.id)!.balance, bal(a.id)!.balance, bal(a.id)!.balance];
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toBe(10700);
  });

  it('22. defaults to the effective as-of date authority', () => {
    const a = account('A', 10000);
    put(tx({ accountId: a.id, date: '2026-08-20', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));

    setAsOfDateOverride('2026-08-19');
    expect(AccountBalanceService.balance(a.id, S().accounts, S().transactions)!.balance).toBe(10000);
    setAsOfDateOverride('2026-08-21');
    expect(AccountBalanceService.balance(a.id, S().accounts, S().transactions)!.balance).toBe(11000);
  });

  /* ===================== undetermined sign is not guessed ================== */

  it('an undetermined transfer contributes 0 and is reported', () => {
    const a = account('A', 10000);
    put(tx({ id: 'opaque', accountId: a.id, date: '2026-06-01', type: 'Transfer' as any,
             direction: undefined, narration: 'OPAQUE', notes: '', amount: 2000 }));
    const b = bal(a.id)!;
    expect(b.balance).toBe(10000);
    expect(b.undeterminedCount).toBe(1);
  });

  /* ======================= §26 executable invariants ======================= */

  describe('§26 invariants', () => {
    it('derived balance always equals opening + qualifying signed sum', () => {
      const a = account('A', 10000, '2026-01-01');
      put(
        tx({ accountId: a.id, date: '2025-12-01', type: 'Income' as any, direction: 'CREDIT', amount: 111 }),
        tx({ accountId: a.id, date: '2026-03-01', type: 'Income' as any, direction: 'CREDIT', amount: 222 }),
        tx({ accountId: a.id, date: '2026-04-01', type: 'Expense' as any, direction: 'DEBIT', amount: 333 }),
        tx({ accountId: null, date: '2026-05-01', type: 'Income' as any, direction: 'CREDIT', amount: 444 })
      );
      const expected = 10000 + S().transactions
        .filter(t => t.accountId === a.id && t.date > '2026-01-01' && t.date <= TODAY)
        .reduce((s, t) => s + TransactionSignService.signedAmount(t), 0);
      expect(bal(a.id)!.balance).toBe(expected);
      expect(bal(a.id)!.balance).toBe(10000 + 222 - 333);
    });

    it('a pure transfer leaves the registered total unchanged', () => {
      const a = account('A', 10000);
      const b = account('B', 5000);
      const before = AccountBalanceService.total(S().accounts, S().transactions, TODAY);
      put(
        tx({ accountId: a.id, date: '2026-06-01', type: 'Transfer' as any, direction: 'DEBIT', amount: 2000 }),
        tx({ accountId: b.id, date: '2026-06-01', type: 'Transfer' as any, direction: 'CREDIT', amount: 2000 })
      );
      expect(AccountBalanceService.total(S().accounts, S().transactions, TODAY)).toBe(before);
    });

    it('unmapped, future and pre-anchor rows each change the total by zero', () => {
      const a = account('A', 10000, '2026-01-01');
      const before = AccountBalanceService.total(S().accounts, S().transactions, TODAY);
      put(
        tx({ accountId: null, date: '2026-06-01', amount: 500 }),                                  // unmapped
        tx({ accountId: a.id, date: '2027-01-01', amount: 500 }),                                  // future
        tx({ accountId: a.id, date: '2025-12-31', amount: 500 })                                   // pre-anchor
      );
      expect(AccountBalanceService.total(S().accounts, S().transactions, TODAY)).toBe(before);
    });
  });

  /* ==================== §23 NET_WORTH preservation ======================== */

  describe('§23 NET_WORTH is unaffected (Decision A — Option B)', () => {
    const netWorth = () => FinancialQueries.getMetric('NET_WORTH').value;

    it('income does not change NET_WORTH', () => {
      const a = account('A', 10000);
      const before = netWorth();
      put(tx({ accountId: a.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));
      expect(bal(a.id)!.balance).toBe(11000);
      expect(netWorth()).toBe(before);
    });

    it('expense does not change NET_WORTH', () => {
      const a = account('A', 10000);
      const before = netWorth();
      put(tx({ accountId: a.id, date: '2026-06-01', type: 'Expense' as any, direction: 'DEBIT', amount: 300 }));
      expect(bal(a.id)!.balance).toBe(9700);
      expect(netWorth()).toBe(before);
    });

    it('a transfer does not change NET_WORTH', () => {
      const a = account('A', 10000);
      const b = account('B', 5000);
      const before = netWorth();
      put(
        tx({ accountId: a.id, date: '2026-06-01', type: 'Transfer' as any, direction: 'DEBIT', amount: 2000 }),
        tx({ accountId: b.id, date: '2026-06-01', type: 'Transfer' as any, direction: 'CREDIT', amount: 2000 })
      );
      expect(netWorth()).toBe(before);
    });

    it('a real statement import does not change NET_WORTH', () => {
      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 10000 });
      const before = netWorth();
      const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'SBI_Statement.xlsx')));
      const r = ImportPipelineService.processBinaryFile(bytes, [], 'Bank Import', 'SBI_Statement.xlsx');
      S().commitImportedRows(r.validRows);
      expect(S().transactions.length).toBeGreaterThan(0);
      expect(netWorth()).toBe(before);
    });
  });

  /* ==================== §24 reconciliation lifecycle ====================== */

  describe('§24 reconciliation', () => {
    it('an unmapped row is visible, excluded, and creates no pseudo-account', () => {
      const a = account('A', 10000);
      put(tx({ id: 'recon-1', accountId: null, account: 'Nowhere', date: '2026-06-01',
               type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));

      expect(S().getFilteredTransactions({ type: 'All', dateRange: 'YTD' }).length).toBe(1);  // Ledger
      expect(bal(a.id)!.balance).toBe(10000);                                                 // excluded
      expect(AccountBalanceService.reconciliation(S().accounts, S().transactions, TODAY).unmappedCount).toBe(1);
      expect(S().accounts).toHaveLength(1);                                                   // no pseudo-account
      expect(FinancialQueries.getMetric('NET_WORTH').value).toBe(0);
    });

    it('mapping the row updates the balance and clears the notice, same transaction', () => {
      const a = account('A', 10000);
      put(tx({ id: 'recon-1', accountId: null, account: 'A', date: '2026-06-01',
               type: 'Income' as any, direction: 'CREDIT', amount: 1000 }));

      const idsBefore = S().transactions.map(t => t.id);

      // Map it (DATA-04 remap path, as a matching account now exists).
      repo.transactionsData = repo.transactionsData.map(t =>
        t.id === 'recon-1' ? { ...t, accountId: a.id } : t
      );
      repo.syncStore();

      expect(bal(a.id)!.balance).toBe(11000);
      expect(AccountBalanceService.reconciliation(S().accounts, S().transactions, TODAY).unmappedCount).toBe(0);
      expect(S().transactions.map(t => t.id)).toEqual(idsBefore);   // no duplicate, same row
      expect(S().transactions).toHaveLength(1);
    });
  });

  /* ======================= §25 opening anchor ============================= */

  describe('§25 opening anchor', () => {
    it('excludes 2025-12-31 and includes 2026-01-02 against a 2026-01-01 anchor', () => {
      const a = account('A', 10000, '2026-01-01');
      put(tx({ accountId: a.id, date: '2025-12-31', type: 'Income' as any, direction: 'CREDIT', amount: 500 }));
      expect(bal(a.id)!.balance).toBe(10000);

      put(tx({ accountId: a.id, date: '2026-01-02', type: 'Income' as any, direction: 'CREDIT', amount: 500 }));
      expect(bal(a.id)!.balance).toBe(10500);
    });

    it('register-then-import honours the user anchor, not the creation date', () => {
      // User states the balance was true on 2026-08-01, then imports Aug 17-20.
      const a = account('SBI Bank', 10000, '2026-08-01');
      const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'SBI_Statement.xlsx')));
      const r = ImportPipelineService.processBinaryFile(bytes, [], 'Bank Import', 'SBI_Statement.xlsx');
      S().commitImportedRows(r.validRows);

      // SBI fixture: +1 +604.93 -500 = +105.93, all after the anchor.
      expect(bal(a.id)!.transactionCount).toBe(3);
      expect(bal(a.id)!.balance).toBeCloseTo(10105.93, 2);

      // Same data, anchor AFTER the statement -> already represented, excluded.
      repo.accountsData = [{ ...a, asOfDate: '2026-08-31' }];
      repo.syncStore();
      expect(bal(a.id)!.balance).toBe(10000);
      expect(bal(a.id)!.transactionCount).toBe(0);
    });

    it('reports a missing anchor instead of silently guessing one', () => {
      const acc: Account = { id: 'acc-noanchor', name: 'NoAnchor', type: 'Bank' as any, openingBalance: 1000 };
      repo.accountsData = [acc];
      put(tx({ accountId: acc.id, date: '2026-06-01', type: 'Income' as any, direction: 'CREDIT', amount: 50 }));
      const b = bal(acc.id)!;
      expect(b.anchorMissing).toBe(true);
      expect(b.balance).toBe(1050);
    });
  });

  /* ================== §27 DATA-02 Ledger visibility ======================= */

  it('§27 does not regress Ledger visibility of the six imported rows', () => {
    useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });
    for (const f of ['SBI_Statement.xlsx', 'ICICI_Statement.xls']) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, f)));
      const r = ImportPipelineService.processBinaryFile(bytes, S().transactions, 'Bank Import', f);
      S().commitImportedRows(r.validRows);
    }
    const visible = S().getFilteredTransactions({ type: 'All', dateRange: 'YTD' });
    expect(visible).toHaveLength(6);
    expect(visible.length).toBe(S().transactions.length);
    for (const d of ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20']) {
      expect(visible.map(t => t.date)).toContain(d);
    }
  });
});
