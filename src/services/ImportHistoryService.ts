/**
 * FINBOOM-CR (CR-04) — In-memory Import History service.
 *
 * Records a small audit entry each time a broker or bank import
 * completes (success, partial, or failure). The history is
 * **in-memory only** — no IndexedDB schema change is required
 * for the CR (per the spec's explicit non-goal: "no IndexedDB
 * schema change unless an implementation gate proves an
 * existing schema change is strictly required").
 *
 * The service is intentionally simple:
 *   - `record(...)`: append a new entry; returns the entry.
 *   - `list()`: snapshot of all entries, reverse-chronological
 *     (newest first). The list is a defensive copy.
 *   - `clear()`: empty the in-memory array. Provided for tests
 *     and for an explicit user action (e.g. "Clear history").
 *
 * The history is reset on a full page reload (the in-memory
 * array is gone). This is acceptable for the CR's audit purpose
 * because the canonical Holdings / Transactions ledgers are
 * persisted via their own mechanisms and the Import History
 * itself is not the source of truth for any reconciliation.
 *
 * The recording sites are the caller sites of the canonical
 * lifecycle (BrokerImportSection for broker import; ImportPage
 * for bank import COMMIT step). This service is NOT called from
 * inside any MUST-NOT-CHANGE service (canonical ledger,
 * HoldingWealthBridge, HoldingIdentityService,
 * HoldingLifecycleService, BrokerImportService, etc.) — that
 * would be an unauthorised widening of the integration surface.
 *
 * Required fields per CR-04:
 *   - `id` (generated `imp-<uuid>`)
 *   - `timestamp` (ISO 8601 at record time)
 *   - `importType` ('BROKER_HOLDINGS' | 'BANK_STATEMENT' | 'STANDARD_IMPORT')
 *   - `institution` (e.g. "Zerodha", "Dhan", "Angel One", "HDFC Bank",
 *      "Standard Import")
 *   - `sourceFilename` (the file as uploaded)
 *   - `result` ('success' | 'partial' | 'failure')
 *   - `processedCount` (total rows the import saw)
 *   - `importedCount` (rows successfully committed)
 *   - `rejectedCount` (rows rejected by validation / lifecycle)
 *   - `errorSummary` (short string descriptions of the first
 *      N rejections; bounded to keep the array small)
 *
 * FINBOOM-CR (CR-STANDARD-IMPORT) — extended the closed union to
 * include `STANDARD_IMPORT` for the Requirement #1 Standard Import
 * flow. Authorized in
 * `FINBOOM-REQUIREMENT-1-STANDARD-IMPORT-IMPLEMENTATION-AUTHORITY-REPORT.md`
 * (Q7 disposition = AUTHORIZED).
 */

/**
 * Discriminator for the kind of import. The CR-04 spec defined
 * exactly two values: `BROKER_HOLDINGS` (broker import) and
 * `BANK_STATEMENT` (bank statement import). The CR-STANDARD-IMPORT
 * authority added a third value: `STANDARD_IMPORT`.
 */
export type ImportHistoryType = 'BROKER_HOLDINGS' | 'BANK_STATEMENT' | 'STANDARD_IMPORT';

/**
 * Result of the import. The CR-04 spec defines three values:
 *   - `success`: all rows processed and committed, no rejections
 *   - `partial`: some rows processed and committed, some rejected
 *   - `failure`: nothing was committed (all rows rejected, or
 *      the import was aborted before any commit)
 */
export type ImportHistoryResult = 'success' | 'partial' | 'failure';

/**
 * A single Import History entry.
 */
export interface ImportHistoryEntry {
  /** Generated id (`imp-<uuid>`); stable for the entry's lifetime. */
  id: string;
  /** ISO 8601 timestamp at record time. */
  timestamp: string;
  /** The kind of import (broker or bank). */
  importType: ImportHistoryType;
  /** The institution / broker / bank name (e.g. "Zerodha", "HDFC Bank"). */
  institution: string;
  /** The source filename as uploaded. */
  sourceFilename: string;
  /** The outcome of this import. */
  result: ImportHistoryResult;
  /** Total rows the import saw (parser-level). */
  processedCount: number;
  /** Rows successfully committed. */
  importedCount: number;
  /** Rows rejected (validation / lifecycle failures). */
  rejectedCount: number;
  /** Short descriptions of the first N rejections. */
  errorSummary: string[];
}

/**
 * Parameters for `ImportHistoryService.record()`. All fields are
 * required. Callers must compute the result and counts from their
 * own outcome data; the service does NOT inspect the import
 * pipeline.
 */
export interface ImportHistoryRecordInput {
  importType: ImportHistoryType;
  institution: string;
  sourceFilename: string;
  result: ImportHistoryResult;
  processedCount: number;
  importedCount: number;
  rejectedCount: number;
  errorSummary?: string[];
}

/**
 * In-memory Import History service. The class is a thin wrapper
 * over a module-scoped array; the methods are static because
 * there is no per-instance state. The `importHistory` array is
 * intentionally NOT exposed as public state; it is only mutated
 * via the static methods.
 */
export class ImportHistoryService {
  /**
   * Append a new entry to the in-memory history. Returns the
   * stored entry (with generated id and timestamp).
   *
   * Inputs are validated: `processedCount`, `importedCount`, and
   * `rejectedCount` are clamped to non-negative integers; an
   * empty `errorSummary` defaults to `[]`; `errorSummary` is
   * truncated to at most `MAX_ERROR_SUMMARY` items.
   */
  static record(input: ImportHistoryRecordInput): ImportHistoryEntry {
    const sanitized: ImportHistoryEntry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      importType: input.importType,
      institution: String(input.institution ?? '').trim(),
      sourceFilename: String(input.sourceFilename ?? '').trim(),
      result: input.result,
      processedCount: this.sanitizeCount(input.processedCount),
      importedCount: this.sanitizeCount(input.importedCount),
      rejectedCount: this.sanitizeCount(input.rejectedCount),
      errorSummary: this.sanitizeErrorSummary(input.errorSummary ?? []),
    };
    importHistory.push(sanitized);
    return sanitized;
  }

  /**
   * Return a snapshot of all entries in reverse-chronological
   * order (newest first). The returned array is a defensive
   * copy; mutating it does not affect the underlying history.
   */
  static list(): ImportHistoryEntry[] {
    // Reverse copy: the most recent entry is at the end of the
    // internal array (we push on record), so we reverse for
    // display.
    return importHistory.slice().reverse().map((e) => ({ ...e, errorSummary: e.errorSummary.slice() }));
  }

  /**
   * Return the number of entries currently in the in-memory
   * history. Provided for tests and for "Clear" affordance
   * confirmation.
   */
  static size(): number {
    return importHistory.length;
  }

  /**
   * Empty the in-memory history. Provided for tests (to make
   * test cases hermetic) and for an explicit "Clear history"
   * user action.
   */
  static clear(): void {
    importHistory.length = 0;
  }

  // -------------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------------

  private static generateId(): string {
    // Generate an `imp-<uuid>` style id. Uses the same UUID v4
    // pattern as `HoldingIdentityService` for consistency.
    // `globalThis.crypto` is available in modern browsers and
    // Node 18+; fall back to a Math.random-based id for safety
    // in non-crypto environments (test runners etc.).
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') {
      return `imp-${c.randomUUID()}`;
    }
    // Fallback (defensive; this branch should not execute in
    // modern test runners or browsers).
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    const r = new Uint8Array(16);
    for (let i = 0; i < 16; i++) r[i] = Math.floor(Math.random() * 256);
    r[6] = (r[6] & 0x0f) | 0x40; // version 4
    r[8] = (r[8] & 0x3f) | 0x80; // variant
    const id = [
      hex(r[0]) + hex(r[1]) + hex(r[2]) + hex(r[3]),
      hex(r[4]) + hex(r[5]),
      hex(r[6]) + hex(r[7]),
      hex(r[8]) + hex(r[9]),
      hex(r[10]) + hex(r[11]) + hex(r[12]) + hex(r[13]) + hex(r[14]) + hex(r[15]),
    ].join('-');
    return `imp-${id}`;
  }

  private static sanitizeCount(n: number): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    return Math.floor(n);
  }

  private static sanitizeErrorSummary(summary: string[]): string[] {
    if (!Array.isArray(summary)) return [];
    // Cap at MAX_ERROR_SUMMARY (10) and coerce each entry to a
    // trimmed string. Empty strings are dropped.
    const out: string[] = [];
    for (const item of summary) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed === '') continue;
      out.push(trimmed);
      if (out.length >= MAX_ERROR_SUMMARY) break;
    }
    return out;
  }
}

/** Maximum number of error-summary items stored per entry. */
const MAX_ERROR_SUMMARY = 10;

// Module-scoped in-memory array. The history is reset on full
// page reload. The class is the only API that mutates this
// array; direct mutation from outside is a violation of the
// service contract.
const importHistory: ImportHistoryEntry[] = [];
