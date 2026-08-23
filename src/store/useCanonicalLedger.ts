import { FinancialCommands } from '../application/commands';
import { create } from 'zustand';
import {
  Transaction,
  Asset,
  Liability,
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
    snapshots: NetWorthSnapshot[];
    accounts?: Account[];
    budgets?: MonthlyBudget[];
    policies?: InsurancePolicy[];
    goals?: FinancialGoal[];
    profile?: FinancialProfile | null;
  }) => void;

  initialize: () => Promise<void>;
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

export const useCanonicalLedger = create<LedgerState>((set, get) => ({
  transactions: [],
  assets: [],
  liabilities: [],
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

  rollbackImportBatch: (importBatchId) => {
    return repository.transactions.rollbackBatch(importBatchId);
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
    const { assets, liabilities } = get();
    const totAssets = assets.reduce((sum, a) => sum + a.amount, 0);
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
