import {
  Transaction,
  Asset,
  Liability,
  Holding,
  NetWorthSnapshot,
  Account,
  MonthlyBudget,
  InsurancePolicy,
  FinancialGoal,
  FinancialProfile
} from '../domain/types';
import { AssetIdentityService } from './AssetIdentityService';
import { LiabilityIdentityService } from './LiabilityIdentityService';

const DB_NAME = 'finboom_db';
// WP-FB-DATA-04c-1: bumped 3 -> 4. The `assets` object store moves from
// keyPath 'name' to keyPath 'id' so that a mutable display name is no longer
// the storage key. See migrateAssetsToIdKeyPath() below.
// WP-FB-DATA-07: 4 -> 5 migrates `liabilities` from a 'name' keyPath to 'id',
// the last store still keyed on a mutable display string.
// See migrateLiabilitiesToIdKeyPath() below.
// WP-FB-IMPORT-BROKER-01: 5 -> 6 adds the `holdings` object store. The
// existing 9 stores are untouched. No data transformation: the migration
// is purely a schema extension. The single-line `createObjectStore` is
// verify-or-abort by virtue of running inside the IndexedDB upgrade
// transaction.
const DB_VERSION = 6;

export interface StoredLedgerState {
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
  hasLoadedOnce: boolean;
}

/**
 * WP-FB-DATA-07c — proof that the holder is running inside the write lock.
 *
 * `runExclusive` mints one lease per critical section and passes it to the
 * task. `persist` accepts a save ONLY from the lease that is currently active,
 * which makes "I am inside the lock" a checkable fact rather than a convention
 * a future edit can quietly break. It is deliberately opaque: nothing outside
 * this module can construct one.
 */
export interface WriteLease {
  readonly id: number;
}

/** The whole ledger, as written in one atomic IndexedDB transaction. */
export interface LedgerWriteState {
  transactions: Transaction[];
  assets: Asset[];
  liabilities: Liability[];
  holdings?: Holding[];
  snapshots: NetWorthSnapshot[];
  accounts?: Account[];
  budgets?: MonthlyBudget[];
  policies?: InsurancePolicy[];
  goals?: FinancialGoal[];
  profile?: FinancialProfile | null;
}

export class IndexedDBStorageService {
  private static nodeFallbackStore: StoredLedgerState = {
    transactions: [],
    assets: [],
    liabilities: [],
    holdings: [],
    snapshots: [],
    accounts: [],
    budgets: [],
    policies: [],
    goals: [],
    profile: null,
    hasLoadedOnce: false
  };

  private static mutex: Promise<any> = Promise.resolve();

  /* WP-FB-DATA-07c — the write lock.
   *
   * `mutex` already serialised the IndexedDB transaction itself. What it did
   * NOT serialise was the in-memory mutation that each repository performed
   * BEFORE enqueuing its save, nor the rollback it performed afterwards. Two
   * overlapping writes therefore interleaved like this:
   *
   *   op1  snapshot = [X,Y,Z]        memory := [Y,Z]        enqueue save
   *   op2  snapshot = [Y,Z]          memory := [Z]          enqueue save
   *   op1  save FAILS  -> memory := [X,Y,Z]   (op2's success erased)
   *   op2  save OK     -> storage  := [Z]     (both deletions persisted)
   *
   * Measured in real Chromium: memory [X,Y,Z], storage [Z]. The user was told
   * one delete failed and one succeeded, saw neither, and after a reload had
   * both. `runExclusive` closes the window by putting the WHOLE operation —
   * snapshot, mutation, save and rollback — inside the one existing lock.
   */
  private static activeLease: WriteLease | null = null;
  private static leaseCounter = 0;
  public static simulateFailureOnce: boolean = false;
  /** WP-FB-DATA-06c-READFAIL: injects a genuine read-path failure, for tests. */
  public static simulateReadFailureOnce: boolean = false;
  /**
   * WP-FB-DATA-09: injects a failure PART-WAY THROUGH queuing the multi-store
   * save, reproducing the exact condition that produced the historical torn
   * write. Exists so the abort path is provable rather than assumed.
   */
  public static simulateQueueFailureOnce: boolean = false;

  /**
   * WP-FB-DATA-09 — the keyPath every object store is created with.
   *
   * Mirrors `createObjectStore` in `getDB` exactly. Kept adjacent to the
   * validation that consumes it so the two cannot drift apart silently.
   */
  private static readonly STORE_KEY_PATHS: Readonly<Record<string, string>> = {
    transactions: 'id',
    assets: 'id',
    liabilities: 'id',
    holdings: 'id',
    snapshots: 'id',
    accounts: 'id',
    budgets: 'id',
    policies: 'id',
    goals: 'id',
    profile: 'id',
    meta: 'key'
  };

  /**
   * WP-FB-DATA-09 — refuse a save whose records cannot be keyed.
   *
   * Throws before ANY destructive operation is queued. The message names the
   * store and the offending index so the failure is diagnosable from the
   * disclosure alone, and never contains a financial amount.
   */
  private static assertRecordsSatisfyKeyPaths(plan: Array<[string, any[]]>): void {
    for (const [storeName, items] of plan) {
      const keyPath = this.STORE_KEY_PATHS[storeName];
      if (!keyPath || !Array.isArray(items)) continue;
      for (let i = 0; i < items.length; i++) {
        const record = items[i];
        const key = record == null ? undefined : (record as any)[keyPath];
        if (key === undefined || key === null || key === '') {
          throw new Error(
            `Refusing to persist: record at index ${i} destined for the "${storeName}" store ` +
            `has no "${keyPath}" value. Saving it would fail part-way through the write and ` +
            `leave stored data inconsistent, so the whole operation was refused and nothing ` +
            `was changed.`
          );
        }
      }
    }
  }

  /**
   * WP-FB-DATA-06c-READFAIL — set when a `loadAll` genuinely failed.
   *
   * While true, `saveAll` REFUSES. Propagating the read failure alone does not
   * close the destructive sequence: the app would still start with an empty
   * in-memory ledger, and the next write would `clear()` the store and persist
   * that emptiness over real data. Refusing to write after a failed read is the
   * part that actually prevents the loss.
   *
   * Cleared by any subsequent successful load, so recovery needs no new API.
   */
  private static lastLoadFailed = false;

  /** True when the most recent load attempt failed. */
  static get loadFailed(): boolean { return this.lastLoadFailed; }

  static enqueueSave<T>(task: () => Promise<T>): Promise<T> {
    const resultPromise = this.mutex.then(() => task());
    this.mutex = resultPromise.then(() => {}).catch(() => {});
    return resultPromise;
  }

  /**
   * WP-FB-DATA-07c — run a complete write operation inside the write lock.
   *
   * Everything the caller does inside `task` is serialised against every other
   * exclusive write: reading current state, mutating memory, persisting, and
   * rolling memory back on failure. Because no other write can interleave, a
   * snapshot taken inside the task CANNOT be stale by the time it is restored.
   *
   * ⚠️ NEVER call `saveAll` from inside a task — it takes the same lock and
   * would deadlock. Use `persist(lease, state)`; the lease makes that a
   * runtime-checked rule rather than a comment.
   *
   * ⚠️ Tasks must not nest. `MemorySnapshotRepository.add` therefore delegates
   * to `create` WITHOUT wrapping again.
   */
  static runExclusive<T>(task: (lease: WriteLease) => Promise<T>): Promise<T> {
    return this.enqueueSave(async () => {
      const lease: WriteLease = { id: ++this.leaseCounter };
      this.activeLease = lease;
      try {
        return await task(lease);
      } finally {
        if (this.activeLease === lease) this.activeLease = null;
      }
    });
  }

  /**
   * Persist from inside an exclusive write. Refuses a lease that is not the
   * one currently running, which is what a stray `persist` call outside the
   * lock — or a leaked lease from an earlier operation — would look like.
   */
  static async persist(lease: WriteLease, state: LedgerWriteState): Promise<void> {
    if (!lease || this.activeLease !== lease) {
      throw new Error(
        'IndexedDBStorageService.persist was called outside its write lease. ' +
        'Repository writes must run inside runExclusive(); use saveAll() for a ' +
        'standalone write.'
      );
    }
    return this.performSave(state);
  }

  private static getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        reject(new Error('IndexedDB not supported in this environment'));
        return;
      }
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        const upgradeTx = (e.target as IDBOpenDBRequest).transaction;

        // WP-FB-DATA-04c-1: assets 'name' -> 'id'. Runs BEFORE the
        // create-if-absent block so an existing legacy store is migrated
        // rather than left alone.
        if (e.oldVersion > 0 && e.oldVersion < 4 && db.objectStoreNames.contains('assets') && upgradeTx) {
          this.migrateAssetsToIdKeyPath(db, upgradeTx);
        }

        // WP-FB-DATA-07: liabilities 'name' -> 'id'. Same placement and the
        // same reason as the assets migration above — it must run BEFORE the
        // create-if-absent block, or an existing legacy store would be left on
        // its old keyPath. Gated on < 5 so it also runs for users already on
        // version 4, whose assets are migrated but whose liabilities are not.
        if (e.oldVersion > 0 && e.oldVersion < 5 && db.objectStoreNames.contains('liabilities') && upgradeTx) {
          this.migrateLiabilitiesToIdKeyPath(db, upgradeTx);
        }

        if (!db.objectStoreNames.contains('transactions')) db.createObjectStore('transactions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('liabilities')) db.createObjectStore('liabilities', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('holdings')) db.createObjectStore('holdings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('accounts')) db.createObjectStore('accounts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('budgets')) db.createObjectStore('budgets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('policies')) db.createObjectStore('policies', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('goals')) db.createObjectStore('goals', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
    });
  }

  /**
   * WP-FB-DATA-04c-1 — assets object store: keyPath 'name' -> 'id'.
   *
   * Runs inside the versionchange transaction:
   *   read all -> capture count + field fingerprint -> assign ids where absent
   *   -> delete store -> recreate with keyPath 'id' -> restore -> verify.
   *
   * Verification (count, per-field equality, id uniqueness) runs via
   * AssetIdentityService.verify(). If it fails the upgrade transaction is
   * ABORTED, leaving the database untouched at version 3 - the migration is
   * never partially applied and success is never claimed falsely.
   */
  private static lastAssetMigrationReport: {
    countBefore: number; countAfter: number; assigned: number; preserved: number;
    ambiguous: number; invalid: number; ok: boolean; failures: string[];
  } | null = null;

  static getLastAssetMigrationReport() {
    return this.lastAssetMigrationReport;
  }

  /**
   * WP-FB-DATA-07 — outcome of the liabilities `name` -> `id` migration.
   * Same contract as the asset report above: on failure the upgrade is ABORTED
   * and this records why, so a failed migration is inspectable rather than
   * silent.
   */
  private static lastLiabilityMigrationReport: {
    countBefore: number; countAfter: number; assigned: number; preserved: number;
    ambiguous: number; invalid: number; ok: boolean; failures: string[];
  } | null = null;

  static getLastLiabilityMigrationReport() {
    return this.lastLiabilityMigrationReport;
  }

  private static migrateAssetsToIdKeyPath(db: IDBDatabase, upgradeTx: IDBTransaction): void {
    const legacy = upgradeTx.objectStore('assets');
    if (legacy.keyPath === 'id') return;                    // already migrated

    const readAll = legacy.getAll();
    readAll.onsuccess = () => {
      const before: Asset[] = (readAll.result || []) as Asset[];
      const snapshot = before.map(a => ({ ...a }));         // pre-change copy

      const result = AssetIdentityService.migrate(before);
      const verification = AssetIdentityService.verify(snapshot, result.assets);

      this.lastAssetMigrationReport = {
        countBefore: snapshot.length,
        countAfter: result.assets.length,
        assigned: result.assigned,
        preserved: result.preserved,
        ambiguous: result.ambiguous,
        invalid: result.invalid,
        ok: verification.ok,
        failures: verification.failures
      };

      if (!verification.ok) {
        // Do not recreate the store on a failed verification.
        try { upgradeTx.abort(); } catch { /* transaction already settled */ }
        return;
      }

      db.deleteObjectStore('assets');
      const store = db.createObjectStore('assets', { keyPath: 'id' });
      for (const asset of result.assets) store.put(asset);
    };
    readAll.onerror = () => {
      this.lastAssetMigrationReport = {
        countBefore: -1, countAfter: -1, assigned: 0, preserved: 0,
        ambiguous: 0, invalid: 0, ok: false, failures: ['failed to read legacy assets store']
      };
      try { upgradeTx.abort(); } catch { /* already settled */ }
    };
  }

  /**
   * WP-FB-DATA-07 — migrate the `liabilities` store from `keyPath: 'name'` to
   * `keyPath: 'id'`.
   *
   * Byte-for-byte the same shape as `migrateAssetsToIdKeyPath` above, and for
   * the same reasons:
   *
   *   - read the legacy records BEFORE the store is destroyed;
   *   - assign ids with a pure, idempotent, order-preserving transform;
   *   - VERIFY the result is lossless;
   *   - ABORT the whole upgrade if verification fails, rather than recreating
   *     the store — a failed migration must never be allowed to destroy a
   *     user's debt records;
   *   - only then delete and recreate with the new keyPath.
   *
   * Duplicate-named records are carried across as SEPARATE rows with DISTINCT
   * ids. Under the old `name` keyPath IndexedDB could only hold one of them;
   * after this migration the store can hold both, which is why the create-path
   * upsert (MemoryLiabilityRepository.add) is what still prevents duplicates —
   * not the storage layer. That separation is the whole point of Q-D07-1 = (c).
   */
  private static migrateLiabilitiesToIdKeyPath(db: IDBDatabase, upgradeTx: IDBTransaction): void {
    const legacy = upgradeTx.objectStore('liabilities');
    if (legacy.keyPath === 'id') return;                    // already migrated

    const readAll = legacy.getAll();
    readAll.onsuccess = () => {
      const before: Liability[] = (readAll.result || []) as Liability[];
      const snapshot = before.map(l => ({ ...l }));         // pre-change copy

      const result = LiabilityIdentityService.migrate(before);
      const verification = LiabilityIdentityService.verify(snapshot, result.liabilities);

      this.lastLiabilityMigrationReport = {
        countBefore: snapshot.length,
        countAfter: result.liabilities.length,
        assigned: result.assigned,
        preserved: result.preserved,
        ambiguous: result.ambiguous,
        invalid: result.invalid,
        ok: verification.ok,
        failures: verification.failures
      };

      if (!verification.ok) {
        // Do not recreate the store on a failed verification.
        try { upgradeTx.abort(); } catch { /* transaction already settled */ }
        return;
      }

      db.deleteObjectStore('liabilities');
      const store = db.createObjectStore('liabilities', { keyPath: 'id' });
      for (const liability of result.liabilities) store.put(liability);
    };
    readAll.onerror = () => {
      this.lastLiabilityMigrationReport = {
        countBefore: -1, countAfter: -1, assigned: 0, preserved: 0,
        ambiguous: 0, invalid: 0, ok: false, failures: ['failed to read legacy liabilities store']
      };
      try { upgradeTx.abort(); } catch { /* already settled */ }
    };
  }

  static async loadAll(): Promise<StoredLedgerState> {
    return this.enqueueSave(async () => {
      if (this.simulateReadFailureOnce) {
        this.simulateReadFailureOnce = false;
        this.lastLoadFailed = true;
        throw new Error('Simulated IndexedDB read failure');
      }

      if (typeof window === 'undefined' || !window.indexedDB) {
        // Not a failure: this environment has no IndexedDB by design.
        this.lastLoadFailed = false;
        return {
          transactions: [...this.nodeFallbackStore.transactions],
          assets: [...this.nodeFallbackStore.assets],
          liabilities: [...this.nodeFallbackStore.liabilities],
          holdings: [...this.nodeFallbackStore.holdings],
          snapshots: [...this.nodeFallbackStore.snapshots],
          accounts: [...this.nodeFallbackStore.accounts],
          budgets: [...this.nodeFallbackStore.budgets],
          policies: [...this.nodeFallbackStore.policies],
          goals: [...this.nodeFallbackStore.goals],
          profile: this.nodeFallbackStore.profile ? { ...this.nodeFallbackStore.profile } : null,
          hasLoadedOnce: this.nodeFallbackStore.hasLoadedOnce
        };
      }

      try {
        const db = await this.getDB();
        const storeNames = ['transactions', 'assets', 'liabilities', 'holdings', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
          .filter(name => db.objectStoreNames.contains(name));

        const tx = db.transaction(storeNames, 'readonly');
        const getStore = (name: string) => new Promise<any[]>((resolve, reject) => {
          // A store that does not exist is legitimately empty.
          if (!db.objectStoreNames.contains(name)) return resolve([]);
          const req = tx.objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result || []);
          // WP-FB-DATA-06c-READFAIL: a FAILED read is not an empty store.
          // This previously resolved([]), making "could not read your
          // transactions" indistinguishable from "you have no transactions" —
          // and it never reached the catch below, so nothing else could tell
          // the difference either.
          req.onerror = () => reject(
            req.error || new Error(`IndexedDB read failed for store "${name}"`)
          );
        });

        const [
          transactions,
          assets,
          liabilities,
          holdings,
          snapshots,
          accounts,
          budgets,
          policies,
          goals,
          profiles,
          meta
        ] = await Promise.all([
          getStore('transactions'),
          getStore('assets'),
          getStore('liabilities'),
          getStore('holdings'),
          getStore('snapshots'),
          getStore('accounts'),
          getStore('budgets'),
          getStore('policies'),
          getStore('goals'),
          getStore('profile'),
          getStore('meta')
        ]);

        const hasLoadedMeta = meta.find((m: any) => m.key === 'hasLoadedOnce');

        // Reached only when every store read succeeded. An empty ledger is a
        // legitimate successful result and must clear any earlier failure.
        this.lastLoadFailed = false;

        return {
          transactions: transactions as Transaction[],
          assets: assets as Asset[],
          liabilities: liabilities as Liability[],
          holdings: (holdings as Holding[]) ?? [],
          snapshots: snapshots as NetWorthSnapshot[],
          accounts: accounts as Account[],
          budgets: budgets as MonthlyBudget[],
          policies: policies as InsurancePolicy[],
          goals: goals as FinancialGoal[],
          profile: (profiles.length > 0 ? profiles[0] : null) as FinancialProfile | null,
          hasLoadedOnce: !!hasLoadedMeta?.value
        };
        // A genuinely empty store is a successful load, not a failure.
      } catch (e) {
        /* WP-FB-DATA-06c-READFAIL — READ FAILURE NOW PROPAGATES.
         *
         * This previously returned the (normally empty) in-memory fallback and
         * RESOLVED SUCCESSFULLY, which produced the destructive sequence:
         *
         *   1. a real ledger is persisted
         *   2. the IndexedDB read fails
         *   3. loadAll silently returns an empty ledger
         *   4. the application believes there is nothing stored
         *   5. the next successful saveAll clears the store and writes that
         *      emptiness over the real data
         *
         * The environment fallback ABOVE is untouched: an environment with no
         * IndexedDB at all is Node/jsdom, not a failure. What propagates here is
         * the other case — IndexedDB exists, was read, and did not work.
         */
        this.lastLoadFailed = true;
        throw e instanceof Error
          ? e
          : new Error(`IndexedDB load failed: ${String(e)}`);
      }
    });
  }

  /**
   * Standalone write: takes the write lock itself. Repository operations use
   * `runExclusive` + `persist` instead, so that their in-memory mutation and
   * rollback are inside the same lock as the save (WP-FB-DATA-07c).
   */
  static async saveAll(state: LedgerWriteState): Promise<void> {
    return this.runExclusive(lease => this.persist(lease, state));
  }

  /** The actual save. Callers reach it through `saveAll` or `persist`. */
  private static async performSave(state: LedgerWriteState): Promise<void> {
    {
      if (this.simulateFailureOnce) {
        this.simulateFailureOnce = false;
        throw new Error('Simulated IndexedDB persistence failure');
      }

      /* WP-FB-DATA-06c-READFAIL — REFUSE TO WRITE OVER DATA WE FAILED TO READ.
       *
       * `saveAll` mirrors the WHOLE array with clear() + put(). After a failed
       * load the in-memory ledger is empty, so a single write would clear the
       * store and persist that emptiness over the user's real data.
       *
       * Propagating the read failure is necessary but NOT sufficient to prevent
       * that; this refusal is the part that actually closes the sequence. It is
       * deliberately narrow: it fires only when a load was ATTEMPTED AND FAILED,
       * never merely because no load has happened yet. Any subsequent successful
       * load clears it, so recovery needs no new API.
       */
      if (this.lastLoadFailed) {
        throw new Error(
          'Refusing to persist: the last IndexedDB load failed, so the in-memory ledger ' +
          'may be incomplete. Writing now could overwrite stored data that was never read. ' +
          'Reload the application to retry.'
        );
      }

      const accounts = state.accounts || [];
      const budgets = state.budgets || [];
      const policies = state.policies || [];
      const goals = state.goals || [];
      const profile = state.profile ? [state.profile] : [];

      /* WP-FB-DATA-09 (2) — PRE-QUEUE KEYPATH VALIDATION.
       *
       * Every object store is created with an explicit keyPath (`id`, or `key`
       * for `meta`). `IDBObjectStore.put` throws `DataError` SYNCHRONOUSLY when
       * a record does not carry that key path. Because the whole save is
       * queued onto one transaction inside a loop, that synchronous throw used
       * to escape mid-loop, leaving earlier stores already cleared and
       * repopulated — a torn write (measured at the 09 discovery gate:
       * `loadDemoData` committed 16 demo transactions while the user's real
       * accounts, goals and profile survived, producing a ledger state that
       * never existed in memory).
       *
       * Validating BEFORE anything is queued turns that class of fault into a
       * clean, total refusal: nothing is cleared, nothing is put, storage is
       * untouched, and the caller receives a named error it can disclose.
       *
       * This runs ahead of the environment branch deliberately, so the node
       * fallback obeys the identical contract — a malformed record must never
       * be accepted anywhere.
       */
      this.assertRecordsSatisfyKeyPaths([
        ['transactions', state.transactions],
        ['assets', state.assets],
        ['liabilities', state.liabilities],
        ['snapshots', state.snapshots],
        ['accounts', accounts],
        ['budgets', budgets],
        ['policies', policies],
        ['goals', goals],
        ['profile', profile]
      ]);

      if (typeof window === 'undefined' || !window.indexedDB) {
        this.nodeFallbackStore = {
          transactions: [...state.transactions],
          assets: [...state.assets],
          liabilities: [...state.liabilities],
          holdings: [...(state.holdings ?? [])],
          snapshots: [...state.snapshots],
          accounts: [...accounts],
          budgets: [...budgets],
          policies: [...policies],
          goals: [...goals],
          profile: state.profile ? { ...state.profile } : null,
          hasLoadedOnce: true
        };
        return;
      }

      let db: IDBDatabase | undefined;
      try {
        db = await this.getDB();
        const storeNames = ['transactions', 'assets', 'liabilities', 'holdings', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
          .filter(name => db!.objectStoreNames.contains(name));

        const activeTx = db.transaction(storeNames, 'readwrite');

        /* WP-FB-DATA-09 (1) — the transaction outcome is observed BEFORE any
         * work is queued, so an abort we trigger ourselves is always awaited
         * rather than surfacing later as an unhandled rejection. */
        const settled = new Promise<void>((resolve, reject) => {
          activeTx.oncomplete = () => resolve();
          activeTx.onerror = () => reject(activeTx.error || new Error('IndexedDB transaction failed'));
          activeTx.onabort = () => reject(activeTx.error || new Error('IndexedDB transaction aborted'));
        });

        const clearAndPut = (name: string, items: any[]) => {
          if (db!.objectStoreNames.contains(name)) {
            const store = activeTx.objectStore(name);
            store.clear();
            items.forEach(item => store.put(item));
          }
        };

        try {
          const writePlan: Array<[string, any[]]> = [
            ['transactions', state.transactions],
            ['assets', state.assets],
            ['liabilities', state.liabilities],
            ['holdings', state.holdings ?? []],
            ['snapshots', state.snapshots],
            ['accounts', accounts],
            ['budgets', budgets],
            ['policies', policies],
            ['goals', goals],
            ['profile', profile]
          ];

          for (let i = 0; i < writePlan.length; i++) {
            /* Test seam (mirrors `simulateFailureOnce`): fault injection AFTER
             * the first store is queued, which is precisely the historical
             * torn-write condition. Without a seam the abort path below could
             * only ever be exercised by shipping a malformed record, which the
             * validation above now prevents. */
            if (this.simulateQueueFailureOnce && i === 1) {
              this.simulateQueueFailureOnce = false;
              throw new Error('Simulated IndexedDB mid-queue failure');
            }
            const [name, items] = writePlan[i];
            clearAndPut(name, items);
          }

          if (db.objectStoreNames.contains('meta')) {
            const metaStore = activeTx.objectStore('meta');
            metaStore.put({ key: 'hasLoadedOnce', value: true });
          }
        } catch (queueError) {
          /* WP-FB-DATA-09 (1) — ABORT, DO NOT MERELY CLOSE.
           *
           * `IDBDatabase.close()` does NOT cancel work already queued on a live
           * transaction; per spec it waits for outstanding transactions to
           * COMPLETE. The previous implementation only closed the connection,
           * so everything queued before the fault was committed anyway. That is
           * exactly how the torn write reached storage.
           *
           * Aborting discards every queued operation atomically, then we wait
           * for the abort to actually land before rethrowing, so the caller can
           * rely on storage being untouched the moment this promise rejects.
           */
          try { activeTx.abort(); } catch { /* already settled — nothing queued survives */ }
          await settled.catch(() => { /* the abort rejection is expected here */ });
          throw queueError;
        }

        await settled;
      } catch (e) {
        /* WP-FB-DATA-06c-0 (P-5) — PERSISTENCE FAILURE NOW PROPAGATES.
         *
         * This block previously copied the state into `nodeFallbackStore` and
         * RESOLVED SUCCESSFULLY. A genuine IndexedDB failure in a real browser
         * therefore looked identical to a successful save: `MemoryRepository`
         * skipped its rollback, the UI reported the write had landed, and the
         * data was gone on the next reload with no error anywhere.
         *
         * That silent-success path is the reason a caller could not trust
         * persistence at all, and it becomes far more dangerous once lifecycle
         * operations exist — "your correction was saved" would be a lie.
         *
         * The environment fallback ABOVE (`typeof window === 'undefined' ||
         * !window.indexedDB`) is untouched: an environment that has no
         * IndexedDB at all is not a failure, it is Node/jsdom, and it still
         * uses the in-memory store. What is rethrown here is the other case —
         * IndexedDB EXISTS, was used, and did not work.
         */
        db?.close?.();
        throw e instanceof Error
          ? e
          : new Error(`IndexedDB persistence failed: ${String(e)}`);
      } finally {
        /* The connection is closed on every path. Aborting here as well was
         * tried and removed: by the time control reaches this block the
         * transaction has always already settled — the queue-failure path
         * aborts and awaits it explicitly, `onerror`/`onabort` mean it is
         * finished, and a `getDB` failure means there is no transaction at
         * all. A guard with no reachable case and no coverage is dead code,
         * not defence in depth. */
        db?.close?.();
      }
    }
  }

  static async clearAll(): Promise<void> {
    return this.enqueueSave(async () => {
      if (this.simulateFailureOnce) {
        this.simulateFailureOnce = false;
        throw new Error('Simulated IndexedDB persistence failure');
      }

      if (typeof window === 'undefined' || !window.indexedDB) {
        this.nodeFallbackStore = {
          transactions: [],
          assets: [],
          liabilities: [],
          holdings: [],
          snapshots: [],
          accounts: [],
          budgets: [],
          policies: [],
          goals: [],
          profile: null,
          hasLoadedOnce: true
        };
        return;
      }

      let db: IDBDatabase | undefined;
      try {
        db = await this.getDB();
        const storeNames = ['transactions', 'assets', 'liabilities', 'holdings', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
          .filter(name => db!.objectStoreNames.contains(name));

        const tx = db.transaction(storeNames, 'readwrite');
        storeNames.forEach(name => {
          if (name !== 'meta') {
            tx.objectStore(name).clear();
          }
        });
        if (db.objectStoreNames.contains('meta')) {
          tx.objectStore('meta').put({ key: 'hasLoadedOnce', value: true });
        }

        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => {
            db!.close();
            resolve();
          };
          tx.onerror = () => {
            db!.close();
            reject(tx.error);
          };
        });
      } catch (e) {
        /* WP-FB-DATA-06c-0 (P-5). `clearAll` carried the identical
         * false-success swallow as `saveAll`, and it is a DESTRUCTIVE write:
         * reporting "your data was cleared" when the clear failed leaves the
         * user believing their ledger is empty while it is not. Same class of
         * defect, same fix. The environment fallback above is untouched. */
        db?.close?.();
        throw e instanceof Error
          ? e
          : new Error(`IndexedDB clear failed: ${String(e)}`);
      }
    });
  }
}
