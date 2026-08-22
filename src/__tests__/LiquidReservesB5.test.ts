/**
 * WP-FB-DATA-05b — B5 closed: liquid reserves from derived balances + the
 * explicit Account↔Asset link.
 *
 * Approved decisions under test:
 *   F1 — a linked pair counts ONCE using the account's DERIVED balance; the
 *        linked asset is suppressed. NET_WORTH is deliberately NOT reconciled.
 *   G3 — link-based dedup, but a same-name unlinked undismissed pair is HELD
 *        (preserving the pre-05b figure) and reported for explicit resolution.
 *        A name is a candidate signal only; it never writes a relationship.
 *   H(a) — a link never overrides account-type classification.
 *   H(b) — a link to a non-liquid asset suppresses nothing.
 *   H(c) — a broken link still counts the account and is reported.
 *   I  — one liquid definition shared with WealthIntelligenceService.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LiquidReservesService } from '../services/LiquidReservesService';
import { EssentialsService } from '../services/EssentialsService';
import { WealthIntelligenceService } from '../services/WealthIntelligenceService';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { FinancialQueries } from '../application/queries';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Account, Asset, Transaction } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState();
const TODAY = '2026-08-21';

function reset() {
  repo.transactionsData = []; repo.accountsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.syncStore();
}
function account(id: string, name: string, ob: number, type = 'Bank', extra: Partial<Account> = {}): Account {
  const a = { id, name, type, openingBalance: ob, asOfDate: '2026-01-01', ...extra } as Account;
  repo.accountsData = [...repo.accountsData, a]; repo.syncStore(); return a;
}
function asset(id: string, name: string, amount: number, type = 'Cash & Savings'): Asset {
  const a = { id, name, amount, type } as Asset;
  repo.assetsData = [...repo.assetsData, a]; repo.syncStore(); return a;
}
function tx(accountId: string, amount: number, dir: 'CREDIT' | 'DEBIT', date = '2026-06-01') {
  repo.transactionsData = [...repo.transactionsData, {
    id: `tx-${Math.random()}`, date, dateStr: date, title: 'T', narration: 'N',
    account: 'legacy', accountId, type: dir === 'CREDIT' ? 'Income' : 'Expense',
    direction: dir, category: 'G', amount, status: 'CLEARED'
  } as Transaction];
  repo.syncStore();
}
const liquid = () => LiquidReservesService.total(S().assets, S().accounts, S().transactions, TODAY);
const breakdown = () => LiquidReservesService.compute(S().assets, S().accounts, S().transactions, TODAY);
const essentials = () =>
  EssentialsService.calculateEmergencyFundAnalysis(S().assets as any, S().accounts as any, S().transactions as any, [], 6, null);

describe('WP-FB-DATA-05b — B5 liquid reserves', () => {
  beforeEach(() => { reset(); setAsOfDateOverride(TODAY); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* ========================= derived balances ========================== */

  describe('accounts contribute DERIVED balances, not openingBalance', () => {
    it('includes transactions after the anchor', () => {
      const a = account('acc-A', 'Alpha', 10000);
      tx(a.id, 3000, 'CREDIT'); tx(a.id, 500, 'DEBIT');
      expect(liquid()).toBe(12500);                       // not 10000
    });

    it('excludes unmapped transactions (Decision B)', () => {
      account('acc-A', 'Alpha', 10000);
      repo.transactionsData = [{
        id: 'u', date: '2026-06-01', dateStr: 'x', title: 'T', narration: 'N',
        account: 'Nowhere', accountId: null, type: 'Income', direction: 'CREDIT',
        category: 'G', amount: 9999, status: 'CLEARED'
      } as Transaction];
      repo.syncStore();
      expect(liquid()).toBe(10000);
    });

    it('excludes transactions on or before the opening anchor (Decision B4)', () => {
      const a = account('acc-A', 'Alpha', 10000);
      tx(a.id, 500, 'CREDIT', '2025-12-31');
      tx(a.id, 500, 'CREDIT', '2026-01-01');
      expect(liquid()).toBe(10000);
    });
  });

  /* ============================== F1 =================================== */

  describe('F1 — linked pair counts once, account balance wins', () => {
    it('suppresses the linked asset and uses the live derived balance', () => {
      const a = account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      tx(a.id, 3000, 'CREDIT'); tx(a.id, 500, 'DEBIT');

      expect(liquid()).toBe(22500);                       // unlinked: both count
      S().linkAccountToAsset('acc-A', 'ast-X');

      const b = breakdown();
      expect(b.total).toBe(12500);                        // account balance wins
      expect(b.accountsTotal).toBe(12500);
      expect(b.assetsTotal).toBe(0);
      expect(b.suppressedByLink).toBe(10000);
    });

    it('S1 — same names, explicitly linked, counted once', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      S().linkAccountToAsset('acc-A', 'ast-X');
      expect(liquid()).toBe(10000);
    });

    it('S2 — DIFFERENT names, explicitly linked, counted once (B5 closed)', () => {
      account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      expect(liquid()).toBe(20000);                       // the original defect
      S().linkAccountToAsset('acc-A', 'ast-X');
      expect(liquid()).toBe(10000);                       // fixed
    });

    it('S3 — genuinely unrelated, unlinked, both count', () => {
      account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'Cash at home', 10000);
      expect(liquid()).toBe(20000);                       // correct, not a defect
      expect(breakdown().candidates).toHaveLength(0);
    });

    it('S2 and S3 are now distinguishable', () => {
      account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      asset('ast-Y', 'Cash at home', 10000);
      S().linkAccountToAsset('acc-A', 'ast-X');
      // linked asset suppressed, unrelated asset still counted
      expect(liquid()).toBe(20000);                       // 10000 account + 10000 unrelated
      expect(breakdown().suppressedByLink).toBe(10000);
    });
  });

  /* ============================== G3 =================================== */

  describe('G3 — same-name candidate is HELD and reported, never inferred', () => {
    it('preserves the pre-05b figure until the user decides', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);

      const b = breakdown();
      expect(b.total).toBe(10000);                        // unchanged from before 05b
      expect(b.heldPendingConfirmation).toBe(10000);
      expect(b.candidates).toHaveLength(1);
      expect(b.candidates[0]).toMatchObject({
        accountId: 'acc-A', assetId: 'ast-X', accountName: 'HDFC Savings', assetName: 'HDFC Savings'
      });
    });

    it('never writes a link from a name', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      breakdown();
      expect(S().accounts[0].linkedAssetId ?? null).toBeNull();
    });

    it('matches on normalised name (case/whitespace)', () => {
      account('acc-A', '  hdfc   savings ', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      expect(breakdown().candidates).toHaveLength(1);
    });

    it('confirming the link resolves the candidate and keeps the total stable', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      expect(liquid()).toBe(10000);

      S().linkAccountToAsset('acc-A', 'ast-X');

      const b = breakdown();
      expect(b.candidates).toHaveLength(0);
      expect(b.total).toBe(10000);                        // no jump
      expect(b.suppressedByLink).toBe(10000);
    });

    it('dismissing records "not the same money" and BOTH then count', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      expect(liquid()).toBe(10000);

      const r = S().dismissAssetCandidate('acc-A', 'ast-X');
      expect(r.ok).toBe(true);

      const b = breakdown();
      expect(b.candidates).toHaveLength(0);
      expect(b.heldPendingConfirmation).toBe(0);
      expect(b.total).toBe(20000);                        // user said they differ
      expect(S().accounts[0].linkedAssetId ?? null).toBeNull();   // no link written
    });

    it('dismissal is persisted and never re-prompts', async () => {
      const { IndexedDBStorageService } = await import('../services/IndexedDBStorageService');
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      S().dismissAssetCandidate('acc-A', 'ast-X');
      await new Promise(r => setTimeout(r, 0));

      const persisted = await IndexedDBStorageService.loadAll();
      expect(persisted.accounts[0].dismissedAssetCandidateIds).toContain('ast-X');
      expect(breakdown().candidates).toHaveLength(0);
    });

    it('dismissal is idempotent', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      S().dismissAssetCandidate('acc-A', 'ast-X');
      const second = S().dismissAssetCandidate('acc-A', 'ast-X');
      expect(second.unchanged).toBe(true);
      expect(S().accounts[0].dismissedAssetCandidateIds).toEqual(['ast-X']);
    });

    it('an account already linked elsewhere is not offered as a candidate', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      asset('ast-Y', 'Other', 500);
      S().linkAccountToAsset('acc-A', 'ast-Y');
      expect(breakdown().candidates).toHaveLength(0);
    });
  });

  /* ============================ H(a)(b)(c) ============================= */

  describe('H — edge-case rules', () => {
    it('H(a) a Broker account stays non-liquid and its linked asset still counts', () => {
      account('acc-A', 'Zerodha', 5000, 'Broker');
      asset('ast-X', 'Brokerage cash', 5000);
      S().linkAccountToAsset('acc-A', 'ast-X');

      const b = breakdown();
      expect(b.accountsTotal).toBe(0);                    // type filter unchanged
      expect(b.assetsTotal).toBe(5000);                   // money not lost
      expect(b.suppressedByLink).toBe(0);
      expect(b.total).toBe(5000);
    });

    it('H(b) linking a liquid account to a non-liquid asset suppresses nothing', () => {
      account('acc-A', 'HDFC', 10000);
      asset('ast-X', 'Shares', 5000, 'Equity');
      S().linkAccountToAsset('acc-A', 'ast-X');

      const b = breakdown();
      expect(b.accountsTotal).toBe(10000);
      expect(b.assetsTotal).toBe(0);                      // Equity was never liquid
      expect(b.total).toBe(10000);
    });

    it('H(c) a broken link still counts the account and is reported', () => {
      account('acc-A', 'HDFC', 10000, 'Bank', { linkedAssetId: 'ast-GONE' });
      const b = breakdown();
      expect(b.total).toBe(10000);                        // money never silently removed
      expect(b.brokenLinks).toHaveLength(1);
      expect(b.brokenLinks[0]).toMatchObject({ accountId: 'acc-A', missingAssetId: 'ast-GONE' });
    });

    it('non-bank Cash & Savings instruments keep counting', () => {
      asset('ast-1', 'Cash in wallet', 5000);
      asset('ast-2', 'FD 5yr', 20000);
      expect(liquid()).toBe(25000);
    });
  });

  /* =============================== I =================================== */

  describe('I — one liquid definition across the product', () => {
    it('WealthIntelligenceService uses the same figure as Essentials', () => {
      const a = account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'Cash at home', 3000);
      tx(a.id, 2000, 'CREDIT');

      const health = WealthIntelligenceService.getHealthSummary(
        S().assets as any, [], [], S().accounts as any, S().transactions as any
      );
      expect(health.liquidReserve).toBe(liquid());
      expect(health.liquidReserve).toBe(15000);            // 12000 account + 3000 asset
    });

    it('the shared figure honours the link', () => {
      account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      S().linkAccountToAsset('acc-A', 'ast-X');
      const health = WealthIntelligenceService.getHealthSummary(
        S().assets as any, [], [], S().accounts as any, S().transactions as any
      );
      expect(health.liquidReserve).toBe(10000);
    });
  });

  /* ==================== Essentials surface + runway ==================== */

  describe('Essentials consumes the authority and exposes reconciliation', () => {
    it('runway is computed from the derived, deduplicated reserve', () => {
      const a = account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      S().linkAccountToAsset('acc-A', 'ast-X');
      tx(a.id, 2000, 'CREDIT');

      const em = EssentialsService.calculateEmergencyFundAnalysis(
        S().assets as any, S().accounts as any, S().transactions as any, [], 6,
        { monthlyExpenses: 4000 } as any
      );
      expect(em.liquidReserves).toBe(12000);
      expect(em.runwayMonths).toBe(3);
    });

    it('exposes candidates and broken links to the UI', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      account('acc-B', 'Broken', 1000, 'Bank', { linkedAssetId: 'ast-GONE' });

      const em = essentials();
      expect(em.linkCandidates).toHaveLength(1);
      expect(em.brokenLinks).toHaveLength(1);
      expect(em.heldPendingConfirmation).toBe(10000);
    });
  });

  /* ======================= NET_WORTH untouched ========================= */

  describe('NET_WORTH is NOT reconciled (Decision A stands)', () => {
    it('the F1 divergence is accepted and explicit', () => {
      const a = account('acc-A', 'HDFC Bank', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      S().linkAccountToAsset('acc-A', 'ast-X');
      tx(a.id, 2500, 'CREDIT');

      expect(liquid()).toBe(12500);                                  // live
      expect(FinancialQueries.getMetric('NET_WORTH').value).toBe(10000);   // asset.amount
      expect(FinancialQueries.getMetric('TOTAL_ASSETS').value).toBe(10000);
    });

    it('linking and dismissing never move NET_WORTH', () => {
      account('acc-A', 'HDFC Savings', 10000);
      asset('ast-X', 'HDFC Savings', 10000);
      const nw = FinancialQueries.getMetric('NET_WORTH').value;
      S().dismissAssetCandidate('acc-A', 'ast-X');
      expect(FinancialQueries.getMetric('NET_WORTH').value).toBe(nw);
    });
  });

  /* ========================== regressions ============================== */

  describe('upstream invariants preserved', () => {
    it('AccountBalanceService is unchanged', () => {
      const a = account('acc-A', 'A', 10000);
      tx(a.id, 1000, 'CREDIT');
      expect(AccountBalanceService.balance(a.id, S().accounts, S().transactions, TODAY)!.balance).toBe(11000);
    });

    it('an empty registry yields zero and no noise', () => {
      const b = breakdown();
      expect(b.total).toBe(0);
      expect(b.candidates).toHaveLength(0);
      expect(b.brokenLinks).toHaveLength(0);
    });
  });
});
