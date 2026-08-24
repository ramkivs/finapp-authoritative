/**
 * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion service.
 *
 * Pure / stateless service that orchestrates the user-confirmed permanent
 * deletion of a single `closed_absent` Holding, with a mandatory audit
 * record written in the same atomic `MemoryRepository.write` boundary as
 * the removal itself.
 *
 * Authority:
 *   - `WP-FB-IMPORT-BROKER-01-D-06-PRODUCT-AUTHORITY.md` (D-06-1..D-06-12)
 *   - `WP-FB-IMPORT-BROKER-01-D-06-IMPLEMENTATION-AUTHORITY.md` (§4.3 Option B)
 *
 * The implementation is structurally analogous to `BrokerImportService`:
 *
 *   planDelete(id, asOf, existing, existingLog)
 *     → pure pre-validation; computes the entire next state
 *     → throws `HoldingDeletionError` synchronously on any failure
 *     → returns a `HoldingDeletePlan` (next holdings + next log + audit entry)
 *
 *   buildAtomicMutation(plan)
 *     → returns a closure that assigns both `holdingsData` and
 *       `holdingDeletionLogData` in a SINGLE SYNCHRONOUS BLOCK
 *     → the closure is passed to `MemoryRepository.write(() => closure())`
 *     → on persist failure, the existing `revertDelta` mechanism restores
 *       both arrays together (D-06 atomicity contract).
 *
 * D-06 contract reminders:
 *   - Only `closed_absent` Holdings may be permanently deleted. Active
 *     Holdings must first transition to `closed_absent` via the import
 *     pipeline (or a separate user-initiated close path that is out of
 *     D-06 scope).
 *   - The deletion is irreversible: no undo, no backup.
 *   - The audit entry's `id` is distinct from the deleted `holdingId`.
 *   - The same identity reappearing in a future import is classified as
 *     `NEW` (per the existing `BrokerImportService.reconcile` logic; this
 *     service does not touch the identity service).
 *
 * The 10 minimum conceptual audit fields are recorded by the D-06 product
 * authority. The interface preserves them exactly.
 */

import { Holding, HoldingDeletionLogEntry } from '../domain/types';

export class HoldingDeletionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HoldingDeletionError';
  }
}

export interface HoldingDeletePlan {
  /** The Holding that was targeted. */
  readonly target: Holding;
  /** The audit entry to be written. */
  readonly auditEntry: HoldingDeletionLogEntry;
  /** The post-deletion `holdingsData` (one fewer record). */
  readonly nextHoldings: Holding[];
  /** The post-deletion `holdingDeletionLogData` (one more record). */
  readonly nextLog: HoldingDeletionLogEntry[];
}

export class HoldingDeletionService {
  /**
   * P-1 pre-validation. Computes the entire next state in pure form.
   *
   * Throws `HoldingDeletionError` synchronously on any failure. The error
   * codes are:
   *
   *   - `INVALID_ID`         — `id` is empty or not a string.
   *   - `HOLDING_NOT_FOUND`   — no Holding in `existing` has that id.
   *   - `HOLDING_NOT_CLOSED`  — the target Holding's `status` is not
   *                             `closed_absent` (V1 contract: only
   *                             closed_absent Holdings may be deleted).
   *   - `DUPLICATE_AUDIT_ID`  — the computed audit entry id already
   *                             exists in `existingLog` (defensive only;
   *                             should not happen with a fresh UUID).
   *
   * On success, returns a `HoldingDeletePlan` whose `nextHoldings` and
   * `nextLog` arrays are independent copies; mutating them in the caller
   * does not affect the input arrays.
   */
  static planDelete(
    id: string,
    asOf: string,
    existing: readonly Holding[],
    existingLog: readonly HoldingDeletionLogEntry[],
  ): HoldingDeletePlan {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new HoldingDeletionError(
        'INVALID_ID',
        `HoldingDeletionService.planDelete requires a non-empty string id; received ${JSON.stringify(id)}.`,
      );
    }
    if (typeof asOf !== 'string' || asOf.trim() === '') {
      throw new HoldingDeletionError(
        'INVALID_ID',
        `HoldingDeletionService.planDelete requires a non-empty asOf timestamp.`,
      );
    }
    const index = existing.findIndex(h => h.id === id);
    if (index < 0) {
      throw new HoldingDeletionError(
        'HOLDING_NOT_FOUND',
        `Holding with id "${id}" does not exist.`,
      );
    }
    const target = existing[index];
    if (target.status !== 'closed_absent') {
      throw new HoldingDeletionError(
        'HOLDING_NOT_CLOSED',
        `Holding "${id}" is not closed_absent (current status: "${target.status}"). ` +
        `Only closed_absent Holdings may be permanently deleted via D-06.`,
      );
    }

    // Build the audit entry. The audit entry's id is a fresh UUID distinct
    // from the deleted holdingId. The deleted holdingId is recorded as a
    // field, not as a key.
    const auditEntry: HoldingDeletionLogEntry = {
      id: `hdl-${crypto.randomUUID()}`,
      holdingId: target.id,
      broker: target.broker,
      account: target.account,
      instrumentName: target.instrumentName,
      isin: target.isin,
      ticker: target.ticker,
      currentValueAtDeletion: target.currentValue,
      sourceFile: target.sourceFile,
      importedAt: target.importedAt,
      deletedAt: asOf,
    };

    if (existingLog.some(e => e.id === auditEntry.id)) {
      throw new HoldingDeletionError(
        'DUPLICATE_AUDIT_ID',
        `An audit entry with id "${auditEntry.id}" already exists. This should never happen with a fresh UUID.`,
      );
    }

    // Pre-compute the entire next state. The nextHoldings array is a
    // copy with the target removed; the nextLog array is a copy with the
    // audit entry appended.
    const nextHoldings: Holding[] = [
      ...existing.slice(0, index),
      ...existing.slice(index + 1),
    ];
    const nextLog: HoldingDeletionLogEntry[] = [...existingLog, auditEntry];

    return { target, auditEntry, nextHoldings, nextLog };
  }

  /**
   * Returns a closure that applies the pre-computed next state in a SINGLE
   * SYNCHRONOUS ASSIGNMENT. The closure is meant to be passed to
   * `MemoryRepository.write(() => closure())`.
   *
   * The closure assigns both `repository.holdingsData` and
   * `repository.holdingDeletionLogData` in one block; the existing
   * `captureLedger` / `revertDelta` mechanism ensures the whole assignment
   * is atomic with the IndexedDB persist. If persist fails, both arrays
   * roll back together.
   *
   * The pattern mirrors `BrokerImportService.buildAtomicMutation` (which
   * composes NEW + UPDATED + CLOSED_ABSENT in a single closure) and
   * `MemoryLiabilityRepository.remove` (which composes liability-remove
   * + account-link-clear in a single closure). The closure casts
   * `repository` directly (the existing write boundary's pattern) so
   * the assignments hit the live repository state.
   */
  static buildAtomicMutation(plan: HoldingDeletePlan): () => void {
    return () => {
      // The cast matches the BrokerImportService.buildAtomicMutation
      // pattern: `repository` is the live MemoryRepository; mutating its
      // `holdingsData` and `holdingDeletionLogData` here is what the
      // existing captureLedger / revertDelta in MemoryRepository.write
      // is designed to roll back atomically.
      const memoryRepo = (plan as any).__memoryRepo as {
        holdingsData: Holding[];
        holdingDeletionLogData: HoldingDeletionLogEntry[];
        syncStore: () => void;
      };
      memoryRepo.holdingsData = plan.nextHoldings;
      memoryRepo.holdingDeletionLogData = plan.nextLog;
      memoryRepo.syncStore();
    };
  }
}
