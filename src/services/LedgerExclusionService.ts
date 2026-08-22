import { Transaction, LedgerExclusionReason } from '../domain/types';

/* =============================================================================
 * LEDGER EXCLUSION (WP-FB-DATA-06c-1)
 *
 * The single authority on one question:
 *
 *     Does this transaction contribute to derived financial figures?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXCLUDED IS NOT HIDDEN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DATA-02 established: "records exist but are filtered — never silently
 * hidden." Decision 13-b applied that to import rollback: rolled-back rows are
 * RETAINED, MARKED, EXCLUDED FROM BALANCES AND REPORTS, and REMAIN VISIBLE in
 * the Ledger with an explicit disclosure.
 *
 * So this service draws a line that did not previously exist in the codebase:
 *
 *     DERIVATION surfaces  -> must call forDerivation()   (money)
 *     DISPLAY surfaces     -> must NOT filter             (truth)
 *
 * Getting this backwards in either direction is a defect. Filtering the Ledger
 * would silently hide a financial record. Not filtering a balance would count
 * money the user has withdrawn.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT `status`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The WP-FB-DATA-06c discovery gate measured overloading `TransactionStatus`
 * with a `VOID` value and found it splits the application in half:
 *
 *     EXCLUDED it      : 5 dividend consumers (they filter status === 'CLEARED')
 *     STILL COUNTED it : AccountBalanceService, LiquidReserves, the Ledger,
 *                        findManySync
 *
 * A ₹5,000 row would vanish from dividend income while remaining in the account
 * balance. A dedicated field plus an explicit filter at every derivation site is
 * the only coherent option, and that is what this service provides.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE — WP-FB-DATA-06c-1 IS GROUNDWORK ONLY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing in this package WRITES `excludedAt`. There is no rollback, delete,
 * amendment, supersession, reversal or undo capability, and none is implied.
 * This is the read-side semantics that WP-FB-DATA-06c-6 will later need.
 * ========================================================================== */

/** Reported for an exclusion whose reason this build does not recognise. */
export type ResolvedExclusionReason = LedgerExclusionReason | 'UNKNOWN';

/** Every reason this build understands. Grows only as decisions are resolved. */
export const KNOWN_EXCLUSION_REASONS: readonly LedgerExclusionReason[] = ['IMPORT_ROLLBACK'] as const;

export interface ExclusionSummary {
  id: string;
  reason: ResolvedExclusionReason;
  excludedAt: string;
  amount: number;
  narration: string;
  message: string;
}

export class LedgerExclusionService {
  /**
   * Is this row excluded from derived financial figures?
   *
   * Keyed on the PRESENCE of `excludedAt`, not on the reason. A row written by
   * a future build with a reason this one does not recognise is still excluded
   * — the conservative direction. Treating an unrecognised reason as "live"
   * would let money this build does not understand back into a balance.
   */
  static isExcluded(tx: Transaction): boolean {
    return typeof tx.excludedAt === 'string' && tx.excludedAt.length > 0;
  }

  /**
   * Reason, never guessed. An exclusion with an unrecognised or missing reason
   * reports `'UNKNOWN'` rather than being assigned one — the same discipline
   * `TransactionIdentityService.originOf` applies to provenance.
   */
  static reasonOf(tx: Transaction): ResolvedExclusionReason | null {
    if (!this.isExcluded(tx)) return null;
    const r = tx.excludedReason as LedgerExclusionReason | undefined;
    return r && KNOWN_EXCLUSION_REASONS.includes(r) ? r : 'UNKNOWN';
  }

  /**
   * THE FILTER EVERY DERIVED FINANCIAL SURFACE MUST APPLY.
   *
   * Balances, reserves, dividend metrics, insights, essential-expense
   * derivation — anything that turns rows into a number.
   */
  static forDerivation(txs: Transaction[]): Transaction[] {
    return txs.filter(t => !this.isExcluded(t));
  }

  /** The excluded rows, for disclosure surfaces. */
  static excluded(txs: Transaction[]): Transaction[] {
    return txs.filter(t => this.isExcluded(t));
  }

  /** Count, for a badge or notice. */
  static excludedCount(txs: Transaction[]): number {
    return this.excluded(txs).length;
  }

  /** Structured detail for a reconciliation/disclosure surface. */
  static summarise(txs: Transaction[]): ExclusionSummary[] {
    return this.excluded(txs).map(t => ({
      id: t.id,
      reason: this.reasonOf(t) as ResolvedExclusionReason,
      excludedAt: t.excludedAt as string,
      amount: t.amount,
      narration: t.narration,
      message: this.describe(t)
    }));
  }

  /** Human-readable one-liner. */
  static describe(tx: Transaction): string {
    const reason = this.reasonOf(tx);
    const label = reason === 'IMPORT_ROLLBACK'
      ? 'rolled back with its import batch'
      : 'excluded for an unrecognised reason';
    return `${tx.narration} (₹${tx.amount}) — ${label}; still recorded, not counted`;
  }
}
