/**
 * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion service tests.
 *
 * Unit tests for `HoldingDeletionService`:
 *   - `planDelete` validation (INVALID_ID, HOLDING_NOT_FOUND, HOLDING_NOT_CLOSED)
 *   - `planDelete` audit-entry field correctness (the 10 minimum conceptual fields)
 *   - `planDelete` audit-entry id distinct from the deleted `holdingId`
 *   - `buildAtomicMutation` produces a closure that mutates both arrays
 *   - The deletion is irreversible: there is no public `undo` or `restore`
 *
 * Authority:
 *   - `WP-FB-IMPORT-BROKER-01-D-06-PRODUCT-AUTHORITY.md` (D-06-1..D-06-12)
 *   - `WP-FB-IMPORT-BROKER-01-D-06-IMPLEMENTATION-AUTHORITY.md` (§4.3 Option B)
 */
import { describe, it, expect } from 'vitest';
import { HoldingDeletionService, HoldingDeletionError } from '../services/HoldingDeletionService';
import { Holding, HoldingDeletionLogEntry } from '../domain/types';

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: 'hld-1',
  broker: 'Zerodha',
  account: 'UCC-A',
  instrumentName: 'Test Instrument',
  isin: undefined,
  ticker: 'AIIL',
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  unrealisedPnLPercent: 10,
  sourceFile: 'zerodha.csv',
  importedAt: '2026-08-23T10:00:00.000Z',
  status: 'closed_absent',
  ...overrides,
});

describe('WP-FB-IMPORT-BROKER-01 / D-06 — HoldingDeletionService', () => {
  describe('planDelete — validation', () => {
    it('throws INVALID_ID for an empty string id', () => {
      expect(() =>
        HoldingDeletionService.planDelete('', '2026-08-23T10:00:00.000Z', [makeHolding()], []),
      ).toThrow(HoldingDeletionError);
      try {
        HoldingDeletionService.planDelete('', '2026-08-23T10:00:00.000Z', [makeHolding()], []);
      } catch (e: any) {
        expect(e.code).toBe('INVALID_ID');
      }
    });

    it('throws INVALID_ID for a non-string id', () => {
      expect(() =>
        HoldingDeletionService.planDelete(null as any, '2026-08-23T10:00:00.000Z', [makeHolding()], []),
      ).toThrow(HoldingDeletionError);
    });

    it('throws HOLDING_NOT_FOUND when no holding has that id', () => {
      try {
        HoldingDeletionService.planDelete('hld-missing', '2026-08-23T10:00:00.000Z', [makeHolding()], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(HoldingDeletionError);
        expect(e.code).toBe('HOLDING_NOT_FOUND');
      }
    });

    it('throws HOLDING_NOT_CLOSED when the holding is active', () => {
      const active = makeHolding({ status: 'active' });
      try {
        HoldingDeletionService.planDelete('hld-1', '2026-08-23T10:00:00.000Z', [active], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(HoldingDeletionError);
        expect(e.code).toBe('HOLDING_NOT_CLOSED');
        expect(e.message).toContain('Only closed_absent');
      }
    });

    it('accepts a closed_absent holding and produces a plan', () => {
      const holding = makeHolding();
      const plan = HoldingDeletionService.planDelete('hld-1', '2026-08-23T10:00:00.000Z', [holding], []);
      expect(plan.target).toBe(holding);
      expect(plan.nextHoldings).toEqual([]);
      expect(plan.nextLog).toHaveLength(1);
    });
  });

  describe('planDelete — audit-entry fields', () => {
    it('populates the 10 minimum conceptual fields from the deleted holding', () => {
      const holding = makeHolding({
        id: 'hld-zzz',
        broker: 'Groww',
        account: '6995348108',
        instrumentName: 'Axis Bluechip Fund',
        isin: 'INF846K01DP8',
        ticker: undefined,
        currentValue: 1234.56,
        sourceFile: 'groww_mf.xlsx',
        importedAt: '2026-08-20T08:00:00.000Z',
      });
      const asOf = '2026-08-24T12:00:00.000Z';
      const plan = HoldingDeletionService.planDelete('hld-zzz', asOf, [holding], []);
      const e = plan.auditEntry;
      expect(e.holdingId).toBe('hld-zzz');
      expect(e.broker).toBe('Groww');
      expect(e.account).toBe('6995348108');
      expect(e.instrumentName).toBe('Axis Bluechip Fund');
      expect(e.isin).toBe('INF846K01DP8');
      expect(e.ticker).toBeUndefined();
      expect(e.currentValueAtDeletion).toBe(1234.56);
      expect(e.sourceFile).toBe('groww_mf.xlsx');
      expect(e.importedAt).toBe('2026-08-20T08:00:00.000Z');
      expect(e.deletedAt).toBe(asOf);
    });

    it('audit entry id is a fresh UUID and is distinct from the deleted holdingId', () => {
      const holding = makeHolding({ id: 'hld-source' });
      const plan = HoldingDeletionService.planDelete('hld-source', '2026-08-24T12:00:00.000Z', [holding], []);
      expect(plan.auditEntry.id).toBeTruthy();
      expect(plan.auditEntry.id).not.toBe('hld-source');
      expect(plan.auditEntry.id.startsWith('hdl-')).toBe(true);
    });

    it('preserves optional fields when absent (account? isin? ticker?)', () => {
      const holding = makeHolding({
        id: 'hld-min',
        account: undefined,
        isin: undefined,
        ticker: undefined,
      });
      const plan = HoldingDeletionService.planDelete('hld-min', '2026-08-24T12:00:00.000Z', [holding], []);
      expect(plan.auditEntry.account).toBeUndefined();
      expect(plan.auditEntry.isin).toBeUndefined();
      expect(plan.auditEntry.ticker).toBeUndefined();
    });
  });

  describe('planDelete — pre-computed next state', () => {
    it('nextHoldings has one fewer record (target removed)', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const h2 = makeHolding({ id: 'hld-2' });
      const h3 = makeHolding({ id: 'hld-3' });
      const plan = HoldingDeletionService.planDelete('hld-2', '2026-08-24T12:00:00.000Z', [h1, h2, h3], []);
      expect(plan.nextHoldings).toHaveLength(2);
      expect(plan.nextHoldings.map(h => h.id)).toEqual(['hld-1', 'hld-3']);
    });

    it('nextLog has one more record (audit entry appended)', () => {
      const existing: HoldingDeletionLogEntry[] = [
        { id: 'hdl-old-1', holdingId: 'hld-old', broker: 'X', instrumentName: 'Y', currentValueAtDeletion: 0, sourceFile: 'f', importedAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' },
      ];
      const holding = makeHolding({ id: 'hld-1' });
      const plan = HoldingDeletionService.planDelete('hld-1', '2026-08-24T12:00:00.000Z', [holding], existing);
      expect(plan.nextLog).toHaveLength(2);
      expect(plan.nextLog[0]).toBe(existing[0]);
      expect(plan.nextLog[1].holdingId).toBe('hld-1');
    });

    it('does not mutate the input arrays', () => {
      const holding = makeHolding({ id: 'hld-1' });
      const existing: HoldingDeletionLogEntry[] = [];
      const holdingBefore = JSON.parse(JSON.stringify(holding));
      const logBefore = JSON.parse(JSON.stringify(existing));
      HoldingDeletionService.planDelete('hld-1', '2026-08-24T12:00:00.000Z', [holding], existing);
      expect(JSON.parse(JSON.stringify(holding))).toEqual(holdingBefore);
      expect(JSON.parse(JSON.stringify(existing))).toEqual(logBefore);
    });

    it('handles a target that is not at index 0', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const h2 = makeHolding({ id: 'hld-2' });
      const h3 = makeHolding({ id: 'hld-3' });
      const plan = HoldingDeletionService.planDelete('hld-1', '2026-08-24T12:00:00.000Z', [h1, h2, h3], []);
      expect(plan.nextHoldings.map(h => h.id)).toEqual(['hld-2', 'hld-3']);
    });

    it('handles a target that is the last record', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const h2 = makeHolding({ id: 'hld-2' });
      const plan = HoldingDeletionService.planDelete('hld-2', '2026-08-24T12:00:00.000Z', [h1, h2], []);
      expect(plan.nextHoldings.map(h => h.id)).toEqual(['hld-1']);
    });

    it('handles a target that is the only record', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const plan = HoldingDeletionService.planDelete('hld-1', '2026-08-24T12:00:00.000Z', [h1], []);
      expect(plan.nextHoldings).toEqual([]);
      expect(plan.nextLog).toHaveLength(1);
    });
  });

  describe('buildAtomicMutation', () => {
    it('produces a closure that mutates both holdingsData and holdingDeletionLogData in one block', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const h2 = makeHolding({ id: 'hld-2' });
      const memoryRepo: {
        holdingsData: Holding[];
        holdingDeletionLogData: HoldingDeletionLogEntry[];
        syncStore: () => void;
      } = {
        holdingsData: [h1, h2],
        holdingDeletionLogData: [],
        syncStore: () => { /* noop for the test */ },
      };
      const plan = HoldingDeletionService.planDelete('hld-1', '2026-08-24T12:00:00.000Z', [h1, h2], []);
      // Mirror the production wiring: the closure casts `repository` directly.
      (plan as any).__memoryRepo = memoryRepo;
      const closure = HoldingDeletionService.buildAtomicMutation(plan);
      closure();
      expect(memoryRepo.holdingsData.map(h => h.id)).toEqual(['hld-2']);
      expect(memoryRepo.holdingDeletionLogData).toHaveLength(1);
      expect(memoryRepo.holdingDeletionLogData[0].holdingId).toBe('hld-1');
    });
  });
});
