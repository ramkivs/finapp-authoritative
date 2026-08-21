import { Account, Transaction } from '../domain/types';

/* =============================================================================
 * ACCOUNT RESOLUTION (WP-FB-DATA-04)
 *
 * Establishes referential integrity between Transaction and Account.
 *
 *   Account.id            -> authoritative identity
 *   Transaction.accountId -> the reference (nullable = explicitly unmapped)
 *   Transaction.account   -> presentation / legacy display text ONLY
 *
 * Before this work package a transaction referenced its account solely by
 * free-text display name. Import adapters emit fixed bank labels ('SBI Bank',
 * 'ICICI Bank', 'HDFC Bank'), so a registered account named e.g. 'SBI Savings'
 * could receive transactions labelled 'SBI Bank' with no relationship at all,
 * and deleting an account silently orphaned its rows (WP-FB-DATA-03 F-03).
 *
 * Resolution is deterministic and never guesses:
 *   exactly one normalized name match -> MATCHED
 *   more than one match              -> AMBIGUOUS (left unmapped)
 *   no match                         -> UNMAPPED
 * ========================================================================== */

export type AccountResolutionStatus = 'MATCHED' | 'AMBIGUOUS' | 'UNMAPPED';

export interface AccountResolution {
  status: AccountResolutionStatus;
  accountId: string | null;
  /** All accounts whose normalized name equals the requested one. */
  candidates: Account[];
  normalized: string;
}

export interface MigrationReportRow {
  accountLabel: string;
  normalized: string;
  status: AccountResolutionStatus;
  accountId: string | null;
  transactionCount: number;
  candidateNames: string[];
}

export interface MigrationResult {
  transactions: Transaction[];
  matched: number;
  ambiguous: number;
  unmapped: number;
  alreadyResolved: number;
  rows: MigrationReportRow[];
}

export class AccountResolutionService {
  /**
   * Canonical comparison form for an account display name.
   * Trims, collapses internal whitespace, lowercases. Purely for matching —
   * the stored display text is never rewritten.
   */
  static normalizeName(name: string | null | undefined): string {
    if (!name) return '';
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** Resolves a display name against the registered account list. */
  static resolve(name: string | null | undefined, accounts: Account[]): AccountResolution {
    const normalized = this.normalizeName(name);
    if (!normalized) {
      return { status: 'UNMAPPED', accountId: null, candidates: [], normalized };
    }

    const candidates = accounts.filter(a => this.normalizeName(a.name) === normalized);

    if (candidates.length === 1) {
      return { status: 'MATCHED', accountId: candidates[0].id, candidates, normalized };
    }
    if (candidates.length > 1) {
      // Never attach to an arbitrary account.
      return { status: 'AMBIGUOUS', accountId: null, candidates, normalized };
    }
    return { status: 'UNMAPPED', accountId: null, candidates: [], normalized };
  }

  /** Convenience: the resolved id, or null when not deterministically resolvable. */
  static resolveId(name: string | null | undefined, accounts: Account[]): string | null {
    return this.resolve(name, accounts).accountId;
  }

  /**
   * Backfills `accountId` on existing transactions.
   *
   * Guarantees:
   *  - every transaction is preserved (never dropped, never merged);
   *  - `id`, `date`, `amount`, `type`, `narration`, `account` and `fingerprint`
   *    are left byte-identical — only `accountId` is added;
   *  - a transaction that already carries a valid accountId is left untouched;
   *  - unresolvable rows are explicitly set to `accountId: null`, not guessed.
   */
  static migrate(transactions: Transaction[], accounts: Account[]): MigrationResult {
    const validIds = new Set(accounts.map(a => a.id));
    const perLabel = new Map<string, MigrationReportRow>();

    let matched = 0;
    let ambiguous = 0;
    let unmapped = 0;
    let alreadyResolved = 0;

    const migrated = transactions.map(tx => {
      // Respect an existing, still-valid reference.
      if (tx.accountId && validIds.has(tx.accountId)) {
        alreadyResolved++;
        return tx;
      }

      const res = this.resolve(tx.account, accounts);
      const key = res.normalized || '(blank)';
      const row = perLabel.get(key) ?? {
        accountLabel: tx.account ?? '',
        normalized: key,
        status: res.status,
        accountId: res.accountId,
        transactionCount: 0,
        candidateNames: res.candidates.map(c => c.name)
      };
      row.transactionCount++;
      perLabel.set(key, row);

      if (res.status === 'MATCHED') matched++;
      else if (res.status === 'AMBIGUOUS') ambiguous++;
      else unmapped++;

      // Only accountId is introduced; every other field is carried through as-is.
      return { ...tx, accountId: res.accountId };
    });

    return {
      transactions: migrated,
      matched,
      ambiguous,
      unmapped,
      alreadyResolved,
      rows: [...perLabel.values()]
    };
  }

  /** Display name for a transaction, preferring the resolved Account entity. */
  static displayName(tx: Transaction, accounts: Account[]): string {
    if (tx.accountId) {
      const acc = accounts.find(a => a.id === tx.accountId);
      if (acc) return acc.name;
    }
    return tx.account || 'Unassigned';
  }

  /** True when a transaction carries no valid account reference. */
  static isUnmapped(tx: Transaction, accounts: Account[]): boolean {
    if (!tx.accountId) return true;
    return !accounts.some(a => a.id === tx.accountId);
  }
}
