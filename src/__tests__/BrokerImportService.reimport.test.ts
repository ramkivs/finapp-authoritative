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
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';

import { BrokerImportService } from '../services/BrokerImportService';
import { repository } from '../repositories';

const SAMPLE_ZERODHA = resolve(__dirname, 'fixtures/broker_samples/Zerodha_holdings_10082026_1739.csv');
const SAMPLE_ZERODHA_MF = resolve(__dirname, 'fixtures/broker_samples/Zerodha_mutual_funds_holdings.csv');
const SAMPLE_GROWW_STOCKS = resolve(__dirname, 'fixtures/broker_samples/Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx');
const SAMPLE_GROWW_MF = resolve(__dirname, 'fixtures/broker_samples/Groww_Mutual_Funds_6995348108_24-08-2026.xlsx');
const SAMPLE_DHAN_EQUITY = resolve(__dirname, 'fixtures/cr_broker_bank_import/dhan-equity-capstewengine.csv');
const SAMPLE_DHAN_MF_CSV = resolve(__dirname, 'fixtures/broker_samples/Dhan_MF_Report_23-08-2026.csv');
const SAMPLE_DHAN_MF_XLSX = resolve(__dirname, 'fixtures/broker_samples/Dhan_MF_Report_23-08-2026.xlsx');
const SAMPLE_ANGEL_ONE = resolve(__dirname, 'fixtures/cr_broker_bank_import/angel-one-stock-holdings.xlsx');

function loadText(path: string): string {
  return readFileSync(path, 'utf8');
}
function loadBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
function asTextInput(content: string, fileName: string) {
  return { kind: 'text', content, fileName } as const;
}
function asBinaryInput(content: Uint8Array, fileName: string) {
  return { kind: 'binary', content, fileName } as const;
}
function buildXlsxBytes(sheetName: string, aoa: string[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
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

describe('Batch 2 — Step 3: Multi-import lifecycle, scope/account isolation, and zero-row closures (DEF-01, DEF-02, DEF-09)', () => {
  const commitPreview = async (preview: ReturnType<typeof BrokerImportService.reconcile>) => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const outcome = useCanonicalLedger.getState().commitImportedHoldings({
      broker: preview.broker,
      account: preview.account,
      productScope: preview.productScope,
      sourceFile: preview.sourceFile,
      importedAt: preview.importedAt,
      holdings: preview.entries.map((e) => e.candidate),
    });
    if (outcome.persisted) await outcome.persisted;
    return outcome;
  };

  it('DEF-01.A: 3 consecutive imports where holdings progressively disappear -> no ALREADY_CLOSED, previously closed stay closed', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const lines = loadText(SAMPLE_ZERODHA).trim().split(/\r?\n/);
    const header = lines[0];
    const [rowA, rowB, rowC] = [lines[1], lines[2], lines[3]];

    // Import 1: [A, B, C] -> 3 active
    const p1 = BrokerImportService.detectAndParse(
      asTextInput([header, rowA, rowB, rowC].join('\n'), 'zerodha_1.csv'),
    );
    const pv1 = BrokerImportService.reconcile(p1, useCanonicalLedger.getState().holdings);
    expect(pv1.counts.new).toBe(3);
    await commitPreview(pv1);
    expect(useCanonicalLedger.getState().holdings.filter((h) => h.status === 'active')).toHaveLength(3);

    // Import 2: [A, B] -> C closes to closed_absent
    const p2 = BrokerImportService.detectAndParse(
      asTextInput([header, rowA, rowB].join('\n'), 'zerodha_2.csv'),
    );
    const pv2 = BrokerImportService.reconcile(p2, useCanonicalLedger.getState().holdings);
    expect(pv2.counts.closed_absent).toBe(1);
    await commitPreview(pv2);
    const cAfter2 = useCanonicalLedger.getState().holdings.find((h) => h.status === 'closed_absent')!;
    expect(cAfter2).toBeDefined();
    const cClosedAt = cAfter2.importedAt;

    // Import 3: [A] -> B closes; already-closed C is NOT in closures and causes no ALREADY_CLOSED
    const p3 = BrokerImportService.detectAndParse(
      asTextInput([header, rowA].join('\n'), 'zerodha_3.csv'),
    );
    const pv3 = BrokerImportService.reconcile(p3, useCanonicalLedger.getState().holdings);
    expect(pv3.counts.closed_absent).toBe(1);
    expect(pv3.closures.some((cl) => cl.existing.id === cAfter2.id)).toBe(false);
    await expect(commitPreview(pv3)).resolves.toBeDefined();

    const finalHoldings = useCanonicalLedger.getState().holdings;
    expect(finalHoldings).toHaveLength(3);
    expect(finalHoldings.filter((h) => h.status === 'active')).toHaveLength(1);
    expect(finalHoldings.filter((h) => h.status === 'closed_absent')).toHaveLength(2);
    expect(finalHoldings.find((h) => h.id === cAfter2.id)!.importedAt).toBe(cClosedAt);
  });

  it('DEF-01.B: manual F2-A closure followed by re-import while absent, then reappearance reactivates cleanly', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const lines = loadText(SAMPLE_ZERODHA).trim().split(/\r?\n/);
    const header = lines[0];
    const [rowA, rowB, rowC] = [lines[1], lines[2], lines[3]];

    // Import 1: [A, B, C]
    const pv1 = BrokerImportService.reconcile(
      BrokerImportService.detectAndParse(asTextInput([header, rowA, rowB, rowC].join('\n'), 'z1.csv')),
      [],
    );
    await commitPreview(pv1);
    const targetB = useCanonicalLedger.getState().holdings[1];

    // Manual F2-A user close on B
    const closeOutcome = useCanonicalLedger.getState().commitUserCloses([targetB.id]);
    if (closeOutcome.persisted) await closeOutcome.persisted;
    expect(useCanonicalLedger.getState().holdings.find((h) => h.id === targetB.id)!.status).toBe('closed_absent');

    // Re-import [A, C] while B remains absent -> B must NOT be re-closed or throw ALREADY_CLOSED
    const pv2 = BrokerImportService.reconcile(
      BrokerImportService.detectAndParse(asTextInput([header, rowA, rowC].join('\n'), 'z2.csv')),
      useCanonicalLedger.getState().holdings,
    );
    expect(pv2.closures).toHaveLength(0);
    await expect(commitPreview(pv2)).resolves.toBeDefined();
    expect(useCanonicalLedger.getState().holdings.find((h) => h.id === targetB.id)!.status).toBe('closed_absent');

    // Re-import [A, B, C] where B reappears -> reactivated to active with original id preserved
    const pv3 = BrokerImportService.reconcile(
      BrokerImportService.detectAndParse(asTextInput([header, rowA, rowB, rowC].join('\n'), 'z3.csv')),
      useCanonicalLedger.getState().holdings,
    );
    const reactivatedEntry = pv3.entries.find((e) => e.existing?.id === targetB.id);
    expect(reactivatedEntry?.classification).toBe('UPDATED');
    await commitPreview(pv3);
    const bFinal = useCanonicalLedger.getState().holdings.find((h) => h.id === targetB.id)!;
    expect(bFinal.status).toBe('active');
    expect(useCanonicalLedger.getState().holdings.filter((h) => h.status === 'active')).toHaveLength(3);
  });

  it('DEF-02.A: Equity followed by MF (and MF followed by Equity) never cross-closes for Zerodha, Groww, or Dhan', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');

    // 1. Zerodha Equity (82) <-> Zerodha MF (2), both account=undefined
    const zEq = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'Zerodha_holdings.csv'));
    expect(zEq.productScope).toBe('EQUITY');
    await commitPreview(BrokerImportService.reconcile(zEq, useCanonicalLedger.getState().holdings));

    const zMf = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA_MF), 'Zerodha_mutual_funds_holdings.csv'));
    expect(zMf.productScope).toBe('MUTUAL_FUND');
    const zMfPreview = BrokerImportService.reconcile(zMf, useCanonicalLedger.getState().holdings);
    expect(zMfPreview.closures).toHaveLength(0);
    await commitPreview(zMfPreview);

    const zEqRe = BrokerImportService.reconcile(
      BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'Zerodha_holdings_v2.csv')),
      useCanonicalLedger.getState().holdings,
    );
    expect(zEqRe.closures).toHaveLength(0);
    await commitPreview(zEqRe);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Zerodha' && h.status === 'active'),
    ).toHaveLength(zEq.holdings.length + zMf.holdings.length);

    // 2. Groww Stocks <-> Groww MF (even when sharing the exact same account identifier)
    const gStocks = BrokerImportService.detectAndParse(
      asBinaryInput(loadBytes(SAMPLE_GROWW_STOCKS), 'Groww_Stocks.xlsx'),
    );
    expect(gStocks.productScope).toBe('EQUITY');
    await commitPreview(BrokerImportService.reconcile(gStocks, useCanonicalLedger.getState().holdings));

    const gMfParsed = BrokerImportService.detectAndParse(
      asBinaryInput(loadBytes(SAMPLE_GROWW_MF), 'Groww_MF.xlsx'),
    );
    expect(gMfParsed.productScope).toBe('MUTUAL_FUND');
    // Force same account as Groww Stocks to prove productScope isolation independently of account
    const gMfSameAccount = {
      ...gMfParsed,
      account: gStocks.account,
      holdings: gMfParsed.holdings.map((h) => ({ ...h, account: gStocks.account })),
    };
    const gMfPreview = BrokerImportService.reconcile(gMfSameAccount, useCanonicalLedger.getState().holdings);
    expect(gMfPreview.closures).toHaveLength(0);
    await commitPreview(gMfPreview);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Groww' && h.status === 'active'),
    ).toHaveLength(gStocks.holdings.length + gMfParsed.holdings.length);

    // 3. Dhan Equity (account=undefined) <-> Dhan MF (both with UCC and with account=undefined)
    const dEq = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_EQUITY), 'dhan_eq.csv'));
    expect(dEq.productScope).toBe('EQUITY');
    await commitPreview(BrokerImportService.reconcile(dEq, useCanonicalLedger.getState().holdings));

    const dMfNoUccCsv = loadText(SAMPLE_DHAN_MF_CSV)
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('UCC,'))
      .join('\r\n');
    const dMfNoUcc = BrokerImportService.detectAndParse(asTextInput(dMfNoUccCsv, 'dhan_mf_noucc.csv'));
    expect(dMfNoUcc.account).toBeUndefined();
    expect(dMfNoUcc.productScope).toBe('MUTUAL_FUND');
    const dMfPreview = BrokerImportService.reconcile(dMfNoUcc, useCanonicalLedger.getState().holdings);
    expect(dMfPreview.closures).toHaveLength(0);
    await commitPreview(dMfPreview);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Dhan' && h.status === 'active'),
    ).toHaveLength(dEq.holdings.length + dMfNoUcc.holdings.length);
  });

  it('DEF-02.B: separate UCC/account imports never close another account holdings', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');

    const dMfUccA = BrokerImportService.detectAndParse(
      asTextInput(loadText(SAMPLE_DHAN_MF_CSV), 'dhan_mf_uccA.csv'),
    );
    expect(dMfUccA.account).toBe('SYNTHUCC01');
    await commitPreview(BrokerImportService.reconcile(dMfUccA, useCanonicalLedger.getState().holdings));

    const uccBCsv = loadText(SAMPLE_DHAN_MF_CSV).replace('UCC,SYNTHUCC01', 'UCC,SYNTHUCC02');
    const dMfUccB = BrokerImportService.detectAndParse(asTextInput(uccBCsv, 'dhan_mf_uccB.csv'));
    expect(dMfUccB.account).toBe('SYNTHUCC02');
    const pvB = BrokerImportService.reconcile(dMfUccB, useCanonicalLedger.getState().holdings);
    expect(pvB.closures).toHaveLength(0);
    expect(pvB.counts.new).toBe(6);
    await commitPreview(pvB);

    // Partial exit inside SYNTHUCC02 closes ONLY missing holdings in SYNTHUCC02; SYNTHUCC01 stays 6 active
    const uccBTruncated = { ...dMfUccB, holdings: dMfUccB.holdings.slice(0, 4), sourceFile: 'dhan_mf_uccB_2.csv' };
    const pvB2 = BrokerImportService.reconcile(uccBTruncated, useCanonicalLedger.getState().holdings);
    expect(pvB2.closures).toHaveLength(2);
    expect(pvB2.closures.every((c) => c.existing.account === 'SYNTHUCC02')).toBe(true);
    await commitPreview(pvB2);

    const all = useCanonicalLedger.getState().holdings;
    expect(all.filter((h) => h.account === 'SYNTHUCC01' && h.status === 'active')).toHaveLength(6);
    expect(all.filter((h) => h.account === 'SYNTHUCC02' && h.status === 'active')).toHaveLength(4);
    expect(all.filter((h) => h.account === 'SYNTHUCC02' && h.status === 'closed_absent')).toHaveLength(2);
  });

  it('DEF-09: valid header-only zero-row exports preserve (broker, account, productScope) and close matching active holdings only', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');

    // Seed Zerodha Equity (2) + Zerodha MF (2) + Groww Stocks UCC 6995348108 + Groww MF + Dhan MF SYNTHUCC01 + Angel One
    const zEqLines = loadText(SAMPLE_ZERODHA).trim().split(/\r?\n/);
    await commitPreview(
      BrokerImportService.reconcile(
        BrokerImportService.detectAndParse(asTextInput([zEqLines[0], zEqLines[1], zEqLines[2]].join('\n'), 'Zerodha_holdings.csv')),
        useCanonicalLedger.getState().holdings,
      ),
    );
    await commitPreview(
      BrokerImportService.reconcile(
        BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA_MF), 'Zerodha_mutual_funds_holdings.csv')),
        useCanonicalLedger.getState().holdings,
      ),
    );
    const gStocks = BrokerImportService.detectAndParse(asBinaryInput(loadBytes(SAMPLE_GROWW_STOCKS), 'Groww_Stocks.xlsx'));
    await commitPreview(BrokerImportService.reconcile(gStocks, useCanonicalLedger.getState().holdings));
    const gMf = BrokerImportService.detectAndParse(asBinaryInput(loadBytes(SAMPLE_GROWW_MF), 'Groww_MF.xlsx'));
    await commitPreview(BrokerImportService.reconcile(gMf, useCanonicalLedger.getState().holdings));
    const dMf = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_MF_CSV), 'Dhan_MF.csv'));
    await commitPreview(BrokerImportService.reconcile(dMf, useCanonicalLedger.getState().holdings));
    const angel = BrokerImportService.detectAndParse(asBinaryInput(loadBytes(SAMPLE_ANGEL_ONE), 'angel.xlsx'));
    await commitPreview(BrokerImportService.reconcile(angel, useCanonicalLedger.getState().holdings));

    // 1. Header-only Zerodha Equity CSV closes ONLY Zerodha Equity (2); Zerodha MF (2) stays active
    const zEqEmpty = BrokerImportService.detectAndParse(asTextInput(zEqLines[0] + '\n', 'Zerodha_holdings_empty.csv'));
    expect(zEqEmpty.holdings).toEqual([]);
    expect(zEqEmpty.productScope).toBe('EQUITY');
    const pvZEqEmpty = BrokerImportService.reconcile(zEqEmpty, useCanonicalLedger.getState().holdings);
    expect(pvZEqEmpty.confirmationEligible).toBe(true);
    expect(pvZEqEmpty.closures).toHaveLength(2);
    await commitPreview(pvZEqEmpty);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Zerodha' && h.productScope === 'EQUITY' && h.status === 'closed_absent'),
    ).toHaveLength(2);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Zerodha' && h.productScope === 'MUTUAL_FUND' && h.status === 'active'),
    ).toHaveLength(zEqLines.length > 0 ? 2 : 0);

    // 2. Header-only Groww Stocks XLSX closes ONLY Groww Stocks for UCC 6995348108; Groww MF stays active
    const emptyGrowwStocksBytes = buildXlsxBytes('Holdings', [
      ['Unique Client Code', '6995348108'],
      ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', 'Unrealised P&L'],
    ]);
    const gStocksEmpty = BrokerImportService.detectAndParse(asBinaryInput(emptyGrowwStocksBytes, 'Groww_Stocks_Empty.xlsx'));
    expect(gStocksEmpty.account).toBe('6995348108');
    expect(gStocksEmpty.productScope).toBe('EQUITY');
    const pvGStocksEmpty = BrokerImportService.reconcile(gStocksEmpty, useCanonicalLedger.getState().holdings);
    expect(pvGStocksEmpty.confirmationEligible).toBe(true);
    expect(pvGStocksEmpty.closures).toHaveLength(gStocks.holdings.length);
    await commitPreview(pvGStocksEmpty);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Groww' && h.productScope === 'EQUITY' && h.status === 'closed_absent'),
    ).toHaveLength(gStocks.holdings.length);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Groww' && h.productScope === 'MUTUAL_FUND' && h.status === 'active'),
    ).toHaveLength(gMf.holdings.length);

    // 3. Header-only Dhan MF XLSX with UCC SYNTHUCC01 closes all 6 Dhan MF holdings under SYNTHUCC01
    const emptyDhanMfBytes = buildXlsxBytes('MF Holdings', [
      ['MF Holdings | For 25-08-2026', '', '', '', '', '', 'Name', 'Synthetic User', ''],
      ['', '', '', '', '', '', 'UCC', 'SYNTHUCC01', ''],
      ['Scheme Name', 'MF Type', 'Units', 'NAV', 'Investment', 'Current Value', 'P&L', 'P&L%', 'XIRR %'],
    ]);
    const dMfEmpty = BrokerImportService.detectAndParse(asBinaryInput(emptyDhanMfBytes, 'Dhan_MF_Empty.xlsx'));
    expect(dMfEmpty.account).toBe('SYNTHUCC01');
    expect(dMfEmpty.productScope).toBe('MUTUAL_FUND');
    const pvDMfEmpty = BrokerImportService.reconcile(dMfEmpty, useCanonicalLedger.getState().holdings);
    expect(pvDMfEmpty.confirmationEligible).toBe(true);
    expect(pvDMfEmpty.closures).toHaveLength(6);
    await commitPreview(pvDMfEmpty);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Dhan' && h.account === 'SYNTHUCC01' && h.status === 'closed_absent'),
    ).toHaveLength(6);

    // 4. Header-only Angel One XLSX closes all 6 Angel One holdings
    const emptyAngelBytes = buildXlsxBytes('Portfolio', [
      ['Holding Details'],
      [
        'Scrip/Contract', 'Company Name', 'ISIN', 'MarketCap', 'Sector',
        'Quantity', 'Blocked_qty', 'Avg Trading Price', 'Prev closing Price',
        'Invested Value', 'Market Value as of last trading day',
        'Overall Gain/Loss', 'Realised Gain/Loss', 'Holding Weightage',
        'ARQ Prime Quantity',
      ],
    ]);
    const angelEmpty = BrokerImportService.detectAndParse(asBinaryInput(emptyAngelBytes, 'Angel_Empty.xlsx'));
    expect(angelEmpty.productScope).toBe('EQUITY');
    const pvAngelEmpty = BrokerImportService.reconcile(angelEmpty, useCanonicalLedger.getState().holdings);
    expect(pvAngelEmpty.confirmationEligible).toBe(true);
    expect(pvAngelEmpty.closures).toHaveLength(angel.holdings.length);
    await commitPreview(pvAngelEmpty);
    expect(
      useCanonicalLedger.getState().holdings.filter((h) => h.broker === 'Angel One' && h.status === 'closed_absent'),
    ).toHaveLength(angel.holdings.length);
  });
});
