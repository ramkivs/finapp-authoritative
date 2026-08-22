import {
  Transaction,
  TransactionQuery,
  TransactionRepository,
  Asset,
  AssetRepository,
  Liability,
  LiabilityRepository,
  NetWorthSnapshot,
  SnapshotRepository,
  Account,
  AccountRepository,
  MonthlyBudget,
  BudgetRepository,
  InsurancePolicy,
  PolicyRepository,
  FinancialGoal,
  GoalRepository,
  FinancialProfile,
  ProfileRepository,
  FinancialRepositoryPort,
} from '../domain/types';
import { DateRangeService, formatDisplayDate, getEffectiveAsOfDate } from '../services/DateRangeService';
import { AccountResolutionService } from '../services/AccountResolutionService';
import { TransactionSignService } from '../services/TransactionSignService';
import { AssetIdentityService } from '../services/AssetIdentityService';
import { AccountAssetLinkService } from '../services/AccountAssetLinkService';
import { Sha256Service } from '../services/Sha256Service';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { demoTransactions, demoAssets, demoLiabilities, demoSnapshots } from '../domain/demoFixtures';

function generateFingerprint(tx: { account: string; date: string; amount: number; narration: string }): string {
  const canonicalString = `${tx.account}|${tx.date}|${tx.amount}|${tx.narration.toLowerCase().trim()}`;
  return Sha256Service.hash(canonicalString);
}

export class MemoryTransactionRepository implements TransactionRepository {
  constructor(private parent: MemoryRepository) {}

  async findMany(query: TransactionQuery): Promise<Transaction[]> {
    return this.findManySync(query);
  }

  findManySync(query: TransactionQuery): Transaction[] {
    const { type, dateRange, search, customStart, customEnd, asOfDateStr = getEffectiveAsOfDate() } = query;
    const bounds = DateRangeService.getBounds(dateRange || 'This Month', asOfDateStr, customStart, customEnd);

    return this.parent.transactionsData.filter(tx => {
      // Type Filter
      if (type && type !== 'All') {
        if (tx.type !== type && tx.type.toUpperCase() !== type) return false;
      }

      // Date Range Filter
      if (tx.date < bounds.startDate || tx.date > bounds.endDate) return false;

      // Search Query
      if (search && search.trim()) {
        const q = search.toLowerCase();
        const text = `${tx.title} ${tx.narration} ${tx.account} ${tx.category} ${tx.notes || ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }

      return true;
    });
  }

  async findById(id: string): Promise<Transaction | null> {
    return this.parent.transactionsData.find(tx => tx.id === id) || null;
  }

  async append(tx: Transaction): Promise<void> {
    const previous = this.parent.transactionsData;
    const next = [tx, ...previous];
    this.parent.transactionsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: next,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.transactionsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  async appendMany(txs: Transaction[]): Promise<void> {
    const previous = this.parent.transactionsData;
    const next = [...txs, ...previous];
    this.parent.transactionsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: next,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.transactionsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  async findAll(): Promise<Transaction[]> {
    return this.findAllSync();
  }

  findAllSync(): Transaction[] {
    return [...this.parent.transactionsData];
  }
}

export class MemoryAssetRepository implements AssetRepository {
  constructor(private parent: MemoryRepository) {}

  async findAll(): Promise<Asset[]> {
    return this.findAllSync();
  }

  findAllSync(): Asset[] {
    return [...this.parent.assetsData];
  }

  findByIdSync(id: string): Asset | null {
    return this.parent.assetsData.find(a => a.id === id) || null;
  }

  /**
   * Upsert keyed on the authoritative `Asset.id` (WP-FB-DATA-04c-1).
   *
   * When the incoming asset carries no id the legacy create path applies: an
   * existing record with the identical (exact) name is updated in place and
   * keeps its id, exactly as before this package, so `recordAsset(name, amount)`
   * behaves unchanged. Otherwise a new stable id is generated.
   *
   * Names are NEVER normalised for matching here - that would merge assets the
   * user deliberately created as distinct.
   */
  async add(asset: Asset): Promise<void> {
    const previous = this.parent.assetsData;
    let next: Asset[];

    const byId = AssetIdentityService.isValidId(asset.id)
      ? previous.findIndex(a => a.id === asset.id)
      : -1;

    if (byId >= 0) {
      next = [...previous];
      next[byId] = { ...asset, id: previous[byId].id };
    } else {
      // Legacy create path: exact-name match preserves prior upsert behaviour.
      const byName = AssetIdentityService.isValidId(asset.id)
        ? -1
        : previous.findIndex(a => a.name === asset.name);
      if (byName >= 0) {
        next = [...previous];
        next[byName] = { ...asset, id: previous[byName].id || AssetIdentityService.generateId() };
      } else {
        next = [...previous, { ...asset, id: asset.id || AssetIdentityService.generateId() }];
      }
    }

    this.parent.assetsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: next,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.assetsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  /** Removes by authoritative id (WP-FB-DATA-04c-1); never by display name. */
  async remove(id: string): Promise<void> {
    const previous = this.parent.assetsData;
    const previousAccounts = this.parent.accountsData;
    const next = previous.filter(a => a.id !== id);

    // WP-FB-DATA-04c-2: no account may be left holding a dangling reference.
    // The account, its transactions and its balance are untouched.
    this.parent.accountsData =
      AccountAssetLinkService.clearLinksToAsset(id, this.parent.accountsData).accounts;

    this.parent.assetsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: next,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.assetsData = previous;
      this.parent.accountsData = previousAccounts;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemoryLiabilityRepository implements LiabilityRepository {
  constructor(private parent: MemoryRepository) {}

  async findAll(): Promise<Liability[]> {
    return this.findAllSync();
  }

  findAllSync(): Liability[] {
    return [...this.parent.liabilitiesData];
  }

  async add(liability: Liability): Promise<void> {
    const previous = this.parent.liabilitiesData;
    const idx = previous.findIndex(l => l.name === liability.name);
    let next: Liability[];
    if (idx >= 0) {
      next = [...previous];
      next[idx] = { ...liability };
    } else {
      next = [...previous, { ...liability }];
    }
    this.parent.liabilitiesData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: next,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.liabilitiesData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  async remove(name: string): Promise<void> {
    const previous = this.parent.liabilitiesData;
    const next = previous.filter(l => l.name !== name);
    this.parent.liabilitiesData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: next,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.liabilitiesData = previous;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemorySnapshotRepository implements SnapshotRepository {
  constructor(private parent: MemoryRepository) {}

  async findAll(): Promise<NetWorthSnapshot[]> {
    return this.findAllSync();
  }

  findAllSync(): NetWorthSnapshot[] {
    return [...this.parent.snapshotsData].sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  }

  async create(snapshot?: NetWorthSnapshot): Promise<void> {
    const prev = this.parent.snapshotsData;
    let next: NetWorthSnapshot[];

    if (snapshot) {
      const existingIdx = prev.findIndex(s => s.dateStr === snapshot.dateStr);
      if (existingIdx >= 0) {
        next = [...prev];
        next[existingIdx] = { ...snapshot };
      } else {
        next = [snapshot, ...prev];
      }
    } else {
      const totAssets = this.parent.assetsData.reduce((sum, a) => sum + a.amount, 0);
      const totLiabs = this.parent.liabilitiesData.reduce((sum, l) => sum + l.amount, 0);
      const netWorth = totAssets - totLiabs;

      const newSnap: NetWorthSnapshot = {
        id: 'snap-' + Date.now(),
        dateStr: formatDisplayDate(getEffectiveAsOfDate()) + ' (Today)',
        totalAssets: totAssets,
        totalLiabilities: totLiabs,
        netWorth,
        status: 'Anchored Permanent'
      };
      next = [newSnap, ...prev];
    }

    this.parent.snapshotsData = next;
    this.parent.syncStore();

    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: next,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (err) {
      this.parent.snapshotsData = prev;
      this.parent.syncStore();
      throw err;
    }
  }

  async add(snapshot: NetWorthSnapshot): Promise<void> {
    return this.create(snapshot);
  }
}

export class MemoryAccountRepository implements AccountRepository {
  constructor(private parent: MemoryRepository) {}

  async findAll(): Promise<Account[]> {
    return this.findAllSync();
  }

  findAllSync(): Account[] {
    return [...this.parent.accountsData];
  }

  async add(account: Account): Promise<void> {
    const existing = this.parent.accountsData.find(
      a => a.name.trim().toLowerCase() === account.name.trim().toLowerCase() && a.id !== account.id
    );
    if (existing) {
      throw new Error(`Account name "${account.name}" already exists. Account names must be unique.`);
    }

    const previous = this.parent.accountsData;
    const idx = previous.findIndex(a => a.id === account.id);
    let next: Account[];
    if (idx >= 0) {
      next = [...previous];
      next[idx] = { ...account };
    } else {
      next = [...previous, { ...account }];
    }
    this.parent.accountsData = next;
    // WP-FB-DATA-04: a newly registered (or renamed) account may resolve rows
    // that were previously unmapped. Already-valid references are untouched.
    this.parent.remapAccounts();
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: next,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.accountsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    const previous = this.parent.accountsData;
    const previousTransactions = this.parent.transactionsData;
    const next = previous.filter(a => a.id !== id);

    // WP-FB-DATA-04: transactions are NEVER silently orphaned. Any row pointing
    // at the removed account is explicitly transitioned to the unmapped state
    // (accountId = null). The rows themselves - and every financial value on
    // them - are preserved and remain visible in the canonical Ledger.
    this.parent.unmapAccount(id);

    this.parent.accountsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: next,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.accountsData = previous;
      this.parent.transactionsData = previousTransactions;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemoryBudgetRepository implements BudgetRepository {
  constructor(private parent: MemoryRepository) {}

  async findForMonth(monthStr: string): Promise<MonthlyBudget | null> {
    return this.findForMonthSync(monthStr);
  }

  findForMonthSync(monthStr: string): MonthlyBudget | null {
    const found = this.parent.budgetsData.find(b => b.monthStr === monthStr);
    return found ? { ...found } : null;
  }

  async findAll(): Promise<MonthlyBudget[]> {
    return this.findAllSync();
  }

  findAllSync(): MonthlyBudget[] {
    return [...this.parent.budgetsData];
  }

  async save(budget: MonthlyBudget): Promise<void> {
    const previous = this.parent.budgetsData;
    const idx = previous.findIndex(b => b.monthStr === budget.monthStr);
    let next: MonthlyBudget[];
    if (idx >= 0) {
      next = [...previous];
      next[idx] = { ...budget };
    } else {
      next = [...previous, { ...budget }];
    }
    this.parent.budgetsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: next,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.budgetsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemoryPolicyRepository implements PolicyRepository {
  constructor(private parent: MemoryRepository) {}

  async findAll(): Promise<InsurancePolicy[]> {
    return this.findAllSync();
  }

  findAllSync(): InsurancePolicy[] {
    return [...this.parent.policiesData];
  }

  async add(policy: InsurancePolicy): Promise<void> {
    const previous = this.parent.policiesData;
    const idx = previous.findIndex(p => p.id === policy.id);
    let next: InsurancePolicy[];
    if (idx >= 0) {
      next = [...previous];
      next[idx] = { ...policy };
    } else {
      next = [...previous, { ...policy }];
    }
    this.parent.policiesData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: next,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.policiesData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    const previous = this.parent.policiesData;
    const next = previous.filter(p => p.id !== id);
    this.parent.policiesData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: next,
        goals: this.parent.goalsData,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.policiesData = previous;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemoryGoalRepository implements GoalRepository {
  constructor(private parent: MemoryRepository) {}

  async findAll(): Promise<FinancialGoal[]> {
    return this.findAllSync();
  }

  findAllSync(): FinancialGoal[] {
    return [...this.parent.goalsData];
  }

  async add(goal: FinancialGoal): Promise<void> {
    const previous = this.parent.goalsData;
    const idx = previous.findIndex(g => g.id === goal.id);
    let next: FinancialGoal[];
    if (idx >= 0) {
      next = [...previous];
      next[idx] = { ...goal };
    } else {
      next = [...previous, { ...goal }];
    }
    this.parent.goalsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: next,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.goalsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    const previous = this.parent.goalsData;
    const next = previous.filter(g => g.id !== id);
    this.parent.goalsData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: next,
        profile: this.parent.profileData
      });
    } catch (e) {
      this.parent.goalsData = previous;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemoryProfileRepository implements ProfileRepository {
  constructor(private parent: MemoryRepository) {}

  async get(): Promise<FinancialProfile | null> {
    return this.getSync();
  }

  getSync(): FinancialProfile | null {
    return this.parent.profileData ? { ...this.parent.profileData } : null;
  }

  async save(profile: FinancialProfile): Promise<void> {
    const previous = this.parent.profileData;
    const next = { ...profile };
    this.parent.profileData = next;
    this.parent.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.parent.transactionsData,
        assets: this.parent.assetsData,
        liabilities: this.parent.liabilitiesData,
        snapshots: this.parent.snapshotsData,
        accounts: this.parent.accountsData,
        budgets: this.parent.budgetsData,
        policies: this.parent.policiesData,
        goals: this.parent.goalsData,
        profile: next
      });
    } catch (e) {
      this.parent.profileData = previous;
      this.parent.syncStore();
      throw e;
    }
  }
}

export class MemoryRepository implements FinancialRepositoryPort {
  public transactionsData: Transaction[] = [];
  public assetsData: Asset[] = [];
  public liabilitiesData: Liability[] = [];
  public snapshotsData: NetWorthSnapshot[] = [];
  public accountsData: Account[] = [];
  public budgetsData: MonthlyBudget[] = [];
  public policiesData: InsurancePolicy[] = [];
  public goalsData: FinancialGoal[] = [];
  public profileData: FinancialProfile | null = null;

  public transactions: TransactionRepository = new MemoryTransactionRepository(this);
  public assets: AssetRepository = new MemoryAssetRepository(this);
  public liabilities: LiabilityRepository = new MemoryLiabilityRepository(this);
  public snapshots: SnapshotRepository = new MemorySnapshotRepository(this);
  public accounts: AccountRepository = new MemoryAccountRepository(this);
  public budgets: BudgetRepository = new MemoryBudgetRepository(this);
  public policies: PolicyRepository = new MemoryPolicyRepository(this);
  public goals: GoalRepository = new MemoryGoalRepository(this);
  public profile: ProfileRepository = new MemoryProfileRepository(this);

  public syncStore() {
    useCanonicalLedger.getState().syncWithRepository({
      transactions: [...this.transactionsData],
      assets: [...this.assetsData],
      liabilities: [...this.liabilitiesData],
      snapshots: [...this.snapshotsData],
      accounts: [...this.accountsData],
      budgets: [...this.budgetsData],
      policies: [...this.policiesData],
      goals: [...this.goalsData],
      profile: this.profileData ? { ...this.profileData } : null
    });
  }

  async initialize(): Promise<void> {
    const data = await IndexedDBStorageService.loadAll();
    this.transactionsData = data.transactions;
    this.assetsData = data.assets;
    this.liabilitiesData = data.liabilities;
    this.snapshotsData = data.snapshots;
    this.accountsData = data.accounts;
    this.budgetsData = data.budgets;
    this.policiesData = data.policies;
    this.goalsData = data.goals;
    this.profileData = data.profile;

    // WP-FB-DATA-04: backfill Transaction.accountId from the legacy display
    // name. Deterministic and non-destructive - no transaction is dropped and
    // no field other than accountId is written.
    this.transactionsData = AccountResolutionService.migrate(
      this.transactionsData,
      this.accountsData
    ).transactions;

    // WP-FB-DATA-04b: backfill Transaction.direction. Transfer legs predating
    // the field are recovered deterministically from their generated markers.
    this.transactionsData = TransactionSignService.migrate(this.transactionsData).transactions;

    // WP-FB-DATA-04c-1: backfill Asset.id. Deterministic, idempotent and
    // lossless - only `id` is written and no asset is merged or dropped.
    this.assetsData = AssetIdentityService.migrate(this.assetsData).assets;

    // WP-FB-DATA-04c-2: normalise Account.linkedAssetId absent -> null so the
    // "deliberately unlinked" state is explicit. NO link is ever inferred from
    // matching names - that assumption is the B5 defect itself.
    this.accountsData = AccountAssetLinkService.migrate(this.accountsData).accounts;

    this.syncStore();
  }

  /**
   * Re-runs account resolution against the current account registry.
   * Used after an account is added/renamed so previously unmapped transactions
   * can become mapped. Never reassigns an already-valid reference.
   */
  /**
   * WP-FB-DATA-04c-2 link persistence. The relationship decision itself lives
   * in AccountAssetLinkService; this only writes the validated result.
   *
   * Mirrors every other repository mutation: update in memory, sync the store
   * for immediate UI feedback, then persist. On a persistence failure the
   * previous accounts are restored so the link never silently half-applies.
   */
  async applyAccountsUpdate(accounts: Account[]): Promise<void> {
    const previous = this.accountsData;
    this.accountsData = accounts;
    this.syncStore();
    try {
      await IndexedDBStorageService.saveAll({
        transactions: this.transactionsData,
        assets: this.assetsData,
        liabilities: this.liabilitiesData,
        snapshots: this.snapshotsData,
        accounts: this.accountsData,
        budgets: this.budgetsData,
        policies: this.policiesData,
        goals: this.goalsData,
        profile: this.profileData
      });
    } catch (e) {
      this.accountsData = previous;
      this.syncStore();
      throw e;
    }
  }

  remapAccounts(): void {
    this.transactionsData = AccountResolutionService.migrate(
      this.transactionsData,
      this.accountsData
    ).transactions;
  }

  /**
   * Explicitly transitions every transaction referencing `accountId` to the
   * unmapped state. Used when an account is deleted so rows are never silently
   * orphaned. This is deliberately narrow - it touches ONLY accountId and is
   * not a general transaction-update capability (that is DATA-06 scope).
   */
  unmapAccount(accountId: string): number {
    let affected = 0;
    this.transactionsData = this.transactionsData.map(tx => {
      if (tx.accountId === accountId) {
        affected++;
        return { ...tx, accountId: null };
      }
      return tx;
    });
    return affected;
  }

  /** Count of transactions currently referencing an account. */
  countTransactionsForAccount(accountId: string): number {
    return this.transactionsData.filter(tx => tx.accountId === accountId).length;
  }

  async loadDemoData(): Promise<void> {
    this.transactionsData = [...demoTransactions];
    this.assetsData = [...demoAssets];
    this.liabilitiesData = [...demoLiabilities];
    this.snapshotsData = [...demoSnapshots];
    this.accountsData = [];
    this.budgetsData = [];
    this.policiesData = [];
    this.goalsData = [];
    this.profileData = null;
    this.syncStore();
    await IndexedDBStorageService.saveAll({
      transactions: this.transactionsData,
      assets: this.assetsData,
      liabilities: this.liabilitiesData,
      snapshots: this.snapshotsData,
      accounts: this.accountsData,
      budgets: this.budgetsData,
      policies: this.policiesData,
      goals: this.goalsData,
      profile: this.profileData
    });
  }

  async clearLocalData(): Promise<void> {
    this.transactionsData = [];
    this.assetsData = [];
    this.liabilitiesData = [];
    this.snapshotsData = [];
    this.accountsData = [];
    this.budgetsData = [];
    this.policiesData = [];
    this.goalsData = [];
    this.profileData = null;
    this.syncStore();
    await IndexedDBStorageService.clearAll();
  }
}
