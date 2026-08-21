import { Asset } from '../domain/types';

/* =============================================================================
 * ASSET IDENTITY (WP-FB-DATA-04c-1)
 *
 * Assets historically had no identity of their own: `name` served as both the
 * display label and the key, in memory (`findIndex(a => a.name === …)`) and in
 * IndexedDB (`createObjectStore('assets', { keyPath: 'name' })`). DATA-04
 * established that mutable, user-editable display names are not safe keys.
 *
 * This module introduces `Asset.id` as the authoritative persisted identity.
 *
 * SCOPE. Identity only. No Account<->Asset link, no Essentials/B5 change, no
 * NET_WORTH change. `id` never enters search text, display, financial
 * calculations or transaction fingerprints.
 *
 * SAFETY. Migration is deterministic, idempotent and lossless:
 *   - N records in  ->  N records out; never merged, never dropped;
 *   - only `id` is written; name/amount/type/tag/currency/geography untouched;
 *   - a record that already has a valid id keeps it;
 *   - duplicate normalised names stay SEPARATE assets with DISTINCT ids and are
 *     reported AMBIGUOUS - they are never merged;
 *   - blank/invalid names are preserved and reported, never deleted.
 * ========================================================================== */

export type AssetIdentityClass = 'MATCHED' | 'AMBIGUOUS' | 'UNMAPPED' | 'PRESERVED';

export interface AssetIdentityRow {
  id: string;
  name: string;
  normalized: string;
  classification: AssetIdentityClass;
}

export interface AssetMigrationResult {
  assets: Asset[];
  /** Records that received a newly generated id. */
  assigned: number;
  /** Records that already carried a valid id and were left untouched. */
  preserved: number;
  /** Records sharing a normalised name with another record. Never merged. */
  ambiguous: number;
  /** Records with a blank/unusable name. Preserved, never deleted. */
  invalid: number;
  rows: AssetIdentityRow[];
}

export interface AssetMigrationVerification {
  ok: boolean;
  failures: string[];
  countBefore: number;
  countAfter: number;
  uniqueIds: number;
}

/** Fields whose values must survive migration exactly. */
const PRESERVED_FIELDS = ['name', 'amount', 'type', 'tag', 'currency', 'geography'] as const;

export class AssetIdentityService {
  /**
   * Stable, unique, non-user-editable id.
   * Prefers dependency-free `crypto.randomUUID()`; falls back to the existing
   * project convention (`<prefix>-<timestamp>-<random>`) used for accounts,
   * policies and goals. No dependency is introduced either way.
   */
  static generateId(): string {
    const c: any = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return `ast-${c.randomUUID()}`;
    return `ast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Comparison form used ONLY for reporting ambiguity - never for merging. */
  static normalizeName(name: string | null | undefined): string {
    if (!name) return '';
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  static isValidId(id: unknown): id is string {
    return typeof id === 'string' && id.trim().length > 0;
  }

  /**
   * Assigns ids to assets that lack one. Pure: the input array and its
   * elements are never mutated.
   */
  static migrate(assets: Asset[]): AssetMigrationResult {
    // Count normalised names first so ambiguity can be reported accurately.
    const nameCounts = new Map<string, number>();
    for (const a of assets) {
      const n = this.normalizeName(a?.name);
      nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    }

    const seenIds = new Set<string>();
    let assigned = 0;
    let preserved = 0;
    let ambiguous = 0;
    let invalid = 0;
    const rows: AssetIdentityRow[] = [];

    const migrated = assets.map(asset => {
      const normalized = this.normalizeName(asset?.name);
      const isInvalidName = normalized === '';
      const isDuplicateName = !isInvalidName && (nameCounts.get(normalized) || 0) > 1;

      let id: string;
      let classification: AssetIdentityClass;

      if (this.isValidId((asset as Asset).id) && !seenIds.has((asset as Asset).id!)) {
        // Already identified - preserve exactly (idempotency).
        id = (asset as Asset).id!;
        classification = 'PRESERVED';
        preserved++;
      } else {
        id = this.generateId();
        // Guard against an astronomically unlikely collision.
        while (seenIds.has(id)) id = this.generateId();
        assigned++;
        classification = isInvalidName ? 'UNMAPPED' : isDuplicateName ? 'AMBIGUOUS' : 'MATCHED';
      }

      if (isInvalidName) invalid++;
      else if (isDuplicateName) ambiguous++;

      seenIds.add(id);
      rows.push({ id, name: asset?.name ?? '', normalized, classification });

      // ONLY `id` is written. Every other field is carried through untouched.
      return { ...asset, id };
    });

    return { assets: migrated, assigned, preserved, ambiguous, invalid, rows };
  }

  /**
   * Verifies a migration was lossless. Used by the IndexedDB upgrade path
   * before the result is accepted.
   */
  static verify(before: Asset[], after: Asset[]): AssetMigrationVerification {
    const failures: string[] = [];

    if (before.length !== after.length) {
      failures.push(`record count changed: ${before.length} -> ${after.length}`);
    }

    const ids = after.map(a => a.id);
    const uniqueIds = new Set(ids.filter(Boolean)).size;
    if (ids.some(i => !this.isValidId(i))) failures.push('one or more records lack a valid id');
    if (uniqueIds !== after.length) failures.push(`ids are not unique: ${uniqueIds} unique of ${after.length}`);

    // Positional comparison: migrate() preserves order, so index i must match.
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) {
      for (const f of PRESERVED_FIELDS) {
        const b = (before[i] as any)?.[f];
        const a = (after[i] as any)?.[f];
        if (b !== a) failures.push(`record ${i} field "${f}" changed: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      countBefore: before.length,
      countAfter: after.length,
      uniqueIds
    };
  }
}
