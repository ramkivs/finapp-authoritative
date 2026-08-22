import { Transaction } from '../domain/types';
import { LedgerExclusionService } from './LedgerExclusionService';
import { TransactionIdentityService } from './TransactionIdentityService';
import { formatDisplayDate } from './DateRangeService';

/* =============================================================================
 * TRANSACTION AMENDMENT / SUPERSESSION (WP-FB-DATA-06c-2)
 *
 * Pure planning authority for the ONE lifecycle operation this package adds:
 *
 *     "This recorded transaction is wrong. Record the right figures without
 *      destroying what was originally recorded."
 *
 * Performs no I/O and touches no store. `MemoryTransactionRepository.supersede`
 * applies the plan inside a single persistence transaction — exactly the shape
 * `ImportBatchRollbackService` established for 06c-6.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ACCEPTED DECISIONS THIS ENCODES — and nothing beyond them
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   D3  = B  A correction is a NEW ROW with a NEW `id`, plus an explicit link
 *            field. It is never an in-place mutation of the original.
 *
 *   D4  = D  The ORIGINAL REMAINS PRISTINE. Its amount, date, narration,
 *            account, category, fingerprint and every provenance field are left
 *            byte-for-byte as recorded. The only thing that changes about it is
 *            that it stops contributing to derived money. The correction
 *            INHERITS the original's source provenance and carries an explicit
 *            divergence marker (`provenanceDiverged`).
 *
 *   D5  = C  Corrections form a SUPERSESSION CHAIN: v1 <- v2 <- v3. Every
 *            version is retained and walkable.
 *
 *   D10 = C  The chain link is a BACKWARD `supersedes` pointer written once, by
 *            the correction, at creation. Nothing ever re-mutates an earlier
 *            version to point forwards.
 *
 *   D11 = B  The original is excluded with reason `SUPERSEDED`. `DELETED` was
 *            explicitly NOT added to the vocabulary.
 *
 *   D12 = C  ONE atomic amendment primitive. Restore is a separate capability
 *            and is NOT part of this package (see Q2 below).
 *
 *   Q1  = a  An ALREADY-EXCLUDED row may NOT be amended. Measured at the 06c-2
 *            authorization gate: amending a rolled-back row resurrected ₹4,000
 *            of money the user had already withdrawn from the ledger, and left
 *            its batch reporting PARTIALLY_EXCLUDED. Refused outright.
 *
 *   Q1b = c  A correction INHERITS `importBatchId` as provenance, but is NOT a
 *            target of batch rollback. Enforced in `ImportBatchRollbackService`,
 *            which asks `isCorrection()` here rather than re-deriving it.
 *
 *   Q2  = d  RESTORE IS DEFERRED to WP-FB-DATA-06c-2b. There is deliberately no
 *            `restore`, `unsupersede`, `revert` or `undo` in this file or
 *            anywhere else in this package. The gate measured that a naive
 *            restore of v1 while v2 stays live double-counts (15,500 -> 20,500,
 *            two included versions of one economic event), and that making
 *            restore re-exclude the successor IS amendment-undo, which touches
 *            D6. D6 and D9 are OPEN and must not be resolved by implication.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN ALLOWLIST OF AMENDABLE FIELDS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A correction could in principle be handed any partial `Transaction`. That
 * would let a caller "amend" `id`, `supersedes`, `excludedAt`, `fingerprint` or
 * `importBatchId` and quietly forge identity, lifecycle state or provenance
 * through a door that was opened for changing an amount. The amendable surface
 * is therefore an explicit allowlist, and anything outside it is refused with
 * `IMMUTABLE_FIELD` rather than ignored — silently dropping a field the caller
 * asked for is how a UI comes to believe it saved something it did not.
 * ========================================================================== */

/**
 * The fields an amendment may change.
 *
 * ⚠️ `dateStr` is absent on purpose — it is the DISPLAY rendering of `date` and
 * is derived here whenever `date` changes. Letting a caller set them
 * independently is how a row comes to say "12 Mar 2024" while sorting as
 * 2025-11-03.
 *
 * ⚠️ Identity (`id`, `fingerprint`), lifecycle (`excludedAt`, `excludedReason`,
 * `supersedes`, `provenanceDiverged`) and provenance (`origin`, `recordedAt`,
 * `importBatchId`, `source*`) are all absent on purpose. They are produced by
 * this service from the accepted decisions, never supplied by a caller.
 *
 * ⚠️ `transferId` is absent on purpose. Re-parenting a leg into a different
 * transfer is not an amendment; it is a structural rewrite of two economic
 * operations at once, and no decision authorises it.
 */
export const AMENDABLE_FIELDS = [
  'amount',
  'date',
  'title',
  'narration',
  'account',
  'accountId',
  'category',
  'notes',
  'status',
  'direction',
  'type'
] as const;

export type AmendableField = typeof AMENDABLE_FIELDS[number];

export type AmendableChanges = Partial<Pick<Transaction, AmendableField>>;

export type AmendmentRefusalCode =
  /** No amendment was supplied. */
  | 'EMPTY_REQUEST'
  /** The row to amend is not in the ledger. */
  | 'TARGET_NOT_FOUND'
  /** The same row was targeted twice in one request. */
  | 'DUPLICATE_TARGET'
  /** Q1 = a — the row is already excluded (rolled back, or already superseded). */
  | 'TARGET_ALREADY_EXCLUDED'
  /** A field outside `AMENDABLE_FIELDS` was supplied. */
  | 'IMMUTABLE_FIELD'
  /** The correction would be identical to the original. */
  | 'NO_EFFECTIVE_CHANGE'
  /** D8 — some but not all legs of a touched transfer were targeted. */
  | 'PARTIAL_TRANSFER_AMENDMENT';

export interface AmendmentRequest {
  targetId: string;
  changes: AmendableChanges;
}

export interface AmendmentPlan {
  status: 'ADMISSIBLE' | 'REFUSED';
  /** Ids of the rows that would be superseded, in request order. */
  targetIds: string[];
  /** `transferId`s wholly covered by this amendment; each gets one fresh id. */
  touchedTransferIds: string[];
  /** The validated requests, in request order. Empty when REFUSED. */
  requests: AmendmentRequest[];
  refusalCode?: AmendmentRefusalCode;
  refusalReason?: string;
}

export interface AmendmentOutcome {
  /** `id` of the row that was superseded. */
  supersededId: string;
  /** `id` of the newly created correction. */
  correctionId: string;
  /** Fresh `transferId` when the amendment covered a transfer, else null. */
  transferId: string | null;
}

export interface AmendmentResult {
  outcomes: AmendmentOutcome[];
  supersededCount: number;
  correctionCount: number;
}

/** Thrown when an amendment is refused. Carries the machine-readable code. */
export class AmendmentRefusedError extends Error {
  readonly code: AmendmentRefusalCode;
  readonly targetIds: string[];
  constructor(plan: AmendmentPlan) {
    super(`Amendment refused — ${plan.refusalReason}`);
    this.name = 'AmendmentRefusedError';
    this.code = plan.refusalCode as AmendmentRefusalCode;
    this.targetIds = plan.targetIds;
  }
}

/** Fresh-suffix source, injectable so tests can make ids deterministic. */
export type SuffixMinter = () => string;

/** Matches the pre-existing `TransactionFactory` id shape exactly. */
export const defaultSuffixMinter: SuffixMinter = () =>
  Date.now() + '-' + Math.random().toString(36).slice(2, 6);

export class TransactionAmendmentService {
  /**
   * Is this row a CORRECTION produced by an amendment?
   *
   * Keyed on the presence of `supersedes`, which only this service ever writes.
   * `ImportBatchRollbackService` consults this rather than re-deriving it, so
   * Q1b = c has exactly one definition of "correction" in the codebase.
   */
  static isCorrection(tx: Transaction): boolean {
    return typeof tx.supersedes === 'string' && tx.supersedes.length > 0;
  }

  /**
   * Walks the supersession chain forward from any version to the one that is
   * still counted. Returns `null` when every version in the chain is excluded.
   *
   * Report-only. Used by disclosure surfaces and by the tests that prove
   * "exactly one included version" (D5 = C).
   */
  static activeVersionOf(tx: Transaction, txs: Transaction[]): Transaction | null {
    const chain = this.chainOf(tx, txs);
    const live = chain.filter(t => !LedgerExclusionService.isExcluded(t));
    return live.length === 1 ? live[0] : null;
  }

  /**
   * The full supersession chain containing `tx`, oldest first.
   *
   * Walks backwards through `supersedes` to the original, then forwards through
   * the rows that point at each version. Cycle-guarded: a corrupted pointer
   * loop terminates instead of hanging the UI.
   */
  static chainOf(tx: Transaction, txs: Transaction[]): Transaction[] {
    const byId = new Map(txs.map(t => [t.id, t]));

    // backwards to the root
    let root = tx;
    const seenBack = new Set<string>([tx.id]);
    while (this.isCorrection(root)) {
      const prev = byId.get(root.supersedes as string);
      if (!prev || seenBack.has(prev.id)) break;
      seenBack.add(prev.id);
      root = prev;
    }

    // forwards from the root
    const chain: Transaction[] = [root];
    const seenFwd = new Set<string>([root.id]);
    for (;;) {
      const next = txs.find(t => t.supersedes === chain[chain.length - 1].id);
      if (!next || seenFwd.has(next.id)) break;
      seenFwd.add(next.id);
      chain.push(next);
    }
    return chain;
  }

  /** Every supersession chain with more than one version, for disclosure. */
  static supersededPairs(txs: Transaction[]): { original: Transaction; correction: Transaction }[] {
    const byId = new Map(txs.map(t => [t.id, t]));
    const out: { original: Transaction; correction: Transaction }[] = [];
    for (const t of txs) {
      if (!this.isCorrection(t)) continue;
      const original = byId.get(t.supersedes as string);
      if (original) out.push({ original, correction: t });
    }
    return out;
  }

  /**
   * Decides whether the amendment may proceed. Pure and deterministic — mints
   * no ids and reads no clock, so it can be called freely by a UI to decide
   * whether to enable a control, exactly as `ImportBatchRollbackService.plan`
   * is by the Import History surface.
   *
   * Refuses rather than partially applying, in every case.
   */
  static plan(requests: AmendmentRequest[], txs: Transaction[]): AmendmentPlan {
    const base: AmendmentPlan = {
      status: 'REFUSED',
      targetIds: [],
      touchedTransferIds: [],
      requests: []
    };

    if (!Array.isArray(requests) || requests.length === 0) {
      return { ...base, refusalCode: 'EMPTY_REQUEST', refusalReason: 'no amendment was supplied' };
    }

    const byId = new Map(txs.map(t => [t.id, t]));
    const targetIds: string[] = [];

    for (const req of requests) {
      const targetId = String(req?.targetId ?? '');

      if (targetIds.includes(targetId)) {
        return {
          ...base,
          targetIds,
          refusalCode: 'DUPLICATE_TARGET',
          refusalReason:
            `transaction "${targetId}" was targeted more than once in a single amendment; ` +
            `two corrections of the same row would both claim to supersede it`
        };
      }
      targetIds.push(targetId);

      const original = byId.get(targetId);
      if (!original) {
        return {
          ...base,
          targetIds,
          refusalCode: 'TARGET_NOT_FOUND',
          refusalReason: `no transaction with id "${targetId}" exists in the ledger`
        };
      }

      // ── Q1 = a ────────────────────────────────────────────────────────────
      // An excluded row contributes nothing to derived money. Superseding it
      // would create a LIVE correction carrying its amount, putting money back
      // that the user had already taken out. Measured at the gate: a
      // rolled-back ₹1,000 row amended to ₹4,000 resurrected ₹4,000.
      if (LedgerExclusionService.isExcluded(original)) {
        const reason = LedgerExclusionService.reasonOf(original);
        const detail = reason === 'SUPERSEDED'
          ? 'it has already been superseded — amend the current version of this transaction instead'
          : reason === 'IMPORT_ROLLBACK'
            ? 'it was rolled back with its import batch — amending it would put its money back into your balances'
            : 'it is excluded from balances and reports for an unrecognised reason';
        return {
          ...base,
          targetIds,
          refusalCode: 'TARGET_ALREADY_EXCLUDED',
          refusalReason: `transaction "${targetId}" cannot be amended: ${detail}`
        };
      }

      const changes = (req?.changes ?? {}) as Record<string, unknown>;
      const keys = Object.keys(changes);

      const illegal = keys.filter(k => !(AMENDABLE_FIELDS as readonly string[]).includes(k));
      if (illegal.length > 0) {
        return {
          ...base,
          targetIds,
          refusalCode: 'IMMUTABLE_FIELD',
          refusalReason:
            `amendment of "${targetId}" tried to change ${illegal.map(f => `"${f}"`).join(', ')}, ` +
            `which is not amendable. Identity, lifecycle state and provenance are set by the ` +
            `amendment itself, never by the caller`
        };
      }

      const effective = keys.filter(
        k => (changes as Record<string, unknown>)[k] !== (original as unknown as Record<string, unknown>)[k]
      );
      if (effective.length === 0) {
        return {
          ...base,
          targetIds,
          refusalCode: 'NO_EFFECTIVE_CHANGE',
          refusalReason:
            `amendment of "${targetId}" changes nothing. It would still exclude the original and ` +
            `create an identical correction, adding a version to the chain that records no correction`
        };
      }
    }

    // ── D8 — WHOLE-TRANSFER AMENDMENT ────────────────────────────────────────
    // A transfer is one economic operation carried by two rows. Superseding one
    // leg excludes it and leaves the other counting, which the 06c decision
    // gate measured as ₹2,000 leaving the system with integrity reporting
    // clean. The caller must therefore amend BOTH legs in the SAME request; a
    // half request is refused here, and `assertWholeTransferLifecycle` refuses
    // it again at the repository as defence in depth.
    const targetSet = new Set(targetIds);
    const touchedTransferIds: string[] = [];
    for (const targetId of targetIds) {
      const original = byId.get(targetId) as Transaction;
      const transferId = original.transferId;
      if (!transferId || touchedTransferIds.includes(transferId)) continue;
      touchedTransferIds.push(transferId);

      const legs = txs.filter(t => t.transferId === transferId);
      const untargeted = legs.filter(l => !targetSet.has(l.id));
      if (untargeted.length > 0) {
        return {
          ...base,
          targetIds,
          refusalCode: 'PARTIAL_TRANSFER_AMENDMENT',
          refusalReason:
            `amending "${targetId}" would supersede only part of transfer ${transferId} ` +
            `(${untargeted.length} leg(s) would keep counting the old figures), creating or ` +
            `destroying money. A transfer must be amended whole (Decision D8)`
        };
      }
    }

    return { status: 'ADMISSIBLE', targetIds, touchedTransferIds, requests, refusalCode: undefined, refusalReason: undefined };
  }

  /**
   * Produces the next transaction array. Pure — no mutation of the input, no
   * clock read and no id minting of its own; both are injected so a test can
   * assert exact bytes rather than "some hash came out".
   *
   * ONE ARRAY, ONE WRITE. The originals are stamped and the corrections are
   * inserted in the SAME returned array, so the caller persists a single state
   * that is never, at any instant, one where both versions are counted. The
   * gate measured the two-write alternative and recorded
   * `INTERMEDIATE_PERSISTED_DOUBLE_COUNT: true` with ₹20,500 persisted.
   */
  static apply(
    plan: AmendmentPlan,
    txs: Transaction[],
    now: string,
    mintSuffix: SuffixMinter = defaultSuffixMinter
  ): { next: Transaction[]; corrections: Transaction[]; result: AmendmentResult } {
    if (plan.status !== 'ADMISSIBLE') {
      return { next: txs, corrections: [], result: { outcomes: [], supersededCount: 0, correctionCount: 0 } };
    }

    const byId = new Map(txs.map(t => [t.id, t]));

    // One fresh transferId per touched transfer. The corrections CANNOT reuse
    // the original transferId: the group would then hold four legs and
    // `TransferIntegrityService.validateGroup` would report LEG_COUNT INVALID.
    // A new id also states the truth — the corrected pair is a different
    // recording of the operation, and the old pair remains as it was recorded.
    const freshTransferIds = new Map<string, string>();
    for (const transferId of plan.touchedTransferIds) {
      freshTransferIds.set(transferId, 'tr-cor-' + mintSuffix());
    }

    const corrections: Transaction[] = [];
    const outcomes: AmendmentOutcome[] = [];

    for (const req of plan.requests) {
      const original = byId.get(req.targetId) as Transaction;
      const changes = req.changes;

      const correction: Transaction = {
        ...original,
        ...changes,
        // D3 = B — a NEW id. Never a reuse, never a mutation of the original.
        id: 'tx-cor-' + mintSuffix(),
        // D10 = C — the backward pointer, written once, here.
        supersedes: original.id,
        // D4 = D — provenance is inherited from the spread above; this is the
        // explicit marker that the figures are no longer what produced them.
        provenanceDiverged: true,
        // A correction enters the ledger NOW. `date` (the value date) is
        // inherited or amended; `recordedAt` is when the app learned of it.
        recordedAt: now
      };

      // A correction is BORN LIVE. If the original ever carried exclusion
      // stamps this would inherit them through the spread — it cannot today
      // (Q1 = a refuses excluded targets) but relying on that from a distance
      // is how a guard becomes load-bearing without anyone noticing.
      delete correction.excludedAt;
      delete correction.excludedReason;

      // Display date follows the value date rather than being independently
      // settable — see AMENDABLE_FIELDS.
      if (changes.date !== undefined) {
        correction.dateStr = formatDisplayDate(changes.date);
      }

      if (original.transferId) {
        correction.transferId = freshTransferIds.get(original.transferId) as string;
      }

      // Identity must follow content. Inheriting the original's fingerprint
      // would make the correction claim to be the same economic event as the
      // row it replaces, and the next import would dedupe against the wrong
      // figures. Recomputed ONLY when the original carried one, so an amendment
      // never invents an identity for a row that never had one.
      if (original.fingerprint) {
        correction.fingerprint = TransactionIdentityService.fingerprint({
          account: correction.account,
          date: correction.date,
          amount: correction.amount,
          narration: correction.narration
        });
      }

      corrections.push(correction);
      outcomes.push({
        supersededId: original.id,
        correctionId: correction.id,
        transferId: original.transferId ? (correction.transferId as string) : null
      });
    }

    // D11 = B / D4 = D — the ONLY change to an original is its exclusion stamp.
    // Amount, date, narration, account, category, fingerprint and every
    // provenance field are left exactly as recorded.
    const superseded = new Set(plan.targetIds);
    const stamped = txs.map(t =>
      superseded.has(t.id)
        ? { ...t, excludedAt: now, excludedReason: 'SUPERSEDED' as const }
        : t
    );

    return {
      next: [...corrections, ...stamped],
      corrections,
      result: {
        outcomes,
        supersededCount: plan.targetIds.length,
        correctionCount: corrections.length
      }
    };
  }
}
