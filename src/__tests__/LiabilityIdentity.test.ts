/**
 * WP-FB-DATA-07 — Liability identity.
 *
 * Decision Q-D07-1 = (c), step 1 of two.
 *
 * WHAT THIS PACKAGE IS
 *
 * Liabilities were the last financial entity in FinBoom keyed on a mutable
 * display string. Two named "Home Loan" collapsed into one and the first amount
 * was destroyed in memory — measured at ₹25,00,000. This gives them a stable
 * `id` and migrates the IndexedDB store off `keyPath: 'name'`.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 * It does NOT change create-path behaviour. Re-adding a liability under the
 * same name still updates in place, because that is the product's ONLY
 * correction mechanism: there is no edit UI, no delete UI and no
 * `removeLiability` store action. Appending instead would take a ₹500,000 →
 * ₹350,000 paydown to ₹850,000 of debt. WP-FB-DATA-07a adds Edit/Delete against
 * the new id and only then refuses duplicate names.
 *
 *   §1  identity exists and is stable
 *   §2  the migration is lossless
 *   §3  create-path behaviour is UNCHANGED
 *   §4  identity-addressable updates
 *   §5  duplicates are possible at the repository layer
 *   §6  persistence failure & READFAIL
 *   §7  derived figures are numerically unchanged
 *   §8  scope boundary
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WP-FB-DATA-07a AMENDMENT
 *
 * 07a shipped Edit and Delete against the stable id, so the legacy exact-name
 * upsert this file used to guard (§3) is GONE — Q-D07a-4 = (b), create always
 * appends, and a duplicate name is refused (Q-D07a-2 = (b)). The assertions
 * that pinned the old create-path behaviour, and the two §8 assertions that
 * asserted "no edit/delete exists yet", are narrowed here to the authorised
 * names. Everything about IDENTITY — generation, stability, migration,
 * verify-or-abort, no-figure-moves — is unchanged and still asserted.
 * The 07a behaviour itself is covered in `LiabilityLifecycle.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LiabilityIdentityService } from '../services/LiabilityIdentityService';
import { LiabilityLifecycleService } from '../services/LiabilityLifecycleService';
import { AssetIdentityService } from '../services/AssetIdentityService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { PrismaLiabilityRepository } from '../repositories/PrismaRepository';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { demoLiabilities } from '../domain/demoFixtures';
import { Liability } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const libs = (): Liability[] => repo.liabilitiesData;
const byName = (n: string) => libs().filter(l => l.name === n);
const totalDebt = () => libs().reduce((s, l) => s + l.amount, 0);
const drain = () => new Promise(r => setTimeout(r, 30));

function reset() {
  repo.liabilitiesData = [];
  repo.holdingsData = []; repo.assetsData = []; repo.snapshotsData = []; repo.syncStore();
  useCanonicalLedger.setState({ liabilities: [], assets: [], snapshots: [] } as any);
}
async function attempt(fn: () => Promise<any>) {
  try { return { ok: true, value: await fn(), error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}
/** A legacy record exactly as it existed under keyPath 'name'. */
const legacy = (name: string, amount: number, extra: any = {}): any =>
  ({ name, amount, ...extra });

describe('WP-FB-DATA-07 — liability identity', () => {
  beforeEach(reset);
  afterEach(() => {
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    reset();
  });

  /* ═════════════════ §1 identity exists ══════════════════════════════════ */
  describe('§1 every liability carries a stable id', () => {
    it('AC-1 a newly created liability is assigned a non-empty id', async () => {
      S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      await drain();
      const l = libs()[0];
      expect(LiabilityIdentityService.isValidId(l.id)).toBe(true);
      expect(l.id!.startsWith('lia-')).toBe(true);
    });

    it('the id is stable across subsequent updates', async () => {
      // 07a: the correction is now an explicit Edit, not a re-add.
      S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 500000, type: 'Vehicle Loan' });
      await drain();
      const first = libs()[0].id;
      await S().updateLiability({ id: first, name: 'Car Loan', amount: 350000, type: 'Vehicle Loan' });
      await drain();
      expect(libs()[0].id).toBe(first);
      expect(libs()[0].amount).toBe(350000);
    });

    it('ids are unique across records', async () => {
      S().addLiabilityWithMetadata({ name: 'A', amount: 1, type: 'Other' });
      S().addLiabilityWithMetadata({ name: 'B', amount: 2, type: 'Other' });
      S().addLiabilityWithMetadata({ name: 'C', amount: 3, type: 'Other' });
      await drain();
      const ids = libs().map(l => l.id);
      expect(new Set(ids).size).toBe(3);
    });

    it('the demo fixture carries a stable literal id', () => {
      expect(demoLiabilities.every(l => LiabilityIdentityService.isValidId(l.id))).toBe(true);
      expect(demoLiabilities[0].id).toBe('lia-demo-home-loan');
    });

    it('id generation is collision-resistant over many draws', () => {
      const ids = new Set(Array.from({ length: 2000 }, () => LiabilityIdentityService.generateId()));
      expect(ids.size).toBe(2000);
    });
  });

  /* ═════════════════ §2 the migration is lossless ════════════════════════ */
  describe('§2 migration (AC-2)', () => {
    it('AC-2 legacy records survive with every field intact and a back-filled id', () => {
      const before = [
        legacy('Home Loan', 2500000, { type: 'Home Loan', currency: 'INR' }),
        legacy('Card', 50000, { type: 'Credit Card' })
      ];
      const r = LiabilityIdentityService.migrate(before);
      const v = LiabilityIdentityService.verify(before, r.liabilities);

      expect(v.ok).toBe(true);
      expect(v.failures).toEqual([]);
      expect(r.liabilities).toHaveLength(2);
      expect(r.assigned).toBe(2);
      expect(r.preserved).toBe(0);
      expect(r.liabilities[0]).toEqual({ ...before[0], id: r.liabilities[0].id });
      expect(r.liabilities[1]).toEqual({ ...before[1], id: r.liabilities[1].id });
    });

    it('migration is idempotent — a valid id is preserved exactly', () => {
      const before = [{ id: 'lia-fixed', name: 'Home Loan', amount: 100 }];
      const once = LiabilityIdentityService.migrate(before);
      const twice = LiabilityIdentityService.migrate(once.liabilities);
      expect(once.liabilities[0].id).toBe('lia-fixed');
      expect(twice.liabilities[0].id).toBe('lia-fixed');
      expect(twice.preserved).toBe(1);
      expect(twice.assigned).toBe(0);
    });

    it('migration is pure — the input array and its elements are not mutated', () => {
      const before = [legacy('Home Loan', 100)];
      const snapshot = JSON.stringify(before);
      LiabilityIdentityService.migrate(before);
      expect(JSON.stringify(before)).toBe(snapshot);
    });

    it('migration preserves order', () => {
      const before = [legacy('A', 1), legacy('B', 2), legacy('C', 3)];
      const r = LiabilityIdentityService.migrate(before);
      expect(r.liabilities.map(l => l.name)).toEqual(['A', 'B', 'C']);
    });

    it('DUPLICATE names stay SEPARATE with DISTINCT ids — never merged', () => {
      const before = [legacy('Home Loan', 2500000), legacy('Home Loan', 900000)];
      const r = LiabilityIdentityService.migrate(before);
      expect(r.liabilities).toHaveLength(2);
      expect(r.liabilities[0].id).not.toBe(r.liabilities[1].id);
      expect(r.liabilities.map(l => l.amount)).toEqual([2500000, 900000]);
      expect(r.ambiguous).toBe(2);
      expect(LiabilityIdentityService.verify(before, r.liabilities).ok).toBe(true);
    });

    it('blank / unusable names are preserved and reported, never deleted', () => {
      const before = [legacy('', 100), legacy('   ', 200), legacy('Real', 300)];
      const r = LiabilityIdentityService.migrate(before);
      expect(r.liabilities).toHaveLength(3);
      expect(r.invalid).toBe(2);
      expect(r.liabilities.map(l => l.amount)).toEqual([100, 200, 300]);
    });

    it('verify FAILS when a record is dropped', () => {
      const before = [legacy('A', 1), legacy('B', 2)];
      const bad = [{ ...before[0], id: 'lia-1' }];
      const v = LiabilityIdentityService.verify(before, bad);
      expect(v.ok).toBe(false);
      expect(v.failures.join(' ')).toContain('record count changed');
    });

    it('verify FAILS when a financial field changed', () => {
      const before = [legacy('A', 100)];
      const bad = [{ id: 'lia-1', name: 'A', amount: 999 }];
      const v = LiabilityIdentityService.verify(before, bad);
      expect(v.ok).toBe(false);
      expect(v.failures.join(' ')).toContain('"amount" changed');
    });

    it('verify FAILS on a missing or duplicated id', () => {
      const before = [legacy('A', 1), legacy('B', 2)];
      expect(LiabilityIdentityService.verify(before,
        [{ ...before[0] }, { ...before[1], id: 'x' }] as any).ok).toBe(false);
      expect(LiabilityIdentityService.verify(before,
        [{ ...before[0], id: 'x' }, { ...before[1], id: 'x' }] as any).ok).toBe(false);
    });

    it('an empty store migrates cleanly', () => {
      const r = LiabilityIdentityService.migrate([]);
      expect(r.liabilities).toEqual([]);
      expect(LiabilityIdentityService.verify([], r.liabilities).ok).toBe(true);
    });

    it('AC-2 the DB version was bumped and a report hook exists', () => {
      expect(typeof IndexedDBStorageService.getLastLiabilityMigrationReport).toBe('function');
      // null until an upgrade actually runs (jsdom has no IndexedDB)
      expect(IndexedDBStorageService.getLastLiabilityMigrationReport()).toBeNull();
    });
  });

  /* ═════════════════ §3 create path UNCHANGED ════════════════════════════ */
  describe('§3 the name-upsert is GONE — superseded by WP-FB-DATA-07a', () => {
    /* This section used to be THE load-bearing guard: with no edit UI, re-adding
       under the same name was the only correction mechanism. 07a shipped Edit,
       so Q-D07a-4 = (b) retired the silent upsert. The financial outcome the old
       guard protected — a paydown must not become a second debt — is preserved,
       it is just reached through an explicit Edit now. */
    it('re-adding the same name is REFUSED and points at Edit', async () => {
      await S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 500000, type: 'Vehicle Loan' });
      await drain();
      const r = await attempt(() =>
        S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 350000, type: 'Vehicle Loan' })
      );
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('DUPLICATE_NAME');
      expect(r.error.message).toContain('Edit');
      // Nothing moved: the original figure is intact and there is still one row.
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(500000);
    });

    it('the 07-gate money outcome still holds via Edit: 350,000, not 850,000', async () => {
      await S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 500000, type: 'Vehicle Loan' });
      await drain();
      await S().updateLiability({
        id: libs()[0].id, name: 'Car Loan', amount: 350000, type: 'Vehicle Loan'
      });
      await drain();
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(350000);
      expect(totalDebt()).not.toBe(850000);
    });

    it('Edit replaces metadata too, not just the amount', async () => {
      await S().addLiabilityWithMetadata({ name: 'Loan', amount: 100, type: 'Personal Loan', currency: 'INR' });
      await drain();
      await S().updateLiability({ id: libs()[0].id, name: 'Loan', amount: 200, type: 'Gold Loan' });
      await drain();
      expect(libs()).toHaveLength(1);
      expect(libs()[0].type).toBe('Gold Loan');
      expect(libs()[0].amount).toBe(200);
    });

    it('different names still create separate rows', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100, type: 'Home Loan' });
      await S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 200, type: 'Vehicle Loan' });
      await drain();
      expect(libs()).toHaveLength(2);
      expect(totalDebt()).toBe(300);
    });
  });

  /* ═════════════════ §4 identity-addressable updates ═════════════════════ */
  describe('§4 id addresses a record regardless of name (AC-5)', () => {
    it('AC-5 updating by id changes THAT row even under a new name', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      await drain();
      const id = libs()[0].id!;

      await repository.liabilities.update({ id, name: 'Home Loan (ICICI)', amount: 2400000, type: 'Home Loan' });
      await drain();

      expect(libs()).toHaveLength(1);
      expect(libs()[0].id).toBe(id);
      expect(libs()[0].name).toBe('Home Loan (ICICI)');
      expect(libs()[0].amount).toBe(2400000);
    });

    it('a rename via id does not create a second row', async () => {
      await S().addLiabilityWithMetadata({ name: 'Old Name', amount: 100, type: 'Other' });
      await drain();
      const id = libs()[0].id!;
      await repository.liabilities.update({ id, name: 'New Name', amount: 100, type: 'Other' });
      await drain();
      expect(libs()).toHaveLength(1);
      expect(byName('Old Name')).toHaveLength(0);
      expect(byName('New Name')).toHaveLength(1);
    });

    it('07a: an UNKNOWN id is REFUSED on edit, never appended (closes N9)', async () => {
      // Measured at the 07a gate against 07 behaviour: a stale id fell through to
      // the name path and CREATED a row, taking debt 100 -> 10,099.
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100, type: 'Home Loan' });
      await drain();
      const r = await attempt(() =>
        repository.liabilities.update({ id: 'lia-not-present', name: 'Brand New', amount: 9999 })
      );
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('LIABILITY_NOT_FOUND');
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(100);
    });

    it('a record added with no id is assigned one', async () => {
      await repository.liabilities.add({ name: 'No Id', amount: 10 } as Liability);
      await drain();
      expect(LiabilityIdentityService.isValidId(libs()[0].id)).toBe(true);
    });
  });

  /* ═════════════════ §5 duplicates possible at repo layer ════════════════ */
  describe('§5 the storage layer can now hold duplicates (AC-6)', () => {
    /* Q-D07-1 = (c) treats name uniqueness as UX POLICY for 07a, not domain
       truth — two lenders can both be a "Personal Loan". The store must be
       able to hold both; today only the create-path upsert prevents it. */
    it('AC-6 two liabilities differing only by id can coexist', async () => {
      // 07a refuses duplicate names at the CREATE PATH as a UX policy, so this
      // seeds storage directly — the storage layer itself is still capable, and
      // legacy duplicates carried in by migration must remain workable.
      repo.liabilitiesData = [
        { id: 'lia-a', name: 'Personal Loan', amount: 100000 },
        { id: 'lia-b', name: 'Personal Loan', amount: 250000 }
      ];
      repo.syncStore();
      await drain();
      expect(libs()).toHaveLength(2);
      expect(byName('Personal Loan')).toHaveLength(2);
      expect(totalDebt()).toBe(350000);
      expect(new Set(libs().map(l => l.id)).size).toBe(2);
    });

    it('the constraint lives in the CREATE PATH, not in storage', async () => {
      // via the create path -> refused, one row, first figure intact
      await S().addLiabilityWithMetadata({ name: 'Dup', amount: 100, type: 'Other' });
      await attempt(() => S().addLiabilityWithMetadata({ name: 'Dup', amount: 200, type: 'Other' }));
      await drain();
      expect(libs()).toHaveLength(1);
      expect(libs()[0].amount).toBe(100);
      // storage itself still holds two distinct records perfectly well
      reset();
      repo.liabilitiesData = [
        { id: 'lia-1', name: 'Dup', amount: 100 },
        { id: 'lia-2', name: 'Dup', amount: 200 }
      ];
      repo.syncStore();
      expect(libs()).toHaveLength(2);
      expect(totalDebt()).toBe(300);
    });
  });

  /* ═════════════════ §6 failure behaviour ════════════════════════════════ */
  describe('§6 persistence failure and READFAIL (AC-8)', () => {
    it('AC-8 a persistence failure rolls memory back exactly', async () => {
      S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100, type: 'Home Loan' });
      await drain();
      const before = JSON.parse(JSON.stringify(libs()));

      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => repository.liabilities.add({ name: 'New', amount: 999 }));

      expect(r.ok).toBe(false);
      expect(libs()).toEqual(before);
      expect(totalDebt()).toBe(100);
    });

    it('AC-8 READFAIL blocks the write and leaves the store intact', async () => {
      S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100, type: 'Home Loan' });
      await drain();
      const before = JSON.parse(JSON.stringify(libs()));

      vi.spyOn(IndexedDBStorageService, 'persist').mockRejectedValueOnce(
        new Error('Refusing to persist: the last IndexedDB load failed, so the in-memory ledger ' +
                  'may be empty or partial and writing it would destroy stored data.')
      );
      const r = await attempt(() => repository.liabilities.add({ name: 'New', amount: 999 }));

      expect(r.ok).toBe(false);
      expect(String(r.error.message)).toContain('Refusing to persist');
      expect(libs()).toEqual(before);
    });

    it('a failed update does not leave a half-assigned id', async () => {
      IndexedDBStorageService.simulateFailureOnce = true;
      await attempt(() => repository.liabilities.add({ name: 'Ghost', amount: 1 }));
      expect(libs()).toHaveLength(0);
    });
  });

  /* ═════════════════ §7 derived figures unchanged ════════════════════════ */
  describe('§7 no financial figure moves (AC-7)', () => {
    it('AC-7 totalDebt is identical before and after migration', () => {
      const before = [legacy('Home Loan', 2500000), legacy('Card', 50000)];
      const sumBefore = before.reduce((s, l) => s + l.amount, 0);
      const after = LiabilityIdentityService.migrate(before).liabilities;
      expect(after.reduce((s, l) => s + l.amount, 0)).toBe(sumBefore);
    });

    it('AC-7 amounts survive an add/update cycle exactly', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      await S().addLiabilityWithMetadata({ name: 'Card', amount: 50000, type: 'Credit Card' });
      await drain();
      expect(totalDebt()).toBe(2550000);
      const cardId = libs().find(l => l.name === 'Card')!.id;
      await S().updateLiability({ id: cardId, name: 'Card', amount: 40000, type: 'Credit Card' });
      await drain();
      expect(totalDebt()).toBe(2540000);
    });

    it('id never leaks into a user-facing financial field', async () => {
      S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100, type: 'Home Loan' });
      await drain();
      const l = libs()[0];
      expect(l.name).not.toContain('lia-');
      expect(String(l.amount)).not.toContain('lia-');
      expect(l.type).not.toContain('lia-');
    });
  });

  /* ═════════════════ §7b unreachable-branch closure ═════════════════════ */
  /* MUTATION-ESCAPE CLOSURE. Two defensive branches are unreachable through the
     public path today, so mutations removing them survived the whole suite. An
     unreachable guard with no coverage is dead code the next maintainer
     deletes — so each is exercised directly. */
  describe('§7b defensive branches (M1, M24)', () => {
    it('M1 a stored record with NO id can never be silently overwritten', async () => {
      // A record that predates 07 and reached memory without going through add()
      // — 07's migration back-fills ids on load, so this is the belt-and-braces
      // case. 07a must not let it be hit by accident from any direction.
      repo.liabilitiesData = [{ name: 'Legacy Loan', amount: 100 } as Liability];
      repo.syncStore();
      expect(libs()[0].id).toBeUndefined();

      // create under the same name -> refused, the stored figure is untouched
      const created = await attempt(() => repository.liabilities.add({ name: 'Legacy Loan', amount: 250 }));
      expect(created.ok).toBe(false);
      expect(created.error.code).toBe('DUPLICATE_NAME');

      // edit / delete without an identity -> refused, not "index 0"
      const edited = await attempt(() =>
        repository.liabilities.update({ id: undefined as any, name: 'Legacy Loan', amount: 250 })
      );
      expect(edited.ok).toBe(false);
      expect(edited.error.code).toBe('EMPTY_ID');
      const deleted = await attempt(() => repository.liabilities.remove('' as any));
      expect(deleted.ok).toBe(false);
      expect(deleted.error.code).toBe('EMPTY_ID');

      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(100);
    });

    it('M24 ensureId assigns when absent and preserves when present', () => {
      const without = LiabilityIdentityService.ensureId({ name: 'X', amount: 1 } as Liability);
      expect(LiabilityIdentityService.isValidId(without.id)).toBe(true);

      const withId = LiabilityIdentityService.ensureId({ id: 'lia-keep', name: 'X', amount: 1 });
      expect(withId.id).toBe('lia-keep');
      expect(withId).toEqual({ id: 'lia-keep', name: 'X', amount: 1 });

      // pure — the input is not mutated
      const input: Liability = { name: 'Y', amount: 2 };
      LiabilityIdentityService.ensureId(input);
      expect(input.id).toBeUndefined();
    });
  });

  /* ═════════════════ §7c the IndexedDB upgrade path ═════════════════════ */
  /* jsdom has NO IndexedDB, so the entire upgrade path — version number, store
     keyPath, migration invocation, abort-on-failed-verification — executes
     nowhere in this suite. Four mutations survived because of it. This is the
     same gap WP-FB-DATA-06c-0 closed with a failing-`indexedDB` stub; the same
     technique is used here, with a stub faithful enough to run the real
     `onupgradeneeded` handler. */
  describe('§7c upgrade path via an IndexedDB stub (M19-M22)', () => {
    function makeStub(opts: { existing?: any[]; oldVersion?: number; failRead?: boolean; fresh?: boolean }) {
      const state = {
        requestedVersion: -1,
        createdStores: [] as { name: string; keyPath: string }[],
        deletedStores: [] as string[],
        putRecords: [] as any[],
        aborted: false
      };
      const storeNames = new Set<string>(opts.fresh ? [] : ['liabilities']);
      const legacyStore = {
        keyPath: 'name',
        getAll: () => {
          const req: any = {};
          setTimeout(() => {
            if (opts.failRead) { req.onerror && req.onerror(); }
            else { req.result = opts.existing ?? []; req.onsuccess && req.onsuccess(); }
          }, 0);
          return req;
        }
      };
      const upgradeTx: any = {
        objectStore: (n: string) => (n === 'liabilities' ? legacyStore : { keyPath: 'id' }),
        abort: () => { state.aborted = true; }
      };
      const db: any = {
        objectStoreNames: { contains: (n: string) => storeNames.has(n) },
        deleteObjectStore: (n: string) => { state.deletedStores.push(n); storeNames.delete(n); },
        createObjectStore: (n: string, o: any) => {
          state.createdStores.push({ name: n, keyPath: o.keyPath });
          storeNames.add(n);
          return { put: (r: any) => state.putRecords.push(r) };
        }
      };
      const indexedDB: any = {
        open: (_name: string, version: number) => {
          state.requestedVersion = version;
          const req: any = { result: db, transaction: upgradeTx, error: null };
          setTimeout(() => {
            req.onupgradeneeded && req.onupgradeneeded({
              target: req, oldVersion: opts.oldVersion ?? 4
            });
            req.onsuccess && req.onsuccess();
          }, 0);
          return req;
        }
      };
      return { state, indexedDB };
    }

    async function runUpgrade(opts: Parameters<typeof makeStub>[0]) {
      const { state, indexedDB } = makeStub(opts);
      const original = (globalThis as any).window.indexedDB;
      Object.defineProperty((globalThis as any).window, 'indexedDB',
        { value: indexedDB, configurable: true, writable: true });
      // force a fresh connection so getDB() actually calls open()
      (IndexedDBStorageService as any).dbPromise = null;
      (IndexedDBStorageService as any).db = null;
      try {
        await (IndexedDBStorageService as any).getDB();
        await new Promise(r => setTimeout(r, 10));
      } finally {
        Object.defineProperty((globalThis as any).window, 'indexedDB',
          { value: original, configurable: true, writable: true });
        (IndexedDBStorageService as any).dbPromise = null;
        (IndexedDBStorageService as any).db = null;
      }
      return state;
    }

    it('M19 the database is opened at version 6 (5->6 adds holdings store)', async () => {
      const s = await runUpgrade({ existing: [] });
      // WP-FB-IMPORT-BROKER-01: DB_VERSION 5 -> 6 adds the `holdings` object
      // store. The existing migration tests (M20+) still apply on the v5->v6
      // upgrade path; only the requested version is now 6.
      expect(s.requestedVersion).toBe(6);
    });

    it('M20 + M21 a legacy name-keyed store is migrated and recreated on id', async () => {
      const s = await runUpgrade({
        oldVersion: 4,
        existing: [
          { name: 'Home Loan', amount: 2500000, type: 'Home Loan' },
          { name: 'Card', amount: 50000 }
        ]
      });
      expect(s.deletedStores).toContain('liabilities');
      const created = s.createdStores.find(c => c.name === 'liabilities');
      expect(created).toBeTruthy();
      expect(created!.keyPath).toBe('id');
      expect(s.aborted).toBe(false);

      // every record carried across, with a back-filled id and untouched fields
      expect(s.putRecords).toHaveLength(2);
      expect(s.putRecords.every(r => LiabilityIdentityService.isValidId(r.id))).toBe(true);
      expect(s.putRecords.map(r => r.amount)).toEqual([2500000, 50000]);
      expect(s.putRecords[0].type).toBe('Home Loan');

      const report = IndexedDBStorageService.getLastLiabilityMigrationReport();
      expect(report).toBeTruthy();
      expect(report!.ok).toBe(true);
      expect(report!.countBefore).toBe(2);
      expect(report!.countAfter).toBe(2);
      expect(report!.assigned).toBe(2);
    });

    /* M20 lives in the CREATE-IF-ABSENT branch, which only runs on a database
       that has no liabilities store yet. The migration path above deletes and
       recreates the store itself, so it never exercises that line — which is
       exactly why the mutation survived the first pass. */
    it('M20 a FRESH database creates the liabilities store on keyPath id', async () => {
      const s = await runUpgrade({ fresh: true, oldVersion: 0 });
      const created = s.createdStores.find(c => c.name === 'liabilities');
      expect(created).toBeTruthy();
      expect(created!.keyPath).toBe('id');
      // no migration should have run — there was nothing to migrate
      expect(s.deletedStores).not.toContain('liabilities');
      // and every other store is still keyed on id
      for (const n of ['transactions', 'assets', 'snapshots', 'accounts',
                       'budgets', 'policies', 'goals', 'profile']) {
        const c = s.createdStores.find(x => x.name === n);
        expect(c, `store ${n}`).toBeTruthy();
        expect(c!.keyPath, `store ${n}`).toBe('id');
      }
      expect(s.createdStores.find(x => x.name === 'meta')!.keyPath).toBe('key');
    });

    it('M22 a FAILED verification ABORTS the upgrade and destroys nothing', async () => {
      // force verify() to fail without touching production source
      vi.spyOn(LiabilityIdentityService, 'verify').mockReturnValue({
        ok: false, failures: ['forced'], countBefore: 1, countAfter: 1, uniqueIds: 1
      });
      const s = await runUpgrade({ oldVersion: 4, existing: [{ name: 'Home Loan', amount: 100 }] });

      expect(s.aborted).toBe(true);
      expect(s.deletedStores).not.toContain('liabilities');
      expect(s.createdStores.find(c => c.name === 'liabilities')).toBeUndefined();
      expect(s.putRecords).toHaveLength(0);
      expect(IndexedDBStorageService.getLastLiabilityMigrationReport()!.ok).toBe(false);
    });

    it('a failed READ of the legacy store aborts rather than proceeding', async () => {
      const s = await runUpgrade({ oldVersion: 4, failRead: true });
      expect(s.aborted).toBe(true);
      expect(s.deletedStores).not.toContain('liabilities');
      const report = IndexedDBStorageService.getLastLiabilityMigrationReport();
      expect(report!.ok).toBe(false);
      expect(report!.failures.join(' ')).toContain('failed to read legacy liabilities store');
    });

    it('duplicate-named legacy records BOTH survive the upgrade', async () => {
      const s = await runUpgrade({
        oldVersion: 4,
        existing: [{ name: 'Home Loan', amount: 2500000 }, { name: 'Home Loan', amount: 900000 }]
      });
      // under keyPath 'name' IndexedDB could hold only one; now it holds both
      expect(s.putRecords).toHaveLength(2);
      expect(s.putRecords.map(r => r.amount)).toEqual([2500000, 900000]);
      expect(new Set(s.putRecords.map(r => r.id)).size).toBe(2);
      expect(IndexedDBStorageService.getLastLiabilityMigrationReport()!.ambiguous).toBe(2);
    });
  });

  /* ═════════════════ §8 scope boundary ═══════════════════════════════════ */
  describe('§8 scope boundary — identity only', () => {
    it('07a: the port declares exactly add / update / remove', () => {
      const port = repository.liabilities as any;
      const declared = ['findAll', 'findAllSync', 'add', 'update', 'remove'];
      for (const m of declared) expect(typeof port[m]).toBe('function');
      // Delete is authorised for LIABILITIES only (Q-D07a-3 = (b)).
      expect(typeof S().removeLiability).toBe('function');
      // and only under that one authorised name
      expect(typeof S().deleteLiability).toBe('undefined');
    });

    it('AC-9 remove is id-addressable, not name-addressable', async () => {
      repo.liabilitiesData = [
        { id: 'lia-a', name: 'Same', amount: 100 },
        { id: 'lia-b', name: 'Same', amount: 200 }
      ];
      repo.syncStore();
      await drain();
      await (repository.liabilities as any).remove('lia-a');
      await drain();
      expect(libs()).toHaveLength(1);
      expect(libs()[0].id).toBe('lia-b');
      expect(libs()[0].amount).toBe(200);
    });

    it('07a exposes exactly the authorised liability store surface', () => {
      const s = S();
      // Only ONE edit name exists — no editLiability/renameLiability synonyms
      // for the same intent, which is how UI and write path drift apart.
      expect(typeof s.updateLiability).toBe('function');
      for (const k of ['editLiability', 'renameLiability', 'archiveLiability', 'excludeLiability']) {
        expect(typeof s[k]).toBe('undefined');
      }
      expect(Object.keys(s).filter(k => /iabilit/i.test(k)).sort())
        .toEqual(['addLiability', 'addLiabilityWithMetadata', 'liabilities', 'removeLiability', 'updateLiability']);
    });

    it('the Prisma adapter mirrors the lifecycle policy, not just identity', async () => {
      const p = new PrismaLiabilityRepository();
      const spy = vi.spyOn(LiabilityLifecycleService, 'planCreate');
      await p.add({ name: 'Home Loan', amount: 100 });
      expect(spy).toHaveBeenCalled();
      // and the produced record carries a generated identity
      expect(LiabilityIdentityService.isValidId(spy.mock.results[0].value.liability.id)).toBe(true);
      spy.mockRestore();
    });

    it('LiabilityIdentityService mirrors the AssetIdentityService contract', () => {
      for (const m of ['generateId', 'normalizeName', 'isValidId', 'migrate', 'verify']) {
        expect(typeof (LiabilityIdentityService as any)[m]).toBe('function');
        expect(typeof (AssetIdentityService as any)[m]).toBe('function');
      }
      expect(LiabilityIdentityService.generateId().startsWith('lia-')).toBe(true);
      expect(AssetIdentityService.generateId().startsWith('ast-')).toBe(true);
    });

    it('the transaction write surface is untouched', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
    });
  });
});
