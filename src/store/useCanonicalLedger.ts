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
import { Sha256Service } from '../services/Sha256Service';
import { AccountResolutionService } from '../services/AccountResolutionService';
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
  commitImportedRows: (validRows?: Transaction[]) => { appended: number; duplicates: number };

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

function generateFingerprint(tx: { account: string; date: string; amount: number; narration: string }): string {
  const canonicalString = `${tx.account}|${tx.date}|${tx.amount}|${tx.narration.toLowerCase().trim()}`;
  return Sha256Service.hash(canonicalString);
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
    const tx: Transaction = {
      id: 'tx-inc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      date: getEffectiveAsOfDate(),
      dateStr: formatDisplayDate(getEffectiveAsOfDate()),
      title,
      narration: 'MANUAL/' + title.toUpperCase(),
      account,
      accountId: AccountResolutionService.resolveId(account, get().accounts),
      direction: 'CREDIT',
      type: 'Income',
      category,
      amount,
      status: 'CLEARED',
      notes
    };
    repository.transactions.append(tx);
  },

  addExpense: (title, amount, account, category, notes) => {
    const tx: Transaction = {
      id: 'tx-exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      date: getEffectiveAsOfDate(),
      dateStr: formatDisplayDate(getEffectiveAsOfDate()),
      title,
      narration: 'MANUAL/' + title.toUpperCase(),
      account,
      accountId: AccountResolutionService.resolveId(account, get().accounts),
      direction: 'DEBIT',
      type: 'Expense',
      category,
      amount,
      status: 'CLEARED',
      notes: notes || 'Manual expense entry'
    };
    repository.transactions.append(tx);
  },

  addTransfer: (source, destination, amount) => {
    const transferId = 'tr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const debitLeg: Transaction = {
      id: transferId + '-debit',
      transferId,
      date: getEffectiveAsOfDate(),
      dateStr: formatDisplayDate(getEffectiveAsOfDate()),
      title: 'Transfer to ' + destination,
      narration: 'TRANSFER-DEBIT/' + transferId,
      account: source,
      accountId: AccountResolutionService.resolveId(source, get().accounts),
      direction: 'DEBIT',
      type: 'Transfer',
      category: 'TRANSFER',
      amount,
      status: 'CLEARED',
      notes: 'Bank-to-Bank Transfer (Debit)'
    };
    const creditLeg: Transaction = {
      id: transferId + '-credit',
      transferId,
      date: getEffectiveAsOfDate(),
      dateStr: formatDisplayDate(getEffectiveAsOfDate()),
      title: 'Transfer from ' + source,
      narration: 'TRANSFER-CREDIT/' + transferId,
      account: destination,
      accountId: AccountResolutionService.resolveId(destination, get().accounts),
      direction: 'CREDIT',
      type: 'Transfer',
      category: 'TRANSFER',
      amount,
      status: 'CLEARED',
      notes: 'Bank-to-Bank Transfer (Credit)'
    };
    repository.transactions.appendMany([debitLeg, creditLeg]);
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

    const existingFingerprints = new Set(
      transactions.map(tx => tx.fingerprint || generateFingerprint({ account: tx.account, date: tx.date, amount: tx.amount, narration: tx.narration }))
    );

    const candidateRows: Transaction[] = [];

    if (validRows && validRows.length > 0) {
      for (const row of validRows) {
        // Fingerprint is computed from the UNCHANGED legacy fields
        // (account|date|amount|narration). Introducing accountId does not and
        // must not alter any fingerprint (WP-FB-DATA-04 §14).
        const fp = row.fingerprint || generateFingerprint(row);
        if (existingFingerprints.has(fp)) {
          duplicates++;
          continue;
        }
        existingFingerprints.add(fp);

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

    return { appended, duplicates };
  },

  addAccount: (params) => {
    FinancialCommands.recordAccount(params);
  },

  removeAccount: (id) => {
    repository.accounts.remove(id);
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
