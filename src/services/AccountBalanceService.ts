import { Account, Transaction } from '../domain/types';
import { LedgerExclusionService } from './LedgerExclusionService';
import { TransactionSignService } from './TransactionSignService';
import { getEffectiveAsOfDate } from './DateRangeService';

/* =============================================================================
 * CANONICAL ACCOUNT BALANCE AUTHORITY (WP-FB-DATA-05a)
 *
 * The single place that derives an account balance from the canonical
 * transaction collection. No page, component or other service may duplicate
 * this arithmetic.
 *
 *   balance(accountId, asOf) =
 *       account.openingBalance
 *     + Σ TransactionSignService.signedAmount(t)
 *       where t.accountId === account.id       (DATA-04 referential identity)
 *         and t.date  >  account.asOfDate      (anchor: see below)
 *         and t.date <=  asOf
 *
 * ANCHOR (Decision B4). `openingBalance` is the balance that was true ON
 * `asOfDate`. Transactions on or before that date are ALREADY represented by
 * the opening balance and must not be added again. An account whose anchor is
 * absent is reported via `anchorMissing` rather than silently guessed.
 *
 * IDENTITY (DATA-04). Matching is on `accountId` only. The legacy
 * `transaction.account` display string is never used for balance arithmetic.
 *
 * SIGN (DATA-04b). Delegated entirely to TransactionSignService. A transaction
 * whose direction cannot be determined contributes 0 and is reported, never
 * guessed.
 *
 * UNMAPPED (Decision B). `accountId === null` contributes to NO registered
 * account balance and is never folded into a pseudo-account. Such activity is
 * surfaced separately via `reconciliation()`.
 *
 * NET_WORTH (Decision A). Deliberately untouched. Nothing here feeds the
 * net-worth formula; account cash remains outside it.
 * ========================================================================== */

/** Sentinel used when an account carries no explicit anchor date. */
const NO_ANCHOR = '0000-00-00';

export interface AccountBalance {
  accountId: string;
  name: string;
  type: string;
  openingBalance: number;
  /** Net signed movement applied after the anchor, through asOf. */
  movement: number;
  /** openingBalance + movement */
  balance: number;
  transactionCount: number;
  /** True when the account has no explicit opening-balance anchor date. */
  anchorMissing: boolean;
  /** Transactions attributed to this account whose sign could not be resolved. */
  undeterminedCount: number;
  asOf: string;
}

export interface ReconciliationSummary {
  /** Transactions with no registered account, dated <= asOf. */
  unmappedCount: number;
  /** Net signed value of those transactions (informational, not spendable). */
  unmappedNet: number;
  /** Gross magnitude, useful for "activity" phrasing. */
  unmappedGross: number;
  /** Transactions whose direction could not be determined. */
  undeterminedCount: number;
  asOf: string;
}

export class AccountBalanceService {
  /** Transactions that qualify for a given account's balance at `asOf`. */
  private static qualifying(
    account: Account,
    transactions: Transaction[],
    asOf: string
  ): Transaction[] {
    const anchor = account.asOfDate || NO_ANCHOR;
    return transactions.filter(
      t =>
        // WP-FB-DATA-06c-1: a row excluded from derived financial surfaces
        // never contributes to a balance. This is the balance authority, so
        // this is the single most important place the filter must appear.
        !LedgerExclusionService.isExcluded(t) &&
        !!t.accountId &&
        t.accountId === account.id &&
        t.date > anchor &&   // on/before the anchor is already inside openingBalance
        t.date <= asOf       // future relative to asOf is excluded
    );
  }

  /**
   * Derived balance for one account. Returns null when the account is not
   * registered — an unknown accountId never produces a balance, and is never
   * resolved by name.
   */
  static balance(
    accountId: string,
    accounts: Account[],
    transactions: Transaction[],
    asOf: string = getEffectiveAsOfDate()
  ): AccountBalance | null {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return null;

    const rows = this.qualifying(account, transactions, asOf);
    const movement = rows.reduce((sum, t) => sum + TransactionSignService.signedAmount(t), 0);
    const opening = Number(account.openingBalance) || 0;

    return {
      accountId: account.id,
      name: account.name,
      type: String(account.type),
      openingBalance: opening,
      movement,
      balance: opening + movement,
      transactionCount: rows.length,
      anchorMissing: !account.asOfDate,
      undeterminedCount: rows.filter(t => TransactionSignService.isDirectionUndetermined(t)).length,
      asOf
    };
  }

  /** Derived balances for every registered account. */
  static balances(
    accounts: Account[],
    transactions: Transaction[],
    asOf: string = getEffectiveAsOfDate()
  ): AccountBalance[] {
    return accounts
      .map(a => this.balance(a.id, accounts, transactions, asOf))
      .filter((b): b is AccountBalance => b !== null);
  }

  /** Sum of all registered account balances. */
  static total(
    accounts: Account[],
    transactions: Transaction[],
    asOf: string = getEffectiveAsOfDate()
  ): number {
    return this.balances(accounts, transactions, asOf).reduce((s, b) => s + b.balance, 0);
  }

  /** Sum of derived balances grouped by account type. */
  static totalsByType(
    accounts: Account[],
    transactions: Transaction[],
    asOf: string = getEffectiveAsOfDate()
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of this.balances(accounts, transactions, asOf)) {
      out[b.type] = (out[b.type] || 0) + b.balance;
    }
    return out;
  }

  /** Sum of derived balances for a set of account types. */
  static totalForTypes(
    types: string[],
    accounts: Account[],
    transactions: Transaction[],
    asOf: string = getEffectiveAsOfDate()
  ): number {
    const wanted = new Set(types);
    return this.balances(accounts, transactions, asOf)
      .filter(b => wanted.has(b.type))
      .reduce((s, b) => s + b.balance, 0);
  }

  /**
   * Activity that is NOT represented in any registered account balance.
   * Decision B: excluded from balances, never hidden, never pseudo-accounted.
   */
  static reconciliation(
    accounts: Account[],
    transactions: Transaction[],
    asOf: string = getEffectiveAsOfDate()
  ): ReconciliationSummary {
    const validIds = new Set(accounts.map(a => a.id));
    const unmapped = transactions.filter(
      t => t.date <= asOf && (!t.accountId || !validIds.has(t.accountId))
    );

    return {
      unmappedCount: unmapped.length,
      unmappedNet: unmapped.reduce((s, t) => s + TransactionSignService.signedAmount(t), 0),
      unmappedGross: unmapped.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0),
      undeterminedCount: transactions.filter(
        t => t.date <= asOf && TransactionSignService.isDirectionUndetermined(t)
      ).length,
      asOf
    };
  }
}
