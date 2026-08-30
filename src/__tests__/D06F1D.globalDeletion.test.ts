/**
 * D-06-F1-D service/store acceptance — the 'GLOBAL' audit tag rides the ONE
 * ratified engine; validation is scope-blind and NEVER bypassed. Authority:
 * FINBOOM-D-06-F6-F1D-IMPLEMENTATION-AUTHORITY-REPORT.md (§§6, 8, 9; AC-F1D-01/06/08/10/12).
 * Hermetic: pure arrays (service) + direct repository seeding (store).
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
  // Unique (broker, account, instrument) identity per seeded row.
  instrumentName: overrides.instrumentName ?? overrides.id,
  isin: 'INE000000000',
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

describe('D06F1D — GLOBAL scope on the ratified engine (service)', () => {
  it('D1: planDeleteMany with GLOBAL tags EVERY entry; shared hdlb- batchId; plan carries the tag', () => {
    const rows = [
      mk({ id: 'g1', broker: 'Zerodha' }),
      mk({ id: 'g2', broker: 'Dhan', account: 'DA1', instrumentName: 'Two' }),
      mk({ id: 'g3', broker: 'ICICI', instrumentName: 'Three' }),
    ];
    const plan = HoldingDeletionService.planDeleteMany(
      ['g1', 'g2', 'g3'],
      '2026-08-30T00:00:00.000Z',
      rows,
      EMPTY_LOG,
      'GLOBAL',
    );
    expect(plan.batchScope).toBe('GLOBAL');
    expect(plan.auditEntries).toHaveLength(3);
    expect(plan.auditEntries.every((e) => e.batchScope === 'GLOBAL')).toBe(true);
    expect(new Set(plan.auditEntries.map((e) => e.batchId))).toEqual(new Set([plan.batchId]));
    expect(plan.batchId.startsWith('hdlb-')).toBe(true);
    // Heterogeneous per-row attribution preserved (undefined-account included):
    const byId = Object.fromEntries(plan.auditEntries.map((e) => [e.holdingId, e]));
    expect(byId.g1.broker).toBe('Zerodha');
    expect(byId.g1.account).toBeUndefined();
    expect(byId.g2.broker).toBe('Dhan');
    expect(byId.g2.account).toBe('DA1');
    expect(byId.g3.broker).toBe('ICICI');
  });

  it('D2: GLOBAL never weakens validation — drifted-active row rejects the WHOLE batch', () => {
    const rows = [mk({ id: 'v1' }), mk({ id: 'v2', instrumentName: 'Two', status: 'active' as any })];
    expect(() =>
      HoldingDeletionService.planDeleteMany(['v1', 'v2'], 'T', rows, EMPTY_LOG, 'GLOBAL'),
    ).toThrowError(expect.objectContaining({ code: 'HOLDING_NOT_CLOSED' }));
  });

  it('D3: empty ids rejected under GLOBAL (no silent whole-ledger or no-op path)', () => {
    expect(() =>
      HoldingDeletionService.planDeleteMany([], 'T', [mk({ id: 'e1' })], EMPTY_LOG, 'GLOBAL'),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ID' }));
  });

  it('D4: duplicate ids rejected under GLOBAL', () => {
    expect(() =>
      HoldingDeletionService.planDeleteMany(['q1', 'q1'], 'T', [mk({ id: 'q1' })], EMPTY_LOG, 'GLOBAL'),
    ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ID' }));
  });

  it('D5: vanished id under GLOBAL rejects the whole batch', () => {
    expect(() =>
      HoldingDeletionService.planDeleteMany(['r1', 'gone'], 'T', [mk({ id: 'r1' })], EMPTY_LOG, 'GLOBAL'),
    ).toThrowError(expect.objectContaining({ code: 'HOLDING_NOT_FOUND' }));
  });

  it('D6: audit attribution is read from the LIVE rows the plan validated (post-drift identity)', () => {
    // A row whose broker drifted between the UI snapshot and the store read
    // is audited with its LIVE attribution — GLOBAL has no scope predicate to
    // broaden/restrict eligibility, so it remains deletable and honestly
    // attributed.
    const rows = [mk({ id: 's1', broker: 'Zerodha' }), mk({ id: 's2', broker: 'Dhan', instrumentName: 'Two' })];
    const drifted = rows.map((h) => (h.id === 's1' ? { ...h, broker: 'Groww' as any } : h));
    const plan = HoldingDeletionService.planDeleteMany(['s1', 's2'], 'T', drifted, EMPTY_LOG, 'GLOBAL');
    expect(plan.auditEntries.find((e) => e.holdingId === 's1')!.broker).toBe('Groww');
  });
});

describe('D06F1D — store boundary (GLOBAL commit)', () => {
  beforeEach(() => {
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    repo.assetsData = [];
    repo.transactionsData = [];
    S().syncWithRepository({
      transactions: [], assets: [], liabilities: [], holdings: [],
      snapshots: [], accounts: [], budgets: [], policies: [], goals: [], profile: null,
    });
  });

  const seed = (holdings: Holding[], assets: any[] = []) => {
    repo.holdingsData = holdings.map((h) => ({ ...h }));
    repo.assetsData = assets.map((a) => ({ ...a }));
    S().syncWithRepository({
      transactions: [], assets: repo.assetsData, liabilities: [], holdings: repo.holdingsData,
      snapshots: [], accounts: [], budgets: [], policies: [], goals: [], profile: null,
    });
  };

  it('D7: GLOBAL commit deletes ALL heterogeneous rows in ONE atomic write; audit GLOBAL + one batchId; assets/txns untouched', async () => {
    seed(
      [
        mk({ id: 'w1', broker: 'Zerodha' }),
        mk({ id: 'w2', broker: 'Dhan', account: 'DA', instrumentName: 'Two' }),
        mk({ id: 'w3', broker: 'Groww', instrumentName: 'Three' }),
        mk({ id: 'keep', broker: 'Zerodha', instrumentName: 'Active one', status: 'active' as any }),
      ],
      [{ id: 'asset-keep-1' }, { id: 'asset-keep-2' }],
    );
    repo.transactionsData = [{ id: 'txn-keep-1' } as any];
    const assetsBefore = repo.assetsData.map((a: any) => a.id);
    const txnsBefore = repo.transactionsData.map((t: any) => t.id);
    const outcome = S().commitBatchHoldingDeletion(['w1', 'w2', 'w3'], 'GLOBAL');
    await outcome.persisted;
    expect(S().holdings.map((h: Holding) => h.id)).toEqual(['keep']);
    const log: HoldingDeletionLogEntry[] = repo.holdingDeletionLogData;
    expect(log).toHaveLength(3);
    expect(log.every((e) => e.batchScope === 'GLOBAL')).toBe(true);
    expect(new Set(log.map((e) => e.batchId)).size).toBe(1);
    // F10-C: no asset/transaction deltas through a GLOBAL batch (content equality —
    // syncStore legitimately rebuilds array identities on every commit).
    expect(repo.assetsData.map((a: any) => a.id)).toEqual(assetsBefore);
    expect(repo.transactionsData.map((t: any) => t.id)).toEqual(txnsBefore);
  });

  it('D8: residual race at the store boundary under GLOBAL — whole-batch reject, data+audit unchanged', () => {
    seed([mk({ id: 'x1' }), mk({ id: 'x2', instrumentName: 'Two', status: 'active' as any })]);
    expect(() => S().commitBatchHoldingDeletion(['x1', 'x2'], 'GLOBAL')).toThrowError(
      expect.objectContaining({ code: 'HOLDING_NOT_CLOSED' }),
    );
    expect(S().holdings).toHaveLength(2);
    expect(repo.holdingDeletionLogData).toHaveLength(0);
  });
});
