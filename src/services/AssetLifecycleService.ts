import { Asset, Holding } from '../domain/types';
import { AssetIdentityService } from './AssetIdentityService';
import {
  HoldingAssetCollisionGuard,
  AssetWriteRequestWithCollisionIdentity,
} from './HoldingAssetCollisionGuard';

/* =============================================================================
 * ASSET LIFECYCLE (WP-FB-DATA-07b)
 *
 * WP-FB-DATA-04c-1 gave assets a stable `id` and deliberately kept the legacy
 * exact-name upsert on the create path, because re-adding under the same name
 * was the product's only correction mechanism — there was no Edit UI, no Delete
 * UI and no store action for either.
 *
 * The 07b discovery gate measured what that cost. Through the real Add Asset
 * modal, in a real browser:
 *
 *     add "Gold"  500,000
 *     add "Gold"  300,000
 *     result: ONE row at 300,000 — ₹5,00,000 destroyed, silently, no notice
 *
 * This module supplies the affordances and retires the upsert.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIONS IMPLEMENTED (FINBOOM-DECISION-LEDGER.md)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Q-D07b-1a = (c)  DUPLICATE NAMES ARE PERMITTED. Create always appends; the
 *                    silent name-upsert is gone. Two SGB tranches, two flats,
 *                    two "Emergency Fund" pots at different banks are genuinely
 *                    different assets that share a natural label, and the gate
 *                    measured that aggregation, grouping and snapshots already
 *                    handle them correctly. The obligation this creates is on
 *                    the UI: duplicates must be DISTINGUISHABLE wherever they
 *                    are shown or chosen between.
 *
 *   Q-D07b-1b = (b)  PHYSICAL DELETE BY id, behind an explicit confirmation.
 *
 * ⚠️ NOTE THE DIFFERENCE FROM LIABILITIES. Q-D07a-2 REFUSED duplicate liability
 * names. Assets went the other way, deliberately: `LiabilityType` has nine
 * members and liabilities have no link relationship, whereas assets carry
 * `type`, `tag`, `geography`, `currency` AND an account link, so they have both
 * more ways to be legitimately distinct and more ways to be confused. There is
 * therefore NO `DUPLICATE_NAME` refusal in this module, and that absence is a
 * decision, not an omission.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR HAZARDS THIS MODULE CLOSES (all measured at the 07b gate against the
 * bare repository primitive, all of which an Edit UI would otherwise ship)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   H2  a partial edit BLANKED type/currency/geography/tag
 *   H3  a padded id (' ast-B ') APPENDED a row with a whitespace id
 *   H4  a stale id APPENDED a phantom row instead of refusing
 *   H5  identity was taken from the caller rather than from storage
 *
 * WHAT THIS MODULE DOES NOT DO: no soft delete (there is no `excludedAt`
 * vocabulary on `Asset` and importing one would extend a transaction-lifecycle
 * concept to a different entity), no undo, no transaction capability. D9-A,
 * D11 and the D6 general-undo closure are untouched.
 * ========================================================================== */

export type AssetLifecycleCode =
  | 'EMPTY_ID'
  | 'ASSET_NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'EMPTY_NAME'
  | 'INVALID_AMOUNT'
  // WP-FB-IMPORT-BROKER-01 D-04: a manual Asset collides with an imported
  // Holding representing the same (broker, account?, instrument) economic
  // position. The create / update is refused to prevent double counting.
  | 'HOLDING_COLLISION';

/**
 * Every field a user may change — the whole of `Asset` apart from `id`.
 *
 * If a field is ever added to `Asset` it must be added here too, or Edit would
 * silently blank it on the full-record replace (hazard H2).
 */
export const ASSET_EDITABLE_FIELDS = ['name', 'amount', 'type', 'tag', 'currency', 'geography'] as const;

export type AssetEditableField = typeof ASSET_EDITABLE_FIELDS[number];

/** A create/edit request: the complete record, minus the identity. */
export interface AssetWriteRequest {
  id?: string;
  name: string;
  amount: number;
  type?: Asset['type'];
  tag?: string;
  currency?: string;
  geography?: Asset['geography'];
}

export class AssetLifecycleError extends Error {
  readonly code: AssetLifecycleCode;
  constructor(code: AssetLifecycleCode, message: string) {
    super(message);
    this.name = 'AssetLifecycleError';
    this.code = code;
  }
}

export interface AssetWritePlan {
  asset: Asset;
  next: Asset[];
}

export interface AssetDeletePlan {
  id: string;
  /** The record about to be destroyed — quoted back in the confirmation. */
  target: Asset;
  next: Asset[];
}

export class AssetLifecycleService {
  /* ── shared refusals ─────────────────────────────────────────────────────
     Create, edit and delete consult the SAME helpers, so a rule cannot hold on
     one path and not another. */

  private static requireId(id: unknown): string {
    if (!AssetIdentityService.isValidId(id) || String(id).trim() === '') {
      throw new AssetLifecycleError(
        'EMPTY_ID',
        'This asset has no identity, so it cannot be edited or deleted. Reload and try again.'
      );
    }
    // Trimmed BEFORE matching: ' ast-B ' must resolve to ast-B or refuse, never
    // append a third row carrying a whitespace id (hazard H3).
    return String(id).trim();
  }

  private static requireName(name: unknown): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed === '') {
      throw new AssetLifecycleError('EMPTY_NAME', 'An asset needs a name.');
    }
    return trimmed;
  }

  private static requireAmount(amount: unknown): number {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new AssetLifecycleError('INVALID_AMOUNT', 'An asset needs a numeric valuation.');
    }
    return amount;
  }

  private static requireIndex(id: string, existing: Asset[]): number {
    const index = existing.findIndex(a => a.id === id);
    if (index < 0) {
      throw new AssetLifecycleError(
        'ASSET_NOT_FOUND',
        'That asset no longer exists. It may have been deleted in another tab. Reload and try again.'
      );
    }
    return index;
  }

  /** Builds the stored record from a request. Complete, every time (H2). */
  private static compose(id: string, request: AssetWriteRequest, name: string, amount: number): Asset {
    return {
      id,
      name,
      amount,
      ...(request.type !== undefined ? { type: request.type } : {}),
      ...(request.tag !== undefined ? { tag: request.tag } : {}),
      ...(request.currency !== undefined ? { currency: request.currency } : {}),
      ...(request.geography !== undefined ? { geography: request.geography } : {})
    };
  }

  /**
   * CREATE. Always appends (Q-D07b-1a = (c)) — there is no name-upsert left.
   *
   * A caller may supply its own id (import/seed determinism); it must be unused.
   */
  static planCreate(
    request: AssetWriteRequest,
    existing: Asset[],
    // WP-FB-IMPORT-BROKER-01 D-04: optional D-04 collision check. When supplied,
    // a request that would create a manual Asset colliding with an imported
    // Holding is refused. The existing Asset type, AssetWriteRequest interface,
    // and compose() whitelist are NOT modified.
    holdingsForCollisionCheck: readonly Holding[] = []
  ): AssetWritePlan {
    const name = this.requireName(request?.name);
    const amount = this.requireAmount(request?.amount);

    // D-04 collision check (optional, no-op if no holdings supplied).
    if (holdingsForCollisionCheck.length > 0) {
      const collision = HoldingAssetCollisionGuard.detect(
        request as AssetWriteRequestWithCollisionIdentity,
        holdingsForCollisionCheck
      );
      if (collision) {
        throw new AssetLifecycleError(
          'HOLDING_COLLISION',
          collision.reason
        );
      }
    }

    let id: string;
    if (AssetIdentityService.isValidId(request?.id) && String(request.id).trim() !== '') {
      id = String(request.id).trim();
      if (existing.some(a => a.id === id)) {
        throw new AssetLifecycleError(
          'DUPLICATE_ID',
          'An asset with that identity already exists. Edit it instead of creating a second one.'
        );
      }
    } else {
      id = AssetIdentityService.generateId();
    }

    const asset = this.compose(id, request, name, amount);
    return { asset, next: [...existing, asset] };
  }

  /**
   * EDIT. Addressed by `id`, NEVER by name, replacing the COMPLETE record.
   *
   * Identity is read from STORAGE, not from the request, so a forged or padded
   * id can never become the stored id (H3, H5). A target that is not present
   * REFUSES rather than appending (H4).
   *
   * A rename to a name another asset already uses is ALLOWED: duplicate names
   * are permitted by Q-D07b-1a = (c).
   */
  static planUpdate(
    request: AssetWriteRequest,
    existing: Asset[],
    // WP-FB-IMPORT-BROKER-01 D-04: optional D-04 collision check. When supplied,
    // a request that would update a manual Asset into a position colliding with
    // an imported Holding is refused.
    holdingsForCollisionCheck: readonly Holding[] = []
  ): AssetWritePlan {
    const id = this.requireId(request?.id);
    const index = this.requireIndex(id, existing);
    const name = this.requireName(request?.name);
    const amount = this.requireAmount(request?.amount);

    // D-04 collision check (optional, no-op if no holdings supplied).
    if (holdingsForCollisionCheck.length > 0) {
      const collision = HoldingAssetCollisionGuard.detect(
        request as AssetWriteRequestWithCollisionIdentity,
        holdingsForCollisionCheck
      );
      if (collision) {
        throw new AssetLifecycleError(
          'HOLDING_COLLISION',
          collision.reason
        );
      }
    }

    const asset = this.compose(existing[index].id as string, request, name, amount);
    const next = [...existing];
    next[index] = asset;
    return { asset, next };
  }

  /**
   * DELETE (Q-D07b-1b = (b)). Physical, by `id`, exactly one row.
   *
   * The account link is cleared by the repository in the SAME write; this
   * planner only decides which asset goes. Refuses an id that is not present
   * rather than silently succeeding.
   */
  static planDelete(id: string, existing: Asset[]): AssetDeletePlan {
    const targetId = this.requireId(id);
    const index = this.requireIndex(targetId, existing);
    const target = existing[index];
    return { id: targetId, target, next: existing.filter((_, i) => i !== index) };
  }

  /* ── duplicate-name support (Q-D07b-1a = (c)) ─────────────────────────────
     Duplicates are permitted, so the product owes the user a way to tell them
     apart. These helpers are the single definition of "shares a name" and of
     "what distinguishes this one", used by every surface that lists or offers
     assets, so the table and the account-link selector cannot disagree. */

  /** Normalised names held by more than one asset. Reporting only. */
  static findDuplicateNames(existing: Asset[]): string[] {
    const counts = new Map<string, number>();
    for (const a of existing) {
      const n = AssetIdentityService.normalizeName(a?.name);
      if (n === '') continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    return [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort();
  }

  /** True when another asset shares this one's normalised name. */
  static isAmbiguous(asset: Asset, existing: Asset[]): boolean {
    const n = AssetIdentityService.normalizeName(asset?.name);
    if (n === '') return false;
    return existing.filter(a => AssetIdentityService.normalizeName(a?.name) === n).length > 1;
  }

  /**
   * A short, human distinguishing detail for an asset that shares its name.
   *
   * The 07b gate measured the hard case: three "Gold" rows produced only TWO
   * distinct `name|type|currency|geography` fingerprints — one pair was
   * indistinguishable by metadata, differing only in amount. So this falls
   * back through metadata and ends at the id, which is always unique. It is
   * never shown for an unambiguous asset: an id in the UI is noise until it is
   * the only thing that disambiguates.
   */
  static describeDistinguishing(asset: Asset, existing: Asset[]): string | null {
    if (!this.isAmbiguous(asset, existing)) return null;

    const sameName = existing.filter(
      a => AssetIdentityService.normalizeName(a?.name) === AssetIdentityService.normalizeName(asset?.name)
    );

    const facets: Array<[string, unknown]> = [
      ['type', asset.type],
      ['tag', asset.tag],
      ['geography', asset.geography],
      ['currency', asset.currency]
    ];
    // The first facet whose value is unique among the same-named assets.
    for (const [label, value] of facets) {
      if (value === undefined || value === null || value === '') continue;
      const shares = sameName.filter(a => (a as any)[label] === value).length;
      if (shares === 1) return String(value);
    }

    // Metadata cannot separate them — fall back to the identity, abbreviated.
    const id = String(asset.id ?? '');
    return id ? `ref ${id.slice(0, 10)}` : null;
  }

  /** The exact wording the UI must confirm with before a delete. */
  static describeDeletion(target: Asset, linkedAccountName?: string | null): string {
    const base = `Delete "${target.name}" (${target.amount})? This cannot be undone.`;
    return linkedAccountName
      ? `${base}\n\nThe link to the account "${linkedAccountName}" will also be cleared. The account, its transactions and its balance are not affected.`
      : base;
  }
}
