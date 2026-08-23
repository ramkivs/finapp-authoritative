import { Transaction } from '../domain/types';
import { LedgerExclusionService } from './LedgerExclusionService';
import { TransferIntegrityService } from './TransferIntegrityService';
import { TransactionAmendmentService } from './TransactionAmendmentService';

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

/* =============================================================================
 * RESTORE (WP-FB-DATA-06c-2b, Decision D6-1 = R5)
 *
 * Restore lives HERE, alongside rollback, deliberately. It is the inverse of
 * the operation defined a few lines above and reasons about the same object —
 * an import batch. A separate `ImportBatchRestoreService` would be a second
 * authority over one concept, and the rules would drift the first time either
 * side changed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT RESTORE IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It is not undo. It clears an IMPORT_ROLLBACK exclusion and stamps an audit
 * timestamp; it retracts no business operation, disposes of no row and touches
 * no other field (Decision D6-7). It cannot act on a SUPERSEDED row, because
 * the D6/D9 gate measured that restoring one produced a persisted, silent,
 * undisclosed double count — two included versions of one economic event, with
 * `activeVersionOf()` returning null.
 *
 * It is not deletion. Decision D9-1 = D9-A: there is no deletion capability in
 * this system and this package adds none.
 * ========================================================================== */

export type RestoreRefusalCode =
  | 'EMPTY_BATCH_ID'
  | 'BATCH_NOT_FOUND'
  /** No row in the batch is currently excluded by IMPORT_ROLLBACK. */
  | 'NOT_ROLLED_BACK'
  /** A row in the batch is excluded for a reason this build cannot name (D6-5). */
  | 'UNRECOGNISED_EXCLUSION_REASON'
  /** A transfer touched by this batch has legs excluded for different reasons (D6-6). */
  | 'MIXED_EXCLUSION_REASONS'
  /** Restoring would leave part of a transfer excluded (D6-10 / D8). */
  | 'WOULD_SPLIT_TRANSFER';

export interface RestorePlan {
  batchId: string;
  status: 'ADMISSIBLE' | 'REFUSED';
  /** Rows this restore would return to the ledger. */
  targetIds: string[];
  /** Rows in the batch excluded for a reason restore must not touch (e.g. SUPERSEDED). */
  untouchedExcludedIds: string[];
  refusalCode?: RestoreRefusalCode;
  refusalReason?: string;
}

export interface BatchRestoreResult {
  batchId: string;
  restoredCount: number;
  restoredIds: string[];
  restoredAt: string;
}

/** Thrown when a restore is refused. Carries the machine-readable code. */
export class BatchRestoreError extends Error {
  readonly code: RestoreRefusalCode;
  readonly batchId: string;
  constructor(plan: RestorePlan) {
    super(`Import batch restore refused — ${plan.refusalReason}`);
    this.name = 'BatchRestoreError';
    this.code = plan.refusalCode as RestoreRefusalCode;
    this.batchId = plan.batchId;
  }
}

/**
 * A user-facing summary of one import batch (WP-FB-DATA-06c-6a).
 *
 * DERIVED from the persisted rows on every read — there is no batch registry and
 * this package does not add one. Every field already persists: `importBatchId`,
 * `sourceProvider`, `sourceFile` and `recordedAt` are written by the import
 * normalizer (DATA-06a) and were verified to survive reload in DATA-06c-6.
 *
 * Deriving rather than storing means the summary cannot drift from the rows it
 * describes, and a rolled-back batch reports itself as rolled back because its
 * rows say so — the same reasoning that made `TransferStatus` and the exclusion
 * state derived rather than persisted.
 */
export interface ImportBatchSummary {
  batchId: string;
  /** Single provider, or a marker when the batch is mixed/absent. */
  provider: string;
  file: string;
  /** Earliest `recordedAt` in the batch; null when no row carries one. */
  importedAt: string | null;
  rowCount: number;
  /** Sum of `amount`, for scale only — not a signed financial figure. */
  totalAmount: number;
  excludedCount: number;
  /**
   * Rows in this batch that are USER CORRECTIONS (WP-FB-DATA-06c-2, Q1b = c).
   *
   * They inherited this `importBatchId` as provenance under D4 = D but are not
   * rollback targets. Surfaced so the Import History can disclose that rolling
   * the batch back will not undo them, instead of leaving the user to infer it
   * from a `PARTIALLY_EXCLUDED` badge.
   */
  correctionCount: number;
  /**
   * Rows in this batch that carry a restore audit stamp (WP-FB-DATA-06c-2b,
   * D6-3). Non-zero means this batch was rolled back and later restored — a
   * fact that survives a SUBSEQUENT rollback, so `rollback -> restore ->
   * rollback` never looks like a plain `rollback`.
   */
  restoredCount: number;
  status: 'LIVE' | 'ROLLED_BACK' | 'PARTIALLY_EXCLUDED';
  /** Whether `rollbackBatch` would currently succeed. */
  rollbackEligible: boolean;
  /** Populated when `rollbackEligible` is false. */
  rollbackBlockedCode?: RollbackRefusalCode;
  rollbackBlockedReason?: string;
  /* ── RESTORE (WP-FB-DATA-06c-2c) ──────────────────────────────────────────
   *
   * The exact mirror of the three rollback fields above, computed from
   * `planRestore()` for the same reason: the UI must ask the authority the
   * write path asks. Before 06c-2c this summary knew nothing about restore, so
   * a restore control had no way to agree with `restoreBatch` except by
   * re-deriving the rules — two implementations of one rule, which is not one
   * rule. */
  /** Whether `restoreBatch` would currently succeed. */
  restoreEligible: boolean;
  /** Populated when `restoreEligible` is false. */
  restoreBlockedCode?: RestoreRefusalCode;
  restoreBlockedReason?: string;
  /**
   * How many rows a restore would ACTUALLY return.
   *
   * ⚠️ NOT `rowCount`. A batch containing a superseded original is restorable
   * for only part of itself — the 06c-2c gate measured `rowCount 3` against
   * `restoreTargetCount 1`. A confirmation quoting `rowCount` would overstate
   * what the user is agreeing to by two rows.
   */
  restoreTargetCount: number;
  /** Excluded rows a restore will deliberately NOT touch (e.g. SUPERSEDED). */
  restoreUntouchedCount: number;
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

    /* ── Q1b = c — CORRECTIONS ARE NOT ROLLBACK TARGETS ─────────────────────
     *
     * D4 = D makes a correction inherit the original's `importBatchId`, so a
     * correction of an imported row is a MEMBER of that batch for provenance.
     * Q1b = c resolved that it is nonetheless NOT a target of rolling that
     * batch back: the figures on a correction were entered by the user, not by
     * the statement, so undoing the import does not undo them.
     *
     * ⚠️ SURFACED CONSEQUENCE, NOT A SILENT ONE. Rolling back a batch that
     * contains corrections therefore leaves those corrections counting. The
     * batch reports `PARTIALLY_EXCLUDED` with a non-zero `correctionCount`
     * rather than claiming to be fully rolled back, so the Import History
     * surface can say so instead of implying the import was undone.
     */
    const corrections = rows.filter(r => TransactionAmendmentService.isCorrection(r));
    const correctionIds = new Set(corrections.map(r => r.id));

    const targets = rows.filter(r => !LedgerExclusionService.isExcluded(r) && !correctionIds.has(r.id));

    if (targets.length === 0) {
      const retained = corrections.filter(r => !LedgerExclusionService.isExcluded(r)).length;
      return {
        ...base,
        alreadyExcludedIds,
        refusalCode: 'ALREADY_ROLLED_BACK',
        refusalReason:
          `import batch "${batchId}" has already been rolled back ` +
          `(${alreadyExcludedIds.length} row(s) already excluded)` +
          (retained > 0
            ? `; ${retained} user correction(s) inherited this batch id and are still counted, ` +
              `because a correction records the user's own figures, not the statement's (Q1b)`
            : '')
      };
    }

    // ── split-batch transfer guard ────────────────────────────────────────
    // For every transfer this rollback actually EXCLUDES part of, EVERY leg
    // must end up excluded. A leg counts as ending up excluded if it is already
    // excluded or is a target of this rollback.
    const willBeExcluded = new Set([...alreadyExcludedIds, ...targets.map(t => t.id)]);
    const touchedTransferIds = new Set(
      rows.map(r => r.transferId).filter((id): id is string => !!id)
    );

    for (const transferId of touchedTransferIds) {
      const legs = txs.filter(t => t.transferId === transferId);

      /* Groups this rollback excludes NOTHING from are not its business.
       *
       * Before Q1b = c this branch was unreachable: every batch row was either
       * already excluded or a target, so every touched group had at least one
       * leg in `willBeExcluded`. Corrections are now neither, so a corrected
       * transfer pair — a wholly live, wholly valid transfer that merely
       * inherited this batch id — would otherwise be read as "two stranded
       * legs" and block the rollback of unrelated rows. Skipping it is a no-op
       * for every pre-06c-2 batch and is asserted as such in the tests.
       */
      if (!legs.some(l => willBeExcluded.has(l.id))) continue;

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
  /**
   * Every import batch present in the ledger, newest first.
   *
   * Rows with no `importBatchId` are not imports and are omitted. Eligibility is
   * computed with `plan()`, so the UI never re-implements the refusal rules — it
   * asks the same authority the write path asks, and can therefore explain
   * WOULD_SPLIT_TRANSFER before the user clicks rather than after.
   */
  static listBatches(txs: Transaction[]): ImportBatchSummary[] {
    const ids: string[] = [];
    for (const t of txs) {
      if (t.importBatchId && !ids.includes(t.importBatchId)) ids.push(t.importBatchId);
    }

    const summaries = ids.map(batchId => {
      const rows = this.rowsInBatch(batchId, txs);
      const providers = [...new Set(rows.map(r => r.sourceProvider).filter(Boolean))] as string[];
      const files = [...new Set(rows.map(r => r.sourceFile).filter(Boolean))] as string[];
      const stamps = rows.map(r => r.recordedAt).filter(Boolean).sort() as string[];
      const excludedCount = rows.filter(r => LedgerExclusionService.isExcluded(r)).length;

      const plan = this.plan(batchId, txs);
      const restorePlan = this.planRestore(batchId, txs);

      const status: ImportBatchSummary['status'] =
        excludedCount === 0 ? 'LIVE'
          : excludedCount === rows.length ? 'ROLLED_BACK'
            : 'PARTIALLY_EXCLUDED';

      return {
        batchId,
        // Never invent a source. A batch with no provider says so.
        provider: providers.length === 1 ? providers[0] : providers.length === 0 ? 'Unknown source' : 'Multiple sources',
        file: files.length === 1 ? files[0] : files.length === 0 ? 'Unknown file' : `${files.length} files`,
        importedAt: stamps.length > 0 ? stamps[0] : null,
        rowCount: rows.length,
        totalAmount: rows.reduce((sum, r) => sum + r.amount, 0),
        excludedCount,
        correctionCount: rows.filter(r => TransactionAmendmentService.isCorrection(r)).length,
        restoredCount: rows.filter(r => typeof r.restoredAt === 'string' && r.restoredAt.length > 0).length,
        status,
        rollbackEligible: plan.status === 'ADMISSIBLE',
        rollbackBlockedCode: plan.status === 'ADMISSIBLE' ? undefined : plan.refusalCode,
        rollbackBlockedReason: plan.status === 'ADMISSIBLE' ? undefined : plan.refusalReason,
        restoreEligible: restorePlan.status === 'ADMISSIBLE',
        restoreBlockedCode: restorePlan.status === 'ADMISSIBLE' ? undefined : restorePlan.refusalCode,
        restoreBlockedReason: restorePlan.status === 'ADMISSIBLE' ? undefined : restorePlan.refusalReason,
        restoreTargetCount: restorePlan.targetIds.length,
        restoreUntouchedCount: restorePlan.untouchedExcludedIds.length
      };
    });

    // newest first; batches with no timestamp sort last
    return summaries.sort((a, b) => {
      if (a.importedAt && b.importedAt) return a.importedAt < b.importedAt ? 1 : -1;
      if (a.importedAt) return -1;
      if (b.importedAt) return 1;
      return 0;
    });
  }

  /**
   * Decides whether an import batch may be RESTORED (WP-FB-DATA-06c-2b).
   *
   * Pure. Refuses rather than partially applying, in every case — the same
   * discipline `plan()` applies, and for the same reason: a restore that
   * half-succeeds leaves the user believing their import is back while some of
   * its money is still missing.
   */
  static planRestore(batchId: string, txs: Transaction[]): RestorePlan {
    const base: RestorePlan = {
      batchId, status: 'REFUSED', targetIds: [], untouchedExcludedIds: []
    };

    if (typeof batchId !== 'string' || batchId.trim().length === 0) {
      return { ...base, refusalCode: 'EMPTY_BATCH_ID', refusalReason: 'no import batch id was supplied' };
    }

    const rows = this.rowsInBatch(batchId, txs);
    if (rows.length === 0) {
      return {
        ...base,
        refusalCode: 'BATCH_NOT_FOUND',
        refusalReason: `no transactions belong to import batch "${batchId}"`
      };
    }

    const excluded = rows.filter(r => LedgerExclusionService.isExcluded(r));

    /* ── D6-5 — UNRECOGNISED REASON REFUSES THE WHOLE OPERATION ────────────
     *
     * A row excluded for a reason this build cannot name is money it does not
     * understand. `LedgerExclusionService.reasonOf` already refuses to guess;
     * restoring on top of that guess would put the money back anyway. Skipping
     * such a row silently would be worse still: the user would be told the
     * batch was restored while part of it stayed out. */
    const unrecognised = excluded.filter(r => LedgerExclusionService.reasonOf(r) === 'UNKNOWN');
    if (unrecognised.length > 0) {
      return {
        ...base,
        refusalCode: 'UNRECOGNISED_EXCLUSION_REASON',
        refusalReason:
          `import batch "${batchId}" contains ${unrecognised.length} row(s) excluded for a reason ` +
          `this version does not recognise (${unrecognised.map(r => String(r.excludedReason)).join(', ')}). ` +
          `They are left exactly as they are rather than guessed at`
      };
    }

    // Decision D6-1 = R5: IMPORT_ROLLBACK is the ONLY restorable exclusion.
    const targets = excluded.filter(r => LedgerExclusionService.reasonOf(r) === 'IMPORT_ROLLBACK');
    const untouched = excluded.filter(r => LedgerExclusionService.reasonOf(r) !== 'IMPORT_ROLLBACK');

    if (targets.length === 0) {
      const restoredBefore = rows.some(r => typeof r.restoredAt === 'string' && r.restoredAt.length > 0);
      return {
        ...base,
        untouchedExcludedIds: untouched.map(r => r.id),
        refusalCode: 'NOT_ROLLED_BACK',
        refusalReason:
          restoredBefore
            ? `import batch "${batchId}" has already been restored; there is nothing left to bring back`
            : `import batch "${batchId}" is not rolled back, so there is nothing to restore` +
              (untouched.length > 0
                ? `. ${untouched.length} row(s) are excluded for another reason and a restore does not touch them`
                : '')
      };
    }

    /* ── D6-6 / D8 — TRANSFERS ─────────────────────────────────────────────
     *
     * Two distinct failures, deliberately reported separately.
     *
     * MIXED_EXCLUSION_REASONS: the legs of one transfer were excluded by
     * different mechanisms, so no restore of this batch can make the transfer
     * whole again. Refused with its own code because the remedy is different —
     * the user must resolve the supersession first.
     *
     * WOULD_SPLIT_TRANSFER: every leg shares the reason, but some leg sits
     * outside this batch and would keep counting alone. */
    const targetIds = new Set(targets.map(t => t.id));
    const touchedTransferIds = new Set(
      rows.map(r => r.transferId).filter((id): id is string => !!id)
    );

    for (const transferId of touchedTransferIds) {
      const legs = txs.filter(t => t.transferId === transferId);
      const excludedLegs = legs.filter(l => LedgerExclusionService.isExcluded(l));
      if (excludedLegs.length === 0) continue;      // nothing of this transfer is excluded

      const reasons = new Set(excludedLegs.map(l => LedgerExclusionService.reasonOf(l)));
      if (reasons.size > 1) {
        return {
          ...base,
          untouchedExcludedIds: untouched.map(r => r.id),
          refusalCode: 'MIXED_EXCLUSION_REASONS',
          refusalReason:
            `transfer ${transferId} has legs excluded for different reasons ` +
            `(${[...reasons].join(', ')}). Restoring only the rolled-back leg would leave the transfer ` +
            `half counted, creating or destroying money. A transfer must be restored whole (Decision D8)`
        };
      }

      // every leg that is excluded must be coming back in THIS restore
      const stranded = excludedLegs.filter(l => !targetIds.has(l.id));
      if (stranded.length > 0) {
        return {
          ...base,
          untouchedExcludedIds: untouched.map(r => r.id),
          refusalCode: 'WOULD_SPLIT_TRANSFER',
          refusalReason:
            `restoring "${batchId}" would return only part of transfer ${transferId} ` +
            `(${stranded.length} leg(s) would stay excluded), creating or destroying money. ` +
            `A transfer must be restored whole`
        };
      }
    }

    return {
      batchId,
      status: 'ADMISSIBLE',
      targetIds: targets.map(t => t.id),
      untouchedExcludedIds: untouched.map(r => r.id)
    };
  }

  /**
   * Produces the next transaction array for a restore. Pure.
   *
   * Removes ONLY `excludedAt` / `excludedReason` and stamps `restoredAt`
   * (Constraint 8). Amount, date, account, direction, category, status, id,
   * fingerprint and every provenance field are left exactly as they were — a
   * restored row must be the same record that was imported, not a new one.
   *
   * ⚠️ `restoredAt` IS THE AUDIT RECORD (D6-3). It is written here and cleared
   * nowhere. `apply()` above spreads the existing row, so a later rollback
   * preserves it and `rollback -> restore -> rollback` stays distinguishable
   * from a single rollback.
   */
  static applyRestore(plan: RestorePlan, txs: Transaction[], now: string): Transaction[] {
    if (plan.status !== 'ADMISSIBLE') return txs;
    const targets = new Set(plan.targetIds);
    return txs.map(t => {
      if (!targets.has(t.id)) return t;
      const next = { ...t, restoredAt: now };
      delete (next as { excludedAt?: string }).excludedAt;
      delete (next as { excludedReason?: unknown }).excludedReason;
      return next;
    });
  }

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
