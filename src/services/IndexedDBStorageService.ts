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
      if (typeof window === 'undefined' || !window.indexedDB) {
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
        const getStore = (name: string) => new Promise<any[]>((resolve) => {
          if (!db.objectStoreNames.contains(name)) return resolve([]);
          const req = tx.objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
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
      } catch (e) {
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

      try {
        const db = await this.getDB();
        const storeNames = ['transactions', 'assets', 'liabilities', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
          .filter(name => db.objectStoreNames.contains(name));

        const tx = db.transaction(storeNames, 'readwrite');

        const clearAndPut = (name: string, items: any[]) => {
          if (db.objectStoreNames.contains(name)) {
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
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        });
      } catch (e) {
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

      try {
        const db = await this.getDB();
        const storeNames = ['transactions', 'assets', 'liabilities', 'snapshots', 'accounts', 'budgets', 'policies', 'goals', 'profile', 'meta']
          .filter(name => db.objectStoreNames.contains(name));

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
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        });
      } catch (e) {
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
      }
    });
  }
}
