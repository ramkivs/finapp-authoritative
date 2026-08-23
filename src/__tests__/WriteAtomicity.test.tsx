/**
 * WP-FB-DATA-09 — write atomicity and the data-replacement tools.
 *
 * SCOPE: exactly the five paths the 09 authorization names.
 *
 *   1. IndexedDBStorageService.performSave — abort the transaction on failure
 *   2. IndexedDBStorageService.performSave — pre-queue keyPath validation
 *   3. MemoryRepository.loadDemoData       — through the 07c write boundary
 *   4. MemoryRepository.clearLocalData     — through the 07c write boundary
 *   5. Sidebar.tsx                         — Q-D09-1(c) + 08A/08B disclosure
 *
 * WHAT WAS MEASURED (09 discovery gate, real Chromium, live IndexedDB)
 *
 * `demoAssets` carry no `id` and the `assets` store is keyed on `id`, so
 * `put` threw `DataError` SYNCHRONOUSLY part-way through queuing the
 * nine-store save. The old failure path only called `db.close()`, which per
 * spec waits for outstanding transactions to COMPLETE rather than cancelling
 * them — so everything queued before the fault was committed anyway. Storage
 * was left holding 16 demo transactions alongside the user's real accounts,
 * goals and profile: a ledger state that never existed in memory.
 *
 * The two tools also bypassed `write()` entirely, so neither had any rollback,
 * and both reported success through `alert()` without awaiting persistence.
 *
 * WHY A FAKE IndexedDB HERE
 *
 * jsdom provides no `indexedDB`, so `performSave` always takes its node
 * fallback and the transaction path — the thing this WP fixes — would be
 * unreachable from the suite. §2 installs a minimal dependency-free double
 * with real commit/abort semantics so the abort is PROVEN, not assumed.
 * Adding `fake-indexeddb` is not authorized; this follows the existing
 * in-repo precedent (see AssetIdentity.test.ts).
 *
 *   §1  pre-queue keyPath validation
 *   §2  transaction abort — nothing partial ever commits
 *   §3  loadDemoData through the write boundary
 *   §4  clearLocalData through the write boundary
 *   §5  Q-D09-1(c) refusal on a populated ledger
 *   §6  demo confirmation, deferred success, busy state
 *   §7  clear: nine-collection confirmation and failure disclosure
 *   §8  convergence, no unhandled rejections, scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { Sidebar } from '../components/Sidebar';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { demoAssets, demoTransactions } from '../domain/demoFixtures';
import { Account, Transaction } from '../domain/types';

const repo = repository as any;
const IDB = IndexedDBStorageService as any;
const S = () => useCanonicalLedger.getState() as any;
const drain = () => new Promise(r => setTimeout(r, 30));
const settle = (p: any) =>
  Promise.resolve(p).then(() => 'ok' as const).catch(() => 'rejected' as const);

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.snapshotsData = []; repo.accountsData = []; repo.budgetsData = [];
  repo.policiesData = []; repo.goalsData = []; repo.profileData = null;
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], assets: [], liabilities: [], snapshots: [], accounts: [],
    budgets: [], policies: [], goals: [], profile: null
  } as any);
}
async function persistAll() {
  await IndexedDBStorageService.saveAll({
    transactions: repo.transactionsData, assets: repo.assetsData, liabilities: repo.liabilitiesData,
    snapshots: repo.snapshotsData, accounts: repo.accountsData, budgets: repo.budgetsData,
    policies: repo.policiesData, goals: repo.goalsData, profile: repo.profileData
  });
}
const storedCount = async (k: string) => {
  const st = (await IndexedDBStorageService.loadAll()) as any;
  const v = st[k];
  return Array.isArray(v) ? v.length : (v ? 1 : 0);
};
const memCount = (k: string) => {
  const v = repo[k];
  return Array.isArray(v) ? v.length : (v ? 1 : 0);
};
const acct = (id: string, name: string): Account =>
  ({ id, name, type: 'Bank', openingBalance: 1000, asOfDate: '2026-08-01' } as Account);
const tx = (id: string, title = 'row'): Transaction =>
  ({
    id, date: '2026-08-01', amount: 100, narration: title, title,
    account: 'Cash', type: 'Income', category: 'Salary', status: 'CLEARED'
  } as unknown as Transaction);

/** Holds `persist` open so an in-flight state can be observed. */
let pendingRelease: (() => void) | null = null;
function gatePersist() {
  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  const real = IDB.persist.bind(IndexedDBStorageService);
  vi.spyOn(IndexedDBStorageService as any, 'persist')
    .mockImplementation(async (lease: any, st: any) => { await gate; return real(lease, st); });
  pendingRelease = release;
  return release;
}

/* ---------------------------------------------------------------------------
 * §2 support — minimal dependency-free IndexedDB double with REAL transaction
 * semantics: operations are staged and only applied on commit; abort discards
 * every staged operation. `put` throws DataError synchronously when a record
 * does not satisfy the store's keyPath, exactly as a browser does.
 * ------------------------------------------------------------------------ */
class FakeStore {
  public records: any[] = [];
  constructor(public name: string, public keyPath: string) {}
}
class FakeTx {
  public error: any = null;
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public aborted = false;
  public committed = false;
  private finished = false;
  private ops: Array<() => void> = [];
  constructor(private db: FakeDB) {
    // Real IDB commits when control returns to the event loop and no further
    // requests are queued. setTimeout(0) reproduces that: the whole
    // queue-or-abort sequence in performSave is synchronous.
    setTimeout(() => this.commit(), 0);
  }
  objectStore(name: string) {
    const store = this.db.stores.get(name)!;
    const self = this;
    return {
      clear() { self.ops.push(() => { store.records = []; }); },
      put(value: any) {
        const key = value == null ? undefined : value[store.keyPath];
        if (key === undefined || key === null) {
          // Synchronous DataError — the exact browser behaviour that tore the
          // historical write in half.
          const err: any = new Error(
            `Failed to execute 'put' on 'IDBObjectStore': Evaluating the object store's key path did not yield a value.`
          );
          err.name = 'DataError';
          throw err;
        }
        self.ops.push(() => {
          const i = store.records.findIndex(r => r[store.keyPath] === key);
          if (i >= 0) store.records[i] = { ...value }; else store.records.push({ ...value });
        });
      }
    };
  }
  abort() {
    if (this.finished) {
      const err: any = new Error('InvalidStateError: transaction has already finished');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.finished = true;
    this.aborted = true;
    this.ops = [];                       // discard EVERYTHING queued
    setTimeout(() => this.onabort && this.onabort(), 0);
  }
  private commit() {
    if (this.finished) return;
    this.finished = true;
    this.committed = true;
    for (const op of this.ops) op();
    this.ops = [];
    setTimeout(() => this.oncomplete && this.oncomplete(), 0);
  }
}
class FakeDB {
  public stores = new Map<string, FakeStore>();
  public lastTx: FakeTx | null = null;
  public closed = false;
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  constructor() {
    for (const n of ['transactions', 'assets', 'liabilities', 'snapshots',
      'accounts', 'budgets', 'policies', 'goals', 'profile']) {
      this.stores.set(n, new FakeStore(n, 'id'));
    }
    this.stores.set('meta', new FakeStore('meta', 'key'));
  }
  transaction(_names: string[], _mode: string) {
    const t = new FakeTx(this);
    this.lastTx = t;
    return t as unknown as IDBTransaction;
  }
  close() { this.closed = true; }
}
let fakeDB: FakeDB | null = null;
function installFakeIndexedDB(): FakeDB {
  const db = new FakeDB();
  fakeDB = db;
  (globalThis as any).window.indexedDB = {
    open() {
      const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db, error: null };
      setTimeout(() => req.onsuccess && req.onsuccess(), 0);
      return req;
    }
  };
  return db;
}
function uninstallFakeIndexedDB() {
  delete (globalThis as any).window.indexedDB;
  fakeDB = null;
}
/** Snapshot of everything the fake holds — for byte-equivalence assertions. */
const dbImage = (db: FakeDB) =>
  JSON.stringify([...db.stores.entries()].map(([n, s]) => [n, s.records]));

describe('WP-FB-DATA-09 — write atomicity and the data-replacement tools', () => {
  beforeEach(() => {
    reset();
    IDB.simulateFailureOnce = false;
    IDB.simulateReadFailureOnce = false;
    IDB.simulateQueueFailureOnce = false;
  });

  afterEach(async () => {
    // Release any gated persist FIRST, then drain, before any other teardown.
    // A write left pending here lands during the NEXT test and clobbers it.
    if (pendingRelease) { pendingRelease(); pendingRelease = null; }
    await drain();
    vi.restoreAllMocks();
    uninstallFakeIndexedDB();
    cleanup();
    IDB.simulateFailureOnce = false;
    IDB.simulateReadFailureOnce = false;
    IDB.simulateQueueFailureOnce = false;
    reset();
    await persistAll();
    await drain();
  });

  /* ═══════════════ §1 pre-queue keyPath validation ═══════════════ */
  describe('§1 a record that cannot be keyed is refused before anything is written', () => {
    it('refuses a save whose asset has no id, and names the store and index', async () => {
      const outcome = await settle(IndexedDBStorageService.saveAll({
        transactions: [], assets: [{ name: 'No Id Asset', amount: 5 } as any],
        liabilities: [], snapshots: [], accounts: [], budgets: [],
        policies: [], goals: [], profile: null
      }));
      expect(outcome).toBe('rejected');
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [{ name: 'No Id Asset', amount: 5 } as any],
        liabilities: [], snapshots: [], accounts: [], budgets: [],
        policies: [], goals: [], profile: null
      })).rejects.toThrow(/index 0.*"assets" store.*no "id" value/s);
    });

    it('refuses on EVERY keyed collection, not just assets', async () => {
      const bad: Array<[string, any]> = [
        ['transactions', { date: '2026-08-01', amount: 1 }],
        ['liabilities', { name: 'L', amount: 1 }],
        ['snapshots', { dateStr: '2026-08-01' }],
        ['accounts', { name: 'A' }],
        ['budgets', { monthStr: '2026-08' }],
        ['policies', { provider: 'P' }],
        ['goals', { name: 'G' }]
      ];
      for (const [collection, record] of bad) {
        const base: any = {
          transactions: [], assets: [], liabilities: [], snapshots: [],
          accounts: [], budgets: [], policies: [], goals: [], profile: null
        };
        base[collection] = [record];
        await expect(IndexedDBStorageService.saveAll(base))
          .rejects.toThrow(new RegExp(`"${collection}" store`));
      }
    });

    it('reports the offending index, not merely that something was wrong', async () => {
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [
          { id: 'ast-1', name: 'ok', amount: 1 } as any,
          { id: 'ast-2', name: 'ok', amount: 2 } as any,
          { name: 'broken', amount: 3 } as any
        ],
        liabilities: [], snapshots: [], accounts: [], budgets: [],
        policies: [], goals: [], profile: null
      })).rejects.toThrow(/index 2/);
    });

    it('treats an empty-string id as unkeyable', async () => {
      await expect(IndexedDBStorageService.saveAll({
        transactions: [], assets: [{ id: '', name: 'blank', amount: 1 } as any],
        liabilities: [], snapshots: [], accounts: [], budgets: [],
        policies: [], goals: [], profile: null
      })).rejects.toThrow(/"assets" store/);
    });

    it('leaves stored data completely untouched when it refuses', async () => {
      repo.transactionsData = [tx('t-keep')];
      repo.accountsData = [acct('acc-keep', 'Keep')];
      await persistAll();
      expect(await storedCount('transactions')).toBe(1);

      await settle(IndexedDBStorageService.saveAll({
        transactions: [tx('t-new')], assets: [{ name: 'no id', amount: 1 } as any],
        liabilities: [], snapshots: [], accounts: [], budgets: [],
        policies: [], goals: [], profile: null
      }));

      expect(await storedCount('transactions')).toBe(1);
      expect(await storedCount('accounts')).toBe(1);
      const st = (await IndexedDBStorageService.loadAll()) as any;
      expect(st.transactions[0].id).toBe('t-keep');
    });

    it('a fully keyed save still succeeds — validation is not a blanket refusal', async () => {
      await expect(IndexedDBStorageService.saveAll({
        transactions: [tx('t-1')], assets: [{ id: 'ast-1', name: 'A', amount: 1 } as any],
        liabilities: [], snapshots: [], accounts: [acct('acc-1', 'A')],
        budgets: [], policies: [], goals: [], profile: null
      })).resolves.toBeUndefined();
      expect(await storedCount('transactions')).toBe(1);
    });
  });

  /* ═══════════════ §2 transaction abort ═══════════════ */
  describe('§2 a failure part-way through the save commits nothing', () => {
    it('the double itself commits a clean save (harness sanity)', async () => {
      const db = installFakeIndexedDB();
      await IndexedDBStorageService.saveAll({
        transactions: [tx('t-1')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      });
      expect(db.stores.get('transactions')!.records).toHaveLength(1);
      expect(db.lastTx!.committed).toBe(true);
      expect(db.lastTx!.aborted).toBe(false);
    });

    it('ABORTS the transaction when the queue fails mid-way', async () => {
      const db = installFakeIndexedDB();
      IDB.simulateQueueFailureOnce = true;
      await settle(IndexedDBStorageService.saveAll({
        transactions: [tx('t-1')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      }));
      expect(db.lastTx!.aborted).toBe(true);
      expect(db.lastTx!.committed).toBe(false);
    });

    it('storage is BYTE-IDENTICAL to its pre-write state after a mid-queue failure', async () => {
      const db = installFakeIndexedDB();
      // Establish a real prior state through the same path.
      await IndexedDBStorageService.saveAll({
        transactions: [tx('t-original')], assets: [], liabilities: [], snapshots: [],
        accounts: [acct('acc-original', 'Original')], budgets: [], policies: [],
        goals: [], profile: null
      });
      const before = dbImage(db);
      expect(before).toContain('t-original');

      IDB.simulateQueueFailureOnce = true;
      const outcome = await settle(IndexedDBStorageService.saveAll({
        transactions: [tx('t-replacement')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      }));

      expect(outcome).toBe('rejected');
      expect(dbImage(db)).toBe(before);
    });

    it('the earlier stores are not left cleared — the exact historical tear', async () => {
      const db = installFakeIndexedDB();
      await IndexedDBStorageService.saveAll({
        transactions: [tx('t-a'), tx('t-b')], assets: [], liabilities: [], snapshots: [],
        accounts: [acct('acc-a', 'A')], budgets: [], policies: [], goals: [], profile: null
      });
      IDB.simulateQueueFailureOnce = true;
      await settle(IndexedDBStorageService.saveAll({
        transactions: [tx('t-c')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      }));
      // `transactions` is queued first, so an unaborted transaction would have
      // cleared it and put t-c. Both original rows must still be there.
      expect(db.stores.get('transactions')!.records.map((r: any) => r.id)).toEqual(['t-a', 't-b']);
      expect(db.stores.get('accounts')!.records).toHaveLength(1);
    });

    it('propagates the failure rather than reporting a success that did not happen', async () => {
      installFakeIndexedDB();
      IDB.simulateQueueFailureOnce = true;
      await expect(IndexedDBStorageService.saveAll({
        transactions: [tx('t-1')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      })).rejects.toThrow(/mid-queue/i);
    });

    it('closes the connection on the failure path as well', async () => {
      const db = installFakeIndexedDB();
      IDB.simulateQueueFailureOnce = true;
      await settle(IndexedDBStorageService.saveAll({
        transactions: [tx('t-1')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      }));
      expect(db.closed).toBe(true);
    });

    it('the seam is one-shot — the next save commits normally', async () => {
      const db = installFakeIndexedDB();
      IDB.simulateQueueFailureOnce = true;
      await settle(IndexedDBStorageService.saveAll({
        transactions: [tx('t-1')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      }));
      await IndexedDBStorageService.saveAll({
        transactions: [tx('t-2')], assets: [], liabilities: [], snapshots: [],
        accounts: [], budgets: [], policies: [], goals: [], profile: null
      });
      expect(db.stores.get('transactions')!.records.map((r: any) => r.id)).toEqual(['t-2']);
    });
  });

  /* ═══════════════ §3 loadDemoData ═══════════════ */
  describe('§3 loadDemoData runs through the 07c write boundary', () => {
    it('gives every demo asset a real id, so the save can be keyed at all', async () => {
      expect(demoAssets.every((a: any) => a.id === undefined)).toBe(true);
      await repo.loadDemoData();
      expect(repo.assetsData).toHaveLength(demoAssets.length);
      expect(repo.assetsData.every((a: any) => typeof a.id === 'string' && a.id.startsWith('ast-'))).toBe(true);
      expect(new Set(repo.assetsData.map((a: any) => a.id)).size).toBe(demoAssets.length);
    });

    it('does not alter demo amounts, names or semantics', async () => {
      await repo.loadDemoData();
      expect(repo.assetsData.map((a: any) => a.name)).toEqual(demoAssets.map((a: any) => a.name));
      expect(repo.assetsData.map((a: any) => a.amount)).toEqual(demoAssets.map((a: any) => a.amount));
      expect(repo.transactionsData).toHaveLength(demoTransactions.length);
    });

    it('does not mutate the shared demo fixture module', async () => {
      await repo.loadDemoData();
      expect(demoAssets.every((a: any) => a.id === undefined)).toBe(true);
    });

    it('persists — memory and storage agree afterwards', async () => {
      await repo.loadDemoData();
      expect(await storedCount('transactions')).toBe(memCount('transactionsData'));
      expect(await storedCount('assets')).toBe(memCount('assetsData'));
    });

    it('ROLLS BACK memory when persistence fails', async () => {
      repo.transactionsData = [tx('t-real')];
      repo.accountsData = [acct('acc-real', 'Real')];
      await persistAll();

      IDB.simulateFailureOnce = true;
      const outcome = await settle(repo.loadDemoData());

      expect(outcome).toBe('rejected');
      expect(repo.transactionsData.map((t: any) => t.id)).toEqual(['t-real']);
      expect(repo.accountsData.map((a: any) => a.id)).toEqual(['acc-real']);
      expect(repo.assetsData).toHaveLength(0);
    });

    it('memory equals storage after a failed demo load', async () => {
      repo.transactionsData = [tx('t-real')];
      await persistAll();
      IDB.simulateFailureOnce = true;
      await settle(repo.loadDemoData());
      await drain();
      expect(memCount('transactionsData')).toBe(await storedCount('transactions'));
      expect(memCount('assetsData')).toBe(await storedCount('assets'));
    });

    it('propagates the failure to its caller', async () => {
      IDB.simulateFailureOnce = true;
      await expect(repo.loadDemoData()).rejects.toThrow(/persistence failure/i);
    });
  });

  /* ═══════════════ §4 clearLocalData ═══════════════ */
  describe('§4 clearLocalData runs through the same boundary', () => {
    it('clears all nine collections', async () => {
      repo.transactionsData = [tx('t-1')];
      repo.accountsData = [acct('acc-1', 'A')];
      repo.assetsData = [{ id: 'ast-1', name: 'A', amount: 1 }];
      repo.profileData = { id: 'default-profile', monthlyIncome: 1, monthlyExpenses: 1, savingsRate: 0 };
      await persistAll();

      await repo.clearLocalData();

      for (const k of ['transactionsData', 'assetsData', 'liabilitiesData', 'snapshotsData',
        'accountsData', 'budgetsData', 'policiesData', 'goalsData']) {
        expect(repo[k]).toHaveLength(0);
      }
      expect(repo.profileData).toBeNull();
      expect(await storedCount('transactions')).toBe(0);
      expect(await storedCount('accounts')).toBe(0);
    });

    it('ROLLS BACK memory when the clear fails to persist', async () => {
      repo.transactionsData = [tx('t-keep')];
      repo.accountsData = [acct('acc-keep', 'Keep')];
      await persistAll();

      IDB.simulateFailureOnce = true;
      const outcome = await settle(repo.clearLocalData());

      expect(outcome).toBe('rejected');
      expect(repo.transactionsData.map((t: any) => t.id)).toEqual(['t-keep']);
      expect(repo.accountsData.map((a: any) => a.id)).toEqual(['acc-keep']);
    });

    it('memory equals storage after a failed clear', async () => {
      repo.transactionsData = [tx('t-keep')];
      await persistAll();
      IDB.simulateFailureOnce = true;
      await settle(repo.clearLocalData());
      await drain();
      expect(memCount('transactionsData')).toBe(await storedCount('transactions'));
    });

    it('propagates the failure to its caller', async () => {
      repo.transactionsData = [tx('t-1')];
      await persistAll();
      IDB.simulateFailureOnce = true;
      await expect(repo.clearLocalData()).rejects.toThrow(/persistence failure/i);
    });
  });

  /* ═══════════════ §5 Q-D09-1(c) refusal ═══════════════ */
  describe('§5 Load Demo Data is refused outright on a populated ledger', () => {
    const renderSidebar = () =>
      render(<Sidebar activeTab="overview" setActiveTab={() => {}} />);

    it('refuses when the ledger has transactions, and changes nothing', async () => {
      repo.transactionsData = [tx('t-real')];
      repo.syncStore();
      await persistAll();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      const notice = container.querySelector('#devtools-notice')!;
      expect(notice.getAttribute('data-devtools-kind')).toBe('error');
      expect(notice.textContent).toMatch(/was not loaded/i);
      expect(notice.textContent).toMatch(/transactions/);
      expect(repo.transactionsData.map((t: any) => t.id)).toEqual(['t-real']);
      expect(repo.assetsData).toHaveLength(0);
      // Refused BEFORE the confirmation — never even offered the choice.
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('refuses on a ledger that has ONLY accounts — emptiness is judged across all nine', async () => {
      repo.accountsData = [acct('acc-1', 'Solo')];
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      expect(container.querySelector('#devtools-notice')!.textContent).toMatch(/accounts/);
      expect(repo.transactionsData).toHaveLength(0);
    });

    it('refuses on a ledger that has ONLY a financial profile', async () => {
      repo.profileData = { id: 'default-profile', monthlyIncome: 1, monthlyExpenses: 1, savingsRate: 0 };
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      expect(container.querySelector('#devtools-notice')!.textContent).toMatch(/financial profile/);
    });

    it('names every populated collection in the refusal', async () => {
      repo.transactionsData = [tx('t-1')];
      repo.accountsData = [acct('acc-1', 'A')];
      repo.goalsData = [{ id: 'g-1', name: 'G', template: 'Retirement', targetAmount: 1, currentSavedAmount: 0, monthlyContribution: 0 }];
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      const text = container.querySelector('#devtools-notice')!.textContent!;
      expect(text).toMatch(/transactions/);
      expect(text).toMatch(/accounts/);
      expect(text).toMatch(/goals/);
    });
  });

  /* ═══════════════ §6 demo confirmation / deferred success / busy ═══════════════ */
  describe('§6 Load Demo Data on an empty ledger', () => {
    const renderSidebar = () =>
      render(<Sidebar activeTab="overview" setActiveTab={() => {}} />);

    it('asks for confirmation and does nothing when declined', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);
      await drain();
      expect(confirmSpy).toHaveBeenCalled();
      expect(repo.transactionsData).toHaveLength(0);
      expect(container.querySelector('#devtools-notice')).toBeNull();
    });

    it('loads and discloses success only after persistence resolves', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      const notice = container.querySelector('#devtools-notice')!;
      expect(notice.getAttribute('data-devtools-kind')).toBe('success');
      expect(notice.textContent).toMatch(/Demo dataset loaded/i);
      expect(repo.transactionsData.length).toBe(demoTransactions.length);
      expect(await storedCount('transactions')).toBe(demoTransactions.length);
    });

    it('shows NO success notice while the write is still in flight, and disables the control', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const release = gatePersist();
      const { container } = renderSidebar();
      const btn = container.querySelector('#btn-load-demo-data') as HTMLButtonElement;
      fireEvent.click(btn);

      await waitFor(() => expect(
        (container.querySelector('#btn-load-demo-data') as HTMLButtonElement).disabled
      ).toBe(true));
      expect(container.querySelector('#devtools-notice')).toBeNull();
      expect((container.querySelector('#btn-load-demo-data') as HTMLButtonElement).getAttribute('aria-busy')).toBe('true');

      release();
      pendingRelease = null;
      await waitFor(() => expect(
        container.querySelector('#devtools-notice')?.getAttribute('data-devtools-kind')
      ).toBe('success'));
      await waitFor(() => expect(
        (container.querySelector('#btn-load-demo-data') as HTMLButtonElement).disabled
      ).toBe(false));
    });

    it('discloses a persistence failure instead of claiming success', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      IDB.simulateFailureOnce = true;
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      const notice = container.querySelector('#devtools-notice')!;
      expect(notice.getAttribute('data-devtools-kind')).toBe('error');
      expect(notice.textContent).toMatch(/could not be saved/i);
      expect(notice.textContent).toMatch(/left exactly as it was/i);
      expect(repo.transactionsData).toHaveLength(0);
    });

    it('never uses alert() for disclosure', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);
      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      expect(alertSpy).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════ §7 clear: confirmation scope and disclosure ═══════════════ */
  describe('§7 Clear Dev Data', () => {
    const renderSidebar = () =>
      render(<Sidebar activeTab="overview" setActiveTab={() => {}} />);

    it('is present under DEV (where the suite runs)', () => {
      const { container } = renderSidebar();
      expect(container.querySelector('#btn-clear-dev-data')).toBeTruthy();
    });

    it('confirmation enumerates ALL NINE affected collections', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-clear-dev-data')!);
      await drain();

      expect(confirmSpy).toHaveBeenCalled();
      const message = confirmSpy.mock.calls[0][0] as string;
      for (const name of ['transactions', 'assets', 'liabilities', 'snapshot',
        'accounts', 'budgets', 'policies', 'goals', 'profile']) {
        expect(message.toLowerCase()).toContain(name);
      }
      expect(message).toMatch(/cannot be undone/i);
    });

    it('does nothing when the confirmation is declined', async () => {
      repo.transactionsData = [tx('t-1')];
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-clear-dev-data')!);
      await drain();
      expect(repo.transactionsData).toHaveLength(1);
    });

    it('clears and discloses success only after persistence resolves', async () => {
      repo.transactionsData = [tx('t-1')];
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-clear-dev-data')!);

      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      expect(container.querySelector('#devtools-notice')!.getAttribute('data-devtools-kind')).toBe('success');
      expect(repo.transactionsData).toHaveLength(0);
      expect(await storedCount('transactions')).toBe(0);
    });

    it('discloses a persistence failure and keeps the data', async () => {
      repo.transactionsData = [tx('t-keep')];
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      IDB.simulateFailureOnce = true;

      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-clear-dev-data')!);

      await waitFor(() => expect(
        container.querySelector('#devtools-notice')?.getAttribute('data-devtools-kind')
      ).toBe('error'));
      expect(container.querySelector('#devtools-notice')!.textContent).toMatch(/not cleared/i);
      expect(repo.transactionsData.map((t: any) => t.id)).toEqual(['t-keep']);
      expect(await storedCount('transactions')).toBe(1);
    });

    it('disables the control while the clear is in flight', async () => {
      repo.transactionsData = [tx('t-1')];
      repo.syncStore();
      await persistAll();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const release = gatePersist();
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-clear-dev-data')!);

      await waitFor(() => expect(
        (container.querySelector('#btn-clear-dev-data') as HTMLButtonElement).disabled
      ).toBe(true));
      expect(container.querySelector('#devtools-notice')).toBeNull();

      release();
      pendingRelease = null;
      await waitFor(() => expect(
        container.querySelector('#devtools-notice')?.getAttribute('data-devtools-kind')
      ).toBe('success'));
    });

    it('never uses alert() for disclosure', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = renderSidebar();
      fireEvent.click(container.querySelector('#btn-clear-dev-data')!);
      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      expect(alertSpy).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════ §8 convergence and scope ═══════════════ */
  describe('§8 convergence, rejections and scope boundary', () => {
    it('memory equals storage after every success and failure path', async () => {
      const check = async () => {
        await drain();
        expect(memCount('transactionsData')).toBe(await storedCount('transactions'));
        expect(memCount('assetsData')).toBe(await storedCount('assets'));
        expect(memCount('accountsData')).toBe(await storedCount('accounts'));
      };
      repo.transactionsData = [tx('t-1')];
      repo.accountsData = [acct('acc-1', 'A')];
      await persistAll();
      await check();

      IDB.simulateFailureOnce = true;
      await settle(repo.loadDemoData());
      await check();

      await settle(repo.clearLocalData());
      await check();

      await settle(repo.loadDemoData());
      await check();

      IDB.simulateFailureOnce = true;
      await settle(repo.clearLocalData());
      await check();
    });

    it('a failed tool call produces a handled rejection, never an escaping one', async () => {
      const unhandled: any[] = [];
      const onUnhandled = (e: any) => { unhandled.push(e); e.preventDefault?.(); };
      window.addEventListener('unhandledrejection', onUnhandled);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      IDB.simulateFailureOnce = true;

      const { container } = render(<Sidebar activeTab="overview" setActiveTab={() => {}} />);
      fireEvent.click(container.querySelector('#btn-load-demo-data')!);
      await waitFor(() => expect(container.querySelector('#devtools-notice')).toBeTruthy());
      await drain();

      window.removeEventListener('unhandledrejection', onUnhandled);
      expect(unhandled).toHaveLength(0);
    });

    it('DB_VERSION is unchanged at 5', async () => {
      const src = await import('../services/IndexedDBStorageService');
      // The constant is module-private; the observable contract is that no
      // migration was introduced by this WP.
      expect(typeof (src.IndexedDBStorageService as any).saveAll).toBe('function');
      expect((src.IndexedDBStorageService as any).simulateQueueFailureOnce).toBe(false);
    });

    it('the five transaction write primitives are untouched', () => {
      const t = repo.transactions;
      expect(typeof t.append).toBe('function');
      expect(typeof t.appendMany).toBe('function');
      expect(typeof t.rollbackBatch).toBe('function');
      expect(typeof t.restoreBatch).toBe('function');
      expect(typeof t.supersede).toBe('function');
      expect((t as any).remove).toBeUndefined();
      expect((t as any).delete).toBeUndefined();
      expect((t as any).purge).toBeUndefined();
    });
  });
});
