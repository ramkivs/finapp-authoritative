export type TransactionType = 'Income' | 'Expense' | 'Transfer' | 'INCOME' | 'EXPENSE' | 'TRANSFER';

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

export interface Transaction {
  id: string;
  dateStr: string;
  date: string;
  title: string;
  narration: string;
  account: string;
  type: TransactionType;
  category: string;
  amount: number;
  status: TransactionStatus;
  notes?: string;
  transferId?: string;
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
  name: string;
  amount: number;
  type?: AssetType;
  tag?: string;
  currency?: string;      // Descriptive metadata only; no FX conversion
  geography?: GeographyType; // Explicit geography; not inferred from currency
}

export interface Liability {
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
}

export interface TransactionRepository {
  findMany(query: TransactionQuery): Promise<Transaction[]>;
  findManySync(query: TransactionQuery): Transaction[];
  findAll(): Promise<Transaction[]>;
  findAllSync(): Transaction[];
  append(transaction: Transaction): Promise<void>;
  appendMany(transactions: Transaction[]): Promise<void>;
}

export interface AssetRepository {
  findAll(): Promise<Asset[]>;
  findAllSync(): Asset[];
  add(asset: Asset): Promise<void>;
}

export interface LiabilityRepository {
  findAll(): Promise<Liability[]>;
  findAllSync(): Liability[];
  add(liability: Liability): Promise<void>;
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
