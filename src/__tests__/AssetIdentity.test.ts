/**
 * WP-FB-DATA-04c-1 — Asset identity.
 *
 * `Asset` previously had no identity: `name` was the key in memory
 * (findIndex on a.name) and in IndexedDB (keyPath: 'name'). This suite proves
 * the introduction of a stable `Asset.id` is deterministic, idempotent and
 * lossless, and that the IndexedDB keyPath migration verifies itself.
 *
 * SCOPE: identity only. No Account<->Asset link (DATA-04c-2), no Essentials/B5
 * change (DATA-05b), no NET_WORTH change.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';

import { AssetIdentityService } from '../services/AssetIdentityService';
import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialQueries } from '../application/queries';
import { Asset } from '../domain/types';

const repo = repository as any;

function reset() {
  repo.assetsData = [];
  repo.transactionsData = [];
  repo.accountsData = [];
  repo.liabilitiesData = [];
  repo.holdingsData = [];
  repo.syncStore();
}

const A = (name: string, amount: number, extra: Partial<Asset> = {}): Asset =>
  ({ name, amount, type: 'Cash & Savings', ...extra } as Asset);

/* ---------------------------------------------------------------------------
 * Minimal dependency-free IndexedDB doubles. jsdom provides no indexedDB and
 * adding fake-indexeddb is not authorized, so the real migration function is
 * driven directly against these.
 * ------------------------------------------------------------------------ */
class FakeObjectStore {
  public records: any[] = [];
  constructor(public name: string, public keyPath: string, seed: any[] = []) {
    this.records = seed.map(r => ({ ...r }));
  }
  getAll() {
    const req: any = { onsuccess: null, onerror: null, result: this.records.map(r => ({ ...r })) };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  }
  put(v: any) { this.records.push({ ...v }); }
}
class FakeDB {
  public stores = new Map<string, FakeObjectStore>();
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(name: string, opts: { keyPath: string }) {
    const s = new FakeObjectStore(name, opts.keyPath);
    this.stores.set(name, s);
    return s;
  }
  deleteObjectStore(name: string) { this.stores.delete(name); }
}
class FakeTx {
  public aborted = false;
  constructor(private db: FakeDB) {}
  objectStore(n: string) { return this.db.stores.get(n)!; }
  abort() { this.aborted = true; }
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('WP-FB-DATA-04c-1 — asset identity', () => {
  beforeEach(reset);
  afterEach(reset);

  /* ------------------------------- id strategy ------------------------- */
  describe('id generation', () => {
    it('produces stable, unique, prefixed ids without a dependency', () => {
      const ids = new Set(Array.from({ length: 500 }, () => AssetIdentityService.generateId()));
      expect(ids.size).toBe(500);
      for (const id of ids) expect(id.startsWith('ast-')).toBe(true);
    });

    it('never derives identity from name, tag, type or position', () => {
      const a = AssetIdentityService.generateId();
      const b = AssetIdentityService.generateId();
      expect(a).not.toBe(b);
      expect(a).not.toContain('HDFC');
    });
  });

  /* ------------------------------- migration --------------------------- */
  describe('migration', () => {
    it('assigns exactly one id to each unique legacy asset (MATCHED)', () => {
      const res = AssetIdentityService.migrate([A('HDFC Savings', 10000), A('Gold', 5000)]);
      expect(res.assigned).toBe(2);
      expect(res.preserved).toBe(0);
      expect(res.ambiguous).toBe(0);
      expect(res.rows.every(r => r.classification === 'MATCHED')).toBe(true);
      expect(new Set(res.assets.map(a => a.id)).size).toBe(2);
    });

    it('preserves an existing valid id untouched', () => {
      const res = AssetIdentityService.migrate([{ ...A('Gold', 5000), id: 'ast-existing' }]);
      expect(res.preserved).toBe(1);
      expect(res.assigned).toBe(0);
      expect(res.assets[0].id).toBe('ast-existing');
      expect(res.rows[0].classification).toBe('PRESERVED');
    });

    it('is idempotent — a second run changes no identity', () => {
      const once = AssetIdentityService.migrate([A('A', 1), A('B', 2), A('C', 3)]);
      const twice = AssetIdentityService.migrate(once.assets);
      expect(twice.assigned).toBe(0);
      expect(twice.preserved).toBe(3);
      expect(twice.assets.map(a => a.id)).toEqual(once.assets.map(a => a.id));
    });

    it('N in / N out — never merges, never drops', () => {
      const input = [A('X', 1), A('X', 2), A('Y', 3), A('', 4), A('   ', 5)];
      const res = AssetIdentityService.migrate(input);
      expect(res.assets).toHaveLength(input.length);
      expect(new Set(res.assets.map(a => a.id)).size).toBe(input.length);
    });

    it('preserves every financial and descriptive field exactly', () => {
      const original = A('Gold ETF', 12345.67, {
        type: 'Commodities' as any, tag: 'long-term', currency: 'INR', geography: 'India' as any
      });
      const [out] = AssetIdentityService.migrate([{ ...original }]).assets;
      expect(out.name).toBe(original.name);
      expect(out.amount).toBe(original.amount);
      expect(out.type).toBe(original.type);
      expect(out.tag).toBe(original.tag);
      expect(out.currency).toBe(original.currency);
      expect(out.geography).toBe(original.geography);
      expect(AssetIdentityService.isValidId(out.id)).toBe(true);
    });

    it('does not mutate the input array or its elements', () => {
      const input = [A('A', 1)];
      AssetIdentityService.migrate(input);
      expect(input[0].id).toBeUndefined();
    });

    it('keeps duplicate normalised names SEPARATE with distinct ids (AMBIGUOUS)', () => {
      const res = AssetIdentityService.migrate([
        A('HDFC Savings', 10000), A('hdfc savings', 7000), A('HDFC Savings ', 3000)
      ]);
      expect(res.assets).toHaveLength(3);                       // never merged
      expect(res.ambiguous).toBe(3);
      expect(new Set(res.assets.map(a => a.id)).size).toBe(3);  // distinct ids
      expect(res.assets.map(a => a.amount)).toEqual([10000, 7000, 3000]);
      expect(res.rows.every(r => r.classification === 'AMBIGUOUS')).toBe(true);
    });

    it('preserves blank/invalid names and classifies them UNMAPPED', () => {
      const res = AssetIdentityService.migrate([A('', 4000), A('   ', 500)]);
      expect(res.assets).toHaveLength(2);                        // never deleted
      expect(res.invalid).toBe(2);
      expect(res.assets.map(a => a.amount)).toEqual([4000, 500]);
      expect(res.rows.every(r => r.classification === 'UNMAPPED')).toBe(true);
    });

    it('handles a mixed legacy set with an accurate classification report', () => {
      const res = AssetIdentityService.migrate([
        A('Gold', 1), A('Dup', 2), A('dup', 3), A('', 4), { ...A('Kept', 5), id: 'ast-keep' }
      ]);
      expect(res.assets).toHaveLength(5);
      expect(res.preserved).toBe(1);
      expect(res.assigned).toBe(4);
      expect(res.ambiguous).toBe(2);
      expect(res.invalid).toBe(1);
      expect(res.assets.find(a => a.name === 'Kept')!.id).toBe('ast-keep');
    });
  });

  /* ------------------------------ verification ------------------------- */
  describe('verification', () => {
    it('passes a clean migration', () => {
      const before = [A('A', 1), A('B', 2)];
      const after = AssetIdentityService.migrate(before.map(a => ({ ...a }))).assets;
      const v = AssetIdentityService.verify(before, after);
      expect(v.ok).toBe(true);
      expect(v.countBefore).toBe(2);
      expect(v.countAfter).toBe(2);
      expect(v.uniqueIds).toBe(2);
    });

    it('fails on a dropped record', () => {
      const before = [A('A', 1), A('B', 2)];
      const after = AssetIdentityService.migrate([{ ...before[0] }]).assets;
      expect(AssetIdentityService.verify(before, after).ok).toBe(false);
    });

    it('fails on a mutated amount', () => {
      const before = [A('A', 1)];
      const after = AssetIdentityService.migrate([{ ...before[0] }]).assets;
      after[0].amount = 999;
      const v = AssetIdentityService.verify(before, after);
      expect(v.ok).toBe(false);
      expect(v.failures.join(' ')).toMatch(/amount/);
    });

    it('fails on duplicate ids', () => {
      const before = [A('A', 1), A('B', 2)];
      const after = AssetIdentityService.migrate(before.map(a => ({ ...a }))).assets;
      after[1].id = after[0].id;
      expect(AssetIdentityService.verify(before, after).ok).toBe(false);
    });
  });

  /* ------------------------------- repository -------------------------- */
  describe('repository semantics', () => {
    it('assigns an id on the legacy create path', async () => {
      await repo.assets.add({ name: 'Gold', amount: 100 });
      expect(AssetIdentityService.isValidId(repo.assetsData[0].id)).toBe(true);
    });

    it('looks up by id', async () => {
      await repo.assets.add({ name: 'Gold', amount: 100 });
      const id = repo.assetsData[0].id;
      expect(repo.assets.findByIdSync(id)!.name).toBe('Gold');
      expect(repo.assets.findByIdSync('ast-nope')).toBeNull();
    });

    it('updates by id, and a rename does NOT change the id', async () => {
      await repo.assets.add({ name: 'Gold', amount: 100 });
      const id = repo.assetsData[0].id;

      // WP-FB-DATA-07b: the id-addressed replace moved from `add` to `update`.
      // `add` now always appends (Q-D07b-1a = (c)).
      await repo.assets.update({ id, name: 'Gold Bullion', amount: 250 });

      expect(repo.assetsData).toHaveLength(1);          // updated, not appended
      expect(repo.assetsData[0].id).toBe(id);           // identity survived rename
      expect(repo.assetsData[0].name).toBe('Gold Bullion');
      expect(repo.assetsData[0].amount).toBe(250);
    });

    /* WP-FB-DATA-07b AMENDMENT — this section used to assert the OPPOSITE.
       The legacy exact-name upsert was preserved by 04c-1 because assets had no
       Edit UI and re-adding under the same name was the only way to correct a
       figure. 07b ships Edit and Delete, and Q-D07b-1a = (c) permits duplicate
       names, so the silent upsert is retired: it was measured destroying
       ₹5,00,000 through the real modal with no notice. */
    it('07b: an id-less add with an existing name APPENDS — no silent upsert', async () => {
      await repo.assets.add({ name: 'Gold', amount: 100 });
      const id = repo.assetsData[0].id;
      await repo.assets.add({ name: 'Gold', amount: 400 });   // same name, no id

      expect(repo.assetsData).toHaveLength(2);
      expect(repo.assetsData[0].id).toBe(id);
      expect(repo.assetsData[0].amount).toBe(100);            // NOT destroyed
      expect(repo.assetsData[1].amount).toBe(400);
      expect(new Set(repo.assetsData.map((a: Asset) => a.id)).size).toBe(2);
    });

    it('treats differently-cased names as distinct assets (no merging)', async () => {
      await repo.assets.add({ name: 'Gold', amount: 100 });
      await repo.assets.add({ name: 'gold', amount: 200 });
      expect(repo.assetsData).toHaveLength(2);
      expect(new Set(repo.assetsData.map((a: Asset) => a.id)).size).toBe(2);
    });

    it('removes by id, leaving same-named siblings intact', async () => {
      await repo.assets.add({ name: 'Gold', amount: 100 });
      await repo.assets.add({ name: 'gold', amount: 200 });
      const target = repo.assetsData[0].id;

      await repo.assets.remove(target);

      expect(repo.assetsData).toHaveLength(1);
      expect(repo.assetsData[0].amount).toBe(200);
    });
  });

  /* --------------------- IndexedDB keyPath migration ------------------- */
  describe('IndexedDB 3 -> 4 keyPath migration', () => {
    // Imported lazily: a top-level import of the storage service leads the
    // module graph into the pre-existing repositories <-> store import cycle,
    // whose jsdom auto-initialise timer then fires against a partially
    // initialised `repository`. Lazy import preserves normal ordering.
    let IndexedDBStorageService: any;
    beforeAll(async () => {
      ({ IndexedDBStorageService } = await import('../services/IndexedDBStorageService'));
    });

    const runUpgrade = async (seed: any[], keyPath = 'name') => {
      const db = new FakeDB();
      db.stores.set('assets', new FakeObjectStore('assets', keyPath, seed));
      const tx = new FakeTx(db);
      (IndexedDBStorageService as any).migrateAssetsToIdKeyPath(db, tx);
      await flush();
      return { db, tx, store: db.stores.get('assets')! };
    };

    it('recreates the store with keyPath "id" and restores every record', async () => {
      const seed = [
        { name: 'HDFC Savings', amount: 10000, type: 'Cash & Savings', tag: 'liquid', currency: 'INR' },
        { name: 'Gold', amount: 5000, type: 'Commodities' }
      ];
      const { tx, store } = await runUpgrade(seed);

      expect(tx.aborted).toBe(false);
      expect(store.keyPath).toBe('id');
      expect(store.records).toHaveLength(2);                       // N in / N out
      expect(store.records.every(r => AssetIdentityService.isValidId(r.id))).toBe(true);
      expect(store.records.map(r => r.amount)).toEqual([10000, 5000]);
      expect(store.records[0].tag).toBe('liquid');
      expect(store.records[0].currency).toBe('INR');

      const rep = IndexedDBStorageService.getLastAssetMigrationReport()!;
      expect(rep.ok).toBe(true);
      expect(rep.countBefore).toBe(2);
      expect(rep.countAfter).toBe(2);
      expect(rep.assigned).toBe(2);
    });

    it('keeps duplicate normalised names as separate records', async () => {
      const { store } = await runUpgrade([
        { name: 'HDFC Savings', amount: 10000 },
        { name: 'hdfc savings', amount: 7000 }
      ]);
      expect(store.records).toHaveLength(2);
      expect(new Set(store.records.map(r => r.id)).size).toBe(2);
      expect(IndexedDBStorageService.getLastAssetMigrationReport()!.ambiguous).toBe(2);
    });

    it('preserves blank-named records rather than dropping them', async () => {
      const { store } = await runUpgrade([{ name: '', amount: 4000 }]);
      expect(store.records).toHaveLength(1);
      expect(store.records[0].amount).toBe(4000);
      expect(IndexedDBStorageService.getLastAssetMigrationReport()!.invalid).toBe(1);
    });

    it('is a no-op when the store is already keyed by id', async () => {
      const seeded = [{ id: 'ast-1', name: 'Gold', amount: 5000 }];
      const { store, tx } = await runUpgrade(seeded, 'id');
      expect(tx.aborted).toBe(false);
      expect(store.keyPath).toBe('id');
      expect(store.records).toEqual(seeded);
    });

    it('running the upgrade twice produces zero identity changes', async () => {
      const first = await runUpgrade([{ name: 'Gold', amount: 5000 }]);
      const idsAfterFirst = first.store.records.map(r => r.id);
      const second = await runUpgrade(first.store.records, 'id');
      expect(second.store.records.map(r => r.id)).toEqual(idsAfterFirst);
    });

    it('ABORTS the upgrade instead of recreating the store when verification fails', async () => {
      const db = new FakeDB();
      db.stores.set('assets', new FakeObjectStore('assets', 'name', [{ name: 'Gold', amount: 5000 }]));
      const tx = new FakeTx(db);
      // Force verification failure.
      const realVerify = AssetIdentityService.verify;
      (AssetIdentityService as any).verify = () => ({ ok: false, failures: ['forced'], countBefore: 1, countAfter: 1, uniqueIds: 1 });
      try {
        (IndexedDBStorageService as any).migrateAssetsToIdKeyPath(db, tx);
        await flush();
      } finally {
        (AssetIdentityService as any).verify = realVerify;
      }
      expect(tx.aborted).toBe(true);
      expect(db.stores.get('assets')!.keyPath).toBe('name');       // untouched
      expect(IndexedDBStorageService.getLastAssetMigrationReport()!.ok).toBe(false);
    });
  });

  /* -------------------------- hydration + regressions ------------------ */
  describe('hydration and non-regression', () => {
    it('backfills ids on repository initialize-style migration', () => {
      repo.assetsData = [A('Legacy 1', 100), A('Legacy 2', 200)];
      repo.assetsData = AssetIdentityService.migrate(repo.assetsData).assets;
      repo.syncStore();
      expect(useCanonicalLedger.getState().assets.every(a => AssetIdentityService.isValidId(a.id))).toBe(true);
    });

    it('does not change NET_WORTH or TOTAL_ASSETS', () => {
      repo.assetsData = [A('Gold', 5000), A('Cash', 3000)];
      repo.liabilitiesData = [{ name: 'Loan', amount: 1000 } as any];
      repo.syncStore();
      const nwBefore = FinancialQueries.getMetric('NET_WORTH').value;
      const taBefore = FinancialQueries.getMetric('TOTAL_ASSETS').value;

      repo.assetsData = AssetIdentityService.migrate(repo.assetsData).assets;
      repo.syncStore();

      expect(FinancialQueries.getMetric('NET_WORTH').value).toBe(nwBefore);
      expect(FinancialQueries.getMetric('TOTAL_ASSETS').value).toBe(taBefore);
      expect(nwBefore).toBe(7000);
    });

    it('keeps Asset.id out of the AssetsWorkspace search text contract', () => {
      const a = { ...A('Gold', 100, { tag: 't', currency: 'INR' }), id: 'ast-secret-id' };
      // Mirrors AssetsWorkspace:22
      const searchText = `${a.name} ${a.tag || ''} ${a.type || ''} ${a.currency || ''}`.toLowerCase();
      expect(searchText).not.toContain('ast-secret-id');
    });
  });
});
