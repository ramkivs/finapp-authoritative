/**
 * WP-FB-IMPORT-BROKER-01 — D-02 lifecycle planner tests.
 */
import { describe, it, expect } from 'vitest';
import { HoldingLifecycleService, HoldingLifecycleError } from '../services/HoldingLifecycleService';
import { Holding, HoldingStatus } from '../domain/types';
import { HoldingIdentityService } from '../services/HoldingIdentityService';

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

describe('WP-FB-IMPORT-BROKER-01 — D-02 Holding lifecycle planner', () => {
  describe('planCreate', () => {
    it('appends a new holding', () => {
      const candidate = base({ id: 'hld-new' });
      const plan = HoldingLifecycleService.planCreate(candidate, []);
      expect(plan.next).toHaveLength(1);
      expect(plan.next[0]).toEqual(candidate);
    });

    it('refuses a duplicate id', () => {
      const existing = base();
      try {
        HoldingLifecycleService.planCreate(base(), [existing]);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('DUPLICATE_ID');
      }
    });

    it('refuses a duplicate identity (same broker+account+instrument)', () => {
      const existing = base({ id: 'hld-existing', instrumentName: 'Fund X' });
      const candidate = base({ id: 'hld-new', instrumentName: 'Fund X' });
      try {
        HoldingLifecycleService.planCreate(candidate, [existing]);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('DUPLICATE_IDENTITY');
      }
    });

    it('refuses missing id', () => {
      const candidate = base({ id: '' });
      try {
        HoldingLifecycleService.planCreate(candidate, []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('MISSING_ID');
      }
    });

    it('rejects negative quantity', () => {
      const candidate = base({ quantity: -1 });
      try {
        HoldingLifecycleService.planCreate(candidate, []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_NUMERIC');
      }
    });

    it('rejects NaN in monetary fields', () => {
      const candidate = base({ averageCost: NaN });
      try {
        HoldingLifecycleService.planCreate(candidate, []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_NUMERIC');
      }
    });

    it('rejects Infinity in monetary fields', () => {
      const candidate = base({ currentValue: Infinity });
      try {
        HoldingLifecycleService.planCreate(candidate, []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_NUMERIC');
      }
    });

    it('rejects empty broker', () => {
      const candidate = base({ broker: '' });
      try {
        HoldingLifecycleService.planCreate(candidate, []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_STRING');
      }
    });

    it('normalises empty-string account to undefined', () => {
      const candidate = base({ account: '' });
      const plan = HoldingLifecycleService.planCreate(candidate, []);
      expect(plan.holding.account).toBeUndefined();
    });

    it('normalises empty-string securityClassification to undefined', () => {
      const candidate = base({ securityClassification: '   ' });
      const plan = HoldingLifecycleService.planCreate(candidate, []);
      expect(plan.holding.securityClassification).toBeUndefined();
    });
  });

  describe('planUpdate', () => {
    it('replaces an existing record', () => {
      const existing = base();
      const updated = base({ currentValue: 1500, unrealisedPnL: 500 });
      const plan = HoldingLifecycleService.planUpdate(updated, [existing]);
      expect(plan.next).toHaveLength(1);
      expect(plan.next[0].currentValue).toBe(1500);
    });

    it('refuses an unknown id', () => {
      try {
        HoldingLifecycleService.planUpdate(base(), []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('NOT_FOUND');
      }
    });

    it('refuses an identity change', () => {
      const existing = base({ broker: 'Zerodha', ticker: 'AIIL' });
      const updated = base({ broker: 'Dhan', ticker: 'AIIL' });
      try {
        HoldingLifecycleService.planUpdate(updated, [existing]);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('IDENTITY_CHANGE_FORBIDDEN');
      }
    });

    it('allows an identity-preserving update', () => {
      const existing = base();
      const updated = base({ currentValue: 1500 });
      expect(() =>
        HoldingLifecycleService.planUpdate(updated, [existing]),
      ).not.toThrow();
    });
  });

  describe('planClose', () => {
    it('marks an active holding as closed_absent', () => {
      const existing = base();
      const plan = HoldingLifecycleService.planClose('hld-1', [existing], '2026-08-24T00:00:00.000Z');
      expect(plan.holding.status).toBe<HoldingStatus>('closed_absent');
    });

    it('refuses to close an already-closed holding', () => {
      const existing = base({ status: 'closed_absent' as HoldingStatus });
      try {
        HoldingLifecycleService.planClose('hld-1', [existing], '2026-08-24');
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('ALREADY_CLOSED');
      }
    });

    it('refuses to close an unknown id', () => {
      try {
        HoldingLifecycleService.planClose('hld-x', [], '2026-08-24');
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('NOT_FOUND');
      }
    });

    it('updates importedAt to the closure timestamp', () => {
      const existing = base({ importedAt: '2026-08-23T10:00:00.000Z' });
      const plan = HoldingLifecycleService.planClose('hld-1', [existing], '2026-08-24T00:00:00.000Z');
      expect(plan.holding.importedAt).toBe('2026-08-24T00:00:00.000Z');
    });
  });

  describe('identity preservation', () => {
    it('preserves the identity tuple across the full lifecycle', () => {
      const a = base();
      const idA = HoldingIdentityService.identityOf(a);
      const planC = HoldingLifecycleService.planCreate(a, []);
      const idC = HoldingIdentityService.identityOf(planC.holding);
      expect(idA).toEqual(idC);
      const planU = HoldingLifecycleService.planUpdate(planC.holding, planC.next);
      const idU = HoldingIdentityService.identityOf(planU.holding);
      expect(idA).toEqual(idU);
      const planX = HoldingLifecycleService.planClose(planC.holding.id, planC.next, '2026-08-24');
      const idX = HoldingIdentityService.identityOf(planX.holding);
      expect(idA).toEqual(idX);
    });
  });

  it('HoldingLifecycleError carries the documented code', () => {
    try {
      HoldingLifecycleService.planCreate(base({ id: '' }), []);
    } catch (e) {
      expect(e).toBeInstanceOf(HoldingLifecycleError);
      expect((e as HoldingLifecycleError).code).toBe('MISSING_ID');
    }
  });
});
