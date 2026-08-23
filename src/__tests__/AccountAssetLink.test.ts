/**
 * WP-FB-DATA-04c-2 — explicit Account↔Asset link.
 *
 * Approved cardinality (Decision C): 0..1 Account <-> 0..1 Asset, keyed on
 * Account.linkedAssetId -> Asset.id. The link is always user-stated: never
 * inferred from names, type, or fuzzy matching.
 *
 * INFRASTRUCTURE ONLY. This package must not change B5, EssentialsService,
 * AccountBalanceService or NET_WORTH — asserted below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AccountAssetLinkService } from '../services/AccountAssetLinkService';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { AssetIdentityService } from '../services/AssetIdentityService';
import { EssentialsService } from '../services/EssentialsService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { FinancialQueries } from '../application/queries';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Account, Asset, Transaction } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState();
const TODAY = '2026-08-21';

function reset() {
  repo.transactionsData = [];
  repo.accountsData = [];
  repo.assetsData = [];
  repo.liabilitiesData = [];
  repo.syncStore();
}

function account(id: string, name: string, openingBalance = 0, extra: Partial<Account> = {}): Account {
  const a: Account = { id, name, type: 'Bank' as any, openingBalance, asOfDate: '2026-01-01', ...extra };
  repo.accountsData = [...repo.accountsData, a];
  repo.syncStore();
  return a;
}
function asset(id: string, name: string, amount = 1000, extra: Partial<Asset> = {}): Asset {
  const a: Asset = { id, name, amount, type: 'Cash & Savings' as any, ...extra };
  repo.assetsData = [...repo.assetsData, a];
  repo.syncStore();
  return a;
}
const accs = () => S().accounts;
const asts = () => S().assets;
const acc = (id: string) => accs().find(a => a.id === id)!;

describe('WP-FB-DATA-04c-2 — Account↔Asset link', () => {
  beforeEach(() => { reset(); setAsOfDateOverride(TODAY); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* =========================== 1-8 core linking ========================== */

  it('1. links a valid account to a valid asset', () => {
    account('acc-A', 'HDFC Savings'); asset('ast-X', 'HDFC Savings');
    const r = S().linkAccountToAsset('acc-A', 'ast-X');
    expect(r.ok).toBe(true);
    expect(acc('acc-A').linkedAssetId).toBe('ast-X');
  });

  it('2. re-linking the same pair is idempotent', () => {
    account('acc-A', 'A'); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');
    const r = S().linkAccountToAsset('acc-A', 'ast-X');
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(true);
    expect(accs().filter(a => a.linkedAssetId === 'ast-X')).toHaveLength(1);
  });

  it('3+4. an account already linked cannot silently take another asset', () => {
    account('acc-A', 'A'); asset('ast-X', 'X'); asset('ast-Y', 'Y');
    S().linkAccountToAsset('acc-A', 'ast-X');

    const r = S().linkAccountToAsset('acc-A', 'ast-Y');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ACCOUNT_ALREADY_LINKED');
    expect(acc('acc-A').linkedAssetId).toBe('ast-X');      // unchanged
  });

  it('5. a second account cannot claim an already-linked asset', () => {
    account('acc-A', 'A'); account('acc-B', 'B'); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');

    const r = S().linkAccountToAsset('acc-B', 'ast-X');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ASSET_ALREADY_CLAIMED');
    expect(r.conflictingAccountName).toBe('A');
    expect(acc('acc-A').linkedAssetId).toBe('ast-X');       // NOT reassigned
    expect(acc('acc-B').linkedAssetId ?? null).toBeNull();
  });

  it('6. an account may not point at two assets', () => {
    account('acc-A', 'A'); asset('ast-X', 'X'); asset('ast-Y', 'Y');
    S().linkAccountToAsset('acc-A', 'ast-X');
    S().linkAccountToAsset('acc-A', 'ast-Y');
    const linked = accs().filter(a => a.linkedAssetId);
    expect(linked).toHaveLength(1);
    expect(linked[0].linkedAssetId).toBe('ast-X');
  });

  it('7+8. unlink then relink, including relinking to a different asset', () => {
    account('acc-A', 'A'); asset('ast-X', 'X'); asset('ast-Y', 'Y');
    S().linkAccountToAsset('acc-A', 'ast-X');

    expect(S().unlinkAccountFromAsset('acc-A').ok).toBe(true);
    expect(acc('acc-A').linkedAssetId).toBeNull();

    expect(S().linkAccountToAsset('acc-A', 'ast-Y').ok).toBe(true);
    expect(acc('acc-A').linkedAssetId).toBe('ast-Y');
  });

  it('unlinking an unlinked account is safe and idempotent', () => {
    account('acc-A', 'A');
    const r = S().unlinkAccountFromAsset('acc-A');
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(true);
  });

  it('an unlinked asset becomes available to another account', () => {
    account('acc-A', 'A'); account('acc-B', 'B'); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');
    S().unlinkAccountFromAsset('acc-A');
    expect(S().linkAccountToAsset('acc-B', 'ast-X').ok).toBe(true);
    expect(acc('acc-B').linkedAssetId).toBe('ast-X');
  });

  /* ============================ 9-10 deletion =========================== */

  it('9. deleting an account removes it and frees the asset; asset survives', () => {
    account('acc-A', 'A'); asset('ast-X', 'X', 5000);
    S().linkAccountToAsset('acc-A', 'ast-X');

    S().removeAccount('acc-A');

    expect(accs().find(a => a.id === 'acc-A')).toBeUndefined();
    expect(asts().find(a => a.id === 'ast-X')!.amount).toBe(5000);   // preserved
    // freed: another account may now claim it
    account('acc-B', 'B');
    expect(S().linkAccountToAsset('acc-B', 'ast-X').ok).toBe(true);
  });

  it('9b. account deletion preserves transactions and DATA-04 unmapping', () => {
    const a = account('acc-A', 'A'); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');
    repo.transactionsData = [{
      id: 'tx-1', date: '2026-06-01', dateStr: '01 Jun 2026', title: 'T', narration: 'N',
      account: 'A', accountId: a.id, type: 'Income', direction: 'CREDIT',
      category: 'G', amount: 500, status: 'CLEARED'
    } as Transaction];
    repo.syncStore();

    S().removeAccount('acc-A');

    expect(S().transactions).toHaveLength(1);
    expect(S().transactions[0].accountId).toBeNull();       // DATA-04 semantics
    expect(S().transactions[0].amount).toBe(500);
  });

  it('10. deleting a linked asset clears the link and preserves the account', async () => {
    account('acc-A', 'A', 10000); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');

    await repo.assets.remove('ast-X');

    expect(asts().find(a => a.id === 'ast-X')).toBeUndefined();
    expect(acc('acc-A')).toBeDefined();                      // account preserved
    expect(acc('acc-A').linkedAssetId).toBeNull();           // link cleared
    expect(acc('acc-A').openingBalance).toBe(10000);
  });

  it('10b. asset deletion does not touch transactions', async () => {
    const a = account('acc-A', 'A'); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');
    repo.transactionsData = [{
      id: 'tx-1', date: '2026-06-01', dateStr: '01 Jun 2026', title: 'T', narration: 'N',
      account: 'A', accountId: a.id, type: 'Income', direction: 'CREDIT',
      category: 'G', amount: 500, status: 'CLEARED'
    } as Transaction];
    repo.syncStore();

    await repo.assets.remove('ast-X');

    expect(S().transactions).toHaveLength(1);
    expect(S().transactions[0].accountId).toBe(a.id);        // untouched
  });

  /* ============================ 11-12 renames =========================== */

  it('11. renaming the account preserves the link', () => {
    account('acc-A', 'HDFC Bank'); asset('ast-X', 'HDFC Savings');
    S().linkAccountToAsset('acc-A', 'ast-X');

    repo.accountsData = accs().map(a => (a.id === 'acc-A' ? { ...a, name: 'HDFC Main' } : a));
    repo.syncStore();

    expect(acc('acc-A').name).toBe('HDFC Main');
    expect(acc('acc-A').linkedAssetId).toBe('ast-X');
  });

  it('12. renaming the asset preserves the link', () => {
    account('acc-A', 'HDFC Bank'); asset('ast-X', 'HDFC Savings');
    S().linkAccountToAsset('acc-A', 'ast-X');

    repo.assetsData = asts().map(a => (a.id === 'ast-X' ? { ...a, name: 'Renamed Cash' } : a));
    repo.syncStore();

    expect(acc('acc-A').linkedAssetId).toBe('ast-X');
    const st = AccountAssetLinkService.statusOf(acc('acc-A'), asts());
    expect(st.state).toBe('LINKED');
    expect(st.asset!.name).toBe('Renamed Cash');
  });

  it('30. the link survives BOTH sides being renamed', () => {
    account('acc-A', 'A'); asset('ast-X', 'X');
    S().linkAccountToAsset('acc-A', 'ast-X');

    repo.accountsData = accs().map(a => ({ ...a, name: 'A2' }));
    repo.assetsData = asts().map(a => ({ ...a, name: 'X2' }));
    repo.syncStore();

    expect(acc('acc-A').linkedAssetId).toBe('ast-X');
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('LINKED');
  });

  /* ==================== 13-16 hydration / broken refs =================== */

  it('13. a persisted link hydrates unchanged', () => {
    const stored: Account[] = [
      { id: 'acc-A', name: 'A', type: 'Bank' as any, openingBalance: 0, linkedAssetId: 'ast-X' }
    ];
    repo.accountsData = AccountAssetLinkService.migrate(stored).accounts;
    repo.assetsData = [{ id: 'ast-X', name: 'X', amount: 100 } as Asset];
    repo.syncStore();
    expect(acc('acc-A').linkedAssetId).toBe('ast-X');
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('LINKED');
  });

  it('14. a null link hydrates as UNLINKED', () => {
    repo.accountsData = AccountAssetLinkService.migrate([
      { id: 'acc-A', name: 'A', type: 'Bank' as any, openingBalance: 0, linkedAssetId: null }
    ]).accounts;
    repo.syncStore();
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('UNLINKED');
  });

  it('15. a missing asset reference is BROKEN — nothing is deleted or recreated', () => {
    account('acc-A', 'A', 7000, { linkedAssetId: 'ast-GONE' });
    const st = AccountAssetLinkService.statusOf(acc('acc-A'), asts());
    expect(st.state).toBe('BROKEN');
    expect(st.assetId).toBe('ast-GONE');
    expect(st.asset).toBeNull();
    expect(acc('acc-A').openingBalance).toBe(7000);      // account intact
    expect(asts()).toHaveLength(0);                       // no asset invented
  });

  it('15b. a broken link can be repaired by unlinking', () => {
    account('acc-A', 'A', 0, { linkedAssetId: 'ast-GONE' });
    expect(S().unlinkAccountFromAsset('acc-A').ok).toBe(true);
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('UNLINKED');
  });

  it('16. linking a missing account or missing asset is rejected', () => {
    account('acc-A', 'A'); asset('ast-X', 'X');
    expect(S().linkAccountToAsset('acc-NOPE', 'ast-X').reason).toBe('ACCOUNT_NOT_FOUND');
    expect(S().linkAccountToAsset('acc-A', 'ast-NOPE').reason).toBe('ASSET_NOT_FOUND');
    expect(asts()).toHaveLength(1);                       // no asset created
  });

  /* ==================== 17-18 legacy migration / no inference =========== */

  it('17. legacy accounts migrate to an explicit null link', () => {
    const legacy = [
      { id: 'acc-1', name: 'A', type: 'Bank' as any, openingBalance: 0 },
      { id: 'acc-2', name: 'B', type: 'Bank' as any, openingBalance: 0, linkedAssetId: 'ast-K' }
    ] as Account[];
    const res = AccountAssetLinkService.migrate(legacy);
    expect(res.normalized).toBe(1);
    expect(res.preserved).toBe(1);
    expect(res.accounts[0].linkedAssetId).toBeNull();
    expect(res.accounts[1].linkedAssetId).toBe('ast-K');
    expect(res.accounts).toHaveLength(2);
  });

  it('18. migration NEVER infers a link from identical names', () => {
    // The exact B5 trap: identical names on both sides.
    const legacy = [{ id: 'acc-1', name: 'HDFC Savings', type: 'Bank' as any, openingBalance: 10000 }] as Account[];
    repo.assetsData = [{ id: 'ast-1', name: 'HDFC Savings', amount: 10000, type: 'Cash & Savings' } as Asset];
    const res = AccountAssetLinkService.migrate(legacy);
    expect(res.accounts[0].linkedAssetId).toBeNull();     // must stay unlinked
  });

  it('18b. migration is idempotent', () => {
    const once = AccountAssetLinkService.migrate([
      { id: 'acc-1', name: 'A', type: 'Bank' as any, openingBalance: 0 }
    ] as Account[]);
    const twice = AccountAssetLinkService.migrate(once.accounts);
    expect(twice.normalized).toBe(0);
    expect(twice.preserved).toBe(1);
    expect(twice.accounts[0].linkedAssetId).toBeNull();
  });

  /* ======================= 19-21 B5 expressibility ====================== */

  it('19. S1 — same names, explicitly linked', () => {
    account('acc-A', 'HDFC Savings', 10000); asset('ast-X', 'HDFC Savings', 10000);
    expect(S().linkAccountToAsset('acc-A', 'ast-X').ok).toBe(true);
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('LINKED');
  });

  it('20. S2 — DIFFERENT names, explicitly linked (the case names cannot express)', () => {
    account('acc-A', 'HDFC Bank', 10000); asset('ast-X', 'HDFC Savings', 10000);
    expect(S().linkAccountToAsset('acc-A', 'ast-X').ok).toBe(true);
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).assetId).toBe('ast-X');
  });

  it('21. S3 — unrelated, explicitly NOT linked, and distinguishable from S2', () => {
    account('acc-A', 'HDFC Bank', 10000); asset('ast-X', 'Cash at home', 10000);
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('UNLINKED');
    // S2 vs S3 are now distinguishable purely by relationship state.
    expect(S().linkAccountToAsset('acc-A', 'ast-X').ok).toBe(true);
    expect(AccountAssetLinkService.statusOf(acc('acc-A'), asts()).state).toBe('LINKED');
  });

  /* ==================== 22 B5 / financial behaviour unchanged =========== */

  describe('22. B5 and financial behaviour are UNCHANGED by this package', () => {
    const liquid = () =>
      EssentialsService.calculateEmergencyFundAnalysis(
        asts() as any, accs() as any, S().transactions as any, [], 6, null
      ).liquidReserves;

    it('same-name dedup still returns the pre-existing value', () => {
      account('acc-A', 'HDFC Savings', 10000); asset('ast-X', 'HDFC Savings', 10000);
      const before = liquid();
      S().linkAccountToAsset('acc-A', 'ast-X');
      expect(liquid()).toBe(before);
      expect(before).toBe(10000);
    });

    it('the different-name pair is now deduplicated via the explicit link (closed by DATA-05b)', () => {
      account('acc-A', 'HDFC Bank', 10000); asset('ast-X', 'HDFC Savings', 10000);
      // Before DATA-05b this asserted the double-count was still present
      // (liquid = 20000) because the link was infrastructure only. DATA-05b
      // consumes the link under Decision F1: the account's derived balance is
      // counted once and the linked asset is suppressed.
      expect(liquid()).toBe(20000);                  // unlinked: both count

      S().linkAccountToAsset('acc-A', 'ast-X');

      expect(liquid()).toBe(10000);                  // linked: counted once
    });

    it('NET_WORTH and TOTAL_ASSETS are unaffected by linking', () => {
      account('acc-A', 'A', 10000); asset('ast-X', 'X', 5000);
      repo.liabilitiesData = [{ name: 'Loan', amount: 1000 } as any];
      repo.syncStore();
      const nw = FinancialQueries.getMetric('NET_WORTH').value;
      const ta = FinancialQueries.getMetric('TOTAL_ASSETS').value;

      S().linkAccountToAsset('acc-A', 'ast-X');

      expect(FinancialQueries.getMetric('NET_WORTH').value).toBe(nw);
      expect(FinancialQueries.getMetric('TOTAL_ASSETS').value).toBe(ta);
      expect(nw).toBe(4000);
    });

    it('AccountBalanceService is unaffected by linking', () => {
      const a = account('acc-A', 'A', 10000); asset('ast-X', 'X', 5000);
      repo.transactionsData = [{
        id: 'tx-1', date: '2026-06-01', dateStr: '01 Jun 2026', title: 'T', narration: 'N',
        account: 'A', accountId: a.id, type: 'Income', direction: 'CREDIT',
        category: 'G', amount: 1000, status: 'CLEARED'
      } as Transaction];
      repo.syncStore();

      const before = AccountBalanceService.balance(a.id, accs(), S().transactions, TODAY)!.balance;
      S().linkAccountToAsset('acc-A', 'ast-X');
      const after = AccountBalanceService.balance(a.id, accs(), S().transactions, TODAY)!.balance;

      expect(after).toBe(before);
      expect(after).toBe(11000);
    });
  });

  /* ==================== 26-29 selector / conflict contract ============== */

  describe('26-29. selector and conflict contract', () => {
    it('26. duplicate-named assets remain individually selectable by id', () => {
      account('acc-A', 'A');
      asset('ast-1', 'HDFC Savings', 10000, { currency: 'INR' } as any);
      asset('ast-2', 'HDFC Savings', 7000, { currency: 'USD' } as any);

      const available = AccountAssetLinkService.availableAssets('acc-A', accs(), asts());
      expect(available).toHaveLength(2);
      expect(new Set(available.map(a => a.id)).size).toBe(2);

      expect(S().linkAccountToAsset('acc-A', 'ast-2').ok).toBe(true);
      expect(acc('acc-A').linkedAssetId).toBe('ast-2');    // the exact one chosen
    });

    it('27. a duplicate-named asset is never auto-selected — an id is required', () => {
      account('acc-A', 'A');
      asset('ast-1', 'HDFC Savings'); asset('ast-2', 'HDFC Savings');
      // There is no name-based link API at all.
      expect((AccountAssetLinkService as any).linkByName).toBeUndefined();
      expect(acc('acc-A').linkedAssetId ?? null).toBeNull();
    });

    it('28. a claimed asset is excluded from another account\'s available list', () => {
      account('acc-A', 'A'); account('acc-B', 'B');
      asset('ast-X', 'X'); asset('ast-Y', 'Y');
      S().linkAccountToAsset('acc-A', 'ast-X');

      const forB = AccountAssetLinkService.availableAssets('acc-B', accs(), asts());
      expect(forB.map(a => a.id)).toEqual(['ast-Y']);

      const forA = AccountAssetLinkService.availableAssets('acc-A', accs(), asts());
      expect(forA.map(a => a.id).sort()).toEqual(['ast-X', 'ast-Y']);   // own link stays visible
    });

    it('29. conflict reports the claiming account by name for the UI', () => {
      account('acc-A', 'Alpha'); account('acc-B', 'Beta'); asset('ast-X', 'X');
      S().linkAccountToAsset('acc-A', 'ast-X');
      const r = S().linkAccountToAsset('acc-B', 'ast-X');
      expect(r.message).toContain('Alpha');
      expect(r.conflictingAccountId).toBe('acc-A');
    });
  });

  /* ==================== 13b link persistence regression ================= */

  describe('13b. link persistence (regression)', () => {
    /**
     * The first implementation updated memory and synced the store but never
     * called saveAll, so a link vanished on reload. jsdom has no indexedDB, so
     * the unit suite could not see it — the real-browser run did. This asserts
     * the persisted payload directly via the node fallback store.
     */
    it('writes the link through to the persistence layer, not just memory', async () => {
      const { IndexedDBStorageService } = await import('../services/IndexedDBStorageService');
      account('acc-A', 'A'); asset('ast-X', 'X');

      S().linkAccountToAsset('acc-A', 'ast-X');
      await new Promise(r => setTimeout(r, 0));          // let the async save settle

      const persisted = await IndexedDBStorageService.loadAll();
      const stored = persisted.accounts.find(a => a.id === 'acc-A');
      expect(stored, 'the account must reach the persistence layer').toBeDefined();
      expect(stored!.linkedAssetId).toBe('ast-X');
    });

    it('persists an unlink as well', async () => {
      const { IndexedDBStorageService } = await import('../services/IndexedDBStorageService');
      account('acc-A', 'A'); asset('ast-X', 'X');
      S().linkAccountToAsset('acc-A', 'ast-X');
      await new Promise(r => setTimeout(r, 0));

      S().unlinkAccountFromAsset('acc-A');
      await new Promise(r => setTimeout(r, 0));

      const persisted = await IndexedDBStorageService.loadAll();
      expect(persisted.accounts.find(a => a.id === 'acc-A')!.linkedAssetId).toBeNull();
    });
  });

  /* ==================== 23-25 upstream regressions ====================== */

  describe('23-25. upstream invariants preserved', () => {
    it('24. DATA-04b transfer direction is untouched', async () => {
      const { TransactionSignService } = await import('../services/TransactionSignService');
      const debit = { type: 'Transfer', amount: 2000, direction: 'DEBIT' } as Transaction;
      expect(TransactionSignService.signedAmount(debit)).toBe(-2000);
    });

    it('25. DATA-04c-1 asset identity is untouched', async () => {
      await repo.assets.add({ name: 'Fresh', amount: 10 });
      expect(AssetIdentityService.isValidId(repo.assetsData[0].id)).toBe(true);
      const id = repo.assetsData[0].id;
      // WP-FB-DATA-07b: id-addressed replace is `update`; `add` always appends.
      await repo.assets.update({ id, name: 'Fresh Renamed', amount: 20 });
      expect(repo.assetsData).toHaveLength(1);
      expect(repo.assetsData[0].id).toBe(id);
    });
  });
});
