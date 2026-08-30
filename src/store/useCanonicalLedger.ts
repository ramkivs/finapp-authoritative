import { FinancialCommands } from '../application/commands';
import { create } from 'zustand';
import {
  Transaction,
  Asset,
  Liability,
  Holding,
  HoldingDeletionLogEntry,
  NetWorthSnapshot,
  Account,
  ControlledAccountType,
  MonthlyBudget,
  InsurancePolicy,
  PolicyType,
  FinancialGoal,
  GoalTemplateType,
  FinancialProfile,
  BatchRollbackResultShape,
  BatchRestoreResultShape,
  AmendmentRequestShape,
  AmendmentResultShape
} from '../domain/types';
import { formatDisplayDate, DateRangeService, getEffectiveAsOfDate } from '../services/DateRangeService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountResolutionService } from '../services/AccountResolutionService';
import { AccountAssetLinkService, LinkResult } from '../services/AccountAssetLinkService';
import { TransactionSignService } from '../services/TransactionSignService';
import { BrokerImportService } from '../services/BrokerImportService';
import { HoldingDeletionService } from '../services/HoldingDeletionService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { AssetLifecycleService } from '../services/AssetLifecycleService';
import { repository } from '../repositories';

/**
 * WP-FB-DATA-07c-R2 — the outcome of an account-link operation.
 *
 * `ok`/`reason`/`message` answer "was the request admitted?" — synchronously,
 * as they always have. `persisted` answers "did the accepted change reach
 * storage?" and is present ONLY when a write was attempted.
 */
export interface LinkOutcome extends LinkResult {
  /** Resolves when the change is stored; rejects with the persistence error. */
  persisted?: Promise<void>;
}

/**
 * Attaches the persistence promise to an admitted link result.
 *
 * ONE helper for all three actions on purpose: the 06c family repeatedly showed
 * that a rule applied at two of three call sites is not a rule. `link`,
 * `unlink` and `dismissCandidate` share identical write semantics, so they must
 * share identical failure semantics.
 *
 * The promise is RETURNED, never awaited here and never swallowed. A `.catch`
 * placed here would silence the very failure the caller has to render — but
 * leaving the promise entirely unobserved would produce an unhandled rejection
 * for callers that legitimately ignore it, so the rejection is marked handled
 * exactly once while the original promise is what the caller receives.
 */
function withPersistence(result: LinkResult): LinkOutcome {
  if (!result.ok || result.unchanged) return result;
  const persisted = (repository as any).applyAccountsUpdate(result.accounts) as Promise<void>;
  // Keep the rejection observable to the caller AND handled for the runtime.
  persisted.catch(() => { /* the caller's `persisted` is what surfaces this */ });
  return { ...result, persisted };
}

interface LedgerState {
  transactions: Transaction[];
  assets: Asset[];
  liabilities: Liability[];
  holdings: Holding[];
  /** WP-FB-IMPORT-BROKER-01 / D-06: audit log for permanent holding deletions. */
  holdingDeletionLog: HoldingDeletionLogEntry[];
  snapshots: NetWorthSnapshot[];
  accounts: Account[];
  budgets: MonthlyBudget[];
  policies: InsurancePolicy[];
  goals: FinancialGoal[];
  profile: FinancialProfile | null;
  privacyMasked: boolean;
  filterType: 'Expense' | 'Income' | 'Transfer' | 'All';
  dateRange: string;
  searchQuery: string;
  customStart: string;
  customEnd: string;

  // Actions
  setFilterType: (type: 'Expense' | 'Income' | 'Transfer' | 'All') => void;
  setDateRange: (range: string) => void;
  setSearchQuery: (query: string) => void;
  setCustomRange: (start: string, end: string) => void;
  togglePrivacy: () => void;

  syncWithRepository: (state: {
    transactions: Transaction[];
    assets: Asset[];
    liabilities: Liability[];
    holdings?: Holding[];
    /** WP-FB-IMPORT-BROKER-01 / D-06: audit log for permanent holding deletions. */
    holdingDeletionLog?: HoldingDeletionLogEntry[];
    snapshots: NetWorthSnapshot[];
    accounts?: Account[];
    budgets?: MonthlyBudget[];
    policies?: InsurancePolicy[];
    goals?: FinancialGoal[];
    profile?: FinancialProfile | null;
  }) => void;

  initialize: () => Promise<void>;
  /**
   * D-06-F1-A recovery correction — the explicit, user-invoked storage
   * recovery offered after a Confirm was REFUSED by the failed-load guard.
   *
   * Semantics, deliberately thin:
   *  - it runs the ONE legitimate recovery operation (`repository.initialize()`
   *    — the same load startup performs, which re-reads every store and
   *    re-syncs memory). No new load path, no shortcut;
   *  - success → `IndexedDBStorageService.loadFailed` clears inside
   *    `loadAll()` and `initStatus` becomes 'ready' only after the load
   *    actually resolved — success is never fabricated;
   *  - failure → `initStatus`/`initError` carry the real error, the write
   *    refusal REMAINS armed, and nothing in the ledger is touched;
   *  - it never re-attempts the failed mutation itself — retrying "Confirm
   *    import" stays an explicit user action (D-06 review → confirm).
   */
  recoverStorage: () => Promise<{ recovered: boolean; error: string | null }>;
  /**
   * WP-FB-DATA-10 — observable initialization outcome.
   *
   * The startup load is asynchronous and can fail. Without this the UI cannot
   * tell "the ledger is empty" apart from "the ledger could not be read", and
   * the 10 discovery gate measured exactly that: a blocked IndexedDB produced a
   * normal-looking empty FinBoom with no indication anything had gone wrong.
   *
   * This is a DISCLOSURE signal, not a data-safety mechanism. The authority on
   * whether stored data is safe to overwrite remains
   * `IndexedDBStorageService.loadFailed` and the write refusal it drives; this
   * state deliberately does not duplicate or override it.
   */
  initStatus: 'loading' | 'ready' | 'failed';
  /** Actionable message for the user when `initStatus === 'failed'`. */
  initError: string | null;
  loadDemoData: () => Promise<void>;
  clearLocalData: () => Promise<void>;

  addIncome: (title: string, amount: number, account: string, category: string, notes?: string) => Promise<void>;
  addExpense: (title: string, amount: number, account: string, category: string, notes?: string) => Promise<void>;
  /**
   * WP-FB-DATA-06b: returns the persistence promise so a transfer-integrity
   * rejection is visible to the caller. Previously fire-and-forget, which meant
   * any rejection became an invisible unhandled promise rejection.
   */
  addTransfer: (source: string, destination: string, amount: number) => Promise<void>;
  /**
   * WP-FB-DATA-07b — asset lifecycle. All four RETURN their promise so the UI
   * can render a refusal or a persistence failure instead of closing a modal
   * over a write that never happened.
   */
  addAsset: (name: string, amount: number) => Promise<void>;
  /**
   * WP-FB-DATA-07a — liability lifecycle. All four RETURN their promise so the
   * UI can render a refusal or a persistence failure instead of closing a modal
   * over a write that never happened.
   */
  addLiability: (name: string, amount: number) => Promise<void>;
  addAssetWithMetadata: (params: { name: string; amount: number; type?: any; tag?: string; currency?: string; geography?: any }) => Promise<void>;
  updateAsset: (params: { id: string; name: string; amount: number; type?: any; tag?: string; currency?: string; geography?: any }) => Promise<void>;
  removeAsset: (id: string) => Promise<void>;
  addLiabilityWithMetadata: (params: { name: string; amount: number; type?: any; currency?: string }) => Promise<void>;
  updateLiability: (params: { id: string; name: string; amount: number; type?: any; currency?: string }) => Promise<void>;
  removeLiability: (id: string) => Promise<void>;
  addPastSnapshot: (params: { dateStr: string; totalAssets: number; totalLiabilities: number; label?: string }) => Promise<void>;
  captureSnapshot: (label?: string) => Promise<void>;
  commitImportedRows: (validRows?: Transaction[]) => ImportCommitOutcome;

  /**
   * WP-FB-IMPORT-BROKER-01 — WP-08 broker-holding commit.
   *
   * Sibling to `commitImportedRows` (which is for `Transaction[]` only).
   * This hook accepts the parsed `Holding[]` candidates from a confirmed
   * broker-import preview and commits them atomically via
   * `MemoryRepository.write`.
   *
   * The hook does NOT perform the parse / reconcile / preview steps — those
   * are the UI/service layer's responsibility (see `BrokerImportService`).
   * It only persists the final, user-confirmed set of parsed Holdings.
   *
   * Semantics:
   *   - All parsed candidates are `planCreate`-ed against the current
   *     `holdings` set (so duplicate identity is refused by the existing
   *     lifecycle service, not by the import layer).
   *   - The planCreate/planUpdate/planClose decisions are made ONCE inside
   *     the write boundary, against the live (snapshot) holdings set.
   *   - On failure, `MemoryRepository.write` rolls back the entire mutation
   *     in memory and storage. The returned `persisted` promise REJECTS with
   *     the failure; the caller (UI) must surface it.
   *
   * The returned `ImportCommitOutcome`-shaped result is synchronous (counts)
   * with a `persisted` promise for the caller to await.
   */
  commitImportedHoldings: (parsed: Holding[]) => ImportCommitOutcome;

  /**
   * FINBOOM-CR (CR-STANDARD-IMPORT) — Requirement #1 Standard Import commit.
   *
   * Sibling to `commitImportedRows` (Transaction[]) and
   * `commitImportedHoldings` (Holding[]). This hook accepts the parsed
   * `Asset[]` candidates from a confirmed Standard Import preview and
   * commits them atomically via `MemoryRepository.write`.
   *
   * The hook does NOT perform the parse / validate / preview steps —
   * those are the Standard Import panel's responsibility (see
   * `StandardImportService`). It only persists the final,
   * user-confirmed set of parsed Assets.
   *
   * Semantics:
   *   - All parsed candidates are appended via `AssetRepository.add` in
   *     a single `MemoryRepository.write` boundary (so the whole import
   *     is atomic: all-or-nothing, in-memory and IndexedDB).
   *   - The planCreate decisions are made ONCE inside the write
   *     boundary, against the live (snapshot) assets set.
   *   - On failure, `MemoryRepository.write` rolls back the entire
   *     mutation. The returned `persisted` promise REJECTS with the
   *     failure; the caller (UI) must surface it.
   *
   * The returned `ImportCommitOutcome`-shaped result is synchronous
   * (counts) with a `persisted` promise for the caller to await.
   *
   * Per the IMPLEMENTATION AUTHORITY REPORT (FINBOOM-REQUIREMENT-1-STANDARD-IMPORT-IMPLEMENTATION-AUTHORITY-REPORT.md):
   *  - V1 has NO rollback support. The commit-success UX must
   *    explicitly communicate the V1 rollback limitation.
   *  - No new Asset fields are added (no `importBatchId`, no
   *    `sourceFile`). The audit trail is via `ImportHistoryService`.
   *  - Duplicate Asset names are PERMITTED at the canonical layer
   *    (Q-D07b-1a = (c)); the within-file and against-existing dedup
   *    rules are enforced at the StandardImportService level, not
   *    here.
   */
  commitImportedStandardAssets: (assets: Asset[]) => ImportCommitOutcome;

  /**
   * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion.
   *
   * Composes the holding removal and the audit-record creation inside ONE
   * `MemoryRepository.write` boundary via `HoldingDeletionService`. Both
   * succeed or both roll back together (D-06 atomicity contract).
   *
   * Pre-conditions enforced by `HoldingDeletionService.planDelete`:
   *   - `id` is a non-empty string (else `INVALID_ID`).
   *   - The Holding exists (else `HOLDING_NOT_FOUND`).
   *   - The Holding's `status` is `closed_absent` (else `HOLDING_NOT_CLOSED`).
   *     Only `closed_absent` Holdings may be permanently deleted via D-06.
   *
   * On any of these pre-validation failures, the call throws
   * `HoldingDeletionError` synchronously. No memory or IndexedDB mutation
   * has occurred.
   *
   * On persistence failure, the existing `MemoryRepository.write`
   * `revertDelta` mechanism restores both the pre-deletion `holdingsData`
   * and the pre-deletion `holdingDeletionLogData` from the captured
   * snapshot. The returned `persisted` promise REJECTS with the failure.
   *
   * The result is shaped like `HoldingDeletionOutcome`: synchronous counts
   * with a `persisted` promise for the caller to await.
   *
   * D-06 is irreversible. There is no `undoHoldingDeletion` action.
   */
  commitHoldingDeletion: (id: string) => HoldingDeletionOutcome;

  /**
   * D-06-F1-A — user-selected multi-select BATCH deletion of `closed_absent`
   * Holdings.
   *
   * Composes the removal of ALL selected Holdings and the creation of ALL
   * corresponding audit records inside ONE `MemoryRepository.write` boundary
   * via `HoldingDeletionService.planDeleteMany` +
   * `buildAtomicMutationForBatch`. The whole batch succeeds or the whole
   * batch rolls back — partial batch deletion is impossible.
   *
   * Pre-conditions enforced by `HoldingDeletionService.planDeleteMany`
   * (the ENTIRE batch is rejected on ANY failure, before any mutation):
   *   - `ids` is a non-empty array of non-empty strings (else `INVALID_ID`).
   *   - No id appears twice (else `DUPLICATE_ID`).
   *   - Every Holding exists (else `HOLDING_NOT_FOUND`).
   *   - Every Holding's `status` is `closed_absent` (else `HOLDING_NOT_CLOSED`).
   *
   * On any pre-validation failure the call throws `HoldingDeletionError`
   * synchronously; no memory or IndexedDB mutation has occurred.
   *
   * On persistence failure the existing `MemoryRepository.write` revertDelta
   * mechanism restores both `holdingsData` and `holdingDeletionLogData` from
   * the captured snapshot; `persisted` REJECTS with the failure.
   *
   * Every audit entry of the batch carries the shared `batchId` and
   * `batchScope: 'MULTI_SELECT'` (D-06-F1-A batch attribution). Optional
   * fields on `HoldingDeletionLogEntry` keep single-deletion records and
   * pre-existing serialized records fully compatible: DB_VERSION stays 7,
   * no migration, no new object store.
   *
   * D-06-F1-A scope is user-selected multi-select ONLY: no broker-wide,
   * account-wide, or global deletion path exists (F1-B/C/D deferred). No
   * Asset effect (F10-C), no transaction mutation, no snapshot
   * recomputation, no undo.
   */
  commitBatchHoldingDeletion: (ids: readonly string[]) => HoldingBatchDeletionOutcome;

  // Account & Budget Actions (WP-18)
  /**
   * WP-FB-DATA-06c-6 / Decision 13-b. Returns the promise so a refusal is
   * visible to the caller rather than becoming an invisible unhandled
   * rejection (the F-06b-2 lesson).
   */
  rollbackImportBatch: (importBatchId: string) => Promise<BatchRollbackResultShape>;
  /**
   * WP-FB-DATA-06c-2b / Decision D6-1 = R5 — reverse an import-batch rollback.
   *
   * Returns the promise so a refusal reaches the caller rather than becoming an
   * invisible unhandled rejection (the F-06b-2 lesson).
   *
   * ⚠️ Whole batch only (D6-2), IMPORT_ROLLBACK only (D6-1). This is NOT undo:
   * there is deliberately no `undo`, `revert`, `restoreTransaction` or
   * `unsupersedeTransaction` on this store, and D6-7 keeps it that way.
   */
  restoreImportBatch: (importBatchId: string) => Promise<BatchRestoreResultShape>;
  /**
   * WP-FB-DATA-06c-2 — amend recorded transactions by supersession.
   *
   * Returns the promise so the caller can await the outcome and surface a
   * refusal in the UI. Fire-and-forget here would repeat defect F-06b-2, where
   * a write refusal reached only the console.
   *
   * Amend a transfer by passing BOTH legs in one call (Decision D8).
   *
   * ⚠️ There is no matching `restoreTransaction`. Q2 = d deferred restore to
   * WP-FB-DATA-06c-2b; D6 and D9 are OPEN.
   */
  supersedeTransactions: (requests: AmendmentRequestShape[]) => Promise<AmendmentResultShape>;
  addAccount: (params: {
    name: string;
    type: ControlledAccountType;
    institution?: string;
    lastFourDigits?: string;
    openingBalance: number;
    currency?: string;
    asOfDate?: string;
    notes?: string;
  }) => Promise<void>;
  /**
   * WP-FB-DATA-08A - destructive deletions RETURN their promise.
   *
   * Measured at the 08 gate: each of these confirmed a deletion, failed to
   * persist, reverted memory correctly, and told the user nothing while the
   * rejection escaped as an unhandled page error.
   */
  removeAccount: (id: string) => Promise<void>;
  /**
   * WP-FB-DATA-04c-2: explicit Account<->Asset link (0..1 <-> 0..1).
   *
   * WP-FB-DATA-07c-R2 — these three now carry `persisted`.
   *
   * The synchronous part of the result is a DECISION: whether the link service
   * admitted the request at all (claim conflicts, unknown ids, no-op). That has
   * always been synchronous and stays synchronous, because callers branch on it
   * immediately.
   *
   * `persisted` is the separate question of whether the accepted change actually
   * reached storage. It used to be discarded: measured at the 07c-R1 gate, a
   * persistence failure closed the modal as if the link had worked while memory
   * and storage both held no link, and the rejection surfaced as an unhandled
   * page error. A caller that cannot see this promise cannot tell the user the
   * truth.
   *
   * It is present only when a write was actually attempted — a refusal or an
   * unchanged result writes nothing and therefore promises nothing.
   */
  linkAccountToAsset: (accountId: string, assetId: string) => LinkOutcome;
  unlinkAccountFromAsset: (accountId: string) => LinkOutcome;
  /** WP-FB-DATA-05b G3: record "not the same money" for a same-name candidate. */
  dismissAssetCandidate: (accountId: string, assetId: string) => LinkOutcome;
  /**
   * WP-FB-DATA-08B — the remaining write actions RETURN their promise.
   *
   * Measured at the 08B gate: each of these discarded it, so a persistence
   * failure reverted memory correctly, told the user nothing, and escaped as an
   * unhandled page error. Discovery also measured that NO caller consumes a
   * return value from these paths, so ordinary promise propagation is enough —
   * the 08A admission/`persisted` split would be complexity with no beneficiary.
   */
  saveMonthlyBudget: (monthStr: string, allocations: Record<string, number>) => Promise<void>;

  // Essentials Actions (WP-19)
  addPolicy: (params: {
    type: PolicyType;
    provider: string;
    policyNumber?: string;
    coverAmount: number;
    premiumAmount: number;
    renewalDate?: string;
    status?: 'Active' | 'Lapsed' | 'Pending';
    currency?: string;
    notes?: string;
  }) => Promise<void>;
  removePolicy: (id: string) => Promise<void>;
  addGoal: (params: {
    name: string;
    template: GoalTemplateType;
    targetAmount: number;
    targetDate?: string;
    currentSavedAmount?: number;
    monthlyContribution?: number;
    linkedCategory?: string;
    status?: 'In Progress' | 'Achieved' | 'Paused';
    currency?: string;
    notes?: string;
  }) => Promise<void>;
  removeGoal: (id: string) => Promise<void>;
  saveProfile: (profile: FinancialProfile) => Promise<void>;

  getFilteredTransactions: (params?: {
    type?: 'Expense' | 'Income' | 'Transfer' | 'All';
    dateRange?: string;
    search?: string;
    customStart?: string;
    customEnd?: string;
  }) => Transaction[];
  getNetWorth: () => number;
}

/**
 * WP-FB-DATA-08A — the outcome of an import commit.
 *
 * The counts are an ADMISSION decision: which rows the ledger accepted, which
 * it excluded as exact duplicates, and which it refused (unpaired transfers,
 * colliding ids). All of that is computed before anything is written, and 20
 * existing assertions read it synchronously, so it stays synchronous.
 *
 * `persisted` is the separate question of whether the admitted rows reached
 * storage. It used to be discarded, and the 08 gate measured the consequence:
 * with persistence failing, this returned `appended: 1` while memory AND
 * storage both held 0 rows, and ImportPage alerted "Appended 1 new rows".
 * That was not silence - it was an affirmative false claim.
 *
 * ⚠️ `appended` therefore means ADMITTED, not stored. No surface may report it
 * to the user until `persisted` has resolved.
 */
export interface ImportCommitOutcome {
  /** Rows admitted for persistence. NOT a guarantee that they were stored. */
  appended: number;
  duplicates: number;
  divergentDuplicates: number;
  /** WP-FB-DATA-06b / T3-b: rows excluded because they were not a valid transfer pair. */
  rejectedTransferRows: number;
  rejectedTransferReasons: string[];
  /** WP-FB-DATA-06c-0 / P-1: rows excluded because their id was already in use. */
  rejectedDuplicateIdRows: number;
  rejectedDuplicateIdReasons: string[];
  /** Resolves when the admitted rows are stored; rejects with the failure. */
  persisted?: Promise<void>;
}

/**
 * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion outcome.
 *
 * The synchronous fields are the ADMISSION decision: the holding id, the
 * generated audit entry id, and the deletion timestamp. All of that is
 * computed before anything is written (by `HoldingDeletionService.planDelete`).
 *
 * `persisted` is the separate question of whether the deletion reached
 * storage. It is present only when a write was attempted; pre-validation
 * failures throw synchronously and produce no `persisted` promise.
 */
export interface HoldingDeletionOutcome {
  /** The deleted Holding's id. */
  holdingId: string;
  /** The generated audit entry's id (distinct from `holdingId`). */
  auditEntryId: string;
  /** ISO 8601 timestamp of the deletion event. */
  deletedAt: string;
  /** Resolves when the deletion is stored; rejects with the failure. */
  persisted?: Promise<void>;
}

/**
 * D-06-F1-A — user-selected multi-select BATCH deletion outcome.
 *
 * Same admission/persistence split as `HoldingDeletionOutcome`: the
 * synchronous fields are computed by `HoldingDeletionService.planDeleteMany`
 * BEFORE anything is written; `persisted` answers whether the single atomic
 * write reached storage. Pre-validation failures throw synchronously and
 * produce no outcome at all — there is no partial batch result.
 */
export interface HoldingBatchDeletionOutcome {
  /** The deleted Holding ids, in selection order. */
  holdingIds: string[];
  /** Shared attribution id of the batch's audit entries. Prefix `hdlb-`. */
  batchId: string;
  /** The generated audit entry ids (one per deleted Holding). */
  auditEntryIds: string[];
  /** ISO 8601 timestamp of the deletion event. */
  deletedAt: string;
  /** Resolves when the whole batch is stored; rejects with the failure. */
  persisted?: Promise<void>;
}

export const useCanonicalLedger = create<LedgerState>((set, get) => ({
  transactions: [],
  assets: [],
  liabilities: [],
  holdings: [],
  holdingDeletionLog: [],
  snapshots: [],
  accounts: [],
  budgets: [],
  policies: [],
  goals: [],
  profile: null,
  initStatus: 'loading',
  initError: null,
  privacyMasked: typeof window !== 'undefined' ? localStorage.getItem('finapp.privacy.masked') === 'true' : false,
  filterType: 'All',
  dateRange: 'This Month',
  searchQuery: '',
  customStart: '2026-07-01',
  customEnd: getEffectiveAsOfDate(),

  setFilterType: (filterType) => set({ filterType }),
  setDateRange: (dateRange) => {
    set({ dateRange });
    if (dateRange === '12M') {
      set({ filterType: 'Income' });
    }
  },
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setCustomRange: (customStart, customEnd) => set({ customStart, customEnd, dateRange: 'Custom' }),
  togglePrivacy: () => {
    const next = !get().privacyMasked;
    localStorage.setItem('finapp.privacy.masked', String(next));
    set({ privacyMasked: next });
  },

  syncWithRepository: (state) => {
    set({
      transactions: state.transactions,
      assets: state.assets,
      liabilities: state.liabilities,
      holdings: state.holdings || [],
      holdingDeletionLog: state.holdingDeletionLog || [],
      snapshots: state.snapshots,
      accounts: state.accounts || [],
      budgets: state.budgets || [],
      policies: state.policies || [],
      goals: state.goals || [],
      profile: state.profile ?? null
    });
  },

  initialize: async () => {
    // WP-FB-DATA-10: the outcome is recorded so the UI can disclose it. The
    // rejection is still rethrown — callers (and the retry affordance) must be
    // able to observe the failure, and 06c-READFAIL's propagation contract is
    // unchanged. Only the reporting is new.
    set({ initStatus: 'loading', initError: null });
    try {
      await repository.initialize();
      set({ initStatus: 'ready', initError: null });
    } catch (e) {
      set({
        initStatus: 'failed',
        initError: e instanceof Error ? e.message : String(e)
      });
      throw e;
    }
  },

  recoverStorage: async () => {
    // D-06-F1-A recovery correction. Runs the SAME legitimate load as
    // `initialize` and reports the outcome without rethrowing, so the UI can
    // render 'recovered' vs 'still refused' from the returned value alone.
    // The write-refusal latch is cleared inside loadAll() strictly on a
    // successful read — this function neither clears nor bypasses it.
    try {
      await get().initialize();
      return { recovered: !IndexedDBStorageService.loadFailed, error: null };
    } catch (e) {
      return { recovered: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  loadDemoData: async () => {
    await repository.loadDemoData();
  },

  clearLocalData: async () => {
    await repository.clearLocalData();
  },

  addIncome: (title, amount, account, category, notes) => {
    // WP-FB-DATA-06a: constructed by the single TransactionFactory authority.
    return repository.transactions.append(TransactionFactory.createIncome({
      title,
      amount,
      account,
      accountId: AccountResolutionService.resolveId(account, get().accounts),
      category,
      notes
    }));
  },

  addExpense: (title, amount, account, category, notes) => {
    return repository.transactions.append(TransactionFactory.createExpense({
      title,
      amount,
      account,
      accountId: AccountResolutionService.resolveId(account, get().accounts),
      category,
      notes
    }));
  },

  addTransfer: (source, destination, amount) => {
    const accounts = get().accounts;
    // Both legs are constructed together AND admitted together: appendMany
    // validates the pair as one economic operation and writes it through a
    // single IndexedDB transaction (WP-FB-DATA-06b).
    //
    // The promise is RETURNED, not discarded. A rejection here is a refusal to
    // record the user's money, and the caller must be able to see it.
    return repository.transactions.appendMany(TransactionFactory.createTransferPair({
      source,
      destination,
      amount,
      sourceAccountId: AccountResolutionService.resolveId(source, accounts),
      destinationAccountId: AccountResolutionService.resolveId(destination, accounts)
    }));
  },

  addAsset: (name, amount) => {
    // WP-FB-DATA-07b: the OverviewPage quick-add path. It bypasses
    // FinancialCommands, which is precisely why create semantics live at the
    // repository boundary rather than in a modal.
    return repository.assets.add({ name, amount });
  },

  addLiability: (name, amount) => {
    // WP-FB-DATA-07a: the OverviewPage quick-add path. It bypasses
    // FinancialCommands, which is precisely why the duplicate-name policy is
    // enforced at the repository boundary rather than in a modal.
    return repository.liabilities.add({ name, amount });
  },

  addAssetWithMetadata: (params) => {
    return FinancialCommands.recordAssetWithMetadata(params);
  },

  updateAsset: (params) => {
    return FinancialCommands.updateAsset(params);
  },

  removeAsset: (id) => {
    return FinancialCommands.removeAsset(id);
  },

  addLiabilityWithMetadata: (params) => {
    return FinancialCommands.recordLiabilityWithMetadata(params);
  },

  updateLiability: (params) => {
    return FinancialCommands.updateLiability(params);
  },

  removeLiability: (id) => {
    return FinancialCommands.removeLiability(id);
  },

  addPastSnapshot: (params) => {
    return FinancialCommands.addPastSnapshot(params);
  },

  captureSnapshot: (label) => {
    return FinancialCommands.createSnapshot(label);
  },

  commitImportedRows: (validRows) => {
    const { transactions, accounts } = get();
    let persisted: Promise<void> | undefined;
    let appended = 0;
    let duplicates = 0;
    let divergentDuplicates = 0;
    const rejectedTransferReasons: string[] = [];
    const rejectedDuplicateIdReasons: string[] = [];

    // WP-FB-DATA-06a: identity resolved through the single authority
    // (TransactionIdentityService), which is now also what the import pipeline
    // uses. Two dedup sites, one definition of "same row".
    const existingByFingerprint = new Map<string, Transaction>();
    for (const tx of transactions) {
      const fp = TransactionIdentityService.fingerprintOf(tx);
      if (!existingByFingerprint.has(fp)) existingByFingerprint.set(fp, tx);
    }

    const candidateRows: Transaction[] = [];

    if (validRows && validRows.length > 0) {
      for (const row of validRows) {
        // Fingerprint is computed from the UNCHANGED legacy fields
        // (account|date|amount|narration). Introducing accountId does not and
        // must not alter any fingerprint (WP-FB-DATA-04 §14), and neither does
        // introducing origin/recordedAt (WP-FB-DATA-06a).
        const fp = TransactionIdentityService.fingerprintOf(row);
        const collision = existingByFingerprint.get(fp);
        if (collision) {
          duplicates++;
          // L-02 disclosure: the row is still dropped, but a drop that discards a
          // direction/type correction is now counted and reported, not silent.
          if (TransactionIdentityService.isDivergentDuplicate(row, collision)) {
            divergentDuplicates++;
          }
          continue;
        }
        existingByFingerprint.set(fp, row);

        // WP-FB-DATA-04: resolve the adapter's bank label to a registered
        // account. No deterministic match => explicitly unmapped (null), never
        // guessed and never auto-created.
        candidateRows.push({
          ...row,
          accountId: row.accountId ?? AccountResolutionService.resolveId(row.account, accounts)
        });
        appended++;
      }
    }

    // WP-FB-DATA-06b / Decision T3-b — IMPORT PATH GUARD.
    //
    // A one-sided bank row is not a transfer; it is a payment the user may later
    // reclassify. Every current adapter already emits Income/Expense and none
    // emits a transferId, so this changes nothing about importing a real
    // statement — it closes the hole discovery scenario P3 walked through, where
    // a lone transfer leg was pushed through this public API, persisted, and
    // destroyed ₹2,000.
    //
    // Rows are DROPPED AND REPORTED, never silently reclassified: rewriting a
    // Transfer into an Income would be inventing the user's intent.
    const admissible: Transaction[] = [];
    const rejectedIds = new Set<string>();
    const duplicateIdRejected = new Set<string>();

    // WP-FB-DATA-06c-0 / P-1 — ID UNIQUENESS, REPORTED ACCURATELY.
    //
    // The repository refuses a duplicate id outright, which is correct. But
    // appendMany is not awaited here, so without this pre-pass the refusal
    // would arrive as an unhandled rejection AFTER this function had already
    // returned `appended: N` — telling the user N rows were imported when zero
    // were. A result object that reports a success that did not happen is the
    // same class of defect as P-5 itself, so the check is mirrored here to keep
    // the reported outcome truthful.
    if (candidateRows.length > 0) {
      const existingIds = new Set(transactions.map(t => String(t.id)));
      const seenInBatch = new Set<string>();
      for (const rowItem of candidateRows) {
        const id = String(rowItem.id);
        if (existingIds.has(id)) {
          rejectedDuplicateIdReasons.push(`${id}: already exists in the ledger`);
          duplicateIdRejected.add(id);
        } else if (seenInBatch.has(id)) {
          rejectedDuplicateIdReasons.push(`${id}: appears more than once in this import`);
          duplicateIdRejected.add(id);
        }
        seenInBatch.add(id);
      }
    }

    if (candidateRows.length > 0) {
      const incomingGroups = TransferIntegrityService.groupByTransferId(candidateRows);
      const combined = [...transactions, ...candidateRows];
      const allGroups = TransferIntegrityService.groupByTransferId(combined);

      for (const [transferId] of incomingGroups) {
        const validation = TransferIntegrityService.validateGroup(transferId, allGroups.get(transferId) || []);
        if (validation.status === 'INVALID') {
          rejectedTransferReasons.push(TransferIntegrityService.describe(validation));
          for (const r of incomingGroups.get(transferId) || []) rejectedIds.add(r.id);
        }
      }
      for (const row of candidateRows) {
        // P-1: every row carrying a colliding id is excluded, including the
        // first occurrence — the application must not pick a winner.
        if (duplicateIdRejected.has(String(row.id))) continue;
        // A Transfer row with no transferId can never form a pair.
        if (String(row.type).toUpperCase() === 'TRANSFER' && !row.transferId) {
          rejectedTransferReasons.push(`${row.id}: transfer row carries no transferId, so it can never form a pair`);
          rejectedIds.add(row.id);
          continue;
        }
        if (!rejectedIds.has(row.id)) admissible.push(row);
      }

      if (admissible.length > 0) {
        // WP-FB-DATA-08A: the write is observable. `.catch` marks the rejection
        // handled for the runtime so an ignoring caller cannot produce a page
        // error, while the promise the caller receives still surfaces it.
        persisted = repository.transactions.appendMany(admissible);
        persisted.catch(() => { /* the caller's `persisted` is what surfaces this */ });
      }
    }

    const rejectedTransferRows = rejectedIds.size;
    const rejectedDuplicateIdRows = candidateRows.filter(r => duplicateIdRejected.has(String(r.id))).length;
    appended -= (rejectedTransferRows + rejectedDuplicateIdRows);

    return {
      appended, duplicates, divergentDuplicates,
      rejectedTransferRows, rejectedTransferReasons,
      rejectedDuplicateIdRows, rejectedDuplicateIdReasons,
      persisted
    };
  },

  /**
   * WP-FB-IMPORT-BROKER-01 — WP-08 broker-holding commit.
   *
   * Accepts the parsed `Holding[]` from a user-confirmed broker-import
   * preview and commits them atomically.
   *
   * The hook first computes a reconciliation against the current `holdings`
   * state (NEW / UPDATED / UNCHANGED / CLOSED_ABSENT) using the same identity
   * rules as `BrokerImportService.reconcile`. It then constructs a `mutate`
   * closure that applies the decisions inside `MemoryRepository.write` (the
   * single atomic boundary).
   *
   * The result is shaped like `ImportCommitOutcome`:
   *   - `appended` = NEW count
   *   - `duplicates` = UNCHANGED count
   *   - `divergentDuplicates` = UPDATED count
   *   - `rejectedTransferRows` / `rejectedTransferReasons` = CLOSED_ABSENT count / empty
   *   - `rejectedDuplicateIdRows` / `rejectedDuplicateIdReasons` = 0 / empty
   *     (the broker-import path does not introduce "transfer" semantics;
   *     these fields are kept for shape compatibility with the bank-import
   *     outcome and are always 0/empty here)
   *   - `persisted` = Promise that resolves when the atomic write completes
   *     and rejects with the persistence error (MemoryRepository.write already
   *     handles in-memory and IndexedDB rollback; the rejection is surfaced
   *     to the caller for UI display).
   */
  commitImportedHoldings: (parsed) => {
    const existing = get().holdings;
    const parsedOutput = {
      broker: parsed.length > 0 ? parsed[0].broker : 'Unknown',
      account: parsed.length > 0 ? parsed[0].account : undefined,
      holdings: parsed,
      sourceFile: parsed.length > 0 ? parsed[0].sourceFile : '',
      importedAt: parsed.length > 0 ? parsed[0].importedAt : new Date().toISOString(),
      issues: [],
    };
    const preview = BrokerImportService.reconcile(parsedOutput, existing);

    // The decision is made NOW, against the current state. The reconcile
    // function is pure and returns a snapshot. By the time the mutate
    // closure runs inside MemoryRepository.write, the state may have
    // changed (in theory); but the atomic boundary is short and the
    // decisions are still sound because the reconcile happens against the
    // pre-write snapshot.
    let persisted: Promise<void> | undefined;
    try {
      // MemoryRepository.write is the single atomic boundary (existing
      // WP-07 mechanism). It captures the ledger, runs the mutate,
      // syncs the store, then runs the IndexedDB readwrite transaction
      // with full rollback on failure. The mutate closure is built by
      // BrokerImportService.buildAtomicMutation.
      persisted = (repository as any).write(
        BrokerImportService.buildAtomicMutation(preview),
      );
      persisted.catch(() => { /* the caller's `persisted` is what surfaces this */ });
    } catch (e) {
      // planCreate / planUpdate / planClose threw synchronously (e.g. duplicate
      // identity, identity change). The write never started. Re-throw so the
      // caller can render the failure.
      throw e;
    }

    return {
      appended: preview.counts.new,
      duplicates: preview.counts.unchanged,
      divergentDuplicates: preview.counts.updated,
      rejectedTransferRows: preview.counts.closed_absent,
      rejectedTransferReasons: [] as string[],
      rejectedDuplicateIdRows: 0,
      rejectedDuplicateIdReasons: [] as string[],
      persisted,
    };
  },

  /**
   * FINBOOM-CR (CR-STANDARD-IMPORT) — Standard Import commit.
   *
   * Persists the parsed `Asset[]` candidates in a single
   * `MemoryRepository.write` boundary. Each candidate is appended via
   * `AssetRepository.add` (which delegates to
   * `AssetLifecycleService.planCreate`). Duplicate names are permitted
   * (Q-D07b-1a = (c) — the canonical Asset collection keeps duplicate
   * names as separate rows).
   *
   * Atomicity: the entire `Asset[]` is committed in one
   * `MemoryRepository.write`. A failure (in-memory planCreate refusal
   * or IndexedDB write failure) rolls back the entire mutation; the
   * returned `persisted` promise REJECTS with the failure.
   *
   * The returned `ImportCommitOutcome` uses:
   *   - `appended`           = number of Assets committed (= assets.length on success)
   *   - `duplicates`         = 0 (AssetRepository.add does not refuse duplicate names)
   *   - `divergentDuplicates`= 0
   *   - `rejectedTransferRows` / `rejectedTransferReasons` = 0 / []
   *   - `rejectedDuplicateIdRows` / `rejectedDuplicateIdReasons` = 0 / []
   *   - `persisted`          = Promise<void> (resolves on success, rejects on failure)
   *
   * V1 has NO rollback. The UI is responsible for surfacing the
   * commit-success / commit-failure message and the no-rollback
   * limitation.
   */
  commitImportedStandardAssets: (assets) => {
    let persisted: Promise<void> | undefined;
    try {
      // MemoryRepository.write is the single atomic boundary. The mutate
      // closure is SYNCHRONOUS (it returns void, not Promise<void>);
      // we operate directly on `parent.assetsData` to mirror the
      // established pattern in `MemoryAssetRepository.add` and the
      // transaction-repository patterns. AssetLifecycleService.planCreate
      // is invoked synchronously per-asset inside the mutate closure.
      persisted = (repository as any).write(() => {
        for (const asset of assets) {
          // The planCreate judgement is made against the LIVE
          // (snapshot) assets set, inside the write boundary, so a
          // concurrent mutation cannot interleave. This mirrors the
          // MemoryAssetRepository.add implementation at
          // src/services/IndexedDBStorageService.ts:359-366.
          (repository as any).assetsData =
            AssetLifecycleService.planCreate(asset, (repository as any).assetsData).next;
        }
      });
      // The caller awaits `persisted`; a rejection here is the single
      // source of failure that the UI must surface.
      persisted.catch(() => { /* the caller's `persisted` is what surfaces this */ });
    } catch (e) {
      // planCreate threw synchronously (e.g. DUPLICATE_ID). The write
      // never started. Re-throw so the caller can render the failure.
      throw e;
    }

    return {
      appended: assets.length,
      duplicates: 0,
      divergentDuplicates: 0,
      rejectedTransferRows: 0,
      rejectedTransferReasons: [] as string[],
      rejectedDuplicateIdRows: 0,
      rejectedDuplicateIdReasons: [] as string[],
      persisted,
    };
  },

  rollbackImportBatch: (importBatchId) => {
    return repository.transactions.rollbackBatch(importBatchId);
  },

  /**
   * WP-FB-IMPORT-BROKER-01 / D-06 — permanent deletion of a single
   * `closed_absent` Holding, with mandatory audit-record creation.
   *
   * Composes the holding removal and the audit-record creation inside ONE
   * `MemoryRepository.write` boundary. Both succeed or both roll back.
   *
   * Pre-validation (synchronous, throws `HoldingDeletionError` on any
   * failure): id is non-empty, holding exists, holding's status is
   * `closed_absent`. Only `closed_absent` Holdings may be permanently
   * deleted via D-06.
   *
   * On persistence failure, the existing `revertDelta` mechanism restores
   * both `holdingsData` and `holdingDeletionLogData` from the captured
   * snapshot; the returned `persisted` promise REJECTS with the failure.
   * The caller (UI) surfaces the error and keeps the data unchanged.
   *
   * D-06 is irreversible. There is no `undoHoldingDeletion` action.
   */
  commitHoldingDeletion: (id) => {
    const { holdings, holdingDeletionLog } = get();
    const asOf = new Date().toISOString();
    // planDelete is pure and synchronous; it throws HoldingDeletionError on
    // any pre-validation failure (INVALID_ID, HOLDING_NOT_FOUND,
    // HOLDING_NOT_CLOSED, DUPLICATE_AUDIT_ID). On success, `plan` is the
    // pre-computed next state — both arrays are ready, and the audit entry
    // is already shaped. We can therefore return the audit entry id
    // synchronously alongside the persisted promise.
    const plan = HoldingDeletionService.planDelete(id, asOf, holdings, holdingDeletionLog);
    const auditEntryId = plan.auditEntry.id;
    // The D-06 path composes both writes into a single atomic block by
    // attaching the live `repository` to the plan, then passing the
    // closure to MemoryRepository.write — which provides captureLedger,
    // revertDelta, and the IndexedDB readwrite transaction. The plan
    // is pre-validated: any failure here throws synchronously and the
    // closure is never built. The closure's `memoryRepo` cast is the
    // pattern used by BrokerImportService.buildAtomicMutation.
    (plan as any).__memoryRepo = repository as any;
    const persisted = (repository as any).write(
      HoldingDeletionService.buildAtomicMutation(plan),
    );
    persisted.catch(() => { /* the caller's `persisted` is what surfaces this */ });
    return { holdingId: id, auditEntryId, deletedAt: asOf, persisted };
  },

  /**
   * D-06-F1-A — user-selected multi-select BATCH deletion of `closed_absent`
   * Holdings. See the interface doc for the full contract.
   *
   * Flow (identical shape to `commitHoldingDeletion`, lifted to the batch):
   *
   *   complete validation (planDeleteMany, pure, synchronous throw on ANY
   *   failure) → complete mutation plan → ONE MemoryRepository.write →
   *   single atomic persistence boundary.
   *
   * D-06-F1-A is irreversible. There is no `undoBatchHoldingDeletion`
   * action and no automatic deletion path: only an explicit user selection
   * can reach this action.
   */
  commitBatchHoldingDeletion: (ids) => {
    const { holdings, holdingDeletionLog } = get();
    const asOf = new Date().toISOString();
    // planDeleteMany is pure and synchronous; it throws HoldingDeletionError
    // (INVALID_ID / DUPLICATE_ID / HOLDING_NOT_FOUND / HOLDING_NOT_CLOSED)
    // when ANY selected item is invalid — rejecting the ENTIRE batch before
    // any mutation. On success, `plan` is the complete pre-computed next
    // state for every selected Holding plus every audit entry.
    const plan = HoldingDeletionService.planDeleteMany(ids, asOf, holdings, holdingDeletionLog);
    const batchId = plan.batchId;
    const auditEntryIds = plan.auditEntries.map(e => e.id);
    const holdingIds = plan.targets.map(t => t.id);
    // Same wiring as commitHoldingDeletion: attach the live repository to
    // the plan, then pass the atomic closure to MemoryRepository.write,
    // which provides captureLedger, revertDelta, and the IndexedDB
    // readwrite transaction for the single persistence boundary.
    (plan as any).__memoryRepo = repository as any;
    const persisted = (repository as any).write(
      HoldingDeletionService.buildAtomicMutationForBatch(plan),
    );
    persisted.catch(() => { /* the caller's `persisted` is what surfaces this */ });
    return { holdingIds, batchId, auditEntryIds, deletedAt: asOf, persisted };
  },

  restoreImportBatch: (importBatchId) => {
    return repository.transactions.restoreBatch(importBatchId);
  },

  supersedeTransactions: (requests) => {
    return repository.transactions.supersede(requests);
  },

  addAccount: (params) => {
    return FinancialCommands.recordAccount(params).then(() => {});
  },

  removeAccount: (id) => {
    return repository.accounts.remove(id);
  },

  linkAccountToAsset: (accountId, assetId) => {
    const { accounts, assets } = get();
    const result = AccountAssetLinkService.link(accountId, assetId, accounts, assets);
    return withPersistence(result);
  },

  unlinkAccountFromAsset: (accountId) => {
    const { accounts } = get();
    const result = AccountAssetLinkService.unlink(accountId, accounts);
    return withPersistence(result);
  },

  dismissAssetCandidate: (accountId, assetId) => {
    const { accounts } = get();
    const result = AccountAssetLinkService.dismissCandidate(accountId, assetId, accounts);
    return withPersistence(result);
  },

  saveMonthlyBudget: (monthStr, allocations) => {
    return FinancialCommands.saveMonthlyBudget(monthStr, allocations).then(() => {});
  },

  addPolicy: (params) => {
    return FinancialCommands.recordPolicy(params).then(() => {});
  },

  removePolicy: (id) => {
    return FinancialCommands.deletePolicy(id);
  },

  addGoal: (params) => {
    return FinancialCommands.recordGoal(params).then(() => {});
  },

  removeGoal: (id) => {
    return FinancialCommands.deleteGoal(id);
  },

  saveProfile: (profile) => {
    return FinancialCommands.saveProfile(profile);
  },

  getFilteredTransactions: (params) => {
    const state = get();
    const type = params?.type ?? state.filterType;
    const dateRange = params?.dateRange ?? state.dateRange;
    const searchQuery = params?.search ?? state.searchQuery;
    const customStart = params?.customStart ?? state.customStart;
    const customEnd = params?.customEnd ?? state.customEnd;

    const bounds = DateRangeService.getBounds(dateRange, getEffectiveAsOfDate(), customStart, customEnd);

    // WP-FB-DATA-06c-1 / Decision 13-b — THIS IS A DISPLAY SURFACE.
    //
    // It deliberately does NOT apply LedgerExclusionService.forDerivation().
    // Excluded rows must remain visible in the Canonical Ledger; DATA-02 forbids
    // silently hiding a financial record. Adding an exclusion filter here would
    // be a defect, not a fix. Derivation surfaces filter; display surfaces label.
    return state.transactions.filter(item => {
      if (type !== 'All' && item.type !== type && item.type.toUpperCase() !== type) return false;
      if (item.date < bounds.startDate || item.date > bounds.endDate) return false;
      if (searchQuery) {
        const content = `${item.title} ${item.narration} ${item.account} ${item.category} ${item.notes || ''}`.toLowerCase();
        if (!content.includes(searchQuery.toLowerCase())) return false;
      }
      return true;
    });
  },

  getNetWorth: () => {
    const { assets, liabilities, holdings } = get();
    const totAssets = assets.reduce((sum, a) => sum + a.amount, 0)
      + holdings.reduce((sum, h) => sum + (h.currentValue || 0), 0);
    const totLiabs = liabilities.reduce((sum, l) => sum + l.amount, 0);
    return totAssets - totLiabs;
  }
}));

/**
 * WP-FB-DATA-10 — the startup load, as a named and therefore testable unit.
 *
 * Extracted from the timer body for one reason: a `.catch()` buried inside a
 * module-scope `setTimeout` runs exactly once, at module evaluation, and no
 * test can reach it. Naming it means the swallow itself is covered, rather
 * than a test re-implementing the same shape and proving nothing about the
 * shipped code.
 *
 * Resolves in BOTH outcomes — the failure has already been recorded in
 * `initStatus`/`initError` by `initialize`, and App's #startup-notice renders
 * from that state. Nothing is left for a caller to handle.
 */
export function runStartupInitialization(): Promise<void> {
  return useCanonicalLedger.getState().initialize().catch(() => {
    /* Recorded in initStatus/initError; deliberately not rethrown. */
  });
}

// Initialize storage automatically in browser
if (typeof window !== 'undefined') {
  (window as any).useCanonicalLedger = useCanonicalLedger;
  setTimeout(() => {
    /* WP-FB-DATA-10 — the startup load is OBSERVED, not discarded.
     *
     * This call was previously fire-and-forget. The 10 discovery gate measured
     * the consequence in real Chromium: with IndexedDB blocked, the rejection
     * escaped as an unhandled `pageerror` while the user was shown an ordinary
     * empty ledger — indistinguishable from a genuine first run.
     *
     * NOTE: this does NOT fix the import cycle
     * (store -> repositories -> MemoryRepository -> store). Handling the
     * rejection stops vitest reporting the resulting `undefined.initialize`
     * TypeError, but that test-lifecycle race is untouched and out of scope.
     */
    void runStartupInitialization();
  }, 0);
}
