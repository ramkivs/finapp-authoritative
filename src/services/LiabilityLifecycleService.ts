import { Liability } from '../domain/types';
import { LiabilityIdentityService } from './LiabilityIdentityService';

/* =============================================================================
 * LIABILITY LIFECYCLE (WP-FB-DATA-07a)
 *
 * WP-FB-DATA-07 gave liabilities a stable `id`. It deliberately kept the legacy
 * exact-name upsert on the create path, because re-adding under the same name
 * was the product's ONLY correction mechanism: there was no Edit UI, no Delete
 * UI and no store action for either.
 *
 * 07a supplies those affordances, so the legacy path is retired. The decisions
 * this module implements — all recorded in FINBOOM-DECISION-LEDGER.md:
 *
 *   Q-D07a-1 = (c)  Edit replaces the COMPLETE record except `id`.
 *   Q-D07a-2 = (b)  A duplicate name is REFUSED and the user is pointed at Edit.
 *   Q-D07a-3 = (b)  Physical delete by `id`, behind an explicit confirmation.
 *   Q-D07a-4 = (b)  The legacy name-upsert is GONE. Create always appends.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE POLICY LIVES HERE AND NOT IN A MODAL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The 07a discovery gate measured two create paths, not one:
 *
 *   AddLiabilityModal -> addLiabilityWithMetadata -> FinancialCommands
 *   OverviewPage:89   -> addLiability(name, amount) -> repository directly
 *
 * A policy enforced in a modal is a policy the second path does not have. Every
 * rule below is therefore enforced at the repository write boundary, and both
 * adapters (Memory and Prisma) route through this one module. A rule enforced
 * in one of two implementations is not a rule; it is a coincidence of wiring.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It does NOT introduce soft exclusion. `Liability` has no `excludedAt`,
 * `excludedReason`, `status` or `archived` field, and importing that vocabulary
 * would extend the 06c TRANSACTION lifecycle to a different entity. Liability
 * delete is a physical delete of a user-entered figure, authorised as such.
 *
 * It does NOT touch transactions. D9-A (no transaction deletion, ever) and the
 * permanently-closed general-undo decision are untouched: the transaction write
 * surface remains exactly five primitives.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DUPLICATE NAMES ARE A UX POLICY, NOT A DOMAIN TRUTH
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two lenders can legitimately both be a "Personal Loan". Storage can hold
 * duplicates and always could; `LiabilityIdentityService.migrate` keeps
 * duplicate-named legacy records SEPARATE with DISTINCT ids and merely reports
 * them AMBIGUOUS. Nothing here merges, reassigns or deletes such a record.
 * The refusal below applies to what a USER may newly create or rename to — it
 * is deliberately reversible by changing the policy, and legacy duplicates
 * already stored remain fully editable and deletable.
 * ========================================================================== */

export type LiabilityLifecycleCode =
  | 'EMPTY_ID'
  | 'LIABILITY_NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_NAME'
  | 'EMPTY_NAME'
  | 'INVALID_AMOUNT';

/**
 * Every field a user may change. This is the whole of `Liability` apart from
 * `id`, which is immutable by construction (Q-D07a-1 = (c)).
 *
 * If a field is ever added to `Liability` it must be added here too, or Edit
 * would silently blank it on the full-record replace.
 */
export const LIABILITY_EDITABLE_FIELDS = ['name', 'amount', 'type', 'currency'] as const;

export type LiabilityEditableField = typeof LIABILITY_EDITABLE_FIELDS[number];

/** A create/edit request: the complete record, minus the identity. */
export interface LiabilityWriteRequest {
  id?: string;
  name: string;
  amount: number;
  type?: Liability['type'];
  currency?: string;
}

export class LiabilityLifecycleError extends Error {
  readonly code: LiabilityLifecycleCode;
  constructor(code: LiabilityLifecycleCode, message: string) {
    super(message);
    this.name = 'LiabilityLifecycleError';
    this.code = code;
  }
}

export interface LiabilityDeletePlan {
  id: string;
  /** The record about to be destroyed — quoted back in the confirmation. */
  target: Liability;
  next: Liability[];
}

export interface LiabilityWritePlan {
  /** The record as it will be stored. */
  liability: Liability;
  next: Liability[];
}

export class LiabilityLifecycleService {
  /* ── shared refusals ─────────────────────────────────────────────────────
     Create, edit and delete all consult the SAME helpers. The 06c family
     learned this the hard way: a UI-side check and a write-path check that
     drift apart produce a UI that offers what the write path refuses. */

  private static requireId(id: unknown): string {
    if (!LiabilityIdentityService.isValidId(id)) {
      throw new LiabilityLifecycleError(
        'EMPTY_ID',
        'This liability has no identity, so it cannot be edited or deleted. Reload and try again.'
      );
    }
    return (id as string).trim();
  }

  private static requireName(name: unknown): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed === '') {
      throw new LiabilityLifecycleError('EMPTY_NAME', 'A liability needs a name.');
    }
    return trimmed;
  }

  private static requireAmount(amount: unknown): number {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new LiabilityLifecycleError(
        'INVALID_AMOUNT',
        'A liability needs a numeric outstanding balance.'
      );
    }
    return amount;
  }

  /**
   * Q-D07a-2 = (b). Refuse a name already in use, and say what to do instead.
   * `exceptId` lets an edit keep its own name.
   */
  private static requireNameAvailable(
    name: string,
    existing: Liability[],
    exceptId?: string
  ): void {
    const normalized = LiabilityIdentityService.normalizeName(name);
    // `exceptId` only excludes a record when it is a REAL id. Comparing
    // `l.id !== undefined` would silently exempt every legacy record that has
    // no id yet from the duplicate check — measured during 07a verification.
    const exempt = LiabilityIdentityService.isValidId(exceptId) ? exceptId : null;
    const clash = existing.find(
      l =>
        (exempt === null || l.id !== exempt) &&
        LiabilityIdentityService.normalizeName(l.name) === normalized
    );
    if (clash) {
      throw new LiabilityLifecycleError(
        'DUPLICATE_NAME',
        `A liability named "${clash.name}" already exists. Edit that liability instead of adding a second one.`
      );
    }
  }

  /** Index of `id` in `existing`, refusing when it is not there. */
  private static requireIndex(id: string, existing: Liability[]): number {
    const index = existing.findIndex(l => l.id === id);
    if (index < 0) {
      throw new LiabilityLifecycleError(
        'LIABILITY_NOT_FOUND',
        'That liability no longer exists. It may have been deleted in another tab. Reload and try again.'
      );
    }
    return index;
  }

  /** Reporting helper: normalised names held by more than one record. */
  static findDuplicateNames(existing: Liability[]): string[] {
    const counts = new Map<string, number>();
    for (const l of existing) {
      const n = LiabilityIdentityService.normalizeName(l?.name);
      if (n === '') continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    return [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort();
  }

  /**
   * CREATE. Always appends (Q-D07a-4 = (b)) — there is no name-upsert left.
   *
   * A caller may supply its own id (import/seed determinism); it must be unused.
   * Anything else gets a freshly generated one.
   */
  static planCreate(request: LiabilityWriteRequest, existing: Liability[]): LiabilityWritePlan {
    const name = this.requireName(request?.name);
    const amount = this.requireAmount(request?.amount);
    this.requireNameAvailable(name, existing);

    let id: string;
    if (LiabilityIdentityService.isValidId(request?.id)) {
      id = (request.id as string).trim();
      if (existing.some(l => l.id === id)) {
        throw new LiabilityLifecycleError(
          'DUPLICATE_ID',
          'A liability with that identity already exists. Edit it instead of creating a second one.'
        );
      }
    } else {
      id = LiabilityIdentityService.generateId();
    }

    const liability: Liability = {
      id,
      name,
      amount,
      ...(request.type !== undefined ? { type: request.type } : {}),
      ...(request.currency !== undefined ? { currency: request.currency } : {})
    };

    return { liability, next: [...existing, liability] };
  }

  /**
   * EDIT. Addressed by `id`, NEVER by name.
   *
   * The 07a gate measured the alternative: with two rows named "Home Loan"
   * (₹25,00,000 and ₹9,00,000), a name-addressed edit hits index 0 — a coin
   * flip over ₹16,00,000. It also measured that a STALE id does not refuse
   * today, it appends: `add({ id: 'lia-gone', … })` took debt 100 -> 10,099.
   * `requireIndex` closes that: an edit whose target is gone REFUSES.
   *
   * The replacement is the COMPLETE record (Q-D07a-1 = (c)); `id` is carried
   * over from the stored row and can never be changed by the caller.
   */
  static planUpdate(request: LiabilityWriteRequest, existing: Liability[]): LiabilityWritePlan {
    const id = this.requireId(request?.id);
    const index = this.requireIndex(id, existing);
    const name = this.requireName(request?.name);
    const amount = this.requireAmount(request?.amount);

    /* The duplicate-name policy applies to what the user CHANGES a name to.
       A record whose name is unchanged is never refused — otherwise legacy
       duplicates carried in by the 07 migration (which keeps same-named records
       SEPARATE, by design) would become uneditable: every save would clash with
       their own twin, leaving delete as the only available operation. That
       would be the policy quietly deciding a data question it was never given.
       Caught during 07a verification. */
    const nameUnchanged =
      LiabilityIdentityService.normalizeName(existing[index].name) ===
      LiabilityIdentityService.normalizeName(name);
    if (!nameUnchanged) this.requireNameAvailable(name, existing, id);

    const liability: Liability = {
      id: existing[index].id as string, // identity comes from STORAGE, not the form
      name,
      amount,
      ...(request.type !== undefined ? { type: request.type } : {}),
      ...(request.currency !== undefined ? { currency: request.currency } : {})
    };

    const next = [...existing];
    next[index] = liability;
    return { liability, next };
  }

  /**
   * DELETE (Q-D07a-3 = (b)). Physical, by `id`, one row.
   *
   * Name-addressed deletion was measured destroying BOTH duplicate rows —
   * ₹34,00,000. Filtering on `id` removes exactly the row identified, and
   * `requireIndex` refuses a target that is already gone rather than silently
   * succeeding.
   */
  static planDelete(id: string, existing: Liability[]): LiabilityDeletePlan {
    const targetId = this.requireId(id);
    const index = this.requireIndex(targetId, existing);
    const target = existing[index];
    const next = existing.filter((_, i) => i !== index);
    return { id: targetId, target, next };
  }

  /** The exact wording the UI must confirm with before a delete. */
  static describeDeletion(target: Liability): string {
    return `Delete "${target.name}" (${target.amount})? This cannot be undone.`;
  }
}
