import { Account, Asset } from '../domain/types';

/* =============================================================================
 * ACCOUNT ↔ ASSET LINK AUTHORITY (WP-FB-DATA-04c-2)
 *
 * The single write path for the explicit relationship
 *
 *     Account.linkedAssetId  ->  Asset.id
 *
 * Approved cardinality (Decision C): 0..1 Account <-> 0..1 Asset.
 *   - an Account may hold zero or one linked Asset;
 *   - an Asset may be claimed by at most one Account;
 *   - relinking to a different asset requires an explicit unlink first;
 *   - claiming an asset already held by another account is REJECTED.
 *
 * The link is always user-stated. It is never inferred from names, asset type,
 * or fuzzy matching — the coincidental name matching that produced the B5
 * defect must not be resurrected as a migration or a fallback.
 *
 * INFRASTRUCTURE ONLY. Nothing here feeds a financial calculation:
 * EssentialsService, AccountBalanceService and NET_WORTH are untouched.
 * DATA-05b will consume the relationship later.
 * ========================================================================== */

export type LinkFailureReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'ACCOUNT_ALREADY_LINKED'
  | 'ASSET_ALREADY_CLAIMED';

export interface LinkResult {
  ok: boolean;
  /** True when the requested state already held — no write was needed. */
  unchanged?: boolean;
  reason?: LinkFailureReason;
  message?: string;
  /** The account that already claims the asset, for ASSET_ALREADY_CLAIMED. */
  conflictingAccountId?: string;
  conflictingAccountName?: string;
  /** Accounts after the operation. Unmodified when `ok` is false. */
  accounts: Account[];
}

export type LinkState = 'LINKED' | 'UNLINKED' | 'BROKEN';

export interface AccountLinkStatus {
  state: LinkState;
  assetId: string | null;
  asset: Asset | null;
}

export class AccountAssetLinkService {
  /** Normalises absent/empty to null. */
  static linkedIdOf(account: Account): string | null {
    const id = account.linkedAssetId;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
  }

  /** The account currently claiming `assetId`, if any. */
  static accountClaiming(assetId: string, accounts: Account[]): Account | null {
    return accounts.find(a => this.linkedIdOf(a) === assetId) || null;
  }

  /**
   * Link state for an account.
   * `BROKEN` means the account references an asset that no longer exists —
   * reported, never silently cleared and never silently recreated.
   */
  static statusOf(account: Account, assets: Asset[]): AccountLinkStatus {
    const assetId = this.linkedIdOf(account);
    if (!assetId) return { state: 'UNLINKED', assetId: null, asset: null };
    const asset = assets.find(a => a.id === assetId) || null;
    return asset
      ? { state: 'LINKED', assetId, asset }
      : { state: 'BROKEN', assetId, asset: null };
  }

  /** Assets available to be linked by `accountId` (unclaimed, or already its own). */
  static availableAssets(accountId: string, accounts: Account[], assets: Asset[]): Asset[] {
    return assets.filter(asset => {
      if (!asset.id) return false;
      const claimer = this.accountClaiming(asset.id, accounts);
      return !claimer || claimer.id === accountId;
    });
  }

  /**
   * Establishes the link. Pure — returns a new accounts array and never
   * mutates the input.
   *
   * Enforced: account exists; asset exists; the account holds no different
   * asset; the asset is claimed by no other account. Re-linking an identical
   * pair is idempotent. Nothing is ever silently reassigned.
   */
  static link(
    accountId: string,
    assetId: string,
    accounts: Account[],
    assets: Asset[]
  ): LinkResult {
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      return { ok: false, reason: 'ACCOUNT_NOT_FOUND', message: 'Account not found.', accounts };
    }

    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
      return {
        ok: false,
        reason: 'ASSET_NOT_FOUND',
        message: 'Asset not found. An asset is never created automatically to satisfy a link.',
        accounts
      };
    }

    const current = this.linkedIdOf(account);
    if (current === assetId) {
      return { ok: true, unchanged: true, accounts };   // idempotent
    }

    if (current !== null) {
      return {
        ok: false,
        reason: 'ACCOUNT_ALREADY_LINKED',
        message: `"${account.name}" is already linked to another asset. Unlink it first.`,
        accounts
      };
    }

    const claimer = this.accountClaiming(assetId, accounts);
    if (claimer && claimer.id !== accountId) {
      return {
        ok: false,
        reason: 'ASSET_ALREADY_CLAIMED',
        message: `"${asset.name}" is already linked to account "${claimer.name}". Unlink it there first.`,
        conflictingAccountId: claimer.id,
        conflictingAccountName: claimer.name,
        accounts
      };
    }

    return {
      ok: true,
      accounts: accounts.map(a => (a.id === accountId ? { ...a, linkedAssetId: assetId } : a))
    };
  }

  /** Clears the link. Safe and idempotent when no link exists. */
  static unlink(accountId: string, accounts: Account[]): LinkResult {
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      return { ok: false, reason: 'ACCOUNT_NOT_FOUND', message: 'Account not found.', accounts };
    }
    if (this.linkedIdOf(account) === null) {
      return { ok: true, unchanged: true, accounts };
    }
    return {
      ok: true,
      accounts: accounts.map(a => (a.id === accountId ? { ...a, linkedAssetId: null } : a))
    };
  }

  /**
   * Clears any account link pointing at `assetId`. Used when an asset is
   * removed so no account is left holding a dangling reference. The account
   * itself, its transactions and its balance are untouched.
   */
  static clearLinksToAsset(assetId: string, accounts: Account[]): { accounts: Account[]; cleared: number } {
    let cleared = 0;
    const next = accounts.map(a => {
      if (this.linkedIdOf(a) === assetId) {
        cleared++;
        return { ...a, linkedAssetId: null };
      }
      return a;
    });
    return { accounts: next, cleared };
  }

  /**
   * Legacy accounts predate the field. Normalises absent -> null so the
   * "deliberately unlinked" state is explicit.
   *
   * ⚠️ Deliberately does NOT infer any link. Coincidental name equality
   * between an account and an asset is NOT evidence of a relationship — that
   * assumption is precisely the B5 defect. Existing users must state it.
   */
  static migrate(accounts: Account[]): { accounts: Account[]; normalized: number; preserved: number } {
    let normalized = 0;
    let preserved = 0;
    const next = accounts.map(a => {
      if (a.linkedAssetId === undefined) {
        normalized++;
        return { ...a, linkedAssetId: null };
      }
      preserved++;
      return a;
    });
    return { accounts: next, normalized, preserved };
  }
}
