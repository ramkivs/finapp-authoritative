import { Transaction, TransactionDirection } from '../domain/types';
import { TransactionSignService } from './TransactionSignService';

/* =============================================================================
 * TRANSFER INTEGRITY (WP-FB-DATA-06b)
 *
 * The single pure authority on what makes a transfer a transfer.
 *
 * Target invariant:
 *   A persisted transfer is either a valid balanced two-leg economic
 *   operation, or it does not exist.
 *
 * WP-FB-DATA-06b discovery proved that before this service NOTHING validated a
 * transfer anywhere. All eight adversarial scenarios were accepted without a
 * single rejection: a missing leg created or destroyed ₹2,000, unequal legs
 * created ₹1,000, a duplicated leg destroyed ₹2,000, and a lone leg could be
 * persisted through a public store API. `transferId` was written and never once
 * read outside tests — a label with no enforcement behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO FAILURE CLASSES — the distinction drives the whole design
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   INVALID  Structurally impossible as an economic operation: wrong leg count,
 *            two debits, unequal amounts, a bad direction value. Money is
 *            created or destroyed. These are REJECTED AT ADMISSION and must
 *            never reach storage.
 *
 *   BROKEN   Structurally a correct pair — two legs, one DEBIT, one CREDIT,
 *            equal positive amounts — whose ACCOUNT REFERENCE was lost after
 *            the fact, because the user deleted an account (Decision T1-b).
 *            The economic operation is still internally consistent; it is the
 *            surrounding context that changed. These are ALLOWED, DERIVED and
 *            REPORTED — never blocked, never silently repaired.
 *
 * Collapsing these two into one "invalid" bucket would either block a
 * legitimate account deletion or admit money-destroying writes. They are
 * different problems and get different answers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY STATUS IS DERIVED AND NOT PERSISTED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Decision T1-b says affected transfers are "marked BROKEN". This service marks
 * them by DERIVING the status from the legs on every read rather than writing a
 * flag to storage. A persisted flag can disagree with reality — re-register the
 * deleted account and a stored `BROKEN` would still say BROKEN. A derived one
 * cannot go stale, needs no migration, and adds no new persisted state to a
 * package whose whole purpose is integrity.
 *
 * This mirrors `AccountAssetLinkService`, whose LINKED / UNLINKED / BROKEN
 * vocabulary is likewise derived from `linkedAssetId` rather than stored.
 * ========================================================================== */

export type TransferStatus = 'BALANCED' | 'BROKEN' | 'INVALID';

export type TransferViolationCode =
  /** Not exactly two legs share this transferId. */
  | 'LEG_COUNT'
  /** Not exactly one DEBIT and one CREDIT. */
  | 'DIRECTION_COMPOSITION'
  /** A direction value outside {DEBIT, CREDIT}. */
  | 'INVALID_DIRECTION'
  /** The two legs do not carry the same amount. */
  | 'AMOUNT_MISMATCH'
  /** An amount is zero or negative; `amount` is always a positive magnitude. */
  | 'NON_POSITIVE_AMOUNT'
  /** A leg is not `type: 'Transfer'`. */
  | 'TYPE_MISMATCH'
  /** A transfer row carries no transferId, so it can never be paired. */
  | 'MISSING_TRANSFER_ID'
  /** Both legs reference the same account — that is not a transfer. */
  | 'SAME_ACCOUNT'
  /** Signed amounts do not cancel. */
  | 'NET_NONZERO'
  /** BROKEN-class: exactly one leg lost its account reference. */
  | 'ORPHANED_ACCOUNT_REFERENCE';

export interface TransferViolation {
  code: TransferViolationCode;
  message: string;
  /** BROKEN violations are reportable; INVALID violations are blocking. */
  severity: 'INVALID' | 'BROKEN';
}

export interface TransferValidation {
  transferId: string;
  status: TransferStatus;
  violations: TransferViolation[];
  legCount: number;
  net: number;
}

/** Thrown at the repository admission boundary. Carries the full detail. */
export class TransferIntegrityError extends Error {
  readonly validations: TransferValidation[];
  constructor(validations: TransferValidation[]) {
    const detail = validations
      .map(v => `${v.transferId}: ${v.violations.map(x => x.message).join('; ')}`)
      .join(' | ');
    super(`Transfer integrity violation — ${detail}`);
    this.name = 'TransferIntegrityError';
    this.validations = validations;
  }
}

const VALID_DIRECTIONS: TransactionDirection[] = ['DEBIT', 'CREDIT'];

function isTransferRow(tx: Transaction): boolean {
  return String(tx.type || '').toUpperCase() === 'TRANSFER';
}

export class TransferIntegrityService {
  /** Groups transfer rows by `transferId`. Non-transfer rows are ignored. */
  static groupByTransferId(txs: Transaction[]): Map<string, Transaction[]> {
    const groups = new Map<string, Transaction[]>();
    for (const tx of txs) {
      if (!isTransferRow(tx) && !tx.transferId) continue;
      if (!tx.transferId) continue;
      const list = groups.get(tx.transferId) || [];
      list.push(tx);
      groups.set(tx.transferId, list);
    }
    return groups;
  }

  /**
   * Validates one `transferId` group.
   *
   * NOTE ON DATES — deliberately NOT an invariant. A real transfer can leave one
   * account on Monday and arrive on Wednesday, and bank statements routinely
   * show exactly that. Requiring equal dates would invent a product rule the
   * user never asked for and would reject legitimate data. Date divergence is
   * therefore not a violation at any severity.
   */
  static validateGroup(transferId: string, legs: Transaction[]): TransferValidation {
    const violations: TransferViolation[] = [];
    const net = legs.reduce((s, l) => s + TransactionSignService.signedAmount(l), 0);

    if (legs.length !== 2) {
      violations.push({
        code: 'LEG_COUNT',
        severity: 'INVALID',
        message: `expected exactly 2 legs, found ${legs.length}`
      });
    }

    for (const leg of legs) {
      if (!isTransferRow(leg)) {
        violations.push({
          code: 'TYPE_MISMATCH',
          severity: 'INVALID',
          message: `leg ${leg.id} has type "${leg.type}", expected Transfer`
        });
      }
      if (!leg.direction || !VALID_DIRECTIONS.includes(leg.direction)) {
        violations.push({
          code: 'INVALID_DIRECTION',
          severity: 'INVALID',
          message: `leg ${leg.id} has direction "${String(leg.direction)}", expected DEBIT or CREDIT`
        });
      }
      if (!(leg.amount > 0)) {
        violations.push({
          code: 'NON_POSITIVE_AMOUNT',
          severity: 'INVALID',
          message: `leg ${leg.id} has non-positive amount ${leg.amount}`
        });
      }
    }

    const debits = legs.filter(l => l.direction === 'DEBIT');
    const credits = legs.filter(l => l.direction === 'CREDIT');
    if (legs.length === 2 && (debits.length !== 1 || credits.length !== 1)) {
      violations.push({
        code: 'DIRECTION_COMPOSITION',
        severity: 'INVALID',
        message: `expected 1 DEBIT and 1 CREDIT, found ${debits.length} DEBIT and ${credits.length} CREDIT`
      });
    }

    if (legs.length === 2 && legs[0].amount !== legs[1].amount) {
      violations.push({
        code: 'AMOUNT_MISMATCH',
        severity: 'INVALID',
        message: `legs carry different amounts (${legs[0].amount} vs ${legs[1].amount})`
      });
    }

    // Same-account check only when BOTH references are known. Two unmapped legs
    // are not evidence of a same-account transfer — they are evidence of two
    // unknowns, and guessing from that is exactly what this programme forbids.
    if (
      legs.length === 2 &&
      legs[0].accountId != null &&
      legs[1].accountId != null &&
      legs[0].accountId === legs[1].accountId
    ) {
      violations.push({
        code: 'SAME_ACCOUNT',
        severity: 'INVALID',
        message: `both legs reference the same account ${legs[0].accountId}`
      });
    }

    if (legs.length === 2 && net !== 0 && !violations.some(v => v.code === 'AMOUNT_MISMATCH')) {
      violations.push({
        code: 'NET_NONZERO',
        severity: 'INVALID',
        message: `signed amounts do not cancel (net ${net})`
      });
    }

    // BROKEN class (Decision T1-b): a structurally sound pair that lost exactly
    // one account reference, which is what deleting an account produces.
    const structurallySound = !violations.some(v => v.severity === 'INVALID');
    if (structurallySound && legs.length === 2) {
      const unmapped = legs.filter(l => l.accountId == null);
      if (unmapped.length === 1) {
        violations.push({
          code: 'ORPHANED_ACCOUNT_REFERENCE',
          severity: 'BROKEN',
          message:
            `the ${unmapped[0].direction} leg no longer references an account ` +
            `(its account was deleted), so this transfer no longer balances across accounts`
        });
      }
    }

    const status: TransferStatus = violations.some(v => v.severity === 'INVALID')
      ? 'INVALID'
      : violations.some(v => v.severity === 'BROKEN')
        ? 'BROKEN'
        : 'BALANCED';

    return { transferId, status, violations, legCount: legs.length, net };
  }

  /** Validates every transfer group in a set of rows. */
  static validateAll(txs: Transaction[]): TransferValidation[] {
    const out: TransferValidation[] = [];
    for (const [transferId, legs] of this.groupByTransferId(txs)) {
      out.push(this.validateGroup(transferId, legs));
    }
    return out;
  }

  /**
   * Decision T2-a — load-time detection and REPORTING ONLY.
   *
   * Returns every transfer that is not BALANCED. Mutates nothing, repairs
   * nothing. Auto-synthesising a missing leg would be inventing financial data
   * the user never entered, which this programme does not do.
   */
  static findBrokenTransfers(txs: Transaction[]): TransferValidation[] {
    return this.validateAll(txs).filter(v => v.status !== 'BALANCED');
  }

  /**
   * ADMISSION GATE. Decides whether a set of incoming rows may be written.
   *
   * Only the transfer groups the incoming rows actually TOUCH are validated.
   * This is deliberate and load-bearing:
   *
   *   - A pre-existing BROKEN transfer (from a legitimate account deletion under
   *     T1-b) must not prevent the user from ever recording another transaction.
   *   - Legacy invalid data is reported by `findBrokenTransfers`, per T2-a — it
   *     is not retroactively enforced, because that would lock the user out of
   *     their own ledger over historical rows they cannot edit (there is still
   *     no transaction edit API — that is DATA-06c).
   *
   * @throws {TransferIntegrityError} when any touched group would be INVALID.
   */
  static assertAdmissible(incoming: Transaction[], existing: Transaction[]): void {
    const touched = new Set<string>();
    const failures: TransferValidation[] = [];

    for (const tx of incoming) {
      if (!isTransferRow(tx) && !tx.transferId) continue;
      if (!tx.transferId) {
        // A Transfer row with no transferId can never be paired with anything.
        failures.push({
          transferId: '(none)',
          status: 'INVALID',
          legCount: 1,
          net: TransactionSignService.signedAmount(tx),
          violations: [{
            code: 'MISSING_TRANSFER_ID',
            severity: 'INVALID',
            message: `transfer row ${tx.id} carries no transferId, so it can never form a pair`
          }]
        });
        continue;
      }
      touched.add(tx.transferId);
    }

    if (touched.size > 0) {
      // The prospective post-write state for each touched group.
      const combined = [...existing, ...incoming];
      const groups = this.groupByTransferId(combined);
      for (const transferId of touched) {
        const validation = this.validateGroup(transferId, groups.get(transferId) || []);
        if (validation.status === 'INVALID') failures.push(validation);
      }
    }

    if (failures.length > 0) throw new TransferIntegrityError(failures);
  }

  /** Human-readable one-liner for a reconciliation surface. */
  static describe(v: TransferValidation): string {
    return `${v.transferId} [${v.status}] — ${v.violations.map(x => x.message).join('; ')}`;
  }
}
