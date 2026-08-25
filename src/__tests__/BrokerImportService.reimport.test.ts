/**
 * WP-FB-IMPORT-BROKER-01 — Broker re-import / UPDATE defect regression tests.
 *
 * Exercises the post-fix behavior of `BrokerImportService.buildAtomicMutation`:
 * the UPDATED branch now preserves the existing's authoritative persisted
 * `hld-<uuid>` before calling `HoldingLifecycleService.planUpdate`, so a
 * re-parsed candidate (with a fresh uuid) is correctly matched to its
 * existing record by id.
 *
 * These tests complement the existing H.34-H.37 idempotency tests:
 *   - H.34-H.37 reuse the same `parsed` object across the import and
 *     re-import steps, so `entry.candidate.id === entry.existing.id`
 *     (the fix is a no-op for them).
 *   - This file re-PARSES the file each time, so the parser emits fresh
 *     uuids, reproducing the real-user re-upload flow.
 *
 * Authority: `WP-FB-IMPORT-BROKER-01-REIMPORT-DEFECT-ROOT-CAUSE-AND-AUTHORITY.md`
 * (implementation authority §8).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

import { BrokerImportService } from '../services/BrokerImportService';
import { repository } from '../repositories';

const SAMPLE_ZERODHA = '/home/user/uploads/Zerodha_holdings_10082026_1739.csv';

function loadText(path: string): string {
  return readFileSync(path, 'utf8');
}
function asTextInput(content: string, fileName: string) {
  return { kind: 'text', content, fileName } as const;
}

beforeEach(async () => {
  await repository.clearLocalData();
  await repository.initialize();
});

afterEach(async () => {
  await repository.clearLocalData();
});

describe('WP-FB-IMPORT-BROKER-01 — re-import / UPDATE defect regression', () => {
  it('REIMPORT.A: first import + re-parse + commit -> 82 holdings, all original ids preserved, no NOT_FOUND', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');

    // First parse + commit
    const parsed1 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed1, []);
    expect(preview1.counts.new).toBe(82);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    expect(repository.holdings.findAllSync()).toHaveLength(82);
    const firstIds = repository.holdings.findAllSync().map((h) => h.id).sort();

    // Re-parse: parser emits fresh uuids
    const parsed2 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview2 = BrokerImportService.reconcile(parsed2, repository.holdings.findAllSync());
    // Reconciliation matches by identity: 0 NEW (all 82 exist), UPDATED entries
    // (the parser produces a new importedAt timestamp and the values may
    // differ by parse precision), 0 UNCHANGED only if any field differs.
    expect(preview2.counts.new).toBe(0);
    expect(preview2.counts.closed_absent).toBe(0);
    expect(preview2.entries.every((e) => e.existing !== null && e.classification === 'UPDATED')).toBe(true);
    // Each entry has a distinct candidate.id from its existing.id (fresh uuid)
    const idMismatches = preview2.entries.filter((e) => e.candidate.id !== e.existing!.id).length;
    expect(idMismatches).toBe(82);

    // Commit the re-parse. Pre-fix, this throws NOT_FOUND.
    let commitError: string | null = null;
    try {
      const outcome2 = useCanonicalLedger.getState().commitImportedHoldings(preview2.entries.map((e) => e.candidate));
      if (outcome2.persisted) await outcome2.persisted;
    } catch (e: any) {
      commitError = (e && e.message) || String(e);
    }
    expect(commitError).toBeNull();

    // Post-commit: 82 holdings, every original id preserved
    const after = repository.holdings.findAllSync();
    expect(after).toHaveLength(82);
    const afterIds = after.map((h) => h.id).sort();
    expect(afterIds).toEqual(firstIds);
    // The set of ids is unchanged (no duplicates, no losses)
    expect(new Set(afterIds).size).toBe(82);
  });

  it('REIMPORT.B: reactivation via re-parse -> closed_absent existing + same identity in re-parse -> active, id preserved', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');

    // First: full import -> 82 active
    const parsed1 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed1, []);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    const firstIds = new Set(repository.holdings.findAllSync().map((h) => h.id));

    // Truncate the SAME parsed object (no re-parse) and commit -> 1 closed_absent.
    // (Reusing the parsed object keeps the same candidate ids, so the
    // closure's existing.id is one of the first-import ids.)
    const truncated = { ...parsed1, holdings: parsed1.holdings.slice(0, 81) };
    const preview2 = BrokerImportService.reconcile(truncated, repository.holdings.findAllSync());
    const outcome2 = useCanonicalLedger.getState().commitImportedHoldings(preview2.entries.map((e) => e.candidate));
    if (outcome2.persisted) await outcome2.persisted;
    const closedAfterTruncate = repository.holdings.findAllSync().filter((h) => h.status === 'closed_absent');
    expect(closedAfterTruncate).toHaveLength(1);
    const closedId = closedAfterTruncate[0].id;
    expect(firstIds.has(closedId)).toBe(true);

    // Re-parse the full file (re-parse, fresh uuids) and commit
    const parsed3 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview3 = BrokerImportService.reconcile(parsed3, repository.holdings.findAllSync());
    // The previously-closed one should appear as UPDATED with existing.status='closed_absent'
    const reactivating = preview3.entries.find((e) => e.existing?.status === 'closed_absent');
    expect(reactivating).toBeDefined();
    expect(reactivating!.classification).toBe('UPDATED');
    expect(reactivating!.candidate.id).not.toBe(reactivating!.existing!.id);
    // The reactivating's existing.id must be the previously-closed id
    expect(reactivating!.existing!.id).toBe(closedId);

    // Commit. Pre-fix, this throws NOT_FOUND.
    let commitError: string | null = null;
    try {
      const outcome3 = useCanonicalLedger.getState().commitImportedHoldings(preview3.entries.map((e) => e.candidate));
      if (outcome3.persisted) await outcome3.persisted;
    } catch (e: any) {
      commitError = (e && e.message) || String(e);
    }
    expect(commitError).toBeNull();

    // All 82 are now active
    const after = repository.holdings.findAllSync();
    expect(after).toHaveLength(82);
    const active = after.filter((h) => h.status === 'active');
    const closed = after.filter((h) => h.status === 'closed_absent');
    expect(active).toHaveLength(82);
    expect(closed).toHaveLength(0);

    // The previously-closed holding's id is preserved and now active
    const reactivatedHolding = after.find((h) => h.id === closedId);
    expect(reactivatedHolding).toBeDefined();
    expect(reactivatedHolding!.status).toBe('active');
  });

  it('REIMPORT.C: reduced re-parse with closure -> dropped row -> closed_absent with original id', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');

    // First: full import
    const parsed1 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed1, []);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    const firstIds = new Set(repository.holdings.findAllSync().map((h) => h.id));

    // Re-parse AND truncate: 82 fresh uuids, last source row dropped
    const parsed2 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const truncated = { ...parsed2, holdings: parsed2.holdings.slice(0, 81) };
    const preview2 = BrokerImportService.reconcile(truncated, repository.holdings.findAllSync());
    expect(preview2.closures).toHaveLength(1);
    // The closure's existing.id is one of the first-import's ids (the
    // reconcile step matched by identity and uses the store's existing).
    const closureExistingId = preview2.closures[0].existing.id;
    expect(firstIds.has(closureExistingId)).toBe(true);

    // Commit
    const outcome2 = useCanonicalLedger.getState().commitImportedHoldings(preview2.entries.map((e) => e.candidate));
    if (outcome2.persisted) await outcome2.persisted;

    // 82 holdings, 1 closed_absent with original id
    const after = repository.holdings.findAllSync();
    expect(after).toHaveLength(82);
    const closed = after.filter((h) => h.status === 'closed_absent');
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe(closureExistingId);
  });

  it('REIMPORT.D: re-parse with all-NEW (no existing) -> 82 NEW, fix is a no-op for the UPDATED loop', async () => {
    // Empty store, re-parse twice: both produce 82 NEW
    const parsed1 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed1, []);
    expect(preview1.counts.new).toBe(82);
    expect(preview1.counts.updated).toBe(0);

    // Re-parse with empty existing
    const parsed2 = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview2 = BrokerImportService.reconcile(parsed2, []);
    expect(preview2.counts.new).toBe(82);
    // (The fix touches only the UPDATED branch; the NEW branch uses
    // planCreate, which is unchanged. This test documents that the
    // all-NEW flow is not affected by the fix.)
  });
});
