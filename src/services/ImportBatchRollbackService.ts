import { Transaction } from '../domain/types';
import { LedgerExclusionService } from './LedgerExclusionService';
import { TransferIntegrityService } from './TransferIntegrityService';

/* =============================================================================
 * IMPORT BATCH ROLLBACK (WP-FB-DATA-06c-6, Decision 13-b)
 *
 * Pure planning authority. Decides whether an import batch may be rolled back
 * and computes the resulting rows. Performs no I/O and touches no store — the
 * repository applies the plan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING IS REMOVED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Decision 13-b resolved the disposition: rolled-back rows are RETAINED,
 * MARKED, EXCLUDED from balances and reports, and REMAIN VISIBLE in the Ledger
 * with a disclosure. This service therefore stamps
 * `excludedAt` / `excludedReason: 'IMPORT_ROLLBACK'` and stamps nothing else.
 *
 * ⚠️ NAMING — deliberate deviation, surfaced rather than silent.
 * The authorization named the capability `removeBatch`. Under 13-b it removes
 * nothing, and a method called `removeBatch` that leaves every row in place is
 * a trap: the next maintainer will assume the rows are gone and write a query
 * that double-counts them. The capability is therefore named `rollbackBatch`,
 * and `removeBatch` is deliberately left non-existent so the "no hard-removal
 * API" guard stays meaningful and true.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SPLIT-BATCH HAZARD
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The WP-FB-DATA-06c gate-2 report originally claimed batch rollback "cannot
 * split a transfer". That was corrected during the 06c-6 blocked gate:
 * `commitImportedRows` does NOT validate that a transfer's two legs carry the
 * same `importBatchId`. Executed evidence at that HEAD:
 *
 *     legs: [ {DEBIT, batch-1}, {CREDIT, batch-2} ]
 *     rolling back batch-1 -> system total 15,000 -> 17,000  (₹2,000 CREATED)
 *
 * Excluding one leg of a pair while the other keeps counting creates or
 * destroys money just as surely as deleting it. `plan()` refuses outright
 * rather than partially applying.
 * ========================================================================== */

export type RollbackRefusalCode =
  | 'EMPTY_BATCH_ID'
  | 'BATCH_NOT_FOUND'
  | 'ALREADY_ROLLED_BACK'
  | 'WOULD_SPLIT_TRANSFER';

export interface RollbackPlan {
  batchId: string;
  status: 'ADMISSIBLE' | 'REFUSED';
  /** Rows this rollback would newly exclude. */
  targetIds: string[];
  /** Rows in the batch already excluded by an earlier rollback. */
  alreadyExcludedIds: string[];
  refusalCode?: RollbackRefusalCode;
  refusalReason?: string;
}

export interface BatchRollbackResult {
  batchId: string;
  excludedCount: number;
  excludedIds: string[];
  alreadyExcludedCount: number;
}

/** Thrown when a rollback is refused. Carries the machine-readable code. */
export class BatchRollbackError extends Error {
  readonly code: RollbackRefusalCode;
  readonly batchId: string;
  constructor(plan: RollbackPlan) {
    super(`Import batch rollback refused — ${plan.refusalReason}`);
    this.name = 'BatchRollbackError';
    this.code = plan.refusalCode as RollbackRefusalCode;
    this.batchId = plan.batchId;
  }
}

export class ImportBatchRollbackService {
  /** Rows belonging to a batch. */
  static rowsInBatch(batchId: string, txs: Transaction[]): Transaction[] {
    return txs.filter(t => t.importBatchId === batchId);
  }

  /**
   * Decides whether the batch may be rolled back. Pure.
   *
   * Refuses rather than partially applying, in all four cases. A rollback that
   * half-succeeds is worse than one that does not happen: the user believes the
   * import is undone while some of its money is still counted.
   */
  static plan(batchId: string, txs: Transaction[]): RollbackPlan {
    const base: RollbackPlan = { batchId, status: 'REFUSED', targetIds: [], alreadyExcludedIds: [] };

    if (typeof batchId !== 'string' || batchId.trim().length === 0) {
      return {
        ...base,
        refusalCode: 'EMPTY_BATCH_ID',
        refusalReason: 'no import batch id was supplied'
      };
    }

    const rows = this.rowsInBatch(batchId, txs);
    if (rows.length === 0) {
      return {
        ...base,
        refusalCode: 'BATCH_NOT_FOUND',
        refusalReason: `no transactions belong to import batch "${batchId}"`
      };
    }

    const alreadyExcludedIds = rows.filter(r => LedgerExclusionService.isExcluded(r)).map(r => r.id);
    const targets = rows.filter(r => !LedgerExclusionService.isExcluded(r));

    if (targets.length === 0) {
      return {
        ...base,
        alreadyExcludedIds,
        refusalCode: 'ALREADY_ROLLED_BACK',
        refusalReason:
          `import batch "${batchId}" has already been rolled back ` +
          `(${alreadyExcludedIds.length} row(s) already excluded)`
      };
    }

    // ── split-batch transfer guard ────────────────────────────────────────
    // For every transfer touched by this batch, EVERY leg must end up excluded.
    // A leg counts as ending up excluded if it is already excluded or is a
    // target of this rollback.
    const willBeExcluded = new Set([...alreadyExcludedIds, ...targets.map(t => t.id)]);
    const touchedTransferIds = new Set(
      rows.map(r => r.transferId).filter((id): id is string => !!id)
    );

    for (const transferId of touchedTransferIds) {
      const legs = txs.filter(t => t.transferId === transferId);
      const stranded = legs.filter(l => !willBeExcluded.has(l.id) && !LedgerExclusionService.isExcluded(l));
      if (stranded.length > 0) {
        return {
          ...base,
          alreadyExcludedIds,
          refusalCode: 'WOULD_SPLIT_TRANSFER',
          refusalReason:
            `rolling back "${batchId}" would exclude only part of transfer ${transferId} ` +
            `(${stranded.length} leg(s) would keep counting), creating or destroying money. ` +
            `A transfer must be rolled back whole.`
        };
      }
    }

    return {
      batchId,
      status: 'ADMISSIBLE',
      targetIds: targets.map(t => t.id),
      alreadyExcludedIds
    };
  }

  /**
   * Produces the next transaction array. Pure — no mutation of the input.
   *
   * Stamps ONLY `excludedAt` and `excludedReason`. Amount, date, account,
   * direction, category, status, fingerprint and every provenance field are
   * left exactly as they were: a rolled-back row must remain a faithful record
   * of what was imported.
   */
  static apply(plan: RollbackPlan, txs: Transaction[], now: string): Transaction[] {
    if (plan.status !== 'ADMISSIBLE') return txs;
    const targets = new Set(plan.targetIds);
    return txs.map(t =>
      targets.has(t.id)
        ? { ...t, excludedAt: now, excludedReason: 'IMPORT_ROLLBACK' as const }
        : t
    );
  }

  /**
   * Belt-and-braces: confirms the rollback did not change any transfer's
   * STRUCTURAL integrity.
   *
   * Exclusion never adds or removes rows, so DATA-06b's structural invariants
   * (leg count, direction composition, equal amounts) cannot change by
   * construction. This asserts that rather than assuming it, so a future change
   * to `apply()` that started removing rows would be caught here instead of in
   * a balance.
   */
  static structuralIntegrityUnchanged(before: Transaction[], after: Transaction[]): boolean {
    const key = (txs: Transaction[]) =>
      JSON.stringify(
        TransferIntegrityService.validateAll(txs)
          .map(v => `${v.transferId}:${v.status}:${v.legCount}:${v.net}`)
          .sort()
      );
    return key(before) === key(after);
  }
}
