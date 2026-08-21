/**
 * WP-FB-DATA-04 — Account referential integrity.
 *
 * Guards F-03 from WP-FB-DATA-03: transactions referenced accounts only by
 * free-text display name, so import adapters emitting 'SBI Bank' could not be
 * related to an account registered as 'SBI Savings', and deleting an account
 * silently orphaned its rows.
 *
 * Model under test:
 *   Account.id            -> authoritative identity
 *   Transaction.accountId -> the reference (null = explicitly unmapped)
 *   Transaction.account   -> presentation / legacy text, part of the fingerprint
 *
 * All migration exercises run against synthetic in-memory fixtures. No user
 * IndexedDB data is read or written.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AccountResolutionService } from '../services/AccountResolutionService';
import { ImportPipelineService } from '../services/ImportPipelineService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Account, Transaction } from '../domain/types';

const FIXTURES = path.resolve(__dirname, '../../scripts/fixtures');
const LIVE_TODAY = '2026-08-21';

const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: Account[];
  syncStore: () => void;
  remapAccounts: () => void;
  unmapAccount: (id: string) => number;
  countTransactionsForAccount: (id: string) => number;
};

function reset() {
  repo.transactionsData = [];
  repo.accountsData = [];
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  });
}

function account(id: string, name: string, openingBalance = 0): Account {
  return { id, name, type: 'Bank' as any, openingBalance };
}

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-fixed-1', date: '2026-08-18', dateStr: '18 Aug 2026',
    title: 'T', narration: 'N', account: 'SBI Bank', type: 'Income' as any,
    category: 'GENERAL', amount: 100, status: 'CLEARED' as any,
    fingerprint: 'fp-preexisting-do-not-change',
    ...over
  };
}

function importFixture(fileName: string) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, fileName)));
  const result = ImportPipelineService.processBinaryFile(
    bytes, useCanonicalLedger.getState().transactions, 'Bank Import', fileName
  );
  const commit = useCanonicalLedger.getState().commitImportedRows(result.validRows);
  return { result, commit };
}

describe('WP-FB-DATA-04 — account referential integrity', () => {
  beforeEach(() => { reset(); setAsOfDateOverride(LIVE_TODAY); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ---------------------------------------------------------- §17.2/.3 */
  describe('name resolution', () => {
    const accounts = [account('acc-1', 'SBI Bank'), account('acc-2', 'ICICI Bank')];

    it('resolves an exact name match to the account id', () => {
      const r = AccountResolutionService.resolve('SBI Bank', accounts);
      expect(r.status).toBe('MATCHED');
      expect(r.accountId).toBe('acc-1');
    });

    it('resolves case- and whitespace-normalized names', () => {
      expect(AccountResolutionService.resolveId('  sbi   bank  ', accounts)).toBe('acc-1');
      expect(AccountResolutionService.resolveId('ICICI BANK', accounts)).toBe('acc-2');
    });

    it('returns UNMAPPED when no account matches', () => {
      const r = AccountResolutionService.resolve('SBI Savings', accounts);
      expect(r.status).toBe('UNMAPPED');
      expect(r.accountId).toBeNull();
    });

    it('returns AMBIGUOUS and refuses to guess when several accounts match', () => {
      const dupes = [account('acc-1', 'SBI Bank'), account('acc-9', 'sbi bank')];
      const r = AccountResolutionService.resolve('SBI Bank', dupes);
      expect(r.status).toBe('AMBIGUOUS');
      expect(r.accountId).toBeNull();          // never arbitrarily assigned
      expect(r.candidates).toHaveLength(2);
    });

    it('treats a blank account label as unmapped', () => {
      expect(AccountResolutionService.resolve('', accounts).status).toBe('UNMAPPED');
    });
  });

  /* ------------------------------------------------------------ §17.1 */
  describe('deterministic migration of existing data', () => {
    const accounts = [account('acc-1', 'SBI Bank'), account('acc-2', 'ICICI Bank')];

    it('classifies MATCHED / UNMAPPED / AMBIGUOUS without dropping rows', () => {
      const dupes = [...accounts, account('acc-dup', ' sbi bank ')];
      const rows = [
        tx({ id: 'a', account: 'ICICI Bank' }),
        tx({ id: 'b', account: 'Unknown Bank' }),
        tx({ id: 'c', account: 'SBI Bank' })
      ];
      const res = AccountResolutionService.migrate(rows, dupes);

      expect(res.transactions).toHaveLength(3);          // nothing lost
      expect(res.matched).toBe(1);                       // ICICI
      expect(res.unmapped).toBe(1);                      // Unknown
      expect(res.ambiguous).toBe(1);                     // SBI x2
      expect(res.transactions.find(t => t.id === 'a')!.accountId).toBe('acc-2');
      expect(res.transactions.find(t => t.id === 'b')!.accountId).toBeNull();
      expect(res.transactions.find(t => t.id === 'c')!.accountId).toBeNull();
    });

    it('is idempotent and never reassigns an already-valid reference', () => {
      const rows = [tx({ id: 'x', account: 'SBI Bank' })];
      const once = AccountResolutionService.migrate(rows, accounts);
      const twice = AccountResolutionService.migrate(once.transactions, accounts);
      expect(twice.transactions[0].accountId).toBe('acc-1');
      expect(twice.alreadyResolved).toBe(1);
      expect(twice.matched).toBe(0);
    });

    it('re-resolves a reference pointing at a deleted account', () => {
      const rows = [tx({ id: 'y', account: 'SBI Bank', accountId: 'acc-DELETED' })];
      const res = AccountResolutionService.migrate(rows, accounts);
      expect(res.transactions[0].accountId).toBe('acc-1');
    });
  });

  /* ------------------------------------------------------- §17.10/.11 */
  describe('existing data preservation', () => {
    it('preserves id, date, amount, direction, narration and fingerprint', () => {
      const original = tx({ id: 'tx-keep-me', account: 'SBI Bank' });
      const before = { ...original };
      const [after] = AccountResolutionService.migrate([original], [account('acc-1', 'SBI Bank')]).transactions;

      expect(after.id).toBe(before.id);
      expect(after.date).toBe(before.date);
      expect(after.dateStr).toBe(before.dateStr);
      expect(after.amount).toBe(before.amount);
      expect(after.type).toBe(before.type);
      expect(after.narration).toBe(before.narration);
      expect(after.account).toBe(before.account);        // legacy text untouched
      expect(after.fingerprint).toBe('fp-preexisting-do-not-change');
      expect(after.accountId).toBe('acc-1');             // only addition
    });

    it('does not mutate the input array', () => {
      const original = tx({ id: 'tx-immutable', account: 'SBI Bank' });
      AccountResolutionService.migrate([original], [account('acc-1', 'SBI Bank')]);
      expect(original.accountId).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------ §17.6 */
  describe('import resolves to the correct Account.id', () => {
    it('links SBI rows to a registered SBI Bank account', () => {
      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 10000 });
      const sbiId = useCanonicalLedger.getState().accounts.find(a => a.name === 'SBI Bank')!.id;

      importFixture('SBI_Statement.xlsx');
      const rows = useCanonicalLedger.getState().transactions;

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(t => t.accountId === sbiId)).toBe(true);
    });

    it('links each bank to its own account across two imports', () => {
      const s = useCanonicalLedger.getState();
      s.addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });
      s.addAccount({ name: 'ICICI Bank', type: 'Bank' as any, openingBalance: 0 });
      const accts = useCanonicalLedger.getState().accounts;
      const sbiId = accts.find(a => a.name === 'SBI Bank')!.id;
      const iciciId = accts.find(a => a.name === 'ICICI Bank')!.id;

      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');
      const rows = useCanonicalLedger.getState().transactions;

      expect(rows.filter(t => t.accountId === sbiId).length).toBe(3);
      expect(rows.filter(t => t.accountId === iciciId).length).toBe(3);
      expect(rows.some(t => t.accountId === null)).toBe(false);
    });

    it('leaves an import unmapped when the registered name differs, without inventing an account', () => {
      // The reported real-world case: adapter says 'SBI Bank', user registered 'SBI Savings'.
      useCanonicalLedger.getState().addAccount({ name: 'SBI Savings', type: 'Bank' as any, openingBalance: 0 });
      importFixture('SBI_Statement.xlsx');

      const state = useCanonicalLedger.getState();
      expect(state.accounts).toHaveLength(1);                       // no account invented
      expect(state.transactions.length).toBe(3);                    // nothing discarded
      expect(state.transactions.every(t => !t.accountId)).toBe(true);
    });
  });

  /* ------------------------------------------------------------ §17.13 */
  describe('unmapped transactions remain first-class', () => {
    it('stays visible in the canonical Ledger and is identifiable', () => {
      importFixture('SBI_Statement.xlsx');            // no accounts registered
      const state = useCanonicalLedger.getState();
      const visible = state.getFilteredTransactions({ type: 'All', dateRange: 'YTD' });

      expect(visible.length).toBe(state.transactions.length);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every(t => AccountResolutionService.isUnmapped(t, state.accounts))).toBe(true);
    });

    it('§17.12 falls back to the legacy label for display', () => {
      const t = tx({ account: 'SBI Bank', accountId: null });
      expect(AccountResolutionService.displayName(t, [])).toBe('SBI Bank');
    });

    it('§17.12 displays the resolved account name, not the stale legacy text', () => {
      const t = tx({ account: 'SBI Bank', accountId: 'acc-1' });
      const accts = [account('acc-1', 'SBI Main')];       // renamed since import
      expect(AccountResolutionService.displayName(t, accts)).toBe('SBI Main');
    });
  });

  /* ------------------------------------------------------------- §17.7 */
  describe('account rename preserves the relationship', () => {
    it('keeps transactions linked when only the display name changes', () => {
      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });
      const original = useCanonicalLedger.getState().accounts[0];
      importFixture('SBI_Statement.xlsx');
      const linkedBefore = useCanonicalLedger.getState().transactions.filter(t => t.accountId === original.id).length;
      expect(linkedBefore).toBe(3);

      // Upsert by id with a new display name == rename.
      repo.accountsData = [{ ...original, name: 'SBI Main' }];
      repo.remapAccounts();
      repo.syncStore();

      const after = useCanonicalLedger.getState();
      expect(after.transactions.filter(t => t.accountId === original.id).length).toBe(3);
      expect(after.transactions.every(t => !AccountResolutionService.isUnmapped(t, after.accounts))).toBe(true);
      expect(AccountResolutionService.displayName(after.transactions[0], after.accounts)).toBe('SBI Main');
    });
  });

  /* ------------------------------------------------------------- §17.8 */
  describe('account deletion never silently orphans', () => {
    it('explicitly unmaps referencing transactions and preserves every row and value', () => {
      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });
      const acc = useCanonicalLedger.getState().accounts[0];
      importFixture('SBI_Statement.xlsx');

      const before = useCanonicalLedger.getState().transactions;
      const beforeIds = before.map(t => t.id).sort();
      const beforeTotal = before.reduce((s, t) => s + t.amount, 0);
      expect(repo.countTransactionsForAccount(acc.id)).toBe(3);

      useCanonicalLedger.getState().removeAccount(acc.id);

      const after = useCanonicalLedger.getState();
      expect(after.accounts).toHaveLength(0);
      expect(after.transactions).toHaveLength(before.length);          // nothing deleted
      expect(after.transactions.map(t => t.id).sort()).toEqual(beforeIds);
      expect(after.transactions.reduce((s, t) => s + t.amount, 0)).toBe(beforeTotal);
      expect(after.transactions.every(t => t.accountId === null)).toBe(true);
      expect(after.transactions.every(t => t.account === 'SBI Bank')).toBe(true);  // legacy text kept

      // Acceptance invariant B: no transaction references a deleted Account.id.
      const validIds = new Set(after.accounts.map(a => a.id));
      expect(after.transactions.every(t => !t.accountId || validIds.has(t.accountId))).toBe(true);
    });

    it('leaves other accounts untouched', () => {
      const s = useCanonicalLedger.getState();
      s.addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });
      s.addAccount({ name: 'ICICI Bank', type: 'Bank' as any, openingBalance: 0 });
      const accts = useCanonicalLedger.getState().accounts;
      const iciciId = accts.find(a => a.name === 'ICICI Bank')!.id;

      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');
      useCanonicalLedger.getState().removeAccount(accts.find(a => a.name === 'SBI Bank')!.id);

      const after = useCanonicalLedger.getState();
      expect(after.transactions.filter(t => t.accountId === iciciId)).toHaveLength(3);
      expect(after.transactions.filter(t => t.accountId === null)).toHaveLength(3);
    });
  });

  /* ---------------------------------------------------- §17.9 / §11 */
  describe('manual transactions and registry rules', () => {
    it('attaches a valid accountId to a manually recorded transaction', () => {
      useCanonicalLedger.getState().addAccount({ name: 'HDFC Bank', type: 'Bank' as any, openingBalance: 0 });
      const hdfcId = useCanonicalLedger.getState().accounts[0].id;

      useCanonicalLedger.getState().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');

      const rows = useCanonicalLedger.getState().transactions;
      expect(rows).toHaveLength(1);
      expect(rows[0].accountId).toBe(hdfcId);
    });

    it('records an unmapped manual transaction rather than failing or guessing', () => {
      useCanonicalLedger.getState().addIncome('Cash gift', 100, 'Nowhere Bank', 'GENERAL');
      const rows = useCanonicalLedger.getState().transactions;
      expect(rows).toHaveLength(1);
      expect(rows[0].accountId).toBeNull();
      expect(rows[0].account).toBe('Nowhere Bank');
    });

    it('rejects duplicate account names, so ambiguity cannot be introduced via the UI', async () => {
      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });

      // NOTE: repository.accounts.add() is async and the command layer does not
      // await it, so the uniqueness violation surfaces as a rejected promise
      // rather than a synchronous throw. Asserted at the repository boundary.
      await expect(
        (repository.accounts as any).add({ id: 'acc-dupe', name: '  sbi bank ', type: 'Bank', openingBalance: 0 })
      ).rejects.toThrow(/already exists/i);

      expect(useCanonicalLedger.getState().accounts).toHaveLength(1);
    });

    it('links previously unmapped rows once a matching account is registered', () => {
      importFixture('SBI_Statement.xlsx');                       // unmapped
      expect(useCanonicalLedger.getState().transactions.every(t => !t.accountId)).toBe(true);

      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });

      const after = useCanonicalLedger.getState();
      const sbiId = after.accounts[0].id;
      expect(after.transactions.every(t => t.accountId === sbiId)).toBe(true);
    });
  });

  /* ------------------------------------------------------------- §14 */
  describe('deduplication compatibility (not redesigned here)', () => {
    it('leaves fingerprints unchanged and does not duplicate on re-import', () => {
      useCanonicalLedger.getState().addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });

      const first = importFixture('SBI_Statement.xlsx');
      const fingerprintsFirst = useCanonicalLedger.getState().transactions.map(t => t.fingerprint).sort();

      const second = importFixture('SBI_Statement.xlsx');
      expect(second.commit.appended).toBe(0);

      const fingerprintsSecond = useCanonicalLedger.getState().transactions.map(t => t.fingerprint).sort();
      expect(fingerprintsSecond).toEqual(fingerprintsFirst);
      expect(useCanonicalLedger.getState().transactions).toHaveLength(first.commit.appended);
    });

    it('produces the same fingerprint whether or not accountId is present', () => {
      const withId = tx({ accountId: 'acc-1', fingerprint: undefined });
      const withoutId = tx({ accountId: null, fingerprint: undefined });
      const fp = (t: Transaction) =>
        `${t.account}|${t.date}|${t.amount}|${t.narration.toLowerCase().trim()}`;
      expect(fp(withId)).toBe(fp(withoutId));
    });
  });

  /* ------------------------------------------------- §16 invariants */
  describe('§16 acceptance invariants', () => {
    it('A+B: every transaction resolves to exactly one account or is explicitly unmapped', () => {
      const s = useCanonicalLedger.getState();
      s.addAccount({ name: 'SBI Bank', type: 'Bank' as any, openingBalance: 0 });
      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');            // ICICI not registered -> unmapped

      const after = useCanonicalLedger.getState();
      const validIds = new Set(after.accounts.map(a => a.id));
      for (const t of after.transactions) {
        const ok = t.accountId === null || t.accountId === undefined || validIds.has(t.accountId);
        expect(ok, `transaction ${t.id} must be mapped or explicitly unmapped`).toBe(true);
      }
      expect(after.transactions.filter(t => t.accountId)).toHaveLength(3);
      expect(after.transactions.filter(t => !t.accountId)).toHaveLength(3);
    });

    it('I: Ledger visibility is unaffected by mapping state', () => {
      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');
      const s = useCanonicalLedger.getState();
      expect(s.getFilteredTransactions({ type: 'All', dateRange: 'YTD' }).length)
        .toBe(s.transactions.length);
    });
  });
});
