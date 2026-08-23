import { Liability } from '../domain/types';

/* =============================================================================
 * LIABILITY IDENTITY (WP-FB-DATA-07)
 *
 * Liabilities were the LAST financial entity in FinBoom with no identity of
 * their own. `name` served as both the display label and the key — in memory
 * (`findIndex(l => l.name === …)`) and in IndexedDB
 * (`createObjectStore('liabilities', { keyPath: 'name' })`). Every other store
 * — transactions, assets, snapshots, accounts, budgets, policies, goals — was
 * already keyed on `id`.
 *
 * The consequence was measured at the 07 discovery gate:
 *
 *     add "Home Loan"  2,500,000
 *     add "Home Loan"    900,000
 *     result: ONE row at 900,000 — 2,500,000 destroyed, in memory, silently
 *
 * This module introduces `Liability.id` as the authoritative persisted
 * identity, exactly as WP-FB-DATA-04c-1 did for `Asset.id`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ SCOPE — IDENTITY ONLY. THE NAME-UPSERT IS DELIBERATELY PRESERVED.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It would be natural to assume that giving liabilities an id means writes
 * should become identity-based, so that adding the same name twice yields two
 * rows. The discovery gate measured why that would be a defect, not a fix:
 *
 *   There is NO liability edit UI, NO delete UI and NO removeLiability store
 *   action. Re-adding a liability under the same name IS the product's only
 *   correction mechanism. A user recording a paydown does exactly that.
 *
 *     today      re-add "Car Loan" 350,000  ->  total debt  350,000  (upsert)
 *     id-based   re-add "Car Loan" 350,000  ->  total debt  850,000  (append)
 *                                                net worth understated 500,000
 *
 * Decision Q-D07-1 = (c), two-step delivery: WP-FB-DATA-07 lays the identity
 * foundation with behaviour unchanged; WP-FB-DATA-07a adds Edit/Delete against
 * the stable id and only then refuses duplicate names. Nothing here may make
 * the create path append.
 *
 * ⚠️ DUPLICATE NAMES ARE NOT INVALID. Name uniqueness is a UX policy for 07a to
 * settle, not a domain truth — two lenders can legitimately both be a
 * "Personal Loan", and the nine-member `LiabilityType` vocabulary cannot tell
 * them apart. This service therefore keeps duplicate-named records SEPARATE
 * with DISTINCT ids and merely REPORTS them as ambiguous.
 *
 * SAFETY. Migration is deterministic, idempotent and lossless:
 *   - N records in  ->  N records out; never merged, never dropped;
 *   - only `id` is written; name/amount/type/currency untouched;
 *   - a record that already has a valid id keeps it;
 *   - duplicate normalised names stay SEPARATE with DISTINCT ids, reported
 *     AMBIGUOUS — they are never merged;
 *   - blank/invalid names are preserved and reported, never deleted.
 * ========================================================================== */

export type LiabilityIdentityClass = 'MATCHED' | 'AMBIGUOUS' | 'UNMAPPED' | 'PRESERVED';

export interface LiabilityIdentityRow {
  id: string;
  name: string;
  normalized: string;
  classification: LiabilityIdentityClass;
}

export interface LiabilityMigrationResult {
  liabilities: Liability[];
  /** Records that received a newly generated id. */
  assigned: number;
  /** Records that already carried a valid id and were left untouched. */
  preserved: number;
  /** Records sharing a normalised name with another record. Never merged. */
  ambiguous: number;
  /** Records with a blank/unusable name. Preserved, never deleted. */
  invalid: number;
  rows: LiabilityIdentityRow[];
}

export interface LiabilityMigrationVerification {
  ok: boolean;
  failures: string[];
  countBefore: number;
  countAfter: number;
  uniqueIds: number;
}

/**
 * Fields whose values must survive migration exactly.
 *
 * This is the whole of `Liability` apart from `id`. If a field is ever added to
 * the interface it must be added here too, or migration could silently drop it.
 */
const PRESERVED_FIELDS = ['name', 'amount', 'type', 'currency'] as const;

export class LiabilityIdentityService {
  /**
   * Stable, unique, non-user-editable id.
   *
   * Prefers dependency-free `crypto.randomUUID()`; falls back to the existing
   * project convention (`<prefix>-<timestamp>-<random>`) used for accounts,
   * assets, policies and goals. No dependency is introduced either way.
   */
  static generateId(): string {
    const c: any = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return `lia-${c.randomUUID()}`;
    return `lia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Comparison form used ONLY for reporting ambiguity — never for merging. */
  static normalizeName(name: string | null | undefined): string {
    if (!name) return '';
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  static isValidId(id: unknown): id is string {
    return typeof id === 'string' && id.trim().length > 0;
  }

  /** Assigns an id when absent; returns the record unchanged when present. */
  static ensureId(liability: Liability): Liability {
    return this.isValidId(liability?.id) ? liability : { ...liability, id: this.generateId() };
  }

  /**
   * Assigns ids to liabilities that lack one. Pure: the input array and its
   * elements are never mutated.
   */
  static migrate(liabilities: Liability[]): LiabilityMigrationResult {
    // Count normalised names first so ambiguity can be reported accurately.
    const nameCounts = new Map<string, number>();
    for (const l of liabilities) {
      const n = this.normalizeName(l?.name);
      nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    }

    const seenIds = new Set<string>();
    let assigned = 0;
    let preserved = 0;
    let ambiguous = 0;
    let invalid = 0;
    const rows: LiabilityIdentityRow[] = [];

    const migrated = liabilities.map(liability => {
      const normalized = this.normalizeName(liability?.name);
      const isInvalidName = normalized === '';
      const isDuplicateName = !isInvalidName && (nameCounts.get(normalized) || 0) > 1;

      let id: string;
      let classification: LiabilityIdentityClass;

      if (this.isValidId(liability?.id) && !seenIds.has(liability.id as string)) {
        // Already identified — preserve exactly (idempotency).
        id = liability.id as string;
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
      rows.push({ id, name: liability?.name ?? '', normalized, classification });

      // ONLY `id` is written. Every other field is carried through untouched.
      return { ...liability, id };
    });

    return { liabilities: migrated, assigned, preserved, ambiguous, invalid, rows };
  }

  /**
   * Verifies a migration was lossless. Used by the IndexedDB upgrade path
   * before the result is accepted — a failed verification ABORTS the upgrade
   * rather than recreating the store, so a bad migration can never destroy the
   * user's debt records.
   */
  static verify(before: Liability[], after: Liability[]): LiabilityMigrationVerification {
    const failures: string[] = [];

    if (before.length !== after.length) {
      failures.push(`record count changed: ${before.length} -> ${after.length}`);
    }

    const ids = after.map(l => l.id);
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
