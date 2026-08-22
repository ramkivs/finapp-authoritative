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
  FinancialProfile
} from '../domain/types';
import { formatDisplayDate, DateRangeService, getEffectiveAsOfDate } from '../services/DateRangeService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
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
  addTransfer: (source: string, destination: string, amount: number) => void;
  addAsset: (name: string, amount: number) => void;
  addLiability: (name: string, amount: number) => void;
  addAssetWithMetadata: (params: { name: string; amount: number; type?: any; tag?: string; currency?: string; geography?: any }) => void;
  addLiabilityWithMetadata: (params: { name: string; amount: number; type?: any; currency?: string }) => void;
  addPastSnapshot: (params: { dateStr: string; totalAssets: number; totalLiabilities: number; label?: string }) => void;
  captureSnapshot: (label?: string) => void;
  commitImportedRows: (validRows?: Transaction[]) => { appended: number; duplicates: number; divergentDuplicates: number };

  // Account & Budget Actions (WP-18)
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
    // Both legs come from one construction call. See TransactionFactory's scope
    // note: this guarantees a transfer is CREATED balanced, not that it stays
    // balanced — enforcing that is WP-FB-DATA-06b (finding L-01).
    repository.transactions.appendMany(TransactionFactory.createTransferPair({
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
      if (candidateRows.length > 0) {
        repository.transactions.appendMany(candidateRows);
      }
    }

    return { appended, duplicates, divergentDuplicates };
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
