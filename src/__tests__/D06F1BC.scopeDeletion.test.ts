/**
 * D-06-F1-B/C — service/store level acceptance for the ADDITIVE audit-scope
 * parameter on the single ratified deletion engine (authority:
 * FINBOOM-D-06-F1-BC-IMPLEMENTATION-AUTHORITY-REPORT.md §14).
 *
 * Hermetic: pure arrays for service tests; store tests seed the live
 * repository + store directly (no /home/user/uploads dependency).
 * The five F1-A suites remain the frozen behavioral pins; this file only
 * proves the widening: default-preserving MULTI_SELECT, tag propagation for
 * BROKER_WIDE / ACCOUNT_WIDE, shared batchId, attribution retention, and
 * the unchanged validation/backstop semantics under the new tags.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { HoldingDeletionService } from '../services/HoldingDeletionService';
import { Holding, HoldingDeletionLogEntry } from '../domain/types';
import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const mk = (overrides: Partial<Holding> = {}): Holding => ({
  id: overrides.id ?? `hld-${Math.random().toString(36).slice(2, 10)}`,
  broker: overrides.broker ?? 'Zerodha',
  account: overrides.account,
  // Unique (broker, account, instrument) per seeded row — the identity
  // service rejects colliding duplicates at saveMany (DUPLICATE_IDENTITY).
  instrumentName: overrides.instrumentName ?? overrides.id ?? 'Inst',
  isin: overrides.isin,
  ticker: overrides.ticker,
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  status: 'closed_absent',
  sourceFile: 'seed.csv',
  importedAt: '2026-08-23T10:00:00.000Z',
  ...overrides,
} as Holding);

const EMPTY_LOG: HoldingDeletionLogEntry[] = [];

describe('D06F1BC — additive scope parameter (service)', () => {
  it('S1: omitted scope defaults to MULTI_SELECT (F1-A byte-identical plan shape)', () => {
    const a = mk({ id: 'h1' });
    const b = mk({ id: 'h2', instrumentName: 'Two' });
    const plan = HoldingDeletionService.planDeleteMany(['h1', 'h2'], '2026-08-30T00:00:00.000Z', [a, b], EMPTY_LOG);
    expect(plan.batchScope).toBe('MULTI_SELECT');
    expect(plan.auditEntries).toHaveLength(2);
    expect(plan.auditEntries.every((e) => e.batchScope === 'MULTI_SELECT')).toBe(true);
    expect(plan.auditEntries.every((e) => e.batchId === plan.batchId && plan.batchId.startsWith('hdlb-'))).toBe(true);
  });

  it('S2: BROKER_WIDE tag reaches EVERY audit entry and the plan; batchId shared', () => {
    const rows = [mk({ id: 'x1' }), mk({ id: 'x2', broker: 'Zerodha' })];
    const plan = HoldingDeletionService.planDeleteMany(['x1', 'x2'], 'T', rows, EMPTY_LOG, 'BROKER_WIDE');
    expect(plan.batchScope).toBe('BROKER_WIDE');
    expect(plan.auditEntries.every((e) => e.batchScope === 'BROKER_WIDE')).toBe(true);
    expect(new Set(plan.auditEntries.map((e) => e.batchId))).toEqual(new Set([plan.batchId]));
    expect(plan.auditEntries.every((e) => e.broker === 'Zerodha')).toBe(true);
  });

  it('S3: ACCOUNT_WIDE tag + per-entry broker AND account attribution retained', () => {
    const rows = [mk({ id: 'y1', account: 'ACC-1' }), mk({ id: 'y2', account: 'ACC-1', instrumentName: 'Other' })];
    const plan = HoldingDeletionService.planDeleteMany(['y1', 'y2'], 'T', rows, EMPTY_LOG, 'ACCOUNT_WIDE');
    expect(plan.auditEntries.every((e) => e.batchScope === 'ACCOUNT_WIDE' && e.account === 'ACC-1' && e.broker === 'Zerodha')).toBe(true);
  });

  it('S4: scope param NEVER weakens validation — active row rejects the whole batch', () => {
    const rows = [mk({ id: 'z1' }), mk({ id: 'z2', status: 'active' as any })];
    expect(() =>
      HoldingDeletionService.planDeleteMany(['z1', 'z2'], 'T', rows, EMPTY_LOG, 'BROKER_WIDE'),
    ).toThrowError(expect.objectContaining({ code: 'HOLDING_NOT_CLOSED' }));
  });

  it('S5: empty ids rejected regardless of scope (INVALID_ID) — nothing deletable is never a silent no-op', () => {
    for (const scope of [undefined, 'BROKER_WIDE', 'ACCOUNT_WIDE'] as const) {
      expect(() =>
        HoldingDeletionService.planDeleteMany([], 'T', [mk({ id: 'w1' })], EMPTY_LOG, scope),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_ID' }));
    }
  });

  it('S6: duplicate ids rejected under BROKER_WIDE (DUPLICATE_ID preserved)', () => {
    const rows = [mk({ id: 'd1' })];
    expect(() =>
      HoldingDeletionService.planDeleteMany(['d1', 'd1'], 'T', rows, EMPTY_LOG, 'BROKER_WIDE'),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ID' }));
  });

  it('S7: vanished id rejected under ACCOUNT_WIDE (HOLDING_NOT_FOUND whole-batch reject)', () => {
    const rows = [mk({ id: 'e1' })];
    expect(() =>
      HoldingDeletionService.planDeleteMany(['e1', 'gone'], 'T', rows, EMPTY_LOG, 'ACCOUNT_WIDE'),
    ).toThrowError(expect.objectContaining({ code: 'HOLDING_NOT_FOUND' }));
  });

  it('S8: plan pre-computes next state; inputs are never mutated (immutability preserved under scopes)', () => {
    const a = mk({ id: 'i1' });
    const inputHoldings = [a, mk({ id: 'i2' })];
    const snapshot = [...inputHoldings];
    const plan = HoldingDeletionService.planDeleteMany(['i1'], 'T', inputHoldings, EMPTY_LOG, 'BROKER_WIDE');
    expect(plan.nextHoldings.map((h) => h.id)).toEqual(['i2']);
    expect(inputHoldings).toBe(inputHoldings);
    expect(inputHoldings.map((h) => h.id)).toEqual(snapshot.map((h) => h.id));
  });
});

describe('D06F1BC — store boundary (commitBatchHoldingDeletion)', () => {
  beforeEach(async () => {
    await repository.clearLocalData();
    await repository.initialize();
  });
  afterEach(async () => {
    await repository.clearLocalData();
  });

  const seedAndSync = (holdings: Holding[], assets: any[] = []) => {
    repo.holdingsData = holdings.map((h) => ({ ...h }));
    repo.holdingDeletionLogData = [];
    // Seed assets at the REPOSITORY level so the commit's own syncStore()
    // re-derives them (proves the deletion never mutates repo assets).
    repo.assetsData = assets.map((a) => ({ ...a }));
    S().syncWithRepository({
      transactions: [],
      assets,
      liabilities: [],
      holdings: repo.holdingsData,
      snapshots: [],
      accounts: [],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });
  };

  it('S9: default call persists MULTI_SELECT exactly as ratified (no semantics drift)', async () => {
    seedAndSync([mk({ id: 'm1' }), mk({ id: 'keep', instrumentName: 'Keep', status: 'active' as any })]);
    const outcome = S().commitBatchHoldingDeletion(['m1']);
    await outcome.persisted;
    const log: HoldingDeletionLogEntry[] = repo.holdingDeletionLogData;
    expect(log).toHaveLength(1);
    expect(log[0].batchScope).toBe('MULTI_SELECT');
    expect(log[0].batchId).toBe(outcome.batchId);
    expect(S().holdings.map((h: Holding) => h.id)).toEqual(['keep']);
  });

  it('S10: BROKER_WIDE commit — tags, shared batchId, atomic multi-row removal', async () => {
    seedAndSync([mk({ id: 'b1', broker: 'Groww' }), mk({ id: 'b2', broker: 'Groww' }), mk({ id: 'b3', broker: 'Dhan' })], [
      { id: 'asset-keep-1', name: 'Keep me' } as any,
    ]);
    const assetsBefore = repo.assetsData.map((a: any) => a.id);
    const txnsBefore = repo.transactionsData.map((t: any) => t.id);
    const outcome = S().commitBatchHoldingDeletion(['b1', 'b2'], 'BROKER_WIDE');
    await outcome.persisted;
    const log: HoldingDeletionLogEntry[] = repo.holdingDeletionLogData;
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.batchScope === 'BROKER_WIDE')).toBe(true);
    expect(new Set(log.map((e) => e.batchId))).toEqual(new Set([outcome.batchId]));
    expect(S().holdings.map((h: Holding) => h.id)).toEqual(['b3']);
    // AC-15 no-asset-effect: content equality is the right assertion —
    // syncStore() legitimately rebuilds array identities on EVERY commit
    // (ratified behavior), so reference identity is not the invariant;
    // unchanged CONTENTS (ids) is.
    expect(repo.assetsData.map((a: any) => a.id)).toEqual(assetsBefore);
    expect(repo.transactionsData.map((t: any) => t.id)).toEqual(txnsBefore);
  });

  it('S11: ACCOUNT_WIDE commit retains account attribution per entry', async () => {
    seedAndSync([mk({ id: 'a1', broker: 'Dhan', account: 'IQCX' }), mk({ id: 'a2', broker: 'Dhan', account: 'OTHER' })]);
    const outcome = S().commitBatchHoldingDeletion(['a1'], 'ACCOUNT_WIDE');
    await outcome.persisted;
    const log: HoldingDeletionLogEntry[] = repo.holdingDeletionLogData;
    expect(log).toHaveLength(1);
    expect(log[0].batchScope).toBe('ACCOUNT_WIDE');
    expect(log[0].account).toBe('IQCX');
    expect(log[0].broker).toBe('Dhan');
  });

  it('S12: a drifted (now-active) selected id under BROKER_WIDE rejects the WHOLE batch — data unchanged', () => {
    seedAndSync([mk({ id: 'p1' }), mk({ id: 'p2', status: 'active' as any })]);
    expect(() => S().commitBatchHoldingDeletion(['p1', 'p2'], 'BROKER_WIDE')).toThrowError(
      expect.objectContaining({ code: 'HOLDING_NOT_CLOSED' }),
    );
    expect(S().holdings).toHaveLength(2);
    expect(repo.holdingDeletionLogData).toHaveLength(0);
  });
});
