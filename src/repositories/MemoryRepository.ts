import {
  Transaction,
  TransactionQuery,
  TransactionRepository,
  Asset,
  AssetRepository,
  Liability,
  LiabilityRepository,
  Holding,
  HoldingRepository,
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
  BatchRollbackResultShape,
  BatchRestoreResultShape,
  AmendmentRequestShape,
  AmendmentResultShape,
} from '../domain/types';
import { DateRangeService, formatDisplayDate, getEffectiveAsOfDate } from '../services/DateRangeService';
import { AccountResolutionService } from '../services/AccountResolutionService';
import { TransactionSignService } from '../services/TransactionSignService';
import { AssetIdentityService } from '../services/AssetIdentityService';
import { AssetLifecycleService } from '../services/AssetLifecycleService';
import { LiabilityLifecycleService } from '../services/LiabilityLifecycleService';
import { MemoryHoldingRepository } from './MemoryHoldingRepository';
import { AccountAssetLinkService } from '../services/AccountAssetLinkService';
import { TransferIntegrityService, TransferValidation } from '../services/TransferIntegrityService';
import { TransactionIdentityService, DuplicateIdGroup } from '../services/TransactionIdentityService';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import {
  ImportBatchRollbackService, BatchRollbackError, BatchRestoreError
} from '../services/ImportBatchRollbackService';
import {
  TransactionAmendmentService,
  AmendmentRefusedError,
  AmendmentRequest
} from '../services/TransactionAmendmentService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { demoTransactions, demoAssets, demoLiabilities, demoSnapshots } from '../domain/demoFixtures';

// WP-FB-DATA-06a: the module-local `generateFingerprint` copy that lived here
// was DEAD CODE — defined but never called anywhere in this file. It was one of
// three independent implementations of the same financial identity function.
// The single authority is now `TransactionIdentityService`.

export class MemoryTransactionRepository implements TransactionRepository {
  constructor(private parent: MemoryRepository) {}

  async findMany(query: TransactionQuery): Promise<Transaction[]> {
    return this.findManySync(query);
  }

  findManySync(query: TransactionQuery): Transaction[] {
    const { type, dateRange, search, customStart, customEnd, includeExcluded = false, asOfDateStr = getEffectiveAsOfDate() } = query;
    const bounds = DateRangeService.getBounds(dateRange || 'This Month', asOfDateStr, customStart, customEnd);

    return this.parent.transactionsData.filter(tx => {
      // WP-FB-DATA-06c-1: excluded rows are omitted unless a DISPLAY caller
      // explicitly opts in. The default is the financially conservative one.
      if (!includeExcluded && LedgerExclusionService.isExcluded(tx)) return false;

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
    return this.parent.write(() => {
      const previous = this.parent.transactionsData;
      // WP-FB-DATA-06c-0 (P-1). Id uniqueness is checked FIRST: a duplicate id
      // makes every later group/pair judgement unsound, because two different
      // rows would answer to the same name.
      TransactionIdentityService.assertUniqueIds([tx], previous);
      // WP-FB-DATA-06b admission gate. Throws before anything is mutated or
      // persisted, so an invalid transfer never reaches memory OR storage.
      TransferIntegrityService.assertAdmissible([tx], previous);
      const next = [tx, ...previous];
      this.parent.transactionsData = next;
    });
  }

  async appendMany(txs: Transaction[]): Promise<void> {
    return this.parent.write(() => {
      const previous = this.parent.transactionsData;
      // WP-FB-DATA-06c-0 (P-1). Covers BOTH collision scopes: duplicates within
      // this batch and duplicates against stored rows. Throws before any mutation,
      // so a rejected batch persists nothing at all.
      TransactionIdentityService.assertUniqueIds(txs, previous);
      // WP-FB-DATA-06b admission gate. Both legs of a transfer arrive here
      // together, so the whole pair is validated as one economic operation
      // before any of it is admitted.
      TransferIntegrityService.assertAdmissible(txs, previous);
      const next = [...txs, ...previous];
      this.parent.transactionsData = next;
    });
  }

  async findAll(): Promise<Transaction[]> {
    return this.findAllSync();
  }

  findAllSync(): Transaction[] {
    return [...this.parent.transactionsData];
  }

  /**
   * WP-FB-DATA-06c-6 / Decision 13-b — import batch rollback.
   *
   * Operates on `parent.transactionsData`, the REPOSITORY SOURCE OF TRUTH, not
   * the Zustand projection. The 06c gate-2 discovery proved a store-layer
   * change is silently reverted on the next save or reload, so a rollback
   * written there would look correct in the UI and quietly undo itself.
   *
   * Follows the identical shape as append/appendMany: validate, mutate memory,
   * sync the store, persist through the single-IDB-transaction `saveAll`
   * mirror, and roll memory back if persistence fails.
   */
  async rollbackBatch(importBatchId: string): Promise<BatchRollbackResultShape> {
    // WP-FB-DATA-07c: the plan is produced inside the mutation so it is judged
    // against the state that is actually mutated, and read out afterwards for
    // the caller's result.
    let plan!: ReturnType<typeof ImportBatchRollbackService.plan>;
    await this.parent.write(() => {
      const previous = this.parent.transactionsData;

      plan = ImportBatchRollbackService.plan(importBatchId, previous);
      if (plan.status !== 'ADMISSIBLE') throw new BatchRollbackError(plan);

      const next = ImportBatchRollbackService.apply(plan, previous, new Date().toISOString());

      // WP-FB-DATA-06c-1a / Decision D8 — WHOLE-TRANSFER GATE.
      //
      // The rollback planner already refuses a batch that would split a transfer,
      // but that guard reasons about BATCH MEMBERSHIP. This one reasons about the
      // resulting EXCLUSION STATE, so it holds no matter how the rows were
      // selected. Defence in depth: every future lifecycle primitive routes
      // through here, and structural validation cannot see partial exclusion.
      TransferIntegrityService.assertWholeTransferLifecycle(previous, next);

      // Exclusion adds no rows and removes none, so DATA-06b structural
      // invariants cannot change. Asserted rather than assumed.
      if (!ImportBatchRollbackService.structuralIntegrityUnchanged(previous, next)) {
        throw new Error(
          'Import batch rollback aborted: transfer structural integrity would change. ' +
          'This should be impossible for an exclusion-only operation.'
        );
      }

      this.parent.transactionsData = next;
    });

    return {
      batchId: plan.batchId,
      excludedCount: plan.targetIds.length,
      excludedIds: plan.targetIds,
      alreadyExcludedCount: plan.alreadyExcludedIds.length
    };
  }

  /**
   * WP-FB-DATA-06c-2b / Decision D6-1 = R5 — IMPORT BATCH RESTORE.
   *
   * The exact mirror of `rollbackBatch` above: validate the whole batch first,
   * compute the complete next array, mutate memory, sync the store, persist
   * through the single-IDB-transaction `saveAll`, and roll memory back if
   * persistence fails.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THE GATES ARE THE ONES THEY ARE
   * ─────────────────────────────────────────────────────────────────────────
   *
   * `assertUniqueIds` and `assertAdmissible` are deliberately NOT called.
   * Restore adds no rows, so there is nothing "incoming": the D6/D9 gate
   * measured both as structurally inert here (`assertUniqueIds([], prev)`
   * returns immediately). Calling them would be theatre — a guard that cannot
   * fail teaches the next maintainer that it is load-bearing when it is not.
   *
   * `assertWholeTransferLifecycle` IS called, and it is the real one. The gate
   * measured that restoring a single leg of an excluded transfer moves 2,000
   * and is caught by exactly this guard. `planRestore` refuses first with a
   * clearer code; this is the second door, and it holds no matter how the rows
   * were selected.
   *
   * ⚠️ NO DELETION. Decision D9-1 = D9-A. Nothing here removes a row, and the
   * absence of any removal path is load-bearing.
   */
  async restoreBatch(importBatchId: string): Promise<BatchRestoreResultShape> {
    // WP-FB-DATA-07c: planned inside the mutation, read out for the result.
    let plan!: ReturnType<typeof ImportBatchRollbackService.planRestore>;
    let restoredAt = '';
    await this.parent.write(() => {
      const previous = this.parent.transactionsData;

      plan = ImportBatchRollbackService.planRestore(importBatchId, previous);
      if (plan.status !== 'ADMISSIBLE') throw new BatchRestoreError(plan);

      restoredAt = new Date().toISOString();
      const next = ImportBatchRollbackService.applyRestore(plan, previous, restoredAt);

      // WP-FB-DATA-06c-1a / D8 — whole-transfer gate. Un-excluding one leg is
      // the same defect class as excluding one leg.
      TransferIntegrityService.assertWholeTransferLifecycle(previous, next);

      // Restore adds and removes no rows, so DATA-06b structural invariants
      // cannot change. Asserted rather than assumed.
      if (!ImportBatchRollbackService.structuralIntegrityUnchanged(previous, next)) {
        throw new Error(
          'Import batch restore aborted: transfer structural integrity would change. ' +
          'This should be impossible for an exclusion-only operation.'
        );
      }

      this.parent.transactionsData = next;
    });

    return {
      batchId: plan.batchId,
      restoredCount: plan.targetIds.length,
      restoredIds: plan.targetIds,
      restoredAt
    };
  }

  /**
   * WP-FB-DATA-06c-2 — AMENDMENT / SUPERSESSION. The one atomic primitive
   * (Decision D12 = C).
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY ONE WRITE AND NOT TWO
   * ─────────────────────────────────────────────────────────────────────────
   *
   * The obvious implementation is two existing calls: `append` the correction,
   * then exclude the original. The 06c-2 authorization gate MEASURED that shape
   * and recorded `INTERMEDIATE_PERSISTED_DOUBLE_COUNT: true` — between the two
   * writes both versions of the transaction are live and persisted, and a
   * ₹15,500 ledger reads ₹20,500. A crash, a reload, or a failed second write
   * leaves the user's money permanently double-counted with no marker saying so.
   *
   * So the stamped originals and the new corrections are produced as ONE array
   * by `TransactionAmendmentService.apply` and handed to ONE `saveAll`, which
   * is itself a single IndexedDB `readwrite` transaction. There is no instant,
   * in memory or at rest, in which both versions count.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * EVERY GATE IS AN EXISTING AUTHORITY
   * ─────────────────────────────────────────────────────────────────────────
   *
   * This method adds no new rule of its own. It sequences the ones already in
   * force, in the only order that is sound:
   *
   *   1. `TransactionAmendmentService.plan` — the 06c-2 decisions (Q1 = a and
   *      D8's request-shape half among them).
   *   2. `TransactionIdentityService.assertUniqueIds` — 06c-0 / P-1, FIRST of
   *      the structural gates, because a duplicate id makes every later
   *      pair judgement unsound.
   *   3. `TransferIntegrityService.assertAdmissible` — 06b. The corrections are
   *      genuinely new rows and must clear the same admission gate any other
   *      new row does.
   *   4. `TransferIntegrityService.assertWholeTransferLifecycle` — 06c-1a / D8,
   *      the second door. `plan` reasons about which rows were REQUESTED; this
   *      reasons about the resulting EXCLUSION STATE, so it holds however the
   *      rows were selected.
   *   5. `IndexedDBStorageService.saveAll` — 06c-0 / P-5 and READFAIL. It
   *      rethrows on failure and refuses outright while `lastLoadFailed` is
   *      set, so an amendment can never be written over unread data.
   *
   * Memory is rolled back if persistence fails, exactly as append/appendMany
   * and rollbackBatch do.
   */
  async supersede(requests: AmendmentRequestShape[]): Promise<AmendmentResultShape> {
    // WP-FB-DATA-07c: planned and applied inside the mutation; the caller's
    // result is read out afterwards.
    let result!: AmendmentResultShape;
    await this.parent.write(() => {
      const previous = this.parent.transactionsData;

      const plan = TransactionAmendmentService.plan(requests as AmendmentRequest[], previous);
      if (plan.status !== 'ADMISSIBLE') throw new AmendmentRefusedError(plan);

      const { next, corrections, result: applied } = TransactionAmendmentService.apply(
        plan,
        previous,
        new Date().toISOString()
      );

      TransactionIdentityService.assertUniqueIds(corrections, previous);
      TransferIntegrityService.assertAdmissible(corrections, previous);
      TransferIntegrityService.assertWholeTransferLifecycle(previous, next);

      this.parent.transactionsData = next;
      result = applied;
    });

    return result;
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
   * WP-FB-DATA-07b — CREATE. Always appends.
   *
   * The legacy exact-name upsert that WP-FB-DATA-04c-1 deliberately preserved
   * is GONE (Q-D07b-1a = (c)). It existed only because re-adding under the same
   * name was the product's only correction mechanism; 07b ships Edit, so the
   * silent upsert would now be a second, different mutation semantics for one
   * user intent — and the gate measured it destroying ₹5,00,000 through the
   * real modal, with no notice of any kind.
   *
   * Duplicate names are PERMITTED. The obligation that creates is on the UI,
   * which must make same-named assets distinguishable wherever they are shown
   * or chosen between (`AssetLifecycleService.describeDistinguishing`).
   */
  async add(asset: Asset): Promise<void> {
    return this.parent.write(() => {
      // Planned inside the write boundary so the judgement is made against the
      // state that is actually mutated (WP-FB-DATA-07c).
      this.parent.assetsData =
        AssetLifecycleService.planCreate(asset as any, this.parent.assetsData).next;
    });
  }

  /**
   * WP-FB-DATA-07b — EDIT. Id-addressed complete-record replace, one atomic write.
   *
   * Refuses an id that is not present instead of appending, takes identity from
   * storage rather than the caller, and carries every editable field through —
   * the three hazards the gate measured against the bare primitive.
   */
  async update(asset: Asset): Promise<void> {
    return this.parent.write(() => {
      this.parent.assetsData =
        AssetLifecycleService.planUpdate(asset as any, this.parent.assetsData).next;
    });
  }

  /**
   * WP-FB-DATA-07b — DELETE (Q-D07b-1b = (b)). Id-addressed, one row, one write.
   *
   * Physical deletion of a user-entered holding. It is irreversible and there
   * is deliberately no soft-delete state on `Asset`: importing that vocabulary
   * would extend a transaction-lifecycle concept to a different entity. D9-A
   * still prohibits transaction deletion.
   *
   * The account link is cleared in the SAME write (04c-2), so no account is
   * ever left holding a dangling reference. The account, its transactions and
   * its balance are untouched — measured at the 07b gate.
   *
   * A target that is not present now REFUSES rather than silently succeeding.
   */
  async remove(id: string): Promise<void> {
    return this.parent.write(() => {
      const plan = AssetLifecycleService.planDelete(id, this.parent.assetsData);

      this.parent.accountsData =
        AccountAssetLinkService.clearLinksToAsset(plan.id, this.parent.accountsData).accounts;

      this.parent.assetsData = plan.next;
    });
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

  /**
   * WP-FB-DATA-07a — CREATE. Always appends.
   *
   * The legacy exact-name upsert that WP-FB-DATA-07 deliberately preserved is
   * GONE (Q-D07a-4 = (b)). It existed only because re-adding under the same
   * name was the product's only correction mechanism; 07a ships Edit, so the
   * silent upsert would now be a second, different mutation semantics for one
   * user intent — and the 07a gate measured it destroying ₹25,00,000 when the
   * user meant to record a second loan.
   *
   * A duplicate name is refused with a message pointing at Edit
   * (Q-D07a-2 = (b)). The policy lives in `LiabilityLifecycleService`, not in a
   * modal, because there are TWO create paths and OverviewPage:89 does not go
   * through the modal.
   */
  async add(liability: Liability): Promise<void> {
    const plan = LiabilityLifecycleService.planCreate(
      liability as any,
      this.parent.liabilitiesData
    );
    await this.commit(plan.next);
  }

  /**
   * WP-FB-DATA-07a — EDIT. Id-addressed full-record replace, one atomic write.
   *
   * Refuses an id that is not present instead of appending (the N9 hazard
   * measured at the gate: debt 100 -> 10,099 from a stale id).
   */
  async update(liability: Liability): Promise<void> {
    const plan = LiabilityLifecycleService.planUpdate(
      liability as any,
      this.parent.liabilitiesData
    );
    await this.commit(plan.next);
  }

  /**
   * WP-FB-DATA-07a — DELETE (Q-D07a-3 = (b)). On the port now, and id-addressed.
   *
   * This is the product's first irreversible destructive operation and it is
   * scoped to liabilities ONLY: they are user-entered figures, not a financial
   * ledger. D9-A still prohibits transaction deletion, and no soft-exclusion
   * vocabulary is imported onto `Liability`.
   */
  async remove(id: string): Promise<void> {
    const plan = LiabilityLifecycleService.planDelete(id, this.parent.liabilitiesData);
    await this.commit(plan.next);
  }

  /**
   * ONE atomic `saveAll`, with exact memory rollback on failure.
   *
   * Every liability mutation goes through here so that create, edit and delete
   * cannot drift in their failure behaviour. The promise is RETURNED to the
   * caller: a rejection means the user's money was not recorded and they must
   * be told (F-06b-2).
   */
  private async commit(next: Liability[]): Promise<void> {
    return this.parent.write(() => {
      const previous = this.parent.liabilitiesData;
      this.parent.liabilitiesData = next;
    });
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
    return this.parent.write(() => {
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
    });
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
    return this.parent.write(() => {
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
    });
  }

  async remove(id: string): Promise<void> {
    return this.parent.write(() => {
      const previous = this.parent.accountsData;
      const previousTransactions = this.parent.transactionsData;
      const next = previous.filter(a => a.id !== id);

      // WP-FB-DATA-04: transactions are NEVER silently orphaned. Any row pointing
      // at the removed account is explicitly transitioned to the unmapped state
      // (accountId = null). The rows themselves - and every financial value on
      // them - are preserved and remain visible in the canonical Ledger.
      this.parent.unmapAccount(id);

      this.parent.accountsData = next;
    });
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
    return this.parent.write(() => {
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
    });
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
    return this.parent.write(() => {
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
    });
  }

  async remove(id: string): Promise<void> {
    return this.parent.write(() => {
      const previous = this.parent.policiesData;
      const next = previous.filter(p => p.id !== id);
      this.parent.policiesData = next;
    });
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
    return this.parent.write(() => {
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
    });
  }

  async remove(id: string): Promise<void> {
    return this.parent.write(() => {
      const previous = this.parent.goalsData;
      const next = previous.filter(g => g.id !== id);
      this.parent.goalsData = next;
    });
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
    return this.parent.write(() => {
      const previous = this.parent.profileData;
      const next = { ...profile };
      this.parent.profileData = next;
    });
  }
}

/** WP-FB-DATA-07c: one operation's view of the whole ledger. */
interface LedgerSnapshot {
  transactions: Transaction[];
  assets: Asset[];
  liabilities: Liability[];
  holdings: Holding[];
  snapshots: NetWorthSnapshot[];
  accounts: Account[];
  budgets: MonthlyBudget[];
  policies: InsurancePolicy[];
  goals: FinancialGoal[];
  profile: FinancialProfile | null;
}

export class MemoryRepository implements FinancialRepositoryPort {
  public transactionsData: Transaction[] = [];
  /**
   * WP-FB-DATA-06b / Decision T2-a: transfers that failed the integrity check
   * when this ledger was loaded. Report only — no row was modified.
   */
  public brokenTransfersAtLoad: TransferValidation[] = [];
  /**
   * WP-FB-DATA-06c-0 (P-1): duplicate transaction ids present in the data when
   * this ledger was loaded. Report only — no row was modified or removed.
   */
  public duplicateTransactionIdsAtLoad: DuplicateIdGroup[] = [];
  /**
   * WP-FB-DATA-06c-1a: transfers found only partly excluded when this ledger was
   * loaded. Report only — no row was modified.
   */
  public partiallyExcludedTransfersAtLoad: TransferValidation[] = [];
  public assetsData: Asset[] = [];
  public liabilitiesData: Liability[] = [];
  public holdingsData: Holding[] = [];
  public snapshotsData: NetWorthSnapshot[] = [];
  public accountsData: Account[] = [];
  public budgetsData: MonthlyBudget[] = [];
  public policiesData: InsurancePolicy[] = [];
  public goalsData: FinancialGoal[] = [];
  public profileData: FinancialProfile | null = null;

  public transactions: TransactionRepository = new MemoryTransactionRepository(this);
  public assets: AssetRepository = new MemoryAssetRepository(this);
  public liabilities: LiabilityRepository = new MemoryLiabilityRepository(this);
  public holdings: HoldingRepository = new MemoryHoldingRepository(this);
  public snapshots: SnapshotRepository = new MemorySnapshotRepository(this);
  public accounts: AccountRepository = new MemoryAccountRepository(this);
  public budgets: BudgetRepository = new MemoryBudgetRepository(this);
  public policies: PolicyRepository = new MemoryPolicyRepository(this);
  public goals: GoalRepository = new MemoryGoalRepository(this);
  public profile: ProfileRepository = new MemoryProfileRepository(this);

  /* ═══════════════════════════════════════════════════════════════════════
   * WP-FB-DATA-07c — THE WRITE BOUNDARY
   *
   * THE DEFECT THIS CLOSES (measured in real Chromium against live IndexedDB)
   *
   * Every repository mutation used to be written as:
   *
   *     const previous = this.parent.xData;   // whole-collection snapshot
   *     this.parent.xData = next;             // optimistic, synchronous
   *     try { await saveAll(...) }
   *     catch { this.parent.xData = previous; throw }   // whole-collection restore
   *
   * `saveAll` was serialised; the memory mutation and the rollback were not.
   * Two overlapping writes therefore interleaved:
   *
   *     op1  snapshot [X,Y,Z]   memory := [Y,Z]
   *     op2  snapshot [Y,Z]     memory := [Z]
   *     op1  save FAILS  -> memory := [X,Y,Z]      op2's success ERASED
   *     op2  save OK     -> storage := [Z]         op1's "failed" delete PERSISTED
   *
   *   measured:  memory [X,Y,Z]   storage [Z]   after reload: [Z]
   *
   * The user was told one delete failed and one succeeded, saw neither happen,
   * and after a reload found both had. Reproduced identically for TRANSACTIONS
   * (`append` t1 rejected + t2 ok -> memory [], storage [t2, t1]).
   *
   * THE FIX — operation-scoped revert, not snapshot restore
   *
   *   1. The optimistic synchronous mutation is KEPT. It is what makes the UI
   *      respond immediately, and 400+ existing tests assert it.
   *   2. The save runs inside the existing write lock and persists the LIVE
   *      ledger, so it can never write a stale, precomputed array.
   *   3. On failure the collection is not restored wholesale. Only THIS
   *      operation's delta is undone, against the state as it is at that
   *      moment, so a concurrent success is left standing.
   *   4. Where no overlap happened — the overwhelmingly common case — the
   *      revert is byte-exact: it restores the captured arrays unchanged, so
   *      ordering and object identity behave exactly as before this package.
   *
   * WHAT THIS IS NOT: no event log, no undo system, no audit fields, no schema
   * change, and no new transaction capability. It is persistence ordering and
   * in-memory consistency only.
   * ══════════════════════════════════════════════════════════════════════ */

  /** Shallow copy of every collection — one operation's "before" picture. */
  private captureLedger(): LedgerSnapshot {
    return {
      transactions: this.transactionsData,
      assets: this.assetsData,
      liabilities: this.liabilitiesData,
      holdings: this.holdingsData,
      snapshots: this.snapshotsData,
      accounts: this.accountsData,
      budgets: this.budgetsData,
      policies: this.policiesData,
      goals: this.goalsData,
      profile: this.profileData
    };
  }

  /** The live ledger, as the persistence layer must see it at save time. */
  public currentLedger(): LedgerSnapshot {
    return this.captureLedger();
  }

  private restoreLedger(snapshot: LedgerSnapshot): void {
    this.transactionsData = snapshot.transactions as Transaction[];
    this.assetsData = snapshot.assets as Asset[];
    this.liabilitiesData = snapshot.liabilities as Liability[];
    this.holdingsData = (snapshot.holdings as Holding[]) ?? [];
    this.snapshotsData = snapshot.snapshots as NetWorthSnapshot[];
    this.accountsData = snapshot.accounts as Account[];
    this.budgetsData = snapshot.budgets as MonthlyBudget[];
    this.policiesData = snapshot.policies as InsurancePolicy[];
    this.goalsData = snapshot.goals as FinancialGoal[];
    this.profileData = snapshot.profile as FinancialProfile | null;
  }

  /**
   * Undo one operation's delta against the CURRENT state.
   *
   * `before` and `after` bracket the operation. `current` may already contain
   * later operations' work, which must survive. Rules, per collection:
   *
   *   - a record this operation ADDED is dropped, unless someone has changed
   *     it since (then it is somebody else's record now, and is left alone);
   *   - a record this operation MODIFIED is restored to its earlier value,
   *     unless it has changed again since;
   *   - a record this operation REMOVED is put back, unless it has already
   *     been re-added.
   *
   * Records this operation never touched are never touched here either.
   */
  private revertDelta(before: LedgerSnapshot, after: LedgerSnapshot): void {
    const keyOf = (r: any): string =>
      String(r?.id ?? r?.monthStr ?? r?.dateStr ?? JSON.stringify(r));
    const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

    const revertOne = (beforeRows: any[], afterRows: any[], currentRows: any[]): any[] => {
      // Fast path: nothing else touched this collection, so restore exactly —
      // same order, same object identities, indistinguishable from the old
      // snapshot rollback.
      if (same(currentRows, afterRows)) return beforeRows;

      const beforeMap = new Map(beforeRows.map(r => [keyOf(r), r]));
      const afterMap = new Map(afterRows.map(r => [keyOf(r), r]));
      const currentKeys = new Set(currentRows.map(r => keyOf(r)));

      const merged: any[] = [];
      for (const row of currentRows) {
        const k = keyOf(row);
        const mine = afterMap.get(k);
        const original = beforeMap.get(k);
        if (mine !== undefined && !same(row, mine)) {
          merged.push(row);          // changed since my write — not mine to undo
        } else if (mine !== undefined && original === undefined) {
          continue;                  // I added it, untouched since — drop it
        } else if (mine !== undefined && original !== undefined && !same(mine, original)) {
          merged.push(original);     // I modified it, untouched since — restore
        } else {
          merged.push(row);
        }
      }
      for (const [k, original] of beforeMap) {
        // I removed it and nobody re-added it — put it back.
        if (!afterMap.has(k) && !currentKeys.has(k)) merged.push(original);
      }
      return merged;
    };

    this.transactionsData = revertOne(before.transactions, after.transactions, this.transactionsData);
    this.assetsData = revertOne(before.assets, after.assets, this.assetsData);
    this.liabilitiesData = revertOne(before.liabilities, after.liabilities, this.liabilitiesData);
    this.holdingsData = revertOne(before.holdings ?? [], after.holdings ?? [], this.holdingsData);
    this.snapshotsData = revertOne(before.snapshots, after.snapshots, this.snapshotsData);
    this.accountsData = revertOne(before.accounts, after.accounts, this.accountsData);
    this.budgetsData = revertOne(before.budgets, after.budgets, this.budgetsData);
    this.policiesData = revertOne(before.policies, after.policies, this.policiesData);
    this.goalsData = revertOne(before.goals, after.goals, this.goalsData);
    // Profile is a single record, not a collection: restore it only if it still
    // holds exactly what this operation left there.
    if (same(this.profileData, after.profile)) this.profileData = before.profile as FinancialProfile | null;
  }

  /**
   * Run one repository mutation.
   *
   * `mutate` runs SYNCHRONOUSLY and optimistically, exactly as before. The
   * save is then serialised through the existing write lock, and a failure
   * undoes only this operation (see `revertDelta`) before a compensating save
   * reconciles storage with the corrected memory.
   */
  public async write(mutate: () => void): Promise<void> {
    const before = this.captureLedger();
    mutate();
    const after = this.captureLedger();
    this.syncStore();

    return IndexedDBStorageService.runExclusive(async (lease) => {
      try {
        // The LIVE ledger, never a precomputed array: a save that runs after a
        // concurrent revert must persist the corrected state, not a stale one.
        await IndexedDBStorageService.persist(lease, this.currentLedger());
      } catch (e) {
        this.revertDelta(before, after);
        this.syncStore();
        try {
          // Reconcile storage with the reverted memory. Without this, a failed
          // write whose delta a concurrent save already persisted would leave
          // memory and storage disagreeing — the very defect being closed.
          await IndexedDBStorageService.persist(lease, this.currentLedger());
        } catch {
          // The compensating write failed too. Memory is correct; storage is
          // not, and we say so by rethrowing the original failure below rather
          // than reporting a success that did not happen.
        }
        throw e;
      }
    });
  }

  public syncStore() {
    useCanonicalLedger.getState().syncWithRepository({
      transactions: [...this.transactionsData],
      assets: [...this.assetsData],
      liabilities: [...this.liabilitiesData],
      holdings: [...this.holdingsData],
      snapshots: [...this.snapshotsData],
      accounts: [...this.accountsData],
      budgets: [...this.budgetsData],
      policies: [...this.policiesData],
      goals: [...this.goalsData],
      profile: this.profileData ? { ...this.profileData } : null
    });
  }

  async initialize(): Promise<void> {
    // WP-FB-DATA-06c-READFAIL: a genuine read failure now propagates instead of
    // silently presenting an empty ledger. It is logged here so the cause is
    // visible, then rethrown so the caller can act on it — the repository must
    // not decide on the application's behalf that an unreadable ledger is empty.
    let data;
    try {
      data = await IndexedDBStorageService.loadAll();
    } catch (e) {
      if (typeof console !== 'undefined') {
        console.error(
          '[WP-FB-DATA-06c-READFAIL] Could not load the stored ledger. ' +
          'No data was modified, and writes are blocked until a load succeeds.',
          e
        );
      }
      throw e;
    }
    this.transactionsData = data.transactions;
    this.assetsData = data.assets;
    this.liabilitiesData = data.liabilities;
    this.holdingsData = data.holdings ?? [];
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

    // WP-FB-DATA-06b / Decision T2-a: DETECT AND REPORT ONLY.
    //
    // Existing ledgers can already contain broken or invalid transfers — the
    // account-deletion path produced them before this package existed. They are
    // surfaced here and in the UI reconciliation notice. Nothing is repaired:
    // synthesising a missing leg would invent financial data the user never
    // entered, and silently dropping a leg would destroy data they did.
    // WP-FB-DATA-06c-0 (P-1) existing-data condition: DETECT AND REPORT ONLY.
    // No row is modified, removed, re-identified or chosen as the winner.
    this.duplicateTransactionIdsAtLoad = TransactionIdentityService.findDuplicateIds(this.transactionsData);
    if (this.duplicateTransactionIdsAtLoad.length > 0 && typeof console !== 'undefined') {
      console.warn(
        `[WP-FB-DATA-06c-0] ${this.duplicateTransactionIdsAtLoad.length} duplicate transaction id(s) ` +
        `detected in stored data. No data was modified.\n` +
        this.duplicateTransactionIdsAtLoad.map(d => '  - ' + d.message).join('\n')
      );
    }

    // WP-FB-DATA-06c-1a / Decision D8: DETECT AND REPORT ONLY. A transfer that
    // is already partly excluded is left exactly as it is — choosing whether to
    // exclude the remaining leg or restore the excluded one is a lifecycle
    // decision that has not been made.
    this.partiallyExcludedTransfersAtLoad =
      TransferIntegrityService.findPartiallyExcludedTransfers(this.transactionsData);
    if (this.partiallyExcludedTransfersAtLoad.length > 0 && typeof console !== 'undefined') {
      console.warn(
        `[WP-FB-DATA-06c-1a] ${this.partiallyExcludedTransfersAtLoad.length} transfer(s) are only ` +
        `partly excluded from balances and reports. No data was modified.\n` +
        this.partiallyExcludedTransfersAtLoad.map(v => '  - ' + TransferIntegrityService.describe(v)).join('\n')
      );
    }

    this.brokenTransfersAtLoad = TransferIntegrityService.findBrokenTransfers(this.transactionsData);
    if (this.brokenTransfersAtLoad.length > 0 && typeof console !== 'undefined') {
      console.warn(
        `[WP-FB-DATA-06b] ${this.brokenTransfersAtLoad.length} transfer(s) failed the integrity check at load. ` +
        `No data was modified.\n` +
        this.brokenTransfersAtLoad.map(v => '  - ' + TransferIntegrityService.describe(v)).join('\n')
      );
    }

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
    return this.write(() => {
      const previous = this.accountsData;
      this.accountsData = accounts;
    });
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

  /**
   * WP-FB-DATA-09 (3) — demo data now goes through the ONE write boundary.
   *
   * Previously this assigned all nine collections directly and then called
   * `IndexedDBStorageService.saveAll`, bypassing `write()` entirely. That
   * bypass had two measured consequences at the 09 discovery gate:
   *
   *   1. `demoAssets` carry no `id`, and the `assets` store is keyed on `id`.
   *      Nothing assigned one, because the repository write path that normally
   *      does so was never entered. The resulting `DataError` tore the save in
   *      half and committed a ledger state that never existed in memory.
   *   2. There was no rollback of any kind. A persistence failure left memory
   *      holding demo data while storage still held the user's real ledger.
   *
   * Routing through `write()` fixes both by construction: identity is assigned
   * before the mutation, and a failed save reverts this operation's delta and
   * reconciles storage, exactly as every other repository mutation does.
   *
   * Demo amounts and semantics are untouched — only identity is added.
   */
  async loadDemoData(): Promise<void> {
    return this.write(() => {
      // The same authority the load migration uses (see `applyMigrations`), so
      // demo assets acquire real `ast-` ids without inventing a second scheme.
      const identifiedAssets = AssetIdentityService.migrate(
        demoAssets.map(a => ({ ...a }))
      ).assets;

      this.transactionsData = [...demoTransactions];
      this.assetsData = identifiedAssets;
      this.liabilitiesData = [...demoLiabilities];
      this.holdingsData = [];
      this.snapshotsData = [...demoSnapshots];
      this.accountsData = [];
      this.budgetsData = [];
      this.policiesData = [];
      this.goalsData = [];
      this.profileData = null;
    });
  }

  /**
   * WP-FB-DATA-09 (4) — clearing goes through the same boundary.
   *
   * `write()` persists the live ledger with `clear()` + `put()` per store and
   * re-stamps `hasLoadedOnce`, which is byte-for-byte what `clearAll` did, so
   * the clearing semantics are preserved exactly. What changes is that the
   * operation is now leased, atomic, and rolled back on failure instead of
   * leaving memory empty while storage still holds the data.
   */
  async clearLocalData(): Promise<void> {
    return this.write(() => {
      this.transactionsData = [];
      this.assetsData = [];
      this.liabilitiesData = [];
      this.holdingsData = [];
      this.snapshotsData = [];
      this.accountsData = [];
      this.budgetsData = [];
      this.policiesData = [];
      this.goalsData = [];
      this.profileData = null;
    });
  }
}
