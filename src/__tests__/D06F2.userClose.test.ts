/**
 * D-06-F2-A store/service acceptance — the user-initiated close pathway.
 * Authority: FINBOOM-D-06-F2-IMPLEMENTATION-AUTHORITY-REPORT.md (§3 MUST
 * list, §7 safety, AC-F2-01…09/11/12). Hermetic: real store + real
 * repository + the UNMODIFIED promoted lifecycle planner; NO mocks; no
 * /home/user/uploads dependency. The close action is the ONLY new code —
 * these tests also pin that the promoted deletion engine is untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { Holding, HoldingDeletionLogEntry } from '../domain/types';
import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const mk = (o: Partial<Holding>): Holding => ({
  id: o.id!,
  broker: o.broker ?? 'Zerodha',
  account: o.account,
  instrumentName: o.instrumentName ?? o.id!,
  isin: 'INE000000000',
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  status: 'active',
  sourceFile: 'seed.csv',
  importedAt: '2026-08-23T10:00:00.000Z',
  ...o,
} as Holding);

const sync = () =>
  S().syncWithRepository({
    transactions: [], assets: [], liabilities: [], holdings: repo.holdingsData,
    snapshots: [], accounts: [], budgets: [], policies: [], goals: [], profile: null,
  });
const seed = (holdings: Holding[]) => {
  repo.holdingsData = holdings.map((h) => ({ ...h }));
  repo.holdingDeletionLogData = [];
  sync();
};
const row = (id: string): Holding => repo.holdingsData.find((h: Holding) => h.id === id);
const log = (): HoldingDeletionLogEntry[] => repo.holdingDeletionLogData;

const close = (ids: string[]) => S().commitUserCloses(ids);

describe('D06F2 — commitUserCloses on the promoted lifecycle machinery', () => {
  beforeEach(() => {
    seed([]);
  });

  it('F1: valid batch flips active→closed_absent atomically, stamps importedAt, PRESERVES all other fields, writes no audit', () => {
    seed([
      mk({ id: 'a1', broker: 'Zerodha' }),
      mk({ id: 'a2', broker: 'Dhan', account: 'DA1', instrumentName: 'Two', currentValue: 500 }),
      mk({ id: 'x1', broker: 'ICICI', instrumentName: 'Three', status: 'closed_absent' }),
    ]);
    const before = new Date().toISOString();
    const { closedIds, closedAt, persisted } = close(['a1', 'a2']);
    expect(closedIds).toEqual(['a1', 'a2']);
    expect(closedAt >= before).toBe(true);
    expect(typeof persisted?.then).toBe('function');
    const a1 = row('a1');
    expect(a1.status).toBe('closed_absent');
    expect(a1.importedAt).toBe(closedAt);
    // planClose's field-preserving spread: everything else verbatim.
    expect(a1.broker).toBe('Zerodha');
    expect(a1.currentValue).toBe(1100);
    expect(a1.quantity).toBe(10);
    expect(row('x1').status).toBe('closed_absent'); // untouched
    // Product decision C: NO close audit, NO deletion audit side effect.
    expect(log()).toHaveLength(0);
  });

  it('F2: vanished id rejects the WHOLE batch — NOT_FOUND thrown before any mutation, data unchanged', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' })]);
    const snapshot = JSON.stringify(repo.holdingsData);
    expect(() => close(['a1', 'ghost'])).toThrow(/ghost/);
    expect(JSON.stringify(repo.holdingsData)).toBe(snapshot);
    expect(row('a1').status).toBe('active'); // no partial close
  });

  it('F3: already-closed row in the batch rejects EVERYTHING (ALREADY_CLOSED) — no partial close', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'c1', instrumentName: 'Two', status: 'closed_absent' })]);
    const snapshot = JSON.stringify(repo.holdingsData);
    expect(() => close(['a1', 'c1'])).toThrow(/already closed_absent/);
    expect(row('a1').status).toBe('active');
    expect(JSON.stringify(repo.holdingsData)).toBe(snapshot);
  });

  it('F4: empty ids rejected (INVALID_ID — no whole-ledger/no-op path); duplicate ids rejected via ALREADY_CLOSED; no write either way', () => {
    seed([mk({ id: 'a1' })]);
    const snapshot = JSON.stringify(repo.holdingsData);
    let code = '';
    try {
      close([]);
    } catch (e: any) {
      code = e.code;
    }
    expect(code).toBe('INVALID_ID');
    expect(() => close([])).toThrow(/no whole-ledger|no-op/);
    expect(() => close(['a1', 'a1'])).toThrow(/already closed_absent/);
    expect(row('a1').status).toBe('active');
    expect(JSON.stringify(repo.holdingsData)).toBe(snapshot);
    expect(log()).toHaveLength(0);
  });

  it('F5: whitespace-only id rejected by the promoted MISSING_ID guard; batch untouched', () => {
    seed([mk({ id: 'a1' })]);
    expect(() => close(['  '])).toThrow(/at least one|non-empty|id/);
    expect(row('a1').status).toBe('active');
  });

  it('F6: repository object gains NO new stores/keys and no close records — persistence surface unchanged', () => {
    seed([mk({ id: 'a1' })]);
    const keysBefore = Object.keys(repo).sort().join(',');
    close(['a1']);
    expect(Object.keys(repo).sort().join(',')).toBe(keysBefore);
    expect(log()).toHaveLength(0);
    expect(row('a1').status).toBe('closed_absent');
  });

  it('F7: ratified re-import lifecycle INTACT (no tombstone/suppression): closed-but-reported row reactivates; deleted identity returns as NEW', async () => {
    // (i) user-close, then a broker file that STILL reports the identity:
    seed([mk({ id: 'a1', broker: 'Zerodha', instrumentName: 'REL', account: undefined })]);
    close(['a1']);
    expect(row('a1').status).toBe('closed_absent');
    const reactivating = mk({ id: 'a1-fresh', broker: 'Zerodha', instrumentName: 'REL', currentPrice: 120, currentValue: 1200, status: 'active' });
    // The promoted commit path classifies by identity (broker, account,
    // instrument): same identity as an existing row → UPDATED against it.
    const outcome = S().commitImportedHoldings([reactivating]);
    expect(outcome.divergentDuplicates).toBe(1);
    expect(outcome.appended).toBe(0);
    // planUpdate REPLACES the record → the row is active again, same id survives.
    expect(row('a1').status).toBe('active');
    expect(row('a1-fresh')).toBeUndefined();
    // (ii) close → permanently delete via the UNMODIFIED engine → later import:
    close(['a1']);
    const del = S().commitBatchHoldingDeletion(['a1'], 'GLOBAL');
    expect(row('a1')).toBeUndefined();
    const second = mk({ id: 'a1-new', broker: 'Zerodha', instrumentName: 'REL', status: 'active' });
    const outcome2 = S().commitImportedHoldings([second]);
    expect(outcome2.appended).toBe(1); // classified NEW — ratified behaviour, no suppression exists
    expect(row('a1-new').status).toBe('active');
    if (del.persisted) await Promise.resolve(del.persisted).catch(() => {});
    if (outcome.persisted) await Promise.resolve(outcome.persisted).catch(() => {});
    if (outcome2.persisted) await Promise.resolve(outcome2.persisted).catch(() => {});
  });

  it('F8: deletion engine remains unchanged and closed_absent-only — active rows REJECTED, user-closed rows deletable with full audit', () => {
    seed([mk({ id: 'a1' }), mk({ id: 'a2', instrumentName: 'Two' })]);
    // Active rows remain non-deletable (ratified guard, unchanged):
    expect(() => S().commitBatchHoldingDeletion(['a1'], 'GLOBAL')).toThrow(/not closed_absent|HOLDING_NOT_CLOSED/);
    // After the user close, the SAME row becomes eligible to the existing engine:
    close(['a1']);
    const out = S().commitBatchHoldingDeletion(['a1'], 'GLOBAL');
    expect(row('a1')).toBeUndefined();
    expect(log()).toHaveLength(1);
    expect(log()[0].batchScope).toBe('GLOBAL');
    expect(log()[0].batchId.startsWith('hdlb-')).toBe(true);
    // Deletion audit semantics unchanged; close itself left NO record.
    expect(row('a2').status).toBe('active');
  });
});
