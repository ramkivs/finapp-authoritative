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

  /**
   * D-06-F1-A — user-selected multi-select BATCH deletion of `closed_absent`
   * Holdings. Structurally identical contract to `planDelete`, lifted to the
   * whole batch:
   *
   *   - PURE: no persistence mutation happens here. The entire next state is
   *     computed first; only `buildAtomicMutationForBatch` (inside ONE
   *     `MemoryRepository.write` boundary) touches the repository.
   *   - COMPLETE VALIDATION BEFORE ANY MUTATION: the batch is rejected IN
   *     FULL if ANY id is missing/invalid, ANY Holding is not found, ANY
   *     Holding is not `closed_absent`, or the id list is empty/duplicated.
   *   - NO PARTIAL SUCCESS: there is no code path that deletes some selected
   *     Holdings while another selected Holding fails validation.
   *
   * Error codes (all `HoldingDeletionError`):
   *
   *   - `INVALID_ID`         — `ids` is not a non-empty array, any id is
   *                             empty/non-string, or `asOf` is empty.
   *   - `DUPLICATE_ID`       — the same Holding id appears twice in `ids`.
   *   - `HOLDING_NOT_FOUND`  — any requested id does not exist in `existing`.
   *   - `HOLDING_NOT_CLOSED` — any requested Holding's `status` is not
   *                             `closed_absent`.
   *   - `DUPLICATE_AUDIT_ID` — a computed audit entry id collides (defensive
   *                             only; fresh UUIDs make this unreachable).
   *
   * Every audit entry of one batch carries the SAME `batchId` (prefix
   * `hdlb-`) and `batchScope: 'MULTI_SELECT'` so the batch is fully
   * attributable in the audit log. Single-deletion entries (D-06-1) carry
   * neither field; both fields are optional, so existing records remain
   * readable and DB_VERSION stays 7 with no migration.
   */
  static planDeleteMany(
    ids: readonly string[],
    asOf: string,
    existing: readonly Holding[],
    existingLog: readonly HoldingDeletionLogEntry[],
  ): HoldingBatchDeletePlan {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new HoldingDeletionError(
        'INVALID_ID',
        `HoldingDeletionService.planDeleteMany requires a non-empty array of Holding ids.`,
      );
    }
    if (typeof asOf !== 'string' || asOf.trim() === '') {
      throw new HoldingDeletionError(
        'INVALID_ID',
        `HoldingDeletionService.planDeleteMany requires a non-empty asOf timestamp.`,
      );
    }
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new HoldingDeletionError(
          'INVALID_ID',
          `HoldingDeletionService.planDeleteMany requires every id to be a non-empty string; received ${JSON.stringify(id)}.`,
        );
      }
    }
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        throw new HoldingDeletionError(
          'DUPLICATE_ID',
          `Holding id "${id}" appears more than once in the batch selection.`,
        );
      }
      seen.add(id);
    }

    // COMPLETE validation pass #1: existence. The entire batch is rejected
    // before any mutation if any single id is missing.
    const targets: Holding[] = [];
    for (const id of ids) {
      const hit = existing.find(h => h.id === id);
      if (!hit) {
        throw new HoldingDeletionError(
          'HOLDING_NOT_FOUND',
          `Holding with id "${id}" does not exist. The entire batch was rejected; no Holding was deleted.`,
        );
      }
      targets.push(hit);
    }

    // COMPLETE validation pass #2: eligibility. Only `closed_absent`
    // Holdings may be deleted; one ineligible Holding rejects the whole batch.
    for (const target of targets) {
      if (target.status !== 'closed_absent') {
        throw new HoldingDeletionError(
          'HOLDING_NOT_CLOSED',
          `Holding "${target.id}" is not closed_absent (current status: "${target.status}"). ` +
          `Only closed_absent Holdings may be permanently deleted via D-06. ` +
          `The entire batch was rejected; no Holding was deleted.`,
        );
      }
    }

    // All validation passed. Build the batch attribution and one audit entry
    // per target (in selection order). Every entry shares `batchId`.
    const batchId = `hdlb-${crypto.randomUUID()}`;
    const auditEntries: HoldingDeletionLogEntry[] = targets.map(target => ({
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
      batchId,
      batchScope: 'MULTI_SELECT',
    }));

    const auditIds = new Set<string>(existingLog.map(e => e.id));
    for (const entry of auditEntries) {
      if (auditIds.has(entry.id)) {
        throw new HoldingDeletionError(
          'DUPLICATE_AUDIT_ID',
          `An audit entry with id "${entry.id}" already exists. This should never happen with a fresh UUID.`,
        );
      }
      auditIds.add(entry.id);
    }

    // Pre-compute the ENTIRE next state. Both arrays are independent copies;
    // the input arrays are never mutated.
    const idSet = new Set(ids);
    const nextHoldings: Holding[] = existing.filter(h => !idSet.has(h.id));
    const nextLog: HoldingDeletionLogEntry[] = [...existingLog, ...auditEntries];

    return { batchId, batchScope: 'MULTI_SELECT', targets, auditEntries, nextHoldings, nextLog };
  }

  /**
   * D-06-F1-A — batch analogue of `buildAtomicMutation`. Returns a closure
   * that applies the pre-computed batch next state in a SINGLE SYNCHRONOUS
   * ASSIGNMENT block, meant to be passed to
   * `MemoryRepository.write(() => closure())`.
   *
   * Both `holdingsData` and `holdingDeletionLogData` are assigned together;
   * the existing captureLedger / revertDelta mechanism rolls the WHOLE batch
   * back on persist failure. Failure therefore leaves zero deleted Holdings
   * and zero partial audit batches.
   */
  static buildAtomicMutationForBatch(plan: HoldingBatchDeletePlan): () => void {
    return () => {
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

/**
 * D-06-F1-A — batch deletion plan. Pure, pre-validated, immutable snapshot
 * of the entire next state for a user-selected multi-select deletion.
 */
export interface HoldingBatchDeletePlan {
  /** Shared attribution id for every audit entry of this batch. Prefix `hdlb-`. */
  readonly batchId: string;
  /** Scope of the batch. D-06-F1-A defines exactly one: user multi-select. */
  readonly batchScope: 'MULTI_SELECT';
  /** The selected Holdings, in selection order. All `closed_absent`. */
  readonly targets: Holding[];
  /** One audit entry per target; all share `batchId`. */
  readonly auditEntries: HoldingDeletionLogEntry[];
  /** The post-deletion `holdingsData` (batch removed). */
  readonly nextHoldings: Holding[];
  /** The post-deletion `holdingDeletionLogData` (batch audit appended). */
  readonly nextLog: HoldingDeletionLogEntry[];
}
