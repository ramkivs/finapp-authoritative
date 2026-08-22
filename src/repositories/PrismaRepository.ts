import {
  Transaction, Asset, Liability, NetWorthSnapshot,
  TransactionQuery, TransactionRepository, AssetRepository,
  LiabilityRepository, SnapshotRepository, FinancialRepositoryPort,
  Account, AccountRepository, MonthlyBudget, BudgetRepository,
  InsurancePolicy, PolicyRepository, FinancialGoal, GoalRepository,
  FinancialProfile, ProfileRepository
} from '../domain/types';
import { TransferIntegrityService } from '../services/TransferIntegrityService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';

/**
 * Gate 8 Prisma Repository Adapter (Hexagonal Persistence Port)
 * This adapter implements the exact same FinancialRepositoryPort interface.
 * Prisma Client calls are strictly encapsulated inside this module; zero Prisma
 * dependencies leak into Domain Services, Application API, or React presentation.
 */
export class PrismaTransactionRepository implements TransactionRepository {
  async findMany(query: TransactionQuery): Promise<Transaction[]> {
    return this.findManySync(query);
  }

  findManySync(_query: TransactionQuery): Transaction[] {
    return [];
  }

  async findAll(): Promise<Transaction[]> {
    return this.findAllSync();
  }

  findAllSync(): Transaction[] {
    return [];
  }

  async append(transaction: Transaction): Promise<void> {
    // WP-FB-DATA-06b: the invariant is mirrored here deliberately.
    // Placing it only in MemoryRepository would mean the second implementation
    // of TransactionRepository silently permits money-destroying writes.
    TransactionIdentityService.assertUniqueIds([transaction], this.findAllSync());
    TransferIntegrityService.assertAdmissible([transaction], this.findAllSync());
    // Production implementation: await prisma.transaction.create({ data: ... });
  }

  /**
   * WP-FB-DATA-06b: validates the batch as ONE economic operation before
   * writing any of it.
   *
   * ⚠️ The per-row loop below is NOT atomic — it is N separate writes. A real
   * Prisma implementation MUST wrap this in `prisma.$transaction([...])`, or a
   * mid-loop failure will persist one leg of a transfer and lose the other,
   * reintroducing exactly the defect this package closes. Validating up front
   * prevents an INVALID pair from ever being attempted, but it cannot make a
   * non-atomic writer atomic.
   */
  async appendMany(transactions: Transaction[]): Promise<void> {
    TransactionIdentityService.assertUniqueIds(transactions, this.findAllSync());
    TransferIntegrityService.assertAdmissible(transactions, this.findAllSync());
    for (const tx of transactions) {
      // Production implementation: await prisma.transaction.create({ data: ... });
      void tx;
    }
  }
}

export class PrismaAssetRepository implements AssetRepository {
  async findAll(): Promise<Asset[]> {
    return this.findAllSync();
  }

  findAllSync(): Asset[] {
    return [];
  }

  async add(_asset: Asset): Promise<void> {
    // Production implementation: await prisma.asset.create({ data: ... });
  }

  findByIdSync(_id: string): Asset | null {
    // Production implementation: await prisma.asset.findUnique({ where: { id } });
    return null;
  }

  async remove(_id: string): Promise<void> {}
}

export class PrismaLiabilityRepository implements LiabilityRepository {
  async findAll(): Promise<Liability[]> {
    return this.findAllSync();
  }

  findAllSync(): Liability[] {
    return [];
  }

  async add(_liability: Liability): Promise<void> {
    // Production implementation: await prisma.liability.create({ data: ... });
  }

  async remove(_name: string): Promise<void> {}
}

export class PrismaSnapshotRepository implements SnapshotRepository {
  async findAll(): Promise<NetWorthSnapshot[]> {
    return this.findAllSync();
  }

  findAllSync(): NetWorthSnapshot[] {
    return [];
  }

  async create(_snapshot?: NetWorthSnapshot): Promise<void> {
    // Production implementation: await prisma.snapshot.create({ data: ... });
  }

  async add(_snapshot: NetWorthSnapshot): Promise<void> {
    // Production implementation
  }
}

export class PrismaAccountRepository implements AccountRepository {
  async findAll(): Promise<Account[]> {
    return this.findAllSync();
  }

  findAllSync(): Account[] {
    return [];
  }

  async add(_account: Account): Promise<void> {}
  async remove(_id: string): Promise<void> {}
}

export class PrismaBudgetRepository implements BudgetRepository {
  async findForMonth(_monthStr: string): Promise<MonthlyBudget | null> {
    return this.findForMonthSync(_monthStr);
  }

  findForMonthSync(_monthStr: string): MonthlyBudget | null {
    return null;
  }

  async findAll(): Promise<MonthlyBudget[]> {
    return this.findAllSync();
  }

  findAllSync(): MonthlyBudget[] {
    return [];
  }

  async save(_budget: MonthlyBudget): Promise<void> {}
}

export class PrismaPolicyRepository implements PolicyRepository {
  async findAll(): Promise<InsurancePolicy[]> {
    return this.findAllSync();
  }

  findAllSync(): InsurancePolicy[] {
    return [];
  }

  async add(_policy: InsurancePolicy): Promise<void> {}
  async remove(_id: string): Promise<void> {}
}

export class PrismaGoalRepository implements GoalRepository {
  async findAll(): Promise<FinancialGoal[]> {
    return this.findAllSync();
  }

  findAllSync(): FinancialGoal[] {
    return [];
  }

  async add(_goal: FinancialGoal): Promise<void> {}
  async remove(_id: string): Promise<void> {}
}

export class PrismaProfileRepository implements ProfileRepository {
  async get(): Promise<FinancialProfile | null> {
    return this.getSync();
  }

  getSync(): FinancialProfile | null {
    return null;
  }

  async save(_profile: FinancialProfile): Promise<void> {}
}

export class PrismaRepository implements FinancialRepositoryPort {
  public transactions = new PrismaTransactionRepository();
  public assets = new PrismaAssetRepository();
  public liabilities = new PrismaLiabilityRepository();
  public snapshots = new PrismaSnapshotRepository();
  public accounts = new PrismaAccountRepository();
  public budgets = new PrismaBudgetRepository();
  public policies = new PrismaPolicyRepository();
  public goals = new PrismaGoalRepository();
  public profile = new PrismaProfileRepository();

  async clearLocalData(): Promise<void> {
    // Production implementation: await prisma.transaction.deleteMany(); etc.
  }

  async loadDemoData(): Promise<void> {
    // Production implementation
  }

  async initialize(): Promise<void> {
    // Production implementation
  }
}
