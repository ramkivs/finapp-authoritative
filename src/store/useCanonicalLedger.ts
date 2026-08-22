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
  BatchRollbackResultShape
} from '../domain/types';
import { formatDisplayDate, DateRangeService, getEffectiveAsOfDate } from '../services/DateRangeService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountResolutionService } from '../services/AccountResolutionService';
import { AccountAssetLinkService, LinkResult } from '../services/AccountAssetLinkService';
import { TransactionSignService } from '../services/TransactionSignService';
import { repository } from '../repositories';

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
  loadDemoData: () => Promise<void>;
  clearLocalData: () => Promise<void>;

  addIncome: (title: string, amount: number, account: string, category: string, notes?: string) => void;
  addExpense: (title: string, amount: number, account: string, category: string, notes?: string) => void;
  /**
   * WP-FB-DATA-06b: returns the persistence promise so a transfer-integrity
   * rejection is visible to the caller. Previously fire-and-forget, which meant
   * any rejection became an invisible unhandled promise rejection.
   */
  addTransfer: (source: string, destination: string, amount: number) => Promise<void>;
  addAsset: (name: string, amount: number) => void;
  addLiability: (name: string, amount: number) => void;
  addAssetWithMetadata: (params: { name: string; amount: number; type?: any; tag?: string; currency?: string; geography?: any }) => void;
  addLiabilityWithMetadata: (params: { name: string; amount: number; type?: any; currency?: string }) => void;
  addPastSnapshot: (params: { dateStr: string; totalAssets: number; totalLiabilities: number; label?: string }) => void;
  captureSnapshot: (label?: string) => void;
  commitImportedRows: (validRows?: Transaction[]) => {
    appended: number;
    duplicates: number;
    divergentDuplicates: number;
    /** WP-FB-DATA-06b / T3-b: rows excluded because they were not a valid transfer pair. */
    rejectedTransferRows: number;
    rejectedTransferReasons: string[];
    /** WP-FB-DATA-06c-0 / P-1: rows excluded because their id was already in use. */
    rejectedDuplicateIdRows: number;
    rejectedDuplicateIdReasons: string[];
  };

  // Account & Budget Actions (WP-18)
  /**
   * WP-FB-DATA-06c-6 / Decision 13-b. Returns the promise so a refusal is
   * visible to the caller rather than becoming an invisible unhandled
   * rejection (the F-06b-2 lesson).
   */
  rollbackImportBatch: (importBatchId: string) => Promise<BatchRollbackResultShape>;
  addAccount: (params: {
    name: string;
    type: ControlledAccountType;
    institution?: string;
    lastFourDigits?: string;
    openingBalance: number;
    currency?: string;
    asOfDate?: string;
    notes?: string;
  }) => void;
  removeAccount: (id: string) => void;
  /** WP-FB-DATA-04c-2: explicit Account<->Asset link (0..1 <-> 0..1). */
  linkAccountToAsset: (accountId: string, assetId: string) => LinkResult;
  unlinkAccountFromAsset: (accountId: string) => LinkResult;
  /** WP-FB-DATA-05b G3: record "not the same money" for a same-name candidate. */
  dismissAssetCandidate: (accountId: string, assetId: string) => LinkResult;
  saveMonthlyBudget: (monthStr: string, allocations: Record<string, number>) => void;

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
  }) => void;
  removePolicy: (id: string) => void;
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
  }) => void;
  removeGoal: (id: string) => void;
  saveProfile: (profile: FinancialProfile) => void;

  getFilteredTransactions: (params?: {
    type?: 'Expense' | 'Income' | 'Transfer' | 'All';
    dateRange?: string;
    search?: string;
    customStart?: string;
    customEnd?: string;
  }) => Transaction[];
  getNetWorth: () => number;
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
    await repository.initialize();
  },

  loadDemoData: async () => {
    await repository.loadDemoData();
  },

  clearLocalData: async () => {
    await repository.clearLocalData();
  },

  addIncome: (title, amount, account, category, notes) => {
    // WP-FB-DATA-06a: constructed by the single TransactionFactory authority.
    repository.transactions.append(TransactionFactory.createIncome({
      title,
      amount,
      account,
      accountId: AccountResolutionService.resolveId(account, get().accounts),
      category,
      notes
    }));
  },

  addExpense: (title, amount, account, category, notes) => {
    repository.transactions.append(TransactionFactory.createExpense({
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
    repository.assets.add({ name, amount });
  },

  addLiability: (name, amount) => {
    repository.liabilities.add({ name, amount });
  },

  addAssetWithMetadata: (params) => {
    FinancialCommands.recordAssetWithMetadata(params);
  },

  addLiabilityWithMetadata: (params) => {
    FinancialCommands.recordLiabilityWithMetadata(params);
  },

  addPastSnapshot: (params) => {
    FinancialCommands.addPastSnapshot(params);
  },

  captureSnapshot: (label) => {
    FinancialCommands.createSnapshot(label);
  },

  commitImportedRows: (validRows) => {
    const { transactions, accounts } = get();
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
        repository.transactions.appendMany(admissible);
      }
    }

    const rejectedTransferRows = rejectedIds.size;
    const rejectedDuplicateIdRows = candidateRows.filter(r => duplicateIdRejected.has(String(r.id))).length;
    appended -= (rejectedTransferRows + rejectedDuplicateIdRows);

    return {
      appended, duplicates, divergentDuplicates,
      rejectedTransferRows, rejectedTransferReasons,
      rejectedDuplicateIdRows, rejectedDuplicateIdReasons
    };
  },

  rollbackImportBatch: (importBatchId) => {
    return repository.transactions.rollbackBatch(importBatchId);
  },

  addAccount: (params) => {
    FinancialCommands.recordAccount(params);
  },

  removeAccount: (id) => {
    repository.accounts.remove(id);
  },

  linkAccountToAsset: (accountId, assetId) => {
    const { accounts, assets } = get();
    const result = AccountAssetLinkService.link(accountId, assetId, accounts, assets);
    if (result.ok && !result.unchanged) {
      (repository as any).applyAccountsUpdate(result.accounts);
    }
    return result;
  },

  unlinkAccountFromAsset: (accountId) => {
    const { accounts } = get();
    const result = AccountAssetLinkService.unlink(accountId, accounts);
    if (result.ok && !result.unchanged) {
      (repository as any).applyAccountsUpdate(result.accounts);
    }
    return result;
  },

  dismissAssetCandidate: (accountId, assetId) => {
    const { accounts } = get();
    const result = AccountAssetLinkService.dismissCandidate(accountId, assetId, accounts);
    if (result.ok && !result.unchanged) {
      (repository as any).applyAccountsUpdate(result.accounts);
    }
    return result;
  },

  saveMonthlyBudget: (monthStr, allocations) => {
    FinancialCommands.saveMonthlyBudget(monthStr, allocations);
  },

  addPolicy: (params) => {
    FinancialCommands.recordPolicy(params);
  },

  removePolicy: (id) => {
    FinancialCommands.deletePolicy(id);
  },

  addGoal: (params) => {
    FinancialCommands.recordGoal(params);
  },

  removeGoal: (id) => {
    FinancialCommands.deleteGoal(id);
  },

  saveProfile: (profile) => {
    FinancialCommands.saveProfile(profile);
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

// Initialize storage automatically in browser
if (typeof window !== 'undefined') {
  (window as any).useCanonicalLedger = useCanonicalLedger;
  setTimeout(() => {
    useCanonicalLedger.getState().initialize();
  }, 0);
}
