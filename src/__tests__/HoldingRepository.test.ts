/**
 * WP-FB-IMPORT-BROKER-01 — D-02 Holding repository tests.
 *
 * Validates CRUD, identity lookup, duplicate protection, optional-account semantics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { repository } from '../repositories';
import { MemoryHoldingRepository } from '../repositories/MemoryHoldingRepository';
import { Holding, HoldingStatus } from '../domain/types';

const base = (overrides: Partial<Holding> = {}): Holding => ({
  id: 'hld-1',
  broker: 'TestBroker',
  account: undefined,
  instrumentName: 'Test Instrument',
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  sourceFile: 'test.csv',
  importedAt: '2026-08-23T10:00:00.000Z',
  status: 'active' as HoldingStatus,
  ...overrides,
});

describe('WP-FB-IMPORT-BROKER-01 — HoldingRepository', () => {
  let parent: typeof repository;
  let repo: MemoryHoldingRepository;

  beforeEach(() => {
    parent = repository as any;
    // Reset the shared repo's holdings collection for isolation
    (parent as any).holdingsData = [];
    (parent as any).syncStore();
    repo = new MemoryHoldingRepository({
      holdingsData: (parent as any).holdingsData,
      syncStore: () => (parent as any).syncStore(),
    });
  });

  describe('CRUD', () => {
    it('appends via add()', async () => {
      await repo.add(base());
      expect((parent as any).holdingsData).toHaveLength(1);
      expect((parent as any).holdingsData[0].id).toBe('hld-1');
    });

    it('reads via findAll() and findAllSync()', async () => {
      await repo.add(base());
      await repo.add(base({ id: 'hld-2', instrumentName: 'Other' }));
      const all = await repo.findAll();
      expect(all).toHaveLength(2);
      const sync = repo.findAllSync();
      expect(sync).toHaveLength(2);
    });

    it('updates via update()', async () => {
      await repo.add(base());
      await repo.update(base({ currentValue: 1500, unrealisedPnL: 500 }));
      expect((parent as any).holdingsData[0].currentValue).toBe(1500);
    });

    it('refuses update of unknown id', async () => {
      try {
        await repo.update(base({ id: 'hld-missing' }));
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('NOT_FOUND');
      }
    });

    it('refuses update that would change identity', async () => {
      await repo.add(base({ broker: 'Zerodha', ticker: 'AIIL' }));
      try {
        await repo.update(base({ broker: 'Dhan', ticker: 'AIIL' }));
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('IDENTITY_CHANGE_FORBIDDEN');
      }
    });

    it('removes via remove()', async () => {
      await repo.add(base());
      await repo.remove('hld-1');
      expect((parent as any).holdingsData).toHaveLength(0);
    });

    it('refuses remove of unknown id', async () => {
      try {
        await repo.remove('hld-missing');
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('findByIdSync', () => {
    it('returns the holding by id', async () => {
      await repo.add(base());
      const found = repo.findByIdSync('hld-1');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('hld-1');
    });

    it('returns null for an unknown id', () => {
      expect(repo.findByIdSync('hld-missing')).toBeNull();
    });
  });

  describe('findByIdentitySync', () => {
    it('finds by (broker, account, instrument)', async () => {
      await repo.add(base({ broker: 'Zerodha', account: 'UCC-A', ticker: 'AIIL' }));
      const found = repo.findByIdentitySync(
        base({ broker: 'Zerodha', account: 'UCC-A', ticker: 'AIIL' }),
      );
      expect(found).not.toBeNull();
      expect(found?.id).toBe('hld-1');
    });

    it('returns null when no match exists', async () => {
      await repo.add(base({ broker: 'Zerodha', ticker: 'AIIL' }));
      const found = repo.findByIdentitySync(base({ broker: 'Dhan', ticker: 'AIIL' }));
      expect(found).toBeNull();
    });

    it('treats account-undefined as a distinct identity from account-explicit', async () => {
      await repo.add(base({ broker: 'Zerodha', account: undefined, ticker: 'AIIL' }));
      const found = repo.findByIdentitySync(base({ broker: 'Zerodha', account: 'X', ticker: 'AIIL' }));
      expect(found).toBeNull();
    });
  });

  describe('saveMany', () => {
    it('appends a batch atomically', async () => {
      await repo.saveMany([
        base({ id: 'hld-a', broker: 'Zerodha', ticker: 'A' }),
        base({ id: 'hld-b', broker: 'Dhan', instrumentName: 'B' }),
      ]);
      expect((parent as any).holdingsData).toHaveLength(2);
    });

    it('refuses the whole batch if a record is invalid', async () => {
      try {
        await repo.saveMany([
          base({ id: 'hld-a' }),
          base({ id: 'hld-b', quantity: -1 }),
        ]);
        expect.fail('expected to throw');
      } catch {
        // expected
      }
      expect((parent as any).holdingsData).toHaveLength(0);
    });

    it('refuses the whole batch if a record is a duplicate within the batch', async () => {
      try {
        await repo.saveMany([
          base({ id: 'hld-a', broker: 'Z', ticker: 'A' }),
          base({ id: 'hld-b', broker: 'Z', ticker: 'A' }),
        ]);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('DUPLICATE_IDENTITY');
      }
      expect((parent as any).holdingsData).toHaveLength(0);
    });

    it('refuses the whole batch if a record collides with an existing holding', async () => {
      await repo.add(base({ id: 'hld-existing', broker: 'Z', ticker: 'A' }));
      try {
        await repo.saveMany([base({ id: 'hld-new', broker: 'Z', ticker: 'A' })]);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('DUPLICATE_IDENTITY');
      }
    });
  });

  describe('syncStore side effect', () => {
    it('calls parent.syncStore on every mutation', async () => {
      let calls = 0;
      const recording = new MemoryHoldingRepository({
        holdingsData: (parent as any).holdingsData,
        syncStore: () => { calls++; },
      });
      await recording.add(base());
      await recording.update(base({ currentValue: 1500 }));
      await recording.remove('hld-1');
      expect(calls).toBeGreaterThanOrEqual(3);
    });
  });
});
