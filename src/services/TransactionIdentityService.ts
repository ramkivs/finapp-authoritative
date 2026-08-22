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
}
