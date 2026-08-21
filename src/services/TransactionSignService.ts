import { Transaction, TransactionDirection } from '../domain/types';

/* =============================================================================
 * TRANSACTION SIGN AUTHORITY (WP-FB-DATA-04b)
 *
 * Single place that decides how a transaction contributes to an account
 * balance. `amount` is always a positive magnitude; the sign comes from
 * `direction`, falling back to `type` when direction is absent.
 *
 *   Income   -> CREDIT (+)
 *   Expense  -> DEBIT  (-)
 *   Transfer -> requires an explicit direction; the two legs of a transfer are
 *               otherwise structurally identical (same type, same positive
 *               amount) and their sign is NOT recoverable from `type`.
 *
 * Before this service, transfer direction survived only as string convention.
 * `recoverLegacyDirection()` migrates those rows deterministically.
 * ========================================================================== */

export class TransactionSignService {
  private static normalizeType(tx: Transaction): 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'OTHER' {
    const t = String(tx.type || '').toUpperCase();
    if (t === 'INCOME') return 'INCOME';
    if (t === 'EXPENSE') return 'EXPENSE';
    if (t === 'TRANSFER') return 'TRANSFER';
    return 'OTHER';
  }

  /**
   * Recovers the direction of a legacy row that predates the `direction` field.
   *
   * For transfers the legs were created with deterministic markers, checked in
   * order of reliability:
   *   1. id suffix        `<transferId>-debit` / `-credit`   (generated, exact)
   *   2. narration prefix `TRANSFER-DEBIT/`  / `TRANSFER-CREDIT/`
   *   3. notes text       '(Debit)' / '(Credit)'
   *
   * Returns null when the direction cannot be established — the caller must
   * then treat the row as undetermined rather than guessing a sign.
   */
  static recoverLegacyDirection(tx: Transaction): TransactionDirection | null {
    const kind = this.normalizeType(tx);
    if (kind === 'INCOME') return 'CREDIT';
    if (kind === 'EXPENSE') return 'DEBIT';
    if (kind !== 'TRANSFER') return null;

    const id = String(tx.id || '').toLowerCase();
    if (id.endsWith('-debit')) return 'DEBIT';
    if (id.endsWith('-credit')) return 'CREDIT';

    const narration = String(tx.narration || '').toUpperCase();
    if (narration.startsWith('TRANSFER-DEBIT/')) return 'DEBIT';
    if (narration.startsWith('TRANSFER-CREDIT/')) return 'CREDIT';

    const notes = String(tx.notes || '').toLowerCase();
    if (notes.includes('(debit)')) return 'DEBIT';
    if (notes.includes('(credit)')) return 'CREDIT';

    return null;
  }

  /** Effective direction: the stored field, else recovered from legacy markers. */
  static directionOf(tx: Transaction): TransactionDirection | null {
    if (tx.direction === 'DEBIT' || tx.direction === 'CREDIT') return tx.direction;
    return this.recoverLegacyDirection(tx);
  }

  /**
   * True when the sign of this transaction cannot be established.
   * Such rows must be surfaced for reconciliation, never silently signed.
   */
  static isDirectionUndetermined(tx: Transaction): boolean {
    return this.directionOf(tx) === null;
  }

  /**
   * Signed contribution of a transaction to its account's balance.
   * Returns 0 when the direction is undetermined — refusing to guess is
   * preferable to silently corrupting a balance.
   */
  static signedAmount(tx: Transaction): number {
    const dir = this.directionOf(tx);
    const magnitude = Math.abs(Number(tx.amount) || 0);
    if (dir === 'CREDIT') return magnitude;
    if (dir === 'DEBIT') return -magnitude;
    return 0;
  }

  /**
   * Backfills `direction` on rows that predate the field.
   * Non-destructive: no row is dropped and no field other than `direction` is
   * written, so ids, amounts, dates, narrations and fingerprints are preserved.
   */
  static migrate(transactions: Transaction[]): {
    transactions: Transaction[];
    assigned: number;
    alreadySet: number;
    undetermined: number;
  } {
    let assigned = 0;
    let alreadySet = 0;
    let undetermined = 0;

    const migrated = transactions.map(tx => {
      if (tx.direction === 'DEBIT' || tx.direction === 'CREDIT') {
        alreadySet++;
        return tx;
      }
      const dir = this.recoverLegacyDirection(tx);
      if (!dir) {
        undetermined++;
        return tx;
      }
      assigned++;
      return { ...tx, direction: dir };
    });

    return { transactions: migrated, assigned, alreadySet, undetermined };
  }
}
