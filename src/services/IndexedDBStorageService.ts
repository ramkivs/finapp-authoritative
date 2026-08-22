import {
  Transaction,
  Asset,
  Liability,
  NetWorthSnapshot,
  Account,
  MonthlyBudget,
  InsurancePolicy,
  FinancialGoal,
  FinancialProfile
} from '../domain/types';
import { AssetIdentityService } from './AssetIdentityService';

const DB_NAME = 'finboom_db';
// WP-FB-DATA-04c-1: bumped 3 -> 4. The `assets` object store moves from
// keyPath 'name' to keyPath 'id' so that a mutable display name is no longer
// the storage key. See migrateAssetsToIdKeyPath() below.
const DB_VERSION = 4;

export interface StoredLedgerState {
  transactions: Transaction[];
  assets: Asset[];
  liabilities: Liability[];
  snapshots: NetWorthSnapshot[];
  accounts: Account[];
  budgets: MonthlyBudget[];
  policies: InsurancePolicy[];
  goals: FinancialGoal[];
  profile: FinancialProfile | null;
  hasLoadedOnce: boolean;
}

export class IndexedDBStorageService {
  private static nodeFallbackStore: StoredLedgerState = {
    transactions: [],
    assets: [],
    liabilities: [],
    snapshots: [],
    accounts: [],
    budgets: [],
    policies: [],
    goals: [],
    profile: null,
    hasLoadedOnce: false
  };

  private static mutex: Promise<any> = Promise.resolve();
  public static simulateFailureOnce: boolean = false;
  /** WP-FB-DATA-06c-READFAIL: injects a genuine read-path failure, for tests. */
  public static simulateReadFailureOnce: boolean = false;

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

        if (!db.objectStoreNames.contains('transactions')) db.createObjectStore('transactions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('liabilities')) db.createObjectStore('liabilities', { keyPath: 'name' });
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
        const storeNames = ['transactions', 'assets', 'liabilities', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
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

  static async saveAll(state: {
    transactions: Transaction[];
    assets: Asset[];
    liabilities: Liability[];
    snapshots: NetWorthSnapshot[];
    accounts?: Account[];
    budgets?: MonthlyBudget[];
    policies?: InsurancePolicy[];
    goals?: FinancialGoal[];
    profile?: FinancialProfile | null;
  }): Promise<void> {
    return this.enqueueSave(async () => {
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

      if (typeof window === 'undefined' || !window.indexedDB) {
        this.nodeFallbackStore = {
          transactions: [...state.transactions],
          assets: [...state.assets],
          liabilities: [...state.liabilities],
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
        const storeNames = ['transactions', 'assets', 'liabilities', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
          .filter(name => db!.objectStoreNames.contains(name));

        const tx = db.transaction(storeNames, 'readwrite');

        const clearAndPut = (name: string, items: any[]) => {
          if (db!.objectStoreNames.contains(name)) {
            const store = tx.objectStore(name);
            store.clear();
            items.forEach(item => store.put(item));
          }
        };

        clearAndPut('transactions', state.transactions);
        clearAndPut('assets', state.assets);
        clearAndPut('liabilities', state.liabilities);
        clearAndPut('snapshots', state.snapshots);
        clearAndPut('accounts', accounts);
        clearAndPut('budgets', budgets);
        clearAndPut('policies', policies);
        clearAndPut('goals', goals);
        clearAndPut('profile', profile);

        if (db.objectStoreNames.contains('meta')) {
          const metaStore = tx.objectStore('meta');
          metaStore.put({ key: 'hasLoadedOnce', value: true });
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
      }
    });
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
        const storeNames = ['transactions', 'assets', 'liabilities', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
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
