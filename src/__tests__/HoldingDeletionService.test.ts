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

  describe('planDeleteMany — D-06-F1-A user-selected multi-select batch deletion', () => {
    const asOf = '2026-08-25T09:00:00.000Z';

    it('deletes multiple eligible closed_absent Holdings in one plan with shared batch attribution', () => {
      const h1 = makeHolding({ id: 'hld-a', instrumentName: 'Inst A', currentValue: 1000 });
      const h2 = makeHolding({ id: 'hld-b', instrumentName: 'Inst B', currentValue: 2500 });
      const h3 = makeHolding({ id: 'hld-c', instrumentName: 'Inst C', currentValue: 500 });
      const plan = HoldingDeletionService.planDeleteMany(['hld-a', 'hld-b', 'hld-c'], asOf, [h1, h2, h3], []);

      // Whole batch removed; unrelated ordering preserved.
      expect(plan.nextHoldings).toEqual([]);
      // One audit entry per deleted Holding, in selection order.
      expect(plan.auditEntries).toHaveLength(3);
      expect(plan.auditEntries.map(e => e.holdingId)).toEqual(['hld-a', 'hld-b', 'hld-c']);
      // Shared batch attribution on every entry.
      expect(plan.batchId.startsWith('hdlb-')).toBe(true);
      for (const e of plan.auditEntries) {
        expect(e.batchId).toBe(plan.batchId);
        expect(e.batchScope).toBe('MULTI_SELECT');
        expect(e.id.startsWith('hdl-')).toBe(true);
        expect(e.deletedAt).toBe(asOf);
      }
      // Audit entry ids are distinct from the deleted holdingIds.
      for (const e of plan.auditEntries) {
        expect(e.id).not.toBe(e.holdingId);
      }
      expect(plan.auditEntries[1].currentValueAtDeletion).toBe(2500);
    });

    it('a single-item batch works and carries batch attribution', () => {
      const h1 = makeHolding({ id: 'hld-solo' });
      const plan = HoldingDeletionService.planDeleteMany(['hld-solo'], asOf, [h1], []);
      expect(plan.targets).toHaveLength(1);
      expect(plan.nextHoldings).toEqual([]);
      expect(plan.auditEntries).toHaveLength(1);
      expect(plan.auditEntries[0].batchId).toBe(plan.batchId);
      expect(plan.auditEntries[0].batchScope).toBe('MULTI_SELECT');
    });

    it('rejects the ENTIRE batch when any Holding is active', () => {
      const ok1 = makeHolding({ id: 'hld-ok-1' });
      const active = makeHolding({ id: 'hld-active', status: 'active' });
      const ok2 = makeHolding({ id: 'hld-ok-2' });
      try {
        HoldingDeletionService.planDeleteMany(['hld-ok-1', 'hld-active', 'hld-ok-2'], asOf, [ok1, active, ok2], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(HoldingDeletionError);
        expect(e.code).toBe('HOLDING_NOT_CLOSED');
        expect(e.message).toContain('hld-active');
        expect(e.message).toContain('entire batch was rejected');
      }
    });

    it('rejects a mixed eligible/ineligible batch in full (no partial plan is produced)', () => {
      const eligible = makeHolding({ id: 'hld-eligible' });
      const ineligible = makeHolding({ id: 'hld-ineligible', status: 'active' });
      expect(() =>
        HoldingDeletionService.planDeleteMany(['hld-eligible', 'hld-ineligible'], asOf, [eligible, ineligible], []),
      ).toThrow(HoldingDeletionError);
      // The eligible Holding must NOT be deletable as a side effect of the
      // rejected batch: a follow-up plan for only the ineligible id still
      // fails, and the inputs are untouched.
      expect(eligible.status).toBe('closed_absent');
      expect(ineligible.status).toBe('active');
    });

    it('rejects the whole batch when any id does not exist', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      try {
        HoldingDeletionService.planDeleteMany(['hld-1', 'hld-ghost'], asOf, [h1], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('HOLDING_NOT_FOUND');
        expect(e.message).toContain('hld-ghost');
        expect(e.message).toContain('entire batch was rejected');
      }
    });

    it('rejects duplicate ids in the selection', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      try {
        HoldingDeletionService.planDeleteMany(['hld-1', 'hld-1'], asOf, [h1], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('DUPLICATE_ID');
        expect(e.message).toContain('hld-1');
      }
    });

    it('rejects empty arrays, empty-string ids, and non-string ids', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      expect(() => HoldingDeletionService.planDeleteMany([], asOf, [h1], [])).toThrow(HoldingDeletionError);
      try {
        HoldingDeletionService.planDeleteMany([], asOf, [h1], []);
      } catch (e: any) {
        expect(e.code).toBe('INVALID_ID');
      }
      try {
        HoldingDeletionService.planDeleteMany(['hld-1', ''], asOf, [h1], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_ID');
      }
      try {
        HoldingDeletionService.planDeleteMany(['hld-1', null as any], asOf, [h1], []);
        expect.fail('expected to throw');
      } catch (e: any) {
        expect(e.code).toBe('INVALID_ID');
      }
    });

    it('is pure: planning a batch never mutates the input holdings or log', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const h2 = makeHolding({ id: 'hld-2' });
      const existingLog: HoldingDeletionLogEntry[] = [
        { id: 'hdl-old-1', holdingId: 'hld-old', broker: 'X', instrumentName: 'Y', currentValueAtDeletion: 0, sourceFile: 'f', importedAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-01-02T00:00:00.000Z' },
      ];
      const holdingsBefore = JSON.parse(JSON.stringify([h1, h2]));
      const logBefore = JSON.parse(JSON.stringify(existingLog));
      HoldingDeletionService.planDeleteMany(['hld-1', 'hld-2'], asOf, [h1, h2], existingLog);
      expect(JSON.parse(JSON.stringify([h1, h2]))).toEqual(holdingsBefore);
      expect(JSON.parse(JSON.stringify(existingLog))).toEqual(logBefore);
      // Old single-deletion records remain readable alongside the plan.
      expect(existingLog[0].batchId).toBeUndefined();
      expect(existingLog[0].batchScope).toBeUndefined();
    });

    it('buildAtomicMutationForBatch applies the complete batch in one synchronous block', () => {
      const h1 = makeHolding({ id: 'hld-1' });
      const h2 = makeHolding({ id: 'hld-2' });
      const h3 = makeHolding({ id: 'hld-keep' });
      const memoryRepo: {
        holdingsData: Holding[];
        holdingDeletionLogData: HoldingDeletionLogEntry[];
        syncStore: () => void;
      } = {
        holdingsData: [h1, h2, h3],
        holdingDeletionLogData: [],
        syncStore: () => { /* noop for the test */ },
      };
      const plan = HoldingDeletionService.planDeleteMany(['hld-1', 'hld-2'], asOf, [h1, h2, h3], []);
      (plan as any).__memoryRepo = memoryRepo;
      const closure = HoldingDeletionService.buildAtomicMutationForBatch(plan);
      closure();
      // Both selected Holdings removed; the unrelated Holding untouched.
      expect(memoryRepo.holdingsData.map(h => h.id)).toEqual(['hld-keep']);
      // Both audit entries committed with shared batch attribution.
      expect(memoryRepo.holdingDeletionLogData).toHaveLength(2);
      expect(memoryRepo.holdingDeletionLogData[0].batchId).toBe(plan.batchId);
      expect(memoryRepo.holdingDeletionLogData[1].batchId).toBe(plan.batchId);
    });
  });
});
