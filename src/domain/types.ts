export type TransactionType = 'Income' | 'Expense' | 'Transfer' | 'INCOME' | 'EXPENSE' | 'TRANSFER';

/** Cash direction relative to the referenced account (WP-FB-DATA-04b). */
export type TransactionDirection = 'DEBIT' | 'CREDIT';

export type AccountType = 'SAVINGS' | 'CURRENT' | 'CREDIT_CARD' | 'CASH' | 'WALLET' | 'BROKERAGE' | 'OTHER';

export type FilterType = 'All' | TransactionType;

export type DateRangeFilter =
  | 'This Month'
  | 'Last Month'
  | 'Last 30 Days'
  | '3M'
  | '6M'
  | '12M'
  | 'YTD'
  | 'Custom'
  | 'ALL';

export type TransactionStatus = 'CLEARED' | 'PENDING' | 'RECONCILED' | 'ESTIMATED';

/**
 * Why a transaction is excluded from DERIVED FINANCIAL SURFACES
 * (WP-FB-DATA-06c-1 / 06c-2; Decisions 13-b and D11 = B).
 *
 * ⚠️ ONE MEMBER PER RESOLVED DECISION, DELIBERATELY.
 *
 * Decision 13-b resolved the disposition of IMPORT ROLLBACK: rolled-back rows
 * are retained, marked, excluded from balances and reports, and remain visible
 * in the Ledger with an explicit disclosure. Decision D11 = B extended the
 * vocabulary by exactly one member for AMENDMENT.
 *
 * Adding a member is not a refactor — it is the act of resolving the
 * corresponding lifecycle decision. The exclusion MECHANISM is decision-free;
 * this vocabulary is the ledger of which decisions have actually been made.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEMBERSHIP LOG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   IMPORT_ROLLBACK  Decision 13-b (WP-FB-DATA-06c-6). A whole import batch was
 *                    rolled back; its rows are retained, marked and excluded.
 *
 *   SUPERSEDED       Decision D11 = B (WP-FB-DATA-06c-2). This row has been
 *                    amended: a CORRECTION row now carries the right figures and
 *                    points back here via `supersedes`. The original stays
 *                    pristine and visible; only its contribution to derived
 *                    money moves to the correction.
 *
 * ⚠️ STILL ABSENT, DELIBERATELY.
 * D11 = B explicitly resolved that `DELETED` is NOT added. There is also no
 * `REVERSED` or `AMENDED`: D6 (general undo) and D9 remain OPEN, and minting a
 * member for them here would resolve them by implication. `SUPERSEDED` covers
 * amendment and amendment only.
 */
export type LedgerExclusionReason = 'IMPORT_ROLLBACK' | 'SUPERSEDED';

/**
 * How a transaction entered the ledger (WP-FB-DATA-06a).
 *
 * Recorded explicitly at construction time. Never inferred from the presence of
 * `importBatchId` or any other adjacent field — see
 * `TransactionIdentityService.originOf`, which reports `'UNKNOWN'` for rows
 * persisted before this field existed rather than guessing.
 */
export type TransactionOrigin = 'MANUAL' | 'IMPORT';

export interface Transaction {
  id: string;
  dateStr: string;
  date: string;
  title: string;
  narration: string;
  /**
   * Presentation / legacy display text for the account.
   *
   * ⚠️ NOT the referential key. Use `accountId` for any account relationship.
   * Retained because it is part of the deduplication fingerprint
   * (`account|date|amount|narration`) and of the CSV export contract;
   * rewriting it would invalidate every existing fingerprint.
   */
  account: string;
  /**
   * Authoritative reference to `Account.id` (WP-FB-DATA-04).
   *
   * `null` / absent means the transaction is **explicitly unmapped** — it could
   * not be deterministically resolved to exactly one registered account, or the
   * account it referenced was deleted. Unmapped transactions remain fully
   * visible in the canonical Ledger and are flagged in the UI.
   */
  accountId?: string | null;
  /**
   * Explicit cash direction relative to `accountId` (WP-FB-DATA-04b).
   *
   *   DEBIT  -> money LEAVES the account  (signed contribution: -amount)
   *   CREDIT -> money ENTERS the account  (signed contribution: +amount)
   *
   * `amount` is always a positive magnitude; direction carries the sign.
   *
   * Required to make TRANSFERS derivable: a transfer is two rows sharing a
   * `transferId`, both `type: 'Transfer'` with the same positive `amount`.
   * Before this field the only distinction between the legs was string
   * convention (`-debit`/`-credit` id suffix, `TRANSFER-DEBIT/` narration),
   * so no balance could be derived without parsing text.
   *
   * Optional for Income/Expense, whose sign is unambiguous from `type`;
   * `TransactionSignService.signedAmount()` is the single authority and
   * falls back to `type` when direction is absent.
   */
  direction?: TransactionDirection;
  type: TransactionType;
  category: string;
  amount: number;
  status: TransactionStatus;
  notes?: string;
  transferId?: string;
  /**
   * ISO-8601 timestamp at which this row was excluded from derived financial
   * surfaces (WP-FB-DATA-06c-1). Absent = fully live.
   *
   * ⚠️ EXCLUDED IS NOT HIDDEN. Per DATA-02 ("records exist but are filtered —
   * never silently hidden") and Decision 13-b, an excluded row is removed from
   * balances and reports but REMAINS VISIBLE in the Ledger with a disclosure.
   * `LedgerExclusionService` is the single authority on this distinction.
   *
   * ⚠️ NOT `status`. Overloading `TransactionStatus` was measured and rejected:
   * five dividend consumers filter `status === 'CLEARED'` and would exclude the
   * row by accident, while `AccountBalanceService` does not filter status at all
   * and would keep counting the money — a ₹5,000 row simultaneously excluded
   * from income and included in the balance.
   */
  excludedAt?: string;
  /** Why it is excluded. See `LedgerExclusionReason`. */
  excludedReason?: LedgerExclusionReason;
  /**
   * ISO-8601 timestamp of the most recent IMPORT_ROLLBACK RESTORE
   * (WP-FB-DATA-06c-2b, Decision D6-3). Absent = never restored.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THIS FIELD EXISTS AT ALL
   * ─────────────────────────────────────────────────────────────────────────
   *
   * D6-3 requires that a restore must NOT erase the fact that a rollback
   * occurred, and that `rollback -> restore -> rollback` stays distinguishable
   * from a plain `rollback`.
   *
   * Before this field, `excludedAt` was the ONLY record that a rollback had
   * happened. Restore clears it, so the D6/D9 gate measured that
   * `rollback -> restore -> rollback` was unbounded and left no trace at all:
   * the final state was byte-identical to a batch rolled back once.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY EXACTLY ONE FIELD, AND WHY A TIMESTAMP RATHER THAN A LOG
   * ─────────────────────────────────────────────────────────────────────────
   *
   * Constraint 15 requires the MINIMUM representation that satisfies D6-3 and
   * explicitly forbids inventing a general audit framework. One optional
   * timestamp is provably sufficient, because restore is reachable only from
   * an IMPORT_ROLLBACK exclusion (Decision D6-1 = R5). Its presence therefore
   * PROVES a rollback happened and was undone:
   *
   *   excluded + no restoredAt   -> rolled back once, never restored
   *   not excluded + restoredAt  -> rolled back, then restored
   *   excluded + restoredAt      -> rolled back, restored, rolled back AGAIN
   *   not excluded + no restoredAt -> never rolled back
   *
   * All four states are distinguishable, which is exactly what D6-3 asks for.
   * A `lastRolledBackAt` companion would be redundant (it equals `excludedAt`
   * whenever the row is excluded, and adds nothing once it is not), and a
   * full event log would be the general audit framework constraint 15 forbids.
   *
   * ⚠️ NEVER CLEARED. `ImportBatchRollbackService.apply` spreads the existing
   * row, so a subsequent rollback preserves this automatically. Nothing in the
   * codebase may clear it — clearing it would re-create the very history loss
   * D6-3 exists to prevent.
   *
   * ⚠️ NOT A LIFECYCLE STATE. Whether a row counts is decided solely by
   * `excludedAt` via `LedgerExclusionService`. This field is history, not
   * state, and no derivation surface may read it.
   */
  restoredAt?: string;
  /**
   * BACKWARD supersession pointer (WP-FB-DATA-06c-2, Decisions D3 = B, D5 = C,
   * D10 = C).
   *
   * Present ONLY on a CORRECTION row, where it holds the `id` of the row this
   * one corrects. Absent on originals and on every row written before 06c-2 —
   * which is precisely why no migration is required.
   *
   * ⚠️ THE POINTER GOES BACKWARDS, DELIBERATELY (D10 = C).
   * A forward `supersededBy` on the original would mean the amendment write has
   * to mutate the original's linkage as well as its exclusion state, and every
   * later correction in a chain would have to re-mutate an earlier row. A
   * backward pointer is written once, by the row that is being created, and is
   * never touched again. The chain v1 <- v2 <- v3 is then append-only: the
   * original is left pristine apart from its exclusion stamp (D4 = D).
   *
   * ⚠️ NOT A GENERAL "RELATED TRANSACTION" FIELD. It means one thing: "this row
   * replaces that row's contribution to derived money". Reversal, refund and
   * linked-transaction semantics are NOT resolved (D6, D9 remain OPEN) and must
   * not be expressed here.
   */
  supersedes?: string;
  /**
   * The row's content no longer matches the source document it claims
   * (WP-FB-DATA-06c-2, Decision D4 = D).
   *
   * D4 = D resolved that a correction INHERITS the original's source provenance
   * — `sourceProvider`, `sourceFile`, `sourceRowNumber`, `importBatchId`,
   * `origin` — rather than being reborn as a manual row. That keeps the audit
   * trail intact: the money still traces to the statement it came from.
   *
   * But inherited provenance without a marker would be a LIE. The row would
   * claim "row 7 of SBI_Statement.xlsx says ₹4,000" when the statement says
   * ₹1,000 and a human changed it. This flag is the explicit divergence marker
   * D4 = D requires: provenance is inherited, and the row admits that its
   * figures are no longer what that provenance produced.
   *
   * Set UNCONDITIONALLY on every correction, including corrections of manual
   * rows. It reads: "the figures on this row were not produced by the process
   * named in `origin` — they were entered by an amendment." That is true of
   * every correction, so the flag never under-claims. A conditional marker
   * ("only when the original had a source file") would let a consumer read a
   * manual correction as pristine first-hand entry, which it is not.
   *
   * Absent (not `false`) on originals and on all legacy rows.
   */
  provenanceDiverged?: boolean;
  /**
   * How this row entered the ledger (WP-FB-DATA-06a).
   *
   * Absent on rows persisted before 06a. Absent is reported as `'UNKNOWN'` and
   * is never back-filled by inference.
   */
  origin?: TransactionOrigin;
  /**
   * ISO-8601 wall-clock timestamp of when this row entered the ledger
   * (WP-FB-DATA-06a).
   *
   * ⚠️ NOT a financial date. `date` is the value date — when the money moved.
   * `recordedAt` is when the application learned about it. An imported row can
   * have `date` in the past and `recordedAt` today; that gap is precisely what
   * an audit trail needs and what the pre-06a model could not express
   * (WP-FB-DATA-06 discovery §11: "import timestamp: ABSENT").
   *
   * Excluded from the fingerprint — two identical statement rows imported on
   * different days are still the same economic event.
   */
  recordedAt?: string;
  importBatchId?: string;
  sourceProvider?: string;
  sourceFile?: string;
  sourceRowNumber?: number;
  fingerprint?: string;
}

/** Controlled WP-17 asset category vocabulary (no | string escape hatch) */
export type AssetType =
  | 'Equity'
  | 'Debt'
  | 'Real Estate'
  | 'Commodities'
  | 'Cash & Savings'
  | 'Crypto'
  | 'Alternatives'
  | 'Other';

/** Controlled WP-17 liability loan vocabulary (no | string escape hatch) */
export type LiabilityType =
  | 'Home Loan'
  | 'Vehicle Loan'
  | 'Personal Loan'
  | 'Education Loan'
  | 'Credit Card'
  | 'Gold Loan'
  | 'Business Loan'
  | 'Friends / Family'
  | 'Other';

/** Controlled WP-17 geography exposure vocabulary */
export type GeographyType = 'India' | 'International' | 'Other';

export interface Asset {
  /**
   * Authoritative persisted identity (WP-FB-DATA-04c-1).
   *
   * Stable, unique and non-user-editable. Survives renames. This — not `name` —
   * is the key for storage and for any future reference to an asset.
   *
   * Optional in the type purely for backward compatibility with existing
   * construction sites such as `recordAsset({ name, amount })`; the repository
   * assigns one on write and migration assigns one on load, so every persisted
   * asset carries an id at rest.
   *
   * ⚠️ Must never appear in search text, user-facing display, financial
   * calculations, or transaction fingerprints.
   */
  id?: string;
  /** Display label. Mutable and user-editable — NOT an identity. */
  name: string;
  amount: number;
  type?: AssetType;
  tag?: string;
  currency?: string;      // Descriptive metadata only; no FX conversion
  geography?: GeographyType; // Explicit geography; not inferred from currency
}

export interface Liability {
  /**
   * Authoritative persisted identity (WP-FB-DATA-07).
   *
   * Stable, unique and non-user-editable. Survives renames. This — not `name` —
   * is the key for storage and for any future reference to a liability.
   *
   * Optional in the type purely for backward compatibility with existing
   * construction sites such as `recordLiability({ name, amount })`; the
   * repository assigns one on write and migration assigns one on load, so every
   * persisted liability carries an id at rest. This mirrors `Asset.id` exactly.
   *
   * ⚠️ Liabilities were the LAST entity keyed on a display string. Before this,
   * two liabilities named "Home Loan" collapsed into one and the first amount
   * was destroyed in memory — measured at ₹25,00,000.
   *
   * ⚠️ Adding an id does NOT make the create path append. Re-adding a liability
   * under the same name is still an in-place update, because that is the only
   * correction mechanism the product currently has (Decision Q-D07-1 = c,
   * step 1). WP-FB-DATA-07a changes that, and only after adding an Edit
   * affordance.
   *
   * ⚠️ Must never appear in search text, user-facing display or financial
   * calculations.
   */
  id?: string;
  name: string;
  amount: number;
  type?: LiabilityType;
  currency?: string;      // Descriptive metadata only; no FX conversion
}

export interface NetWorthSnapshot {
  id: string;
  dateStr: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  status: 'Active Preview' | 'Anchored Permanent' | 'Anchored';
  label?: string;         // Optional descriptive label for historical entries
}

export interface MonthBucket {
  yyyyMm: string;
  label: string;
  isMtd: boolean;
}

export interface FinancialMetric {
  metric: FinancialMetricName | string;
  value: number;
  currency: string;
  asOf: string;
  source: string;
  filters: Record<string, any>;
  formula: string;
  status: 'RECONCILED' | 'ESTIMATED' | 'NOT_CONFIGURED';
  displayLabel?: string;
}

export interface FinancialSeries {
  series: FinancialSeriesName | string;
  asOf: string;
  points: Array<{
    month: string;
    amount: number;
    payoutCount: number;
    isMtd: boolean;
  }>;
  source: string;
  filters: Record<string, any>;
  status: 'RECONCILED' | 'ESTIMATED';
}

export interface DateBounds {
  startDate: string;
  endDate: string;
}

export type FinancialMetricName =
  | 'NET_WORTH'
  | 'NET_WORTH_CAGR'
  | 'TTM_REALIZED_DIVIDEND'
  | 'MONTHLY_AVERAGE_DIVIDEND'
  | 'DIVIDEND_YIELD_TTM'
  | 'MTD_REALIZED_DIVIDEND'
  | 'EMERGENCY_FUND_COVERAGE'
  | 'ACTIVE_INSURANCE_POLICY_TOTAL'
  | 'SIP_COMMITMENT_MONTHLY'
  | 'EMERGENCY_FUND_GOAL';

export type FinancialSeriesName = 'MONTHLY_DIVIDEND_HISTOGRAM';

/**
 * Deterministic reference date for demo fixtures, historical snapshots and
 * tests that require a frozen point in time.
 *
 * ⚠️ This is NOT production "today". Use `getEffectiveAsOfDate()` from
 * `services/DateRangeService` for any live/production date decision.
 * Conflating the two caused WP-FB-DATA-01 (RC-L09): the Canonical Ledger
 * bounded every date range by this constant, permanently hiding every
 * transaction dated after 2026-08-09.
 */
export const APP_AS_OF_DATE = '2026-08-09';

export interface TransactionQuery {
  type?: 'Expense' | 'Income' | 'Transfer' | 'All';
  dateRange?: string;
  search?: string;
  customStart?: string | null;
  customEnd?: string | null;
  asOfDateStr?: string;
  /**
   * WP-FB-DATA-06c-1: include rows excluded from derived financial surfaces.
   *
   * Defaults to FALSE — fail-safe. A caller that forgets this flag gets the
   * financially conservative answer (excluded money stays out) rather than
   * silently double-counting. Display surfaces opt IN explicitly.
   */
  includeExcluded?: boolean;
}

export interface TransactionRepository {
  findMany(query: TransactionQuery): Promise<Transaction[]>;
  findManySync(query: TransactionQuery): Transaction[];
  findAll(): Promise<Transaction[]>;
  findAllSync(): Transaction[];
  append(transaction: Transaction): Promise<void>;
  appendMany(transactions: Transaction[]): Promise<void>;
  /**
   * WP-FB-DATA-06c-6 / Decision 13-b — rolls back an import batch by EXCLUDING
   * its rows, not removing them. Nothing is deleted; see
   * `ImportBatchRollbackService`. Rejects with `BatchRollbackError` when the
   * batch is unknown, empty, already rolled back, or when rolling it back would
   * exclude only part of a transfer.
   */
  rollbackBatch(importBatchId: string): Promise<BatchRollbackResultShape>;
  /**
   * WP-FB-DATA-06c-2b / Decision D6-1 = R5 — reverses an import-batch rollback
   * by CLEARING the IMPORT_ROLLBACK exclusion on that batch's rows.
   *
   * ⚠️ SCOPE, DELIBERATELY NARROW.
   *   - Whole batch only (D6-2). There is no per-row restore, by design.
   *   - IMPORT_ROLLBACK only (D6-1). A `SUPERSEDED` row is never restored: the
   *     D6/D9 gate measured that restoring one produced a persisted, silent,
   *     undisclosed double count (15,500 -> 20,500, two included versions).
   *   - It is NOT general undo (D6-7). It clears an exclusion; it retracts no
   *     business operation and disposes of no row.
   *
   * ⚠️ NOT NAMED `restore`. The name is `restoreBatch` for the same reason
   * `rollbackBatch` is not `removeBatch`: a bare `restore` would imply a
   * general capability that D6-7 explicitly withholds.
   *
   * Rejects with `BatchRestoreError` when the batch is unknown, was never
   * rolled back, has already been restored, carries an unrecognised exclusion
   * reason, or when restoring it would leave a transfer partly excluded.
   */
  restoreBatch(importBatchId: string): Promise<BatchRestoreResultShape>;
  /**
   * WP-FB-DATA-06c-2 / Decisions D3, D4, D5, D10, D11, D12 — the ONE atomic
   * amendment primitive.
   *
   * Supersedes each targeted row with a newly created correction, in a SINGLE
   * write. There is deliberately no separate "exclude the original" and "append
   * the correction" pair of calls: the 06c-2 gate measured that shape and
   * recorded a persisted intermediate state in which BOTH versions counted
   * (₹20,500 for a ₹15,500 ledger).
   *
   * A transfer must be amended whole — pass both legs in one call or be
   * refused (D8).
   *
   * ⚠️ NO RESTORE. Q2 = d deferred restore to WP-FB-DATA-06c-2b. There is no
   * `restore`, `unsupersede` or `undo` on this port, and its absence is
   * load-bearing: D6 (general undo) and D9 are OPEN.
   *
   * Rejects with `AmendmentRefusedError` (target missing, already excluded,
   * immutable field, no effective change, partial transfer),
   * `DuplicateTransactionIdError`, `TransferIntegrityError` or
   * `PartialTransferLifecycleError`.
   */
  supersede(requests: AmendmentRequestShape[]): Promise<AmendmentResultShape>;
}

/** Structural mirror of `AmendmentRequest` (kept here to avoid a service import in the port). */
export interface AmendmentRequestShape {
  targetId: string;
  changes: Partial<Pick<
    Transaction,
    'amount' | 'date' | 'title' | 'narration' | 'account' | 'accountId' |
    'category' | 'notes' | 'status' | 'direction' | 'type'
  >>;
}

/** Structural mirror of `AmendmentResult`. */
export interface AmendmentResultShape {
  outcomes: { supersededId: string; correctionId: string; transferId: string | null }[];
  supersededCount: number;
  correctionCount: number;
}

/** Structural mirror of `BatchRollbackResult` (kept here to avoid a service import in the port). */
/** Structural mirror of `BatchRestoreResult` (WP-FB-DATA-06c-2b). */
export interface BatchRestoreResultShape {
  batchId: string;
  restoredCount: number;
  restoredIds: string[];
  /** ISO timestamp stamped onto every restored row as the D6-3 audit record. */
  restoredAt: string;
}

export interface BatchRollbackResultShape {
  batchId: string;
  excludedCount: number;
  excludedIds: string[];
  alreadyExcludedCount: number;
}

/**
 * WP-FB-DATA-07b promotes edit onto the port and retires the name-upsert.
 *
 * `add` CREATES — it appends. Duplicate names are PERMITTED (Q-D07b-1a = (c));
 * the silent exact-name upsert is gone.
 * `update` replaces the complete record addressed by `id`, refusing an id that
 * is not present rather than appending a phantom row.
 * `remove` physically deletes one asset by `id` and clears any account link in
 * the same write (Q-D07b-1b = (b)).
 *
 * This is an ASSET capability only. The transaction write surface is unchanged
 * and still has no delete: D9-A stands.
 */
/* =========================================================================
 * WP-FB-IMPORT-BROKER-01 — D-01 / D-02 / D-04 / D-05
 *
 * First-class Holding entity, separate from Asset.
 *
 * NOT a member of Asset. Persists in its own IndexedDB object store.
 * Identity is computed by HoldingIdentityService.identityOf(holding).
 *
 * All monetary values are JavaScript numbers in the project's existing
 * convention (mirrors Asset.amount). No floating-point currency conversions
 * are applied at this layer.
 *
 * All quantity values are JavaScript numbers; mutual-fund fractional units
 * are first-class. The parser is responsible for any required precision
 * handling.
 *
 * D-05: securityClassification is an UNCONSTRAINED optional string —
 * broker-native label, no closed vocabulary. The repository normalises
 * empty string to undefined.
 * ========================================================================= */

export type HoldingStatus = 'active' | 'closed_absent';

export interface Holding {
  /** Authoritative persisted identity. Prefix `hld-`. Survives renames. */
  id: string;

  // === IDENTITY ===

  /** Broker name as supplied by the import context (UI). Required. */
  broker: string;

  /**
   * Account identifier as observed in the source file (UCC, Mobile, Email,
   * Unique Client Code, etc.). Optional because not all broker formats
   * expose it. The D-02 identity rule is:
   *   account-undefined  !=  account-explicit
   * — they MUST remain distinct. See HoldingIdentityService.identityOf.
   */
  account?: string;

  /**
   * Human-readable instrument name as supplied by the source. Required for
   * display; not the primary identifier (see `isin` / `ticker`).
   */
  instrumentName: string;

  /**
   * ISIN when present in the source. Currently only Groww stocks carry
   * ISIN; other formats leave this undefined. When present, ISIN is the
   * strongest instrument identifier.
   */
  isin?: string;

  /**
   * Exchange ticker (Zerodha equity only, e.g. "AIIL", "BHEL"). When
   * present, the ticker is the stable instrument identifier for that
   * broker.
   */
  ticker?: string;

  // === POSITION / VALUATION ===

  /** Units held. Fractional for mutual funds. Non-negative in V1. */
  quantity: number;

  /**
   * Volume-weighted average cost per unit, in source currency.
   * computed: investedValue / quantity when quantity > 0; 0 when
   * quantity === 0. The repository does not re-derive it.
   */
  averageCost: number;

  /** Total cost basis. Computed: Σ lot.invested (Dhan aggregation) or Qty × AvgCost (other). */
  investedValue: number;

  /** Last/current price per unit, in source currency. The "LTP" / "NAV" / "Closing price". */
  currentPrice: number;

  /** Qty × currentPrice. The only Holding field that contributes to Wealth. */
  currentValue: number;

  /** currentValue − investedValue. May be negative. */
  unrealisedPnL: number;

  /**
   * unrealisedPnL / investedValue × 100, expressed as a percent in the
   * 0-100 range (NOT 0-1). For holdings imported with XIRR (Dhan MF,
   * Groww MF), XIRR is captured separately. For holdings imported without
   * (Zerodha, Groww stocks, Dhan equity after aggregation), this is the
   * only percentage metric and is computed at import time.
   */
  unrealisedPnLPercent?: number;

  /**
   * XIRR percent from the source, when supplied. Dhan MF and Groww MF
   * provide per-scheme XIRR. For other formats this is undefined. Stored
   * as percent in 0-100 range (NOT 0-1). Not used in Wealth aggregation.
   */
  xirrPercent?: number;

  // === CLASSIFICATION (D-05) ===

  /**
   * Broker-native classification string. NOT a controlled vocabulary.
   * Empty string is normalised to undefined at the repository boundary.
   * Canonical analytics buckets are derived at the analytics layer from
   * this string and/or the instrumentName; that derivation is out of scope
   * for WP-07.
   */
  securityClassification?: string;

  // === LIFECYCLE ===

  /** Lifecycle state. See WP-07 design §3.3. */
  status: HoldingStatus;

  /**
   * Filename of the source statement (audit provenance). The actual file
   * is NOT persisted in the canonical model — the user keeps it. The
   * filename + importedAt are sufficient to retrace the import.
   */
  sourceFile: string;

  /**
   * ISO 8601 timestamp of when this Holding was last imported / updated.
   * For Dhan Equity aggregation, this is the max(lot.tradeDate) of the
   * contributing lots, falling back to the file's download timestamp.
   */
  importedAt: string;
}

export interface AssetRepository {
  findAll(): Promise<Asset[]>;
  findAllSync(): Asset[];
  /** Appends a new asset; never merges on name (WP-FB-DATA-07b). */
  add(asset: Asset): Promise<void>;
  /** Complete-record replace addressed by `Asset.id`. */
  update(asset: Asset): Promise<void>;
  /** Finds by authoritative id. */
  findByIdSync(id: string): Asset | null;
  /** Removes by authoritative id, clearing any account link. */
  remove(id: string): Promise<void>;
}

/**
 * WP-FB-DATA-07a promotes edit and delete onto the port.
 *
 * `add` CREATES — it appends and refuses a duplicate name (Q-D07a-2 = (b),
 * Q-D07a-4 = (b)); the legacy exact-name upsert is gone.
 * `update` replaces the complete record addressed by `id`, refusing an id that
 * is not present rather than appending a phantom row.
 * `remove` physically deletes exactly one row by `id` (Q-D07a-3 = (b)).
 *
 * This is a LIABILITY capability only. The transaction write surface is
 * unchanged and still has no delete: D9-A stands.
 */
export interface LiabilityRepository {
  findAll(): Promise<Liability[]>;
  findAllSync(): Liability[];
  add(liability: Liability): Promise<void>;
  update(liability: Liability): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * WP-FB-IMPORT-BROKER-01 — Holding persistence port.
 *
 * Mirrors the AssetRepository / LiabilityRepository shape (findAll, add,
 * update, remove) with identity-lookup support. Identity is computed by
 * HoldingIdentityService.identityOf; the repository does not interpret
 * the (broker, account?, instrument) tuple directly.
 */
export interface HoldingRepository {
  findAll(): Promise<Holding[]>;
  findAllSync(): Holding[];

  /**
   * Appends a new holding. Refuses a duplicate identity
   * (DUPLICATE_IDENTITY) — the import pipeline must perform an explicit
   * update for re-imports of the same identity.
   */
  add(holding: Holding): Promise<void>;

  /**
   * Complete-record replace addressed by `Holding.id`. Refuses an id that
   * is not present. Refuses an identity change (IDENTITY_CHANGE_FORBIDDEN).
   */
  update(holding: Holding): Promise<void>;

  /** Finds by authoritative id. */
  findByIdSync(id: string): Holding | null;

  /**
   * Identity lookup, the import-time hot path. Returns the holding whose
   * identity (broker, account?, instrument) matches `h`, or null.
   */
  findByIdentitySync(h: Holding): Holding | null;

  /**
   * Bulk append. Used by the import pipeline after a successful atomic
   * write. Each holding is validated; a duplicate-identity within the
   * batch or against existing holdings refuses the whole batch.
   */
  saveMany(holdings: Holding[]): Promise<void>;

  /**
   * Removes by authoritative id.
   *
   * ⚠️ NON-ATOMIC DIRECT-SPLICE PATH. This is a port-level primitive that
   * does NOT route through `MemoryRepository.write` and is therefore not
   * inside the atomic write boundary. The existing test at
   * `HoldingRepository.test.ts:84-93` documents this direct-splice shape.
   *
   * The D-06 closed_absent permanent deletion path does NOT use this method.
   * D-06 composes the holding removal and the audit-record creation inside
   * ONE `MemoryRepository.write` boundary via `HoldingDeletionService` and
   * `commitHoldingDeletion`. The V1 contract is that this `remove(id)` is
   * preserved for port completeness and is not the production deletion path.
   *
   * Refuses an id that is not present (`NOT_FOUND`).
   */
  remove(id: string): Promise<void>;
}

/* =========================================================================
 * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion audit log.
 *
 * The D-06 product authority (`WP-FB-IMPORT-BROKER-01-D-06-PRODUCT-AUTHORITY.md`)
 * mandates an audit record for every permanent deletion of a `closed_absent`
 * Holding. The audit record is persisted in its own IndexedDB object store
 * (`holdingDeletionLog`, keyPath `id`) and is written in the SAME atomic
 * `MemoryRepository.write` boundary as the holding removal itself — the two
 * succeed or fail together.
 *
 * The audit entry `id` is distinct from the deleted `holdingId`. This means
 * the same `holdingId` (which is no longer in the canonical collection) can
 * never reappear as a key in this collection, and a fresh audit entry can
 * never accidentally collide with a deleted holding's id.
 *
 * The 10 minimum conceptual fields are recorded by the D-06 product
 * authority. The interface preserves them exactly, with the addition of
 * `id` (the audit entry's own storage key).
 * ========================================================================= */

export interface HoldingDeletionLogEntry {
  /** Audit entry id, distinct from `holdingId`. Prefix `hdl-`. Storage key. */
  id: string;
  /** The deleted Holding's id. */
  holdingId: string;
  /** From the deleted Holding. */
  broker: string;
  /** From the deleted Holding; undefined if not present. */
  account?: string;
  /** From the deleted Holding. */
  instrumentName: string;
  /** From the deleted Holding; undefined if not present. */
  isin?: string;
  /** From the deleted Holding; undefined if not present. */
  ticker?: string;
  /** From the deleted Holding, at the moment of deletion. */
  currentValueAtDeletion: number;
  /** From the deleted Holding. */
  sourceFile: string;
  /** From the deleted Holding. */
  importedAt: string;
  /** ISO 8601 timestamp of the deletion event. */
  deletedAt: string;
}

export interface HoldingDeletionLogRepository {
  findAll(): Promise<HoldingDeletionLogEntry[]>;
  findAllSync(): HoldingDeletionLogEntry[];
  /** Finds by authoritative audit entry id. */
  findByIdSync(id: string): HoldingDeletionLogEntry | null;
  /**
   * Appends a new audit entry. Refuses a duplicate id (`DUPLICATE_AUDIT_ID`).
   *
   * The D-06 implementation does NOT call this directly; the D-06 path
   * composes the entry into the atomic `MemoryRepository.write` boundary
   * via `HoldingDeletionService.buildAtomicMutation` and
   * `commitHoldingDeletion`. This method is provided for port completeness
   * and for any future single-record audit operations.
   */
  add(entry: HoldingDeletionLogEntry): Promise<void>;
}

export interface SnapshotRepository {
  findAll(): Promise<NetWorthSnapshot[]>;
  findAllSync(): SnapshotRepositoryAllSync;
  create(snapshot?: NetWorthSnapshot): Promise<void>;
}

type SnapshotRepositoryAllSync = NetWorthSnapshot[];

export interface AccountRepository {
  findAll(): Promise<Account[]>;
  findAllSync(): Account[];
  add(account: Account): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface BudgetRepository {
  findForMonth(monthStr: string): Promise<MonthlyBudget | null>;
  findForMonthSync(monthStr: string): MonthlyBudget | null;
  findAll(): Promise<MonthlyBudget[]>;
  findAllSync(): MonthlyBudget[];
  save(budget: MonthlyBudget): Promise<void>;
}

export interface PolicyRepository {
  findAll(): Promise<InsurancePolicy[]>;
  findAllSync(): InsurancePolicy[];
  add(policy: InsurancePolicy): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface GoalRepository {
  findAll(): Promise<FinancialGoal[]>;
  findAllSync(): FinancialGoal[];
  add(goal: FinancialGoal): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ProfileRepository {
  get(): Promise<FinancialProfile | null>;
  getSync(): FinancialProfile | null;
  save(profile: FinancialProfile): Promise<void>;
}

export interface FinancialRepositoryPort {
  transactions: TransactionRepository;
  assets: AssetRepository;
  liabilities: LiabilityRepository;
  holdings: HoldingRepository;
  /** WP-FB-IMPORT-BROKER-01 / D-06: audit log for permanent holding deletions. */
  holdingDeletionLog: HoldingDeletionLogRepository;
  snapshots: SnapshotRepository;
  accounts: AccountRepository;
  budgets: BudgetRepository;
  policies: PolicyRepository;
  goals: GoalRepository;
  profile: ProfileRepository;
  clearLocalData(): Promise<void> | void;
  loadDemoData(): Promise<void> | void;
  initialize(): Promise<void> | void;
}

/* =========================================================================
 * WP-18: Money Domain Models (Accounts, Monthly Budgets, Category Mappings)
 * ========================================================================= */

export type ControlledAccountType =
  | 'Bank'
  | 'Credit Card'
  | 'Cash'
  | 'Wallet'
  | 'Broker'
  | 'Other';

export interface Account {
  id: string;
  name: string; // Unique within Account registry
  type: ControlledAccountType;
  institution?: string;
  lastFourDigits?: string;
  openingBalance: number;
  currency?: string; // Descriptive metadata only; no 'INR' default
  asOfDate?: string;
  notes?: string;
  /**
   * Explicit link to the Asset that represents this account's cash
   * (WP-FB-DATA-04c-2). References `Asset.id` — never a name, tag or type.
   *
   * Cardinality: 0..1 Account ↔ 0..1 Asset. An asset may be claimed by at most
   * one account, and an account may claim at most one asset.
   *
   * `null`/absent means deliberately unlinked. The link is ALWAYS user-stated:
   * it is never inferred from matching names, asset type, or fuzzy matching.
   * Because both sides carry stable ids, the link survives renames on either
   * side.
   *
   * ⚠️ Infrastructure only in this package. No financial calculation consumes
   * it yet — B5 deduplication remains name-based until DATA-05b.
   */
  linkedAssetId?: string | null;
  /**
   * Cash & Savings asset ids the user has explicitly declared NOT to be the
   * same money as this account (WP-FB-DATA-05b, Decision G3).
   *
   * Dismissing a same-name candidate is a real user statement, so it is
   * persisted: the pair is never re-prompted and both sides count toward
   * liquidity from then on.
   */
  dismissedAssetCandidateIds?: string[];
}

export interface MonthlyBudget {
  id: string;
  monthStr: string; // "YYYY-MM" e.g. "2026-08"
  allocations: Record<string, number>; // category -> budgeted amount
  totalBudget: number;
  updatedAt?: string;
}

export const BUDGET_CATEGORY_FAMILIES = [
  'Housing',
  'Food & Dining',
  'Groceries',
  'Transport',
  'Healthcare',
  'Education',
  'Insurance',
  'EMI & Loans',
  'Entertainment',
  'Utilities',
  'Shopping',
  'Investment',
  'Travel & Vacations',
  'Subscriptions',
  'Personal Care',
  'Credit Card Payment',
  'Taxes',
  'Cash Withdrawal',
  'Childcare',
  'Other Expense',
  'New Category'
] as const;

export type BudgetCategoryFamily = typeof BUDGET_CATEGORY_FAMILIES[number];

/** Deterministic transaction-category to budget-category mapping */
export const TRANSACTION_TO_BUDGET_CATEGORY_MAP: Record<string, BudgetCategoryFamily> = {
  'DINING': 'Food & Dining',
  'FOOD': 'Food & Dining',
  'GROCERIES': 'Groceries',
  'GROCERY': 'Groceries',
  'HOUSING': 'Housing',
  'RENT': 'Housing',
  'MORTGAGE': 'Housing',
  'SUBSCRIPTION': 'Subscriptions',
  'SUBSCRIPTIONS': 'Subscriptions',
  'OTT': 'Subscriptions',
  'SHOPPING': 'Shopping',
  'UTILITY': 'Utilities',
  'UTILITIES': 'Utilities',
  'ELECTRICITY': 'Utilities',
  'WATER': 'Utilities',
  'TRANSPORT': 'Transport',
  'FUEL': 'Transport',
  'CAB': 'Transport',
  'TRAVEL': 'Travel & Vacations',
  'VACATION': 'Travel & Vacations',
  'HEALTHCARE': 'Healthcare',
  'MEDICAL': 'Healthcare',
  'EDUCATION': 'Education',
  'TUITION': 'Education',
  'INSURANCE': 'Insurance',
  'POLICY': 'Insurance',
  'EMI': 'EMI & Loans',
  'LOAN': 'EMI & Loans',
  'ENTERTAINMENT': 'Entertainment',
  'MOVIES': 'Entertainment',
  'PERSONAL_CARE': 'Personal Care',
  'CREDIT_CARD_PAYMENT': 'Credit Card Payment',
  'TAXES': 'Taxes',
  'TAX': 'Taxes',
  'CASH_WITHDRAWAL': 'Cash Withdrawal',
  'ATM': 'Cash Withdrawal',
  'CHILDCARE': 'Childcare',
  'INVESTMENT': 'Investment',
  'OTHER': 'Other Expense',
  'OTHER_EXPENSE': 'Other Expense'
};

export function mapTransactionCategoryToBudget(txCategory?: string): BudgetCategoryFamily {
  if (!txCategory) return 'Other Expense';
  const norm = txCategory.toUpperCase().trim();
  return TRANSACTION_TO_BUDGET_CATEGORY_MAP[norm] || 'Other Expense';
}

/* =========================================================================
 * WP-17 Phase C: Wealth Intelligence & Diagnostics Types
 * ========================================================================= */

export interface WealthHealthSummary {
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  debtToAssetRatio: number;
  liquidReserve: number;
  liquidRatio: number;
  topAssetConcentration: number;
  status: 'RECONCILED' | 'NOT_CONFIGURED';
}

export interface AssetConcentrationAnalysis {
  topAsset?: {
    name: string;
    amount: number;
    pct: number;
  };
  byType: Array<{
    type: string;
    amount: number;
    pct: number;
  }>;
  byGeography: Array<{
    geography: string;
    amount: number;
    pct: number;
  }>;
  byCurrency: Array<{
    currency: string;
    amount: number;
    pct: number;
  }>;
  isConcentrated: boolean;
  unclassifiedPct: number;
}

export interface AllocationDiagnostics {
  dominantCategory?: string;
  underrepresentedCategories: string[];
  targetDrift: Array<{
    category: string;
    targetPct: number;
    actualPct: number;
    driftPct: number;
  }>;
  hasConcentrationWarning: boolean;
  metadataCompletenessPct: number;
}

export interface LiabilityDiagnostics {
  totalDebt: number;
  debtToAssetRatio: number;
  largestLiability?: {
    name: string;
    amount: number;
    type: string;
    pct: number;
  };
  burdenLevel: 'LOW' | 'MODERATE' | 'ELEVATED' | 'NOT_CONFIGURED';
}

export interface NetWorthTrendIntelligence {
  status: 'NOT_CONFIGURED' | 'BASELINE_SET' | 'TREND_ACTIVE' | 'COMPOUNDING_ACTIVE';
  snapshotCount: number;
  latestNetWorth: number;
  previousNetWorth?: number;
  absoluteChange?: number;
  percentageChange?: number;
  cagrValue?: number;
  direction: 'UP' | 'DOWN' | 'FLAT' | 'NONE';
}

export interface WealthInsight {
  id: string;
  severity: 'INFO' | 'WATCH' | 'ACTION';
  title: string;
  explanation: string;
  sourceMetric: string;
  deterministicReason: string;
}

export interface WealthDataQuality {
  status: 'COMPLETE' | 'PARTIAL' | 'NEEDS_ATTENTION' | 'NOT_CONFIGURED';
  completenessScore: number;
  missingAssetTypeCount: number;
  missingGeographyCount: number;
  missingCurrencyCount: number;
  missingLiabilityTypeCount: number;
  totalRecords: number;
}

/* =========================================================================
   WP-19: ESSENTIALS DOMAIN TYPES & SCHEMAS
   ========================================================================= */

export type PolicyType = 'Term Life' | 'Health' | 'Motor' | 'Home' | 'Other';

export interface InsurancePolicy {
  id: string;
  type: PolicyType;
  provider: string;
  policyNumber?: string;
  coverAmount: number;
  premiumAmount: number;
  renewalDate?: string;
  status: 'Active' | 'Lapsed' | 'Pending';
  currency?: string; // Descriptive metadata only; preserves Not Specified
  notes?: string;
}

export const GOAL_TEMPLATES = [
  'Retirement',
  'Emergency Buffer',
  'Home Purchase',
  'Education',
  'Vacation',
  'Vehicle',
  'Wedding',
  'Custom Milestone'
] as const;

export type GoalTemplateType = typeof GOAL_TEMPLATES[number];

export interface FinancialGoal {
  id: string;
  name: string;
  template: GoalTemplateType;
  targetAmount: number;
  targetDate?: string;
  currentSavedAmount: number;
  monthlyContribution: number;
  linkedCategory?: string;
  status: 'In Progress' | 'Achieved' | 'Paused';
  currency?: string; // Descriptive metadata only; preserves Not Specified
  notes?: string;
}

export interface FinancialProfile {
  id: string;
  age?: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  savingsRate: number; // Percentage (e.g. 35 for 35%)
  dependents?: number;
  targetEmergencyMonths?: number;
  updatedAt: string;
}

export interface EmergencyFundAnalysis {
  liquidReserves: number;
  monthlyEssentialExpenses: number;
  runwayMonths: number;
  targetMonths: number;
  targetAmount: number;
  fundingGap: number;
  status: 'RECONCILED' | 'NOT_CONFIGURED';
  /** WP-FB-DATA-05b: same-name pairs awaiting an explicit user decision (G3). */
  linkCandidates?: Array<{
    accountId: string;
    accountName: string;
    assetId: string;
    assetName: string;
    accountBalance: number;
    assetAmount: number;
  }>;
  /** WP-FB-DATA-05b: accounts referencing a deleted asset (H(c)). */
  brokenLinks?: Array<{ accountId: string; accountName: string; missingAssetId: string }>;
  /** Value held back pending confirmation of a same-name candidate. */
  heldPendingConfirmation?: number;
}

export interface HealthScoreBreakdown {
  score: number; // 0 to 100
  status: 'HEALTHY' | 'MODERATE' | 'NEEDS_ATTENTION' | 'NOT_CONFIGURED';
  emergencyRunwayScore: number; // max 25
  debtSolvencyScore: number;    // max 25
  savingsRateScore: number;     // max 25
  insuranceAdequacyScore: number; // max 25
  explanations: string[];
}

/* =========================================================================
   WP-20: CALCULATOR DOMAIN TYPES & INTERFACES
   ========================================================================= */

export interface CashFlowEntry {
  id: string;
  date: string;
  amount: number; // Negative for outflows / investments, positive for inflows / redemptions
  description?: string;
}

export interface XirrCalculationResult {
  xirr: number; // Annualized percentage e.g. 14.25
  totalInvested: number;
  totalWithdrawn: number;
  currentValue: number;
  netGain: number;
  isValid: boolean;
  error?: string;
}

export interface SipBreakdownYear {
  year: number;
  invested: number;
  value: number;
  interestEarned: number;
  monthlyInstallment: number;
}

export interface SipCalculationResult {
  totalInvested: number;
  estimatedReturns: number;
  totalValue: number;
  yearlyBreakdown: SipBreakdownYear[];
}

export interface LumpsumBreakdownYear {
  year: number;
  invested: number;
  value: number;
  interestEarned: number;
}

export interface LumpsumCalculationResult {
  investedAmount: number;
  estimatedReturns: number;
  totalValue: number;
  realPurchasingPower: number;
  absoluteGrowthMultiple: number;
  yearlyBreakdown: LumpsumBreakdownYear[];
}

export interface CagrCalculationResult {
  cagr: number; // Annualized percentage e.g. 15.5
  absoluteGrowthPct: number;
  multiplier: number;
  isValid: boolean;
  error?: string;
}

export interface AmortizationScheduleRow {
  month: number;
  year: number;
  openingBalance: number;
  emi: number;
  principalComponent: number;
  interestComponent: number;
  closingBalance: number;
}

export interface LoanEmiCalculationResult {
  monthlyEmi: number;
  totalInterest: number;
  totalAmount: number;
  interestPrincipalRatio: number; // Total Interest / Principal
  schedule: AmortizationScheduleRow[];
}
