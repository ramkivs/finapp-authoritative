/**
 * WP-FB-DATA-07c — persistence rollback integrity.
 *
 * THE DEFECT (F-07b-1, measured at the 07b gate in real Chromium)
 *
 * Every repository write used to snapshot a whole collection, mutate memory
 * optimistically, then restore that snapshot if the save failed. `saveAll` was
 * serialised; the memory mutation and the rollback were not. Two overlapping
 * writes therefore interleaved:
 *
 *     start        X:100 Y:200 Z:300      memory == storage
 *     delete X  -> persistence rejected
 *     delete Y  -> succeeds while X is still in flight
 *
 *     memory    -> X, Y, Z    neither deletion appears to have happened
 *     storage   -> Z          both actually happened
 *     reload    -> Z
 *
 * The user was told one delete failed and one succeeded, saw neither, and
 * after a reload had both. The same shape was reproduced for TRANSACTIONS:
 * `append(t1)` rejected + `append(t2)` accepted left memory empty and storage
 * holding BOTH — including the row whose write was reported as failed.
 *
 * THE INVARIANT THESE TESTS DEFEND
 *
 *   After overlapping operations settle, memory represents the persisted
 *   result of the operations that actually succeeded. A failed operation
 *   neither erases a concurrent success nor survives in storage.
 *
 * WHY THE TESTS LOOK LIKE THIS
 *
 * The operations must GENUINELY overlap: the second is issued while the first
 * is still in flight, and only then are both awaited. A test that awaits the
 * first and then starts the second cannot observe this defect at all — the
 * whole 800-test suite awaited its writes, which is exactly why the defect
 * lived at the persistence boundary undetected.
 *
 *   §1  the write lease
 *   §2  liabilities under overlap
 *   §3  transactions under overlap
 *   §4  sequential behaviour is byte-for-byte unchanged
 *   §5  operation-scoped revert leaves unrelated state alone
 *   §6  scope boundary
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Liability, Transaction } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const libs = (): Liability[] => repo.liabilitiesData;
const txs = (): Transaction[] => repo.transactionsData;
const drain = () => new Promise(r => setTimeout(r, 40));

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.holdingsData = [];
  repo.snapshotsData = []; repo.accountsData = []; repo.budgetsData = [];
  repo.policiesData = []; repo.goalsData = []; repo.profileData = null;
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], assets: [], liabilities: [], snapshots: [], accounts: []
  } as any);
}

/** Seeds memory AND storage so the two start in agreement. */
async function seedPersisted(liabilities: Liability[] = [], transactions: Transaction[] = []) {
  repo.liabilitiesData = liabilities;
  repo.transactionsData = transactions;
  repo.syncStore();
  await IndexedDBStorageService.saveAll({
    transactions: repo.transactionsData, assets: repo.assetsData,
    liabilities: repo.liabilitiesData, snapshots: repo.snapshotsData,
    accounts: repo.accountsData, budgets: repo.budgetsData,
    policies: repo.policiesData, goals: repo.goalsData, profile: repo.profileData
  });
}

const storedLiabilities = async () =>
  (await IndexedDBStorageService.loadAll()).liabilities.map(l => `${l.name}:${l.amount}`).sort();
const memoryLiabilities = () => libs().map(l => `${l.name}:${l.amount}`).sort();
const storedTxIds = async () =>
  (await IndexedDBStorageService.loadAll()).transactions.map(t => t.id).sort();
const memoryTxIds = () => txs().map(t => t.id).sort();

const settle = (p: Promise<any>) => p.then(() => 'ok' as const).catch(() => 'rejected' as const);

function mkTx(id: string, amount: number): Transaction {
  return {
    id, date: '2026-08-10', dateStr: '10 Aug 2026', title: id, narration: id.toUpperCase(),
    account: 'A', accountId: 'acc-A', direction: 'CREDIT', type: 'Income',
    category: 'Income', amount, status: 'CLEARED', origin: 'MANUAL'
  } as Transaction;
}

describe('WP-FB-DATA-07c — persistence rollback integrity', () => {
  beforeEach(reset);
  afterEach(async () => {
    IndexedDBStorageService.simulateFailureOnce = false;
    IndexedDBStorageService.simulateReadFailureOnce = false;
    await IndexedDBStorageService.loadAll().catch(() => {});
    vi.restoreAllMocks();
    reset();
  });

  /* ═══════════════ §1 the write lease ════════════════════════════════════ */
  describe('§1 the write lease', () => {
    it('persist refuses a caller that is not inside the write lock', async () => {
      await expect(
        (IndexedDBStorageService as any).persist({ id: -1 }, {
          transactions: [], assets: [], liabilities: [], snapshots: []
        })
      ).rejects.toThrow(/outside its write lease/);
    });

    it('persist refuses a lease that has already been released', async () => {
      let leaked: any;
      await IndexedDBStorageService.runExclusive(async (lease) => { leaked = lease; });
      await expect(
        (IndexedDBStorageService as any).persist(leaked, {
          transactions: [], assets: [], liabilities: [], snapshots: []
        })
      ).rejects.toThrow(/outside its write lease/);
    });

    it('runExclusive serialises: a second section never starts before the first ends', async () => {
      const order: string[] = [];
      const a = IndexedDBStorageService.runExclusive(async () => {
        order.push('a:start');
        await new Promise(r => setTimeout(r, 20));
        order.push('a:end');
      });
      const b = IndexedDBStorageService.runExclusive(async () => {
        order.push('b:start');
        order.push('b:end');
      });
      await Promise.all([a, b]);
      expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('a section that throws still releases the lock', async () => {
      await IndexedDBStorageService.runExclusive(async () => { throw new Error('boom'); })
        .catch(() => {});
      const ran = await IndexedDBStorageService.runExclusive(async () => 'next section ran');
      expect(ran).toBe('next section ran');
    });
  });

  /* ═══════════════ §2 liabilities under overlap ══════════════════════════ */
  describe('§2 liabilities — the measured scenario', () => {
    it('a failed delete does not erase a concurrent successful delete', async () => {
      await seedPersisted([
        { id: 'lia-X', name: 'X', amount: 100 },
        { id: 'lia-Y', name: 'Y', amount: 200 },
        { id: 'lia-Z', name: 'Z', amount: 300 }
      ]);
      expect(memoryLiabilities()).toEqual(await storedLiabilities());

      IndexedDBStorageService.simulateFailureOnce = true;
      // GENUINE OVERLAP: the second delete is issued while the first is in
      // flight. Both promises are created before either is awaited.
      const first = settle(S().removeLiability('lia-X'));
      const second = settle(S().removeLiability('lia-Y'));
      const results = { x: await first, y: await second };
      await drain();

      expect(results.x).toBe('rejected');
      expect(results.y).toBe('ok');

      const memory = memoryLiabilities();
      const storage = await storedLiabilities();

      // THE INVARIANT
      expect(memory).toEqual(storage);
      // the failed operation was undone — X is back, in memory AND in storage
      expect(memory).toContain('X:100');
      expect(storage).toContain('X:100');
      // the successful operation stands — Y is gone from both
      expect(memory).not.toContain('Y:200');
      expect(storage).not.toContain('Y:200');
      // the untouched record is untouched
      expect(memory).toContain('Z:300');
    });

    it('the failed row is not left in storage by the concurrent save', async () => {
      await seedPersisted([
        { id: 'lia-X', name: 'X', amount: 100 },
        { id: 'lia-Y', name: 'Y', amount: 200 }
      ]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const first = settle(S().removeLiability('lia-X'));
      const second = settle(S().updateLiability({ id: 'lia-Y', name: 'Y', amount: 250 }));
      await Promise.all([first, second]);
      await drain();

      const storage = await storedLiabilities();
      // X's deletion was reported as failed, so X must still be stored…
      expect(storage).toContain('X:100');
      // …and Y's successful edit must be stored.
      expect(storage).toContain('Y:250');
      expect(memoryLiabilities()).toEqual(storage);
    });

    it('a failed CREATE does not erase a concurrent successful create', async () => {
      await seedPersisted([{ id: 'lia-A', name: 'A', amount: 100 }]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const first = settle(S().addLiabilityWithMetadata({ name: 'WILL_FAIL', amount: 1 }));
      const second = settle(S().addLiabilityWithMetadata({ name: 'SHOULD_SURVIVE', amount: 7 }));
      expect({ first: await first, second: await second }).toEqual({ first: 'rejected', second: 'ok' });
      await drain();

      const memory = memoryLiabilities();
      expect(memory).toEqual(await storedLiabilities());
      expect(memory).toContain('SHOULD_SURVIVE:7');
      expect(memory).not.toContain('WILL_FAIL:1');
      expect(memory).toContain('A:100');
    });

    it('three overlapping writes with one failure converge', async () => {
      await seedPersisted([
        { id: 'lia-A', name: 'A', amount: 1 },
        { id: 'lia-B', name: 'B', amount: 2 },
        { id: 'lia-C', name: 'C', amount: 3 }
      ]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await Promise.all([
        settle(S().removeLiability('lia-A')),
        settle(S().updateLiability({ id: 'lia-B', name: 'B', amount: 20 })),
        settle(S().addLiabilityWithMetadata({ name: 'D', amount: 4 }))
      ]);
      await drain();
      expect(r).toEqual(['rejected', 'ok', 'ok']);
      const memory = memoryLiabilities();
      expect(memory).toEqual(await storedLiabilities());
      expect(memory).toContain('A:1');    // failed delete undone
      expect(memory).toContain('B:20');   // successful edit kept
      expect(memory).toContain('D:4');    // successful create kept
    });
  });

  /* ═══════════════ §3 transactions under overlap ═════════════════════════ */
  describe('§3 transactions — the same defect, the same fix', () => {
    it('a failed append does not erase a concurrent successful append', async () => {
      await seedPersisted([], []);
      IndexedDBStorageService.simulateFailureOnce = true;
      const first = settle(repository.transactions.append(mkTx('t1', 100)));
      const second = settle(repository.transactions.append(mkTx('t2', 200)));
      expect({ t1: await first, t2: await second }).toEqual({ t1: 'rejected', t2: 'ok' });
      await drain();

      const memory = memoryTxIds();
      const storage = await storedTxIds();
      expect(memory).toEqual(storage);
      expect(memory).toEqual(['t2']);
      // the row whose write was reported as failed must NOT be persisted
      expect(storage).not.toContain('t1');
    });

    it('a failed append does not erase a concurrent successful appendMany', async () => {
      await seedPersisted([], [mkTx('seed', 50)]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const first = settle(repository.transactions.append(mkTx('t1', 100)));
      const second = settle(repository.transactions.appendMany([mkTx('t2', 200), mkTx('t3', 300)]));
      await Promise.all([first, second]);
      await drain();

      const memory = memoryTxIds();
      expect(memory).toEqual(await storedTxIds());
      expect(memory).toEqual(['seed', 't2', 't3']);
    });

    it('D9-A holds under the fix: nothing here deletes a transaction', async () => {
      await seedPersisted([], [mkTx('keep', 10)]);
      IndexedDBStorageService.simulateFailureOnce = true;
      await settle(repository.transactions.append(mkTx('fails', 1)));
      await drain();
      // the revert removed only the row this operation added
      expect(memoryTxIds()).toEqual(['keep']);
      expect(await storedTxIds()).toEqual(['keep']);
    });
  });

  /* ═══════════════ §4 sequential behaviour is unchanged ══════════════════ */
  describe('§4 the no-overlap path is byte-for-byte what it always was', () => {
    it('a failed write restores the exact previous array, order included', async () => {
      await seedPersisted([
        { id: 'lia-1', name: 'One', amount: 1 },
        { id: 'lia-2', name: 'Two', amount: 2 },
        { id: 'lia-3', name: 'Three', amount: 3 }
      ]);
      const before = JSON.parse(JSON.stringify(libs()));

      IndexedDBStorageService.simulateFailureOnce = true;
      await settle(S().removeLiability('lia-2'));
      await drain();

      // Same records, same ORDER — the middle row does not reappear at the end.
      expect(libs()).toEqual(before);
      expect(libs().map(l => l.id)).toEqual(['lia-1', 'lia-2', 'lia-3']);
      expect(memoryLiabilities()).toEqual(await storedLiabilities());
    });

    it('sequential failure then success behaves exactly as before', async () => {
      await seedPersisted([{ id: 'lia-A', name: 'A', amount: 100 }, { id: 'lia-B', name: 'B', amount: 200 }]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const r1 = await settle(S().removeLiability('lia-A'));
      const r2 = await settle(S().removeLiability('lia-B'));
      await drain();
      expect([r1, r2]).toEqual(['rejected', 'ok']);
      expect(libs().map(l => l.id)).toEqual(['lia-A']);
      expect(memoryLiabilities()).toEqual(await storedLiabilities());
    });

    it('a successful write is still exactly one persist', async () => {
      await seedPersisted([{ id: 'lia-A', name: 'A', amount: 1 }]);
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await S().updateLiability({ id: 'lia-A', name: 'A', amount: 2 });
      await drain();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  /* ═══════════════ §5 the revert is operation-scoped ═════════════════════ */
  describe('§5 a revert touches only what the operation touched', () => {
    it('unrelated collections are left alone by a failed liability write', async () => {
      repo.assetsData = [{ id: 'ast-1', name: 'Cash', amount: 500 }];
      repo.accountsData = [{ id: 'acc-1', name: 'A', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' }];
      await seedPersisted([{ id: 'lia-A', name: 'A', amount: 1 }], [mkTx('t0', 5)]);
      const assetsBefore = JSON.stringify(repo.assetsData);
      const accountsBefore = JSON.stringify(repo.accountsData);
      const txBefore = JSON.stringify(repo.transactionsData);

      IndexedDBStorageService.simulateFailureOnce = true;
      await settle(S().removeLiability('lia-A'));
      await drain();

      expect(JSON.stringify(repo.assetsData)).toBe(assetsBefore);
      expect(JSON.stringify(repo.accountsData)).toBe(accountsBefore);
      expect(JSON.stringify(repo.transactionsData)).toBe(txBefore);
    });

    it('a record changed by a later operation is not clawed back by an earlier failure', async () => {
      await seedPersisted([
        { id: 'lia-A', name: 'A', amount: 100 },
        { id: 'lia-B', name: 'B', amount: 200 }
      ]);
      IndexedDBStorageService.simulateFailureOnce = true;
      // The failing operation edits A; the succeeding one edits B. The revert
      // must restore A and leave B's new value standing.
      const first = settle(S().updateLiability({ id: 'lia-A', name: 'A', amount: 999 }));
      const second = settle(S().updateLiability({ id: 'lia-B', name: 'B', amount: 250 }));
      await Promise.all([first, second]);
      await drain();

      expect(libs().find(l => l.id === 'lia-A')!.amount).toBe(100);
      expect(libs().find(l => l.id === 'lia-B')!.amount).toBe(250);
      expect(memoryLiabilities()).toEqual(await storedLiabilities());
    });
  });

  /* ═══════════════ §6 scope boundary ═════════════════════════════════════ */
  describe('§6 scope boundary', () => {
    it('the transaction write surface is unchanged by this package', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
      for (const forbidden of ['remove', 'delete', 'removeBatch', 'purge']) {
        expect(typeof t[forbidden]).toBe('undefined');
      }
    });

    it('no undo, event log or audit field was introduced', async () => {
      await seedPersisted([{ id: 'lia-A', name: 'A', amount: 1 }], [mkTx('t0', 5)]);
      IndexedDBStorageService.simulateFailureOnce = true;
      await settle(S().updateLiability({ id: 'lia-A', name: 'A', amount: 2 }));
      await drain();
      expect(Object.keys(libs()[0]).sort()).toEqual(['amount', 'id', 'name']);
      expect(typeof (repository as any).undo).toBe('undefined');
      expect(typeof (repository as any).journal).toBe('undefined');
      expect(typeof (IndexedDBStorageService as any).eventLog).toBe('undefined');
    });

    it('READFAIL still refuses every write and still says why', async () => {
      await seedPersisted([{ id: 'lia-A', name: 'A', amount: 1 }]);
      IndexedDBStorageService.simulateReadFailureOnce = true;
      await IndexedDBStorageService.loadAll().catch(() => {});
      const r = await S().updateLiability({ id: 'lia-A', name: 'A', amount: 2 })
        .then(() => null).catch((e: any) => e);
      expect(String(r?.message)).toContain('Refusing to persist');
      expect(libs()[0].amount).toBe(1);
    });
  });
});
