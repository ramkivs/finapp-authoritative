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
 * (WP-FB-DATA-06c-1, Decision 13-b).
 *
 * ⚠️ EXACTLY ONE MEMBER, DELIBERATELY.
 *
 * Decision 13-b resolved the disposition of IMPORT ROLLBACK only: rolled-back
 * rows are retained, marked, excluded from balances and reports, and remain
 * visible in the Ledger with an explicit disclosure.
 *
 * Lifecycle Decisions 1-8, 10 and 12 are STILL UNRESOLVED. There is therefore
 * no `DELETED`, `SUPERSEDED`, `REVERSED` or `AMENDED` member here, and adding
 * one is not a refactor — it is the act of resolving the corresponding
 * decision. The exclusion MECHANISM is decision-free; this vocabulary is the
 * ledger of which decisions have actually been made.
 */
export type LedgerExclusionReason = 'IMPORT_ROLLBACK';

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
}

export interface AssetRepository {
  findAll(): Promise<Asset[]>;
  findAllSync(): Asset[];
  /** Upserts by `Asset.id`; assigns one when absent (WP-FB-DATA-04c-1). */
  add(asset: Asset): Promise<void>;
  /** Finds by authoritative id. */
  findByIdSync(id: string): Asset | null;
  /** Removes by authoritative id. */
  remove(id: string): Promise<void>;
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
