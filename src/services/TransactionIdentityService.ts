import { Sha256Service } from './Sha256Service';
import { Transaction, TransactionOrigin } from '../domain/types';

/**
 * WP-FB-DATA-06a — Transaction identity and provenance authority.
 *
 * THE SINGLE PLACE where a transaction fingerprint is defined and computed.
 *
 * Before this service the identical canonical-string + SHA-256 logic existed in
 * THREE places (WP-FB-DATA-06 discovery, finding L-06):
 *
 *   1. `MemoryRepository.ts:33`        — module-local `generateFingerprint` (DEAD: never called)
 *   2. `ImportPipelineService.ts:15`   — `static generateFingerprint`
 *   3. `useCanonicalLedger.ts:133`     — module-local `generateFingerprint`
 *
 * Three copies of a financial identity function is three chances for them to
 * drift apart. Two rows that one copy calls "the same" and another calls
 * "different" is a silent double-count or a silent drop. All copies now
 * delegate here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FINGERPRINT DEFINITION — DELIBERATELY UNCHANGED IN THIS PACKAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   SHA256(`${account}|${date}|${amount}|${narration.toLowerCase().trim()}`)
 *
 * WP-FB-DATA-06a is a foundations package with NO intended user-visible
 * financial change. The canonical string is therefore byte-for-byte identical
 * to the pre-06a implementations, and `FINGERPRINT_VERSION` stays at 1.
 *
 * Changing the input set is NOT a refactor — it is a product decision that
 * changes which rows are treated as duplicates, and therefore changes balances.
 * See `FINGERPRINT_EXCLUDED_FIELDS` below for the two fields the discovery
 * called out, and why each is deferred rather than silently changed.
 */

/**
 * Version of the canonical fingerprint string.
 *
 * Bump ONLY together with an explicit product decision, because every persisted
 * fingerprint computed under the previous version becomes non-comparable.
 */
export const FINGERPRINT_VERSION = 1;

/**
 * The exact ordered field set that participates in the fingerprint.
 * Exported so tests can assert the contract rather than trusting a comment.
 */
export const FINGERPRINT_FIELDS = ['account', 'date', 'amount', 'narration'] as const;

/**
 * Fields deliberately EXCLUDED from the fingerprint, with the reason for each.
 *
 * The two flagged by the WP-FB-DATA-06 discovery gate:
 *
 * `direction` — EXCLUDED, DEFERRED TO A PRODUCT DECISION (finding L-02).
 *   Discovery scenario G proved that re-importing a row whose TYPE/DIRECTION was
 *   corrected produces an identical fingerprint, so the correction is counted as
 *   a duplicate and SILENTLY DROPPED. Including `direction` would make that row
 *   append instead — which changes a balance by 2x the amount. That is a
 *   materially different financial outcome and is exactly what this package is
 *   forbidden from deciding unilaterally. 06a therefore does NOT change the
 *   input set; it removes the word "silently" instead, by detecting the case and
 *   reporting it (see `isDivergentDuplicate`). The decision itself belongs to
 *   DATA-06c decision #12.
 *
 * `accountId` — EXCLUDED, RESOLVED AND PERMANENT.
 *   Already settled by WP-FB-DATA-04 §14. `accountId` is a DERIVED resolution of
 *   the `account` text against the registered account list, and it can legally
 *   change over the life of a row (an account is registered later, renamed, or
 *   deleted). If it entered the fingerprint, merely registering an account would
 *   retroactively change the identity of every historical row and break dedup
 *   against everything already persisted. `account` — the immutable statement
 *   text — carries the account dimension instead. This one is not deferred; it
 *   is decided, and the test suite enforces it.
 *
 * The remaining exclusions are provenance/derived/mutable-metadata fields that
 * must not affect whether two rows are the same economic event.
 */
export const FINGERPRINT_EXCLUDED_FIELDS = [
  'id',
  'dateStr',
  'title',
  'accountId',
  'direction',
  'type',
  'category',
  'status',
  'notes',
  'transferId',
  'origin',
  'recordedAt',
  'importBatchId',
  'sourceProvider',
  'sourceFile',
  'sourceRowNumber',
  'fingerprint'
] as const;

/** The minimum shape required to compute a fingerprint. */
export interface FingerprintInput {
  account: string;
  date: string;
  amount: number;
  narration: string;
}

/* =============================================================================
 * TRANSACTION ID UNIQUENESS (WP-FB-DATA-06c-0 / prerequisite P-1)
 *
 * `Transaction.id` is the addressing key: it is the IndexedDB `keyPath` for the
 * transactions store, and it is what every future lifecycle operation would
 * name ("delete transaction X", "supersede transaction X").
 *
 * It was enforced unique NOWHERE. The WP-FB-DATA-06c discovery gate proved the
 * consequence in real Chromium:
 *
 *   commitImportedRows([ {id:'SAME-ID', ₹100}, {id:'SAME-ID', ₹250} ])
 *     -> appended: 2
 *   in memory   : 2 rows, ₹350
 *   in IndexedDB: 1 row,  ₹250      <-- clear() + put() collapsed them
 *   after reload: ₹250              <-- ₹100 silently destroyed, no error
 *
 * The collapse is silent because `saveAll` mirrors the array with `put()`, and
 * `put()` on a keyPath store overwrites. Memory and storage therefore disagree
 * about how much money exists until the next reload resolves it destructively.
 *
 * ⚠️ THIS IS AN IDENTITY CONCERN, NOT A NEW AUTHORITY.
 * It lives here because `TransactionIdentityService` is already the identity
 * authority (DATA-06a). Creating a separate "IdUniquenessService" would split
 * identity across two owners, which the programme explicitly forbids. Nothing
 * about the fingerprint — its inputs, its canonical string, its version, or
 * `fingerprintOf`'s preference for the persisted value — is altered by the code
 * below. `id` and `fingerprint` remain independent: `id` addresses a ROW,
 * `fingerprint` identifies an ECONOMIC EVENT, and two distinct rows may
 * legitimately share a fingerprint (that is what duplicate detection is for)
 * while never sharing an id.
 * ========================================================================== */

export interface DuplicateIdGroup {
  id: string;
  count: number;
  /** Where the collision came from, for an actionable message. */
  scope: 'WITHIN_BATCH' | 'AGAINST_EXISTING' | 'IN_STORED_DATA';
  message: string;
}

/** Thrown at the repository admission boundary when an id would be reused. */
export class DuplicateTransactionIdError extends Error {
  readonly duplicates: DuplicateIdGroup[];
  constructor(duplicates: DuplicateIdGroup[]) {
    super(
      `Duplicate transaction id — ${duplicates.map(d => d.message).join('; ')}`
    );
    this.name = 'DuplicateTransactionIdError';
    this.duplicates = duplicates;
  }
}

/**
 * Audit clock for `recordedAt`.
 *
 * `recordedAt` is WALL-CLOCK time — when the row entered the ledger — and is
 * deliberately NOT `getEffectiveAsOfDate()`. `date` is the financial value date
 * and answers "when did this money move"; `recordedAt` answers "when did this
 * application learn about it". Conflating them is how an audit trail becomes
 * unfalsifiable.
 *
 * Injectable so tests are deterministic without mocking global Date.
 */
let recordedAtClock: () => string = () => new Date().toISOString();

export function setRecordedAtClock(fn: () => string): void {
  recordedAtClock = fn;
}

export function resetRecordedAtClock(): void {
  recordedAtClock = () => new Date().toISOString();
}

export class TransactionIdentityService {
  /**
   * The canonical string that is hashed. Exposed separately from `fingerprint`
   * so tests can assert the exact byte layout, not just that "some hash" came
   * out. A digest test alone cannot tell you the field order silently changed.
   */
  static canonicalString(tx: FingerprintInput): string {
    return `${tx.account}|${tx.date}|${tx.amount}|${tx.narration.toLowerCase().trim()}`;
  }

  /** SHA-256 of the canonical string. The one fingerprint implementation. */
  static fingerprint(tx: FingerprintInput): string {
    return Sha256Service.hash(this.canonicalString(tx));
  }

  /**
   * Fingerprint of an existing transaction: the persisted value when present,
   * otherwise computed.
   *
   * Preferring the persisted value matters because the stored fingerprint is
   * the identity the row was admitted under. Recomputing unconditionally would
   * silently re-identify any row whose fingerprinted fields were produced by an
   * older normalizer.
   */
  static fingerprintOf(tx: Transaction): string {
    return tx.fingerprint || this.fingerprint({
      account: tx.account,
      date: tx.date,
      amount: tx.amount,
      narration: tx.narration
    });
  }

  /**
   * Origin of a transaction — NEVER INFERRED.
   *
   * Legacy rows persisted before 06a carry no `origin`. It is tempting to infer
   * `importBatchId ? 'IMPORT' : 'MANUAL'`, and that inference would even be
   * right most of the time. "Right most of the time" is not a property an audit
   * field may have, and this programme has already established the principle
   * that identity comes from explicit recording, not from pattern-matching
   * adjacent data (WP-FB-DATA-04c-2: "names identify candidates; only explicit
   * user action establishes the relationship").
   *
   * So a legacy row reports `'UNKNOWN'`, honestly, forever. Only rows written by
   * the factory or the import normalizer carry a real origin.
   */
  static originOf(tx: Transaction): TransactionOrigin | 'UNKNOWN' {
    return tx.origin === 'MANUAL' || tx.origin === 'IMPORT' ? tx.origin : 'UNKNOWN';
  }

  /** Current audit timestamp for a newly recorded row. */
  static recordedAt(): string {
    return recordedAtClock();
  }

  /**
   * A DIVERGENT DUPLICATE: same fingerprint, but a field EXCLUDED from the
   * fingerprint disagrees — specifically `direction` or `type`, the two fields
   * that determine the SIGN of the row.
   *
   * This is finding L-02. Two rows that hash identically but move money in
   * opposite directions are not the same economic event, yet dedup treats them
   * as one and drops the newer silently.
   *
   * 06a does not change what happens to the row (it is still dropped — changing
   * that is a product decision). It changes only that the user is told. This is
   * the DATA-02 principle applied to import: records may be excluded, but never
   * silently.
   */
  static isDivergentDuplicate(candidate: Transaction, existing: Transaction): boolean {
    if (this.fingerprintOf(candidate) !== this.fingerprintOf(existing)) return false;
    return (
      this.normalizedType(candidate) !== this.normalizedType(existing) ||
      (candidate.direction ?? null) !== (existing.direction ?? null)
    );
  }

  /** `'INCOME'`/`'Income'` are the same type; case is a legacy artefact. */
  private static normalizedType(tx: Transaction): string {
    return String(tx.type || '').toUpperCase();
  }

  /* ─────────────────── P-1: transaction id uniqueness ─────────────────── */

  /**
   * ADMISSION GATE for `Transaction.id` (WP-FB-DATA-06c-0).
   *
   * Checks BOTH collision scopes required by the authorization:
   *   - duplicates WITHIN the incoming batch
   *   - duplicates AGAINST already-stored rows
   *
   * Rejects rather than repairing. An id supplied by a caller is never silently
   * regenerated: if the application quietly minted a new id for a colliding
   * row, the caller would hold a reference to a row that no longer exists under
   * that name, and an import would produce rows whose ids differ from the ones
   * its own result reported. Refusing is the only outcome that keeps the
   * caller's view and storage in agreement.
   *
   * @throws {DuplicateTransactionIdError}
   */
  static assertUniqueIds(incoming: Transaction[], existing: Transaction[]): void {
    if (incoming.length === 0) return;

    const duplicates: DuplicateIdGroup[] = [];

    // 1. within the incoming batch
    const seen = new Map<string, number>();
    for (const tx of incoming) {
      const id = String(tx.id ?? '');
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    for (const [id, count] of seen) {
      if (count > 1) {
        duplicates.push({
          id,
          count,
          scope: 'WITHIN_BATCH',
          message: `id "${id}" appears ${count} times in the same write; ` +
                   `only one row would survive persistence`
        });
      }
    }

    // 2. against already-stored rows
    const existingIds = new Set(existing.map(t => String(t.id ?? '')));
    for (const id of seen.keys()) {
      if (existingIds.has(id)) {
        duplicates.push({
          id,
          count: 2,
          scope: 'AGAINST_EXISTING',
          message: `id "${id}" already exists in the ledger; writing it would ` +
                   `overwrite the stored row on the next reload`
        });
      }
    }

    if (duplicates.length > 0) throw new DuplicateTransactionIdError(duplicates);
  }

  /**
   * Load-time detection for data that ALREADY contains duplicate ids
   * (WP-FB-DATA-06c-0, existing-data condition).
   *
   * Report only. This deliberately does NOT pick a winner, drop a row, or mint
   * replacement ids: choosing which of two conflicting financial rows survives
   * is a product decision about the user's money, and inventing one here would
   * be exactly the kind of silent repair this programme refuses.
   *
   * Note such data can only be OBSERVED in memory — IndexedDB has already
   * collapsed same-id rows by the time they are read back. This therefore
   * catches in-session collisions and any future non-IndexedDB backend.
   */
  static findDuplicateIds(txs: Transaction[]): DuplicateIdGroup[] {
    const counts = new Map<string, number>();
    for (const tx of txs) {
      const id = String(tx.id ?? '');
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    const out: DuplicateIdGroup[] = [];
    for (const [id, count] of counts) {
      if (count > 1) {
        out.push({
          id,
          count,
          scope: 'IN_STORED_DATA',
          message: `id "${id}" is used by ${count} stored transactions; ` +
                   `no row was modified or removed`
        });
      }
    }
    return out;
  }
}
