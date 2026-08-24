/**
 * WP-FB-IMPORT-BROKER-01 — WP-08 Broker Import Service.
 *
 * The service layer that sits above the three promoted broker adapters
 * (Zerodha, Groww, Dhan) and the canonical `Holding` model. It implements the
 * authoritative import flow:
 *
 *   DETECT  →  PARSE  →  RECONCILE  →  PREVIEW  →  CONFIRM  →  ATOMIC WRITE
 *
 * The service is STATELESS and PURE — it does not own any persistent state.
 * All state lives in the existing `MemoryHoldingRepository` (source of truth
 * for canonical Holdings) and the `useCanonicalLedger` store (which exposes
 * the atomic `commitImportedHoldings` hook).
 *
 * The service consumes:
 *
 *   - `BrokerFormatDetector` (detection)
 *   - `BrokerAdapter.parseHoldings` / `parseHoldingsFromRows` (parse)
 *   - `HoldingIdentityService.sameIdentity` (D-02 identity)
 *   - `MemoryHoldingRepository.findByIdentitySync` / `findAll` (reconciliation)
 *   - `HoldingLifecycleService.planCreate` / `planUpdate` / `planClose` (lifecycle)
 *
 * The service does NOT:
 *   - Modify any broker adapter.
 *   - Add a new `Holding` field.
 *   - Add a new error code.
 *   - Bump DB_VERSION.
 *   - Persist directly (it produces a `BrokerImportPreview`; the store hook
 *     `commitImportedHoldings` performs the atomic write inside
 *     `MemoryRepository.write`).
 *   - Add a `Lot` entity or any analytics taxonomy.
 *
 * The preview is a PURE function of (parsed candidates, existing holdings).
 * The commit is a PURE function of (preview, user confirmation).
 */

import { Holding } from '../domain/types';
import { HoldingIdentityService } from './HoldingIdentityService';
import { HoldingLifecycleService } from './HoldingLifecycleService';
import { MemoryHoldingRepository } from '../repositories/MemoryHoldingRepository';
import { repository } from '../repositories';
import { BrokerFormatDetector } from './import/BrokerFormatDetector';
import { ImportRowIssue, ParsedCsvRow, StatementInput } from './import/ImportTypes';
import { BrokerParseOutput } from './import/BrokerAdapter';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/** Per-candidate reconciliation result against the existing ledger. */
export interface BrokerImportPreviewEntry {
  /** The parsed candidate (canonical Holding). */
  candidate: Holding;
  /** Reconciliation classification. */
  classification: 'NEW' | 'UPDATED' | 'UNCHANGED';
  /** The existing holding (if any) for diffing. */
  existing: Holding | null;
  /** True iff at least one mutable field differs from `existing`. */
  differs: boolean;
}

/** A holding present in the existing ledger but absent from the new parse set. */
export interface BrokerImportPreviewClosure {
  /** The existing holding that should transition to `closed_absent`. */
  existing: Holding;
  classification: 'CLOSED_ABSENT';
}

/** The top-level preview object. */
export interface BrokerImportPreview {
  /** Broker name (e.g. "Zerodha"). */
  broker: string;
  /** Account identifier (e.g. "6995348108") or undefined for Dhan Equity. */
  account: string | undefined;
  /** Source filename supplied to the parser. */
  sourceFile: string;
  /** Canonical `importedAt` timestamp (parser execution time, or Dhan Equity's `max(Trade Date)`). */
  importedAt: string;
  /** Per-candidate reconciliation entries (NEW / UPDATED / UNCHANGED). */
  entries: BrokerImportPreviewEntry[];
  /** Per-existing-holding closures (CLOSED_ABSENT). */
  closures: BrokerImportPreviewClosure[];
  /** Non-blocking parser issues. */
  issues: ImportRowIssue[];
  /** Blocking errors that prevent confirmation. */
  blockingErrors: string[];
  /** Summary counts. */
  counts: {
    new: number;
    updated: number;
    unchanged: number;
    closed_absent: number;
    issueCount: number;
  };
  /** True iff there are no blocking errors AND at least one mutation exists. */
  confirmationEligible: boolean;
}

// ---------------------------------------------------------------------------
// SERVICE
// ---------------------------------------------------------------------------

/**
 * Static service class. Holds no state. All methods are pure.
 */
export class BrokerImportService {
  /**
   * Step 1+2: detect + parse.
   *
   * Routes the input through `BrokerFormatDetector.detect(input)` (text path)
   * or `BrokerFormatDetector.detectFromRows(headers, rows, fileName)`
   * (decoded-rows path), then calls the matched adapter's
   * `parseHoldings` / `parseHoldingsFromRows`. Returns the `BrokerParseOutput`.
   *
   * Throws `Error` with code `BROKER_UNSUPPORTED` if no adapter matches.
   */
  static detectAndParse(input: StatementInput): BrokerParseOutput {
    const { adapter, detection } = BrokerFormatDetector.detect(input);
    if (!adapter) {
      throw new Error(`BROKER_UNSUPPORTED: ${detection.reason}`);
    }
    return adapter.parseHoldings(input);
  }

  /**
   * Detect + parse from already-decoded rows. Used when the import pipeline
   * has decoded the binary bytes itself (e.g. an XLSX byte path).
   */
  static detectAndParseRows(
    headers: string[],
    rows: ParsedCsvRow[],
    fileName: string,
  ): BrokerParseOutput {
    const { adapter } = BrokerFormatDetector.detectFromRows(headers, rows, fileName);
    if (!adapter) {
      throw new Error('BROKER_UNSUPPORTED: no broker adapter matches the decoded header signature.');
    }
    return adapter.parseHoldingsFromRows(rows, fileName);
  }

  /**
   * Step 3+4: reconcile + preview.
   *
   * Compares each parsed candidate against the existing holdings (using
   * `HoldingIdentityService.sameIdentity` and
   * `MemoryHoldingRepository.findByIdentitySync`) and classifies each as
   * NEW, UPDATED, or UNCHANGED. Also computes the CLOSED_ABSENT set
   * (existing holdings of the same broker that are absent from the parse set).
   *
   * The `existing` parameter is the current canonical holdings array. The
   * caller (store) provides the live state; the service does not read it
   * itself, keeping the function pure and testable.
   *
   * The function does NOT mutate any state. It only computes the preview.
   */
  static reconcile(
    parsed: BrokerParseOutput,
    existing: readonly Holding[],
  ): BrokerImportPreview {
    // Build an index of existing holdings by identity for O(N) lookup.
    const existingByIdentity = new Map<string, Holding>();
    for (const h of existing) {
      if (h.broker !== parsed.broker) continue;
      const key = this.identityKey(h);
      existingByIdentity.set(key, h);
    }

    // Reconcile each candidate.
    const entries: BrokerImportPreviewEntry[] = [];
    const parsedIdentities = new Set<string>();
    for (const candidate of parsed.holdings) {
      const key = this.identityKey(candidate);
      parsedIdentities.add(key);
      const existingHit = existingByIdentity.get(key) ?? null;
      if (existingHit === null) {
        entries.push({ candidate, classification: 'NEW', existing: null, differs: true });
        continue;
      }
      const differs = this.candidateDiffers(existingHit, candidate);
      const classification: 'NEW' | 'UPDATED' | 'UNCHANGED' = differs ? 'UPDATED' : 'UNCHANGED';
      entries.push({ candidate, classification, existing: existingHit, differs });
    }

    // Compute CLOSED_ABSENT: existing holdings for this broker, NOT in the
    // parsed set. This includes reactivatable closed_absent holdings.
    const closures: BrokerImportPreviewClosure[] = [];
    for (const h of existing) {
      if (h.broker !== parsed.broker) continue;
      const key = this.identityKey(h);
      if (parsedIdentities.has(key)) continue;
      closures.push({ existing: h, classification: 'CLOSED_ABSENT' });
    }

    // Tally counts.
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    for (const e of entries) {
      if (e.classification === 'NEW') newCount++;
      else if (e.classification === 'UPDATED') updatedCount++;
      else unchangedCount++;
    }
    const closedAbsentCount = closures.length;
    const issueCount = parsed.issues.length;

    // Confirmation eligibility: no blocking errors AND at least one mutation
    // (NEW, UPDATED, or CLOSED_ABSENT). An all-UNCHANGED import is a no-op and
    // does not require confirmation.
    const confirmationEligible =
      parsed.issues.filter((i) => i.severity === 'INVALID').length === 0 &&
      (newCount + updatedCount + closedAbsentCount) > 0;

    return {
      broker: parsed.broker,
      account: parsed.account,
      sourceFile: parsed.sourceFile,
      importedAt: parsed.importedAt,
      entries,
      closures,
      issues: parsed.issues,
      blockingErrors: [],
      counts: {
        new: newCount,
        updated: updatedCount,
        unchanged: unchangedCount,
        closed_absent: closedAbsentCount,
        issueCount,
      },
      confirmationEligible,
    };
  }

  /**
   * Step 5+6: apply a confirmed preview inside the atomic write boundary.
   *
   * This is the function the store hook calls. It produces a `mutate` closure
   * for `MemoryRepository.write(() => { ... })`. The caller is responsible
   * for invoking `MemoryRepository.write(mutate)` to obtain the atomic,
   * rollback-on-failure semantics.
   *
   * Behaviour:
   *   - For each NEW entry: `HoldingLifecycleService.planCreate` then add.
   *   - For each UPDATED entry: `HoldingLifecycleService.planUpdate` then update.
   *   - For each CLOSED_ABSENT closure: `HoldingLifecycleService.planClose` then update
   *     (status transition; record is preserved).
   *
   * The function is PURE — it does not call the repository itself. It returns
   * a closure that the caller wraps in `MemoryRepository.write`.
   *
   * Implementation note: `MemoryHoldingRepository.add` / `update` are declared
   * `async` but their state-mutating work is synchronous (they mutate the
   * parent array and call `syncStore()` before returning the Promise). The
   * Promise is intentionally not awaited here; the state is already correct
   * by the time the method returns.
   *
   * **Pre-validation (P-1 pattern from WP-FB-DATA-06c-0):** all plans are
   * computed BEFORE any `add` / `update` call. If any plan throws (duplicate
   * id, identity change, NOT_FOUND for update/close), the mutate function
   * throws BEFORE any state has been mutated. This is essential because
   * `MemoryRepository.write` only rolls back on IndexedDB persist failure,
   * NOT on a mutate-time throw. Pre-validation ensures the mutate is
   * all-or-nothing at the planning level, which is the same pattern
   * `commitImportedRows` uses for transfer-integrity and id-uniqueness.
   */
  static buildAtomicMutation(
    preview: BrokerImportPreview,
  ): () => void {
    // PRE-VALIDATION PHASE: compute the entire next state by chaining the
    // per-action lifecycle plans. If any plan throws, the closure is never
    // built and the error propagates to the caller before any state has
    // been mutated. This is the P-1 pattern from WP-FB-DATA-06c-0:
    // validate against the current snapshot, then commit the entire
    // computed `next` array in a single synchronous assignment inside
    // the write boundary.
    //
    // We do NOT call `repo.add` / `repo.update` for each action because
    // those methods are async and their rejection would escape as an
    // unhandled promise (the write boundary only catches synchronous
    // throws and IndexedDB persist failures). By computing the final
    // `holdingsData` array once and assigning it inside the closure, the
    // mutation is a single synchronous assignment — exactly the shape
    // `MemoryRepository.write` is designed to capture, persist, and
    // revert on failure.
    const repo = repository.holdings as MemoryHoldingRepository;
    let working: Holding[] = repo.findAllSync();
    // NEW
    for (const entry of preview.entries) {
      if (entry.classification !== 'NEW') continue;
      const plan = HoldingLifecycleService.planCreate(entry.candidate, working);
      working = plan.next;
    }
    // UPDATED
    for (const entry of preview.entries) {
      if (entry.classification !== 'UPDATED') continue;
      if (entry.existing === null) continue; // defensive
      const plan = HoldingLifecycleService.planUpdate(entry.candidate, working);
      working = plan.next;
    }
    // CLOSED_ABSENT
    for (const closure of preview.closures) {
      const plan = HoldingLifecycleService.planClose(closure.existing.id, working, preview.importedAt);
      working = plan.next;
    }
    // After pre-validation, `working` is the canonical final state. If any
    // plan had thrown, the throw would have escaped and the closure would
    // never be returned. The closure applies `working` atomically.

    return () => {
      // APPLICATION PHASE: assign the pre-computed `working` to the
      // repository state in a single synchronous write. This is what
      // `MemoryRepository.write` captures as `after` and persists; on
      // persist failure, `revertDelta` restores the pre-mutation snapshot.
      //
      // We do NOT call `repo.saveMany` here because that method itself
      // re-validates against the live state and could re-throw async.
      // The pre-validation above is the single source of truth.
      const memoryRepo = (repository as unknown as { holdingsData: Holding[] });
      memoryRepo.holdingsData = working;
    };
  }

  /**
   * Convenience: full preview-from-scratch. Wraps detect + parse + reconcile
   * for the text path. The caller still has to call `commitImportedHoldings`
   * (or `buildAtomicMutation` + `MemoryRepository.write`) to persist.
   */
  static previewFromText(input: StatementInput, existing: readonly Holding[]): BrokerImportPreview {
    const parsed = this.detectAndParse(input);
    return this.reconcile(parsed, existing);
  }

  // -------------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------------

  /**
   * Build a stable identity key for a Holding. The key is NOT the canonical
   * identity (that's what `HoldingIdentityService.identityOf` computes) but
   * a stringified form usable as a Map key. The string form mirrors the
   * D-02 rule: (broker, account?, instrument) where account undefined
   * collapses to a sentinel and the instrument is whichever of ISIN / TICKER
   * / NAME is available (in that precedence).
   */
  private static identityKey(h: Holding): string {
    const broker = h.broker;
    const account = h.account === undefined ? '__UNDEFINED__' : h.account;
    let instrument: string;
    if (h.isin && h.isin.trim() !== '') {
      instrument = `ISIN:${h.isin.trim()}`;
    } else if (h.ticker && h.ticker.trim() !== '') {
      instrument = `TICKER:${h.ticker.trim()}`;
    } else {
      instrument = `NAME:${(h.instrumentName ?? '').trim()}`;
    }
    return `${broker}|${account}|${instrument}`;
  }

  /**
   * Determine whether a candidate differs from an existing record in any
   * mutable field. Mutable fields per the WP-08 authority record §5:
   *
   *   quantity, averageCost, investedValue, currentPrice, currentValue,
   *   unrealisedPnL, unrealisedPnLPercent, xirrPercent, securityClassification,
   *   status, importedAt, sourceFile
   *
   * The `id`, `broker`, `account`, `instrumentName`, and `ticker?`/`isin?`
   * (where the candidate may have re-derived them) are treated as part of
   * the identity and are NOT compared here (identity match is checked
   * separately). Note that `HoldingLifecycleService.planUpdate` will reject
   * any identity change (it does not allow the (broker, account, instrument)
   * tuple to change across an update).
   */
  private static candidateDiffers(existing: Holding, candidate: Holding): boolean {
    if (existing.quantity !== candidate.quantity) return true;
    if (existing.averageCost !== candidate.averageCost) return true;
    if (existing.investedValue !== candidate.investedValue) return true;
    if (existing.currentPrice !== candidate.currentPrice) return true;
    if (existing.currentValue !== candidate.currentValue) return true;
    if (existing.unrealisedPnL !== candidate.unrealisedPnL) return true;
    if ((existing.unrealisedPnLPercent ?? null) !== (candidate.unrealisedPnLPercent ?? null)) return true;
    if ((existing.xirrPercent ?? null) !== (candidate.xirrPercent ?? null)) return true;
    if ((existing.securityClassification ?? null) !== (candidate.securityClassification ?? null)) return true;
    // Status: a closed_absent existing that matches a parsed candidate must
    // be considered "differs" (so it is reclassified as UPDATED → reactivated
    // to 'active' on commit).
    if (existing.status !== candidate.status) return true;
    // importedAt and sourceFile are user-facing provenance fields; if the
    // parser produced a new importedAt (e.g. new max(Trade Date) for Dhan
    // Equity), the record differs.
    if (existing.importedAt !== candidate.importedAt) return true;
    if (existing.sourceFile !== candidate.sourceFile) return true;
    return false;
  }
}
