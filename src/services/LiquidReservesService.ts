import { Account, Asset, Transaction } from '../domain/types';
import { AccountBalanceService } from './AccountBalanceService';
import { AccountAssetLinkService } from './AccountAssetLinkService';
import { getEffectiveAsOfDate } from './DateRangeService';

/* =============================================================================
 * LIQUID RESERVES AUTHORITY (WP-FB-DATA-05b) — closes B5
 *
 * ONE definition of "liquid", consumed by EssentialsService (emergency fund /
 * runway) and WealthIntelligenceService (liquidity ratio). Decision I: the
 * product must not carry two independent notions of liquidity.
 *
 * ---------------------------------------------------------------------------
 * APPROVED SEMANTICS
 *
 * F1 — a linked pair is counted ONCE, using the ACCOUNT's transaction-derived
 *      balance. DATA-05a made the derived balance authoritative for accounts;
 *      the asset's manually-entered amount is a static figure and must not
 *      override a live one. The linked asset is therefore suppressed here.
 *      Accepted trade-off: NET_WORTH still uses `asset.amount` (Decision A),
 *      so the same money may read differently in liquidity vs net worth. This
 *      package deliberately does NOT broaden NET_WORTH to reconcile that.
 *
 * G3 — deduplication is link-based, but an existing coincidental name match
 *      must not silently double a user's runway. A same-name, unlinked,
 *      undismissed pair is a CANDIDATE: the asset is held back exactly as the
 *      old name-based guard did, and the pair is reported so the UI can ask.
 *
 *      This hold is a DISPLAY DECISION PENDING USER CONFIRMATION — never an
 *      inferred relationship. No `linkedAssetId` is ever written from a name.
 *      Confirming writes a real link; dismissing records the pair as distinct
 *      and both sides then count.
 *
 * H(a) — a link never overrides account-type classification. A Broker account
 *        stays non-liquid, and because it never contributes, its linked asset
 *        is NOT suppressed (suppressing it would make the money disappear).
 * H(b) — a link to a non-liquid asset suppresses nothing: the asset was never
 *        in the liquid pool and the account keeps counting.
 * H(c) — a BROKEN link (asset deleted) still counts the account and is
 *        reported for reconciliation. Money is never silently removed.
 * ========================================================================== */

/** Account types that participate in liquidity. */
export const LIQUID_ACCOUNT_TYPES = ['Bank', 'Cash', 'Wallet'] as const;

export interface LinkCandidate {
  accountId: string;
  accountName: string;
  assetId: string;
  assetName: string;
  accountBalance: number;
  assetAmount: number;
}

export interface BrokenLinkReport {
  accountId: string;
  accountName: string;
  missingAssetId: string;
}

export interface LiquidReservesBreakdown {
  /** Authoritative total. */
  total: number;
  /** Derived balances of liquid-type accounts. */
  accountsTotal: number;
  /** Cash & Savings assets that were not suppressed. */
  assetsTotal: number;
  /** Assets suppressed because an explicit link already counted the account. */
  suppressedByLink: number;
  /** Assets held back pending user confirmation (G3). */
  heldPendingConfirmation: number;
  /** Same-name unlinked undismissed pairs awaiting an explicit decision. */
  candidates: LinkCandidate[];
  /** Accounts referencing an asset that no longer exists (H(c)). */
  brokenLinks: BrokenLinkReport[];
  asOf: string;
}

export class LiquidReservesService {
  private static isLiquidAccount(account: Account): boolean {
    return (LIQUID_ACCOUNT_TYPES as readonly string[]).includes(String(account.type));
  }

  private static normalize(name: string | null | undefined): string {
    if (!name) return '';
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private static isDismissed(account: Account, assetId: string): boolean {
    const list = account.dismissedAssetCandidateIds;
    return Array.isArray(list) && list.includes(assetId);
  }

  /**
   * The single liquid-reserves computation.
   *
   * Accounts contribute their DERIVED balance (DATA-05a), which already
   * excludes unmapped transactions (Decision B) and anything on or before the
   * opening-balance anchor (Decision B4).
   */
  static compute(
    assets: Asset[] = [],
    accounts: Account[] = [],
    transactions: Transaction[] = [],
    asOf: string = getEffectiveAsOfDate()
  ): LiquidReservesBreakdown {
    const liquidAccounts = accounts.filter(a => this.isLiquidAccount(a));

    // --- accounts: derived balances, never openingBalance -------------------
    let accountsTotal = 0;
    for (const account of liquidAccounts) {
      const derived = AccountBalanceService.balance(account.id, accounts, transactions, asOf);
      accountsTotal += derived ? derived.balance : 0;
    }

    // --- H(c) broken links --------------------------------------------------
    const brokenLinks: BrokenLinkReport[] = [];
    for (const account of accounts) {
      if (AccountAssetLinkService.statusOf(account, assets).state === 'BROKEN') {
        brokenLinks.push({
          accountId: account.id,
          accountName: account.name,
          missingAssetId: AccountAssetLinkService.linkedIdOf(account) as string
        });
      }
    }

    // --- assets: suppress only where the money is already counted -----------
    const cashAssets = assets.filter(a => a.type === 'Cash & Savings');

    // F1/H(a): an asset is suppressed only when a LIQUID account links it, since
    // only then has its value already been counted via the derived balance.
    const suppressingAccountByAssetId = new Map<string, Account>();
    for (const account of liquidAccounts) {
      const linkedId = AccountAssetLinkService.linkedIdOf(account);
      if (linkedId) suppressingAccountByAssetId.set(linkedId, account);
    }

    let assetsTotal = 0;
    let suppressedByLink = 0;
    let heldPendingConfirmation = 0;
    const candidates: LinkCandidate[] = [];

    for (const asset of cashAssets) {
      const assetId = asset.id;

      // F1 — explicit link to a liquid account: already counted.
      if (assetId && suppressingAccountByAssetId.has(assetId)) {
        suppressedByLink += asset.amount;
        continue;
      }

      // G3 — same-name, unlinked, undismissed candidate: hold and report.
      const normalized = this.normalize(asset.name);
      const candidateAccount = normalized
        ? liquidAccounts.find(acc =>
            this.normalize(acc.name) === normalized &&
            AccountAssetLinkService.linkedIdOf(acc) === null &&
            !!assetId &&
            !this.isDismissed(acc, assetId)
          )
        : undefined;

      if (candidateAccount && assetId) {
        const derived = AccountBalanceService.balance(candidateAccount.id, accounts, transactions, asOf);
        candidates.push({
          accountId: candidateAccount.id,
          accountName: candidateAccount.name,
          assetId,
          assetName: asset.name,
          accountBalance: derived ? derived.balance : 0,
          assetAmount: asset.amount
        });
        heldPendingConfirmation += asset.amount;
        continue;                       // held back: preserves pre-05b behaviour
      }

      assetsTotal += asset.amount;
    }

    return {
      total: accountsTotal + assetsTotal,
      accountsTotal,
      assetsTotal,
      suppressedByLink,
      heldPendingConfirmation,
      candidates,
      brokenLinks,
      asOf
    };
  }

  /** Convenience for callers that only need the number. */
  static total(
    assets: Asset[] = [],
    accounts: Account[] = [],
    transactions: Transaction[] = [],
    asOf: string = getEffectiveAsOfDate()
  ): number {
    return this.compute(assets, accounts, transactions, asOf).total;
  }
}
