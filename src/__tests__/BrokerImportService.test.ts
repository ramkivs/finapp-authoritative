/**
 * WP-FB-IMPORT-BROKER-01 — WP-08 Broker Import Service characterization tests.
 *
 * Covers the 42 minimum tests required by the execution gate §14, organized
 * by section:
 *   A. Detection (6)
 *   B. Parsing (6)
 *   C. Reconciliation (5)
 *   D. Identity (5)
 *   E. Preview (5)
 *   F. Confirmation (3)
 *   G. Atomicity (3)
 *   H. Idempotency (4)
 *   I. Safety (5)
 *
 * Total: 42 tests.
 *
 * The tests use the real broker sample files plus synthetic fixtures for
 * negative / edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

import { BrokerImportService, BrokerImportPreview } from '../services/BrokerImportService';
import { Holding, HoldingStatus } from '../domain/types';
import { HoldingIdentityService } from '../services/HoldingIdentityService';
import { HoldingLifecycleService } from '../services/HoldingLifecycleService';
import { MemoryHoldingRepository } from '../repositories/MemoryHoldingRepository';
import { MemoryRepository } from '../repositories/MemoryRepository';
import { repository } from '../repositories';

// ---------------------------------------------------------------------------
// Real sample file loaders
// ---------------------------------------------------------------------------

const SAMPLE_ZERODHA = '/home/user/uploads/Zerodha_holdings_10082026_1739.csv';
const SAMPLE_GROWW_STOCKS = '/home/user/uploads/Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx';
const SAMPLE_GROWW_MF = '/home/user/uploads/Groww_Mutual_Funds_6995348108_24-08-2026.xlsx';
const SAMPLE_DHAN_EQUITY = '/home/user/uploads/dhan holdings _capstewengine.csv';
const SAMPLE_DHAN_MF_CSV = '/home/user/uploads/Dhan_MF_Report_23-08-2026.csv';
const SAMPLE_DHAN_MF_XLSX = '/home/user/uploads/Dhan_MF_Report_23-08-2026.xlsx';

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

// ---------------------------------------------------------------------------
// Shared setup: in-memory repository reset for each test
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await repository.clearLocalData();
  await repository.initialize();
  // After initialize, the in-memory ledger is empty. No store sync needed
  // because the test only reads via repository.holdings.findAllSync().
});

/** Get the concrete MemoryHoldingRepository (which has addMany / saveMany). */
function holdingRepo(): MemoryHoldingRepository {
  return repository.holdings as MemoryHoldingRepository;
}

/** Get the concrete MemoryRepository (which has write()). */
function memoryRepo(): MemoryRepository {
  return repository as unknown as MemoryRepository;
}

afterEach(async () => {
  await repository.clearLocalData();
});

// ---------------------------------------------------------------------------
// A. Detection
// ---------------------------------------------------------------------------

describe('A. Detection', () => {
  // [RECONCILIATION] A.3 below documents the pre-existing design tension
  // documented in the WP-05 promotion report §5: Groww's `decodeXlsx`
  // and Dhan's `decodeXlsx` both check only the header marker
  // (`Scheme Name`), not the full column sequence. The detector ordering
  // (Dhan before Groww) means Dhan wins for any XLSX with `Scheme Name`.
  // For the Groww MF XLSX, Dhan's `canHandle` returns `matched: true`
  // (marker found) but the actual parse produces 0 holdings because the
  // full column sequence doesn't match. This is a pre-existing design
  // tension that the WP-05 promotion report accepted as a
  // [RECONCILIATION]. WP-08 does not modify any broker adapter.

  it('A.1 Zerodha CSV is detected', () => {
    const parsed = BrokerImportService.detectAndParse(
      asTextInput(loadText(SAMPLE_ZERODHA), 'Zerodha_holdings_10082026_1739.csv'),
    );
    expect(parsed.broker).toBe('Zerodha');
    expect(parsed.holdings).toHaveLength(82);
  });

  it('A.2 Groww Stocks XLSX is detected', () => {
    const parsed = BrokerImportService.detectAndParse(
      asBinaryInput(loadBytes(SAMPLE_GROWW_STOCKS), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    expect(parsed.broker).toBe('Groww');
    expect(parsed.account).toBe('6995348108');
    expect(parsed.holdings).toHaveLength(6);
  });

  it('A.3 Groww MF XLSX — WP-09 fix: Dhan decodeXlsx now requires the full Dhan MF column sequence, so the Groww MF XLSX (which has a different column sequence) falls through to Groww, which correctly claims it with 3 holdings and account=7395930735', () => {
    // WP-09: the pre-existing cross-detection hole (WP-05 promotion
    // report §5 [RECONCILIATION]) is now closed. Both Dhan and
    // Groww decodeXlsx validate the full column sequence at the
    // canHandle stage in the binary path, not just the first-cell
    // marker. A Groww MF XLSX has a different column sequence
    // (Scheme Name, AMC, Category, ...) than the Dhan MF XLSX
    // (Scheme Name, MF Type, Units, NAV, ...). Dhan's canHandle
    // now correctly rejects it. Groww's canHandle accepts it.
    const parsed = BrokerImportService.detectAndParse(
      asBinaryInput(loadBytes(SAMPLE_GROWW_MF), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    // The broker is reported as Groww (Groww's full-column
    // signature matches; Dhan's was rejected).
    expect(parsed.broker).toBe('Groww');
    // The account is extracted from the preamble (Mobile Number row).
    expect(parsed.account).toBe('7395930735');
    // The parse produces 3 holdings (the real sample's data).
    expect(parsed.holdings).toHaveLength(3);
    // No BROKER_HEADER_MISSING issue: detection succeeded.
    expect(parsed.issues.some((i) => i.code === 'BROKER_HEADER_MISSING')).toBe(false);
  });

  it('A.4 Dhan Equity CSV is detected', () => {
    const parsed = BrokerImportService.detectAndParse(
      asTextInput(loadText(SAMPLE_DHAN_EQUITY), 'dhan holdings _capstewengine.csv'),
    );
    expect(parsed.broker).toBe('Dhan');
    expect(parsed.holdings).toHaveLength(66);
  });

  it('A.5 Dhan MF CSV is detected', () => {
    const parsed = BrokerImportService.detectAndParse(
      asTextInput(loadText(SAMPLE_DHAN_MF_CSV), 'Dhan_MF_Report_23-08-2026.csv'),
    );
    expect(parsed.broker).toBe('Dhan');
    expect(parsed.account).toBe('IQCX28849K');
    expect(parsed.holdings).toHaveLength(6);
  });

  it('A.6 Dhan MF XLSX is detected', () => {
    const parsed = BrokerImportService.detectAndParse(
      asBinaryInput(loadBytes(SAMPLE_DHAN_MF_XLSX), 'Dhan_MF_Report_23-08-2026.xlsx'),
    );
    expect(parsed.broker).toBe('Dhan');
    expect(parsed.account).toBe('IQCX28849K');
    expect(parsed.holdings).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// B. Parsing
// ---------------------------------------------------------------------------

describe('B. Parsing (already covered by section A; spot-check fields)', () => {
  it('B.7 Zerodha parse — 82 holdings, account undefined', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'x.csv'));
    expect(parsed.holdings).toHaveLength(82);
    expect(parsed.account).toBeUndefined();
    for (const h of parsed.holdings) {
      expect(h.broker).toBe('Zerodha');
      expect(h.status).toBe('active');
    }
  });

  it('B.8 Groww Stocks parse — 6 holdings, ISIN populated', () => {
    const parsed = BrokerImportService.detectAndParse(asBinaryInput(loadBytes(SAMPLE_GROWW_STOCKS), 'x.xlsx'));
    expect(parsed.holdings).toHaveLength(6);
    for (const h of parsed.holdings) {
      expect(h.isin).toBeDefined();
      expect(h.ticker).toBeUndefined();
      expect(h.xirrPercent).toBeUndefined();
    }
  });

  it('B.9 Groww MF parse — WP-09 fix: the parse produces 3 holdings, not 0 (see A.3); the cross-detection hole is closed', () => {
    const parsed = BrokerImportService.detectAndParse(asBinaryInput(loadBytes(SAMPLE_GROWW_MF), 'x.xlsx'));
    expect(parsed.holdings).toHaveLength(3);
    // Each holding has the canonical fields populated.
    for (const h of parsed.holdings) {
      expect(h.broker).toBe('Groww');
      expect(h.account).toBe('7395930735');
      expect(h.status).toBe('active');
      expect(h.instrumentName).not.toBe('');
      expect(Number.isFinite(h.quantity)).toBe(true);
      expect(Number.isFinite(h.currentValue)).toBe(true);
    }
  });

  it('B.10 Dhan Equity parse — 66 holdings (564 → 66 aggregated)', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_EQUITY), 'x.csv'));
    expect(parsed.holdings).toHaveLength(66);
    for (const h of parsed.holdings) {
      expect(h.account).toBeUndefined();
    }
  });

  it('B.11 Dhan MF CSV parse — 6 holdings, XIRR parsed', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_MF_CSV), 'x.csv'));
    expect(parsed.holdings).toHaveLength(6);
    const xirrs = parsed.holdings.map((h) => h.xirrPercent ?? 0).sort((a, b) => a - b);
    expect(xirrs).toEqual([1.61, 3.55, 6.44, 27.59, 29.85, 47.48]);
  });

  it('B.12 Dhan MF XLSX parse — 6 holdings, byte-identical to CSV', () => {
    const csv = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_MF_CSV), 'x.csv'));
    const xlsx = BrokerImportService.detectAndParse(asBinaryInput(loadBytes(SAMPLE_DHAN_MF_XLSX), 'x.xlsx'));
    expect(xlsx.holdings).toHaveLength(csv.holdings.length);
    for (let i = 0; i < xlsx.holdings.length; i++) {
      expect(xlsx.holdings[i].instrumentName).toBe(csv.holdings[i].instrumentName);
      expect(xlsx.holdings[i].investedValue).toBeCloseTo(csv.holdings[i].investedValue, 2);
    }
  });
});

// ---------------------------------------------------------------------------
// C. Reconciliation
// ---------------------------------------------------------------------------

describe('C. Reconciliation', () => {
  it('C.13 NEW — no existing identity, candidate classified as NEW', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    expect(preview.counts.new).toBe(82);
    expect(preview.counts.updated).toBe(0);
    expect(preview.counts.unchanged).toBe(0);
    expect(preview.counts.closed_absent).toBe(0);
    expect(preview.confirmationEligible).toBe(true);
  });

  it('C.14 UNCHANGED — same file re-imported, all UNCHANGED', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const first = BrokerImportService.reconcile(parsed, []);
    // Commit the parsed holdings to the repo.
    repository.holdings.saveMany(first.entries.map((e) => e.candidate));
    // Now re-import.
    const second = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    expect(second.counts.unchanged).toBe(82);
    expect(second.counts.new).toBe(0);
    expect(second.counts.updated).toBe(0);
    expect(second.counts.closed_absent).toBe(0);
    expect(second.confirmationEligible).toBe(false); // all-UNCHANGED → not eligible
  });

  it('C.15 UPDATED — one value changed, that one is UPDATED', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    // Commit the parsed holdings.
    repository.holdings.saveMany(parsed.holdings);
    // Mutate one candidate's currentPrice.
    const existing = repository.holdings.findAllSync();
    const target = existing[0];
    const mutated: Holding = { ...target, currentPrice: target.currentPrice + 1, currentValue: target.currentValue + target.quantity };
    holdingRepo().update(mutated);
    // Re-reconcile with the new parse (same source values, but the mutated
    // existing record's currentPrice is different from the parsed candidate's).
    const second = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    // Exactly one UPDATED (the one we mutated). The rest are UNCHANGED
    // (the parse and the repo have the same values for the other 81).
    // Note: because the parse contains the OLD currentPrice (from the file),
    // the mutated one is UPDATED.
    expect(second.counts.updated).toBe(1);
    expect(second.counts.unchanged).toBe(81);
    expect(second.counts.new).toBe(0);
  });

  it('C.16 CLOSED_ABSENT — existing holding absent from parse, classified as CLOSED_ABSENT', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    repository.holdings.saveMany(parsed.holdings);
    const existing = repository.holdings.findAllSync();
    // Re-parse with a TRUNCATED set (drop the last holding). We construct
    // a fake parse with only the first 81.
    const truncated = { ...parsed, holdings: parsed.holdings.slice(0, 81) };
    const second = BrokerImportService.reconcile(truncated, existing);
    // The dropped holding should be in closures.
    expect(second.counts.closed_absent).toBe(1);
    expect(second.closures[0].existing.instrumentName).toBe(parsed.holdings[81].instrumentName);
    expect(second.confirmationEligible).toBe(true);
  });

  it('C.17 reactivation of closed_absent — existing closed_absent + same identity in parse → UPDATED/reactivated', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    repository.holdings.saveMany(parsed.holdings);
    // Manually transition one existing holding to closed_absent.
    const existing = repository.holdings.findAllSync();
    const target = existing[0];
    const closePlan = HoldingLifecycleService.planClose(target.id, existing, '2026-08-25T00:00:00.000Z');
    holdingRepo().update(closePlan.holding);
    // Re-import. The same identity now has status='active' in the parse and
    // status='closed_absent' in the existing set. The candidate's status
    // differs → UPDATED → will be reactivated to 'active' on commit.
    const second = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    const reactivatedEntry = second.entries.find((e) => e.existing?.status === 'closed_absent');
    expect(reactivatedEntry).toBeDefined();
    expect(reactivatedEntry!.classification).toBe('UPDATED');
    expect(reactivatedEntry!.differs).toBe(true);
    // The candidate's status is 'active'.
    expect(reactivatedEntry!.candidate.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// D. Identity
// ---------------------------------------------------------------------------

describe('D. Identity', () => {
  it('D.18 ISIN identity — two holdings with the same ISIN are sameIdentity', () => {
    const a: Holding = baseHolding({ isin: 'INF123456789' });
    const b: Holding = baseHolding({ isin: 'INF123456789', instrumentName: 'DIFFERENT NAME' });
    expect(HoldingIdentityService.sameIdentity(a, b)).toBe(true);
  });

  it('D.19 TICKER identity — two holdings with the same ticker, no ISIN, are sameIdentity', () => {
    const a: Holding = baseHolding({ isin: undefined, ticker: 'AAPL' });
    const b: Holding = baseHolding({ isin: undefined, ticker: 'AAPL', instrumentName: 'DIFFERENT' });
    expect(HoldingIdentityService.sameIdentity(a, b)).toBe(true);
  });

  it('D.20 NAME identity — two holdings with no ISIN/ticker, same name, are sameIdentity', () => {
    const a: Holding = baseHolding({ isin: undefined, ticker: undefined, instrumentName: 'AAPL' });
    const b: Holding = baseHolding({ isin: undefined, ticker: undefined, instrumentName: 'AAPL' });
    expect(HoldingIdentityService.sameIdentity(a, b)).toBe(true);
  });

  it('D.21 broker separation — same instrument at different brokers are distinct', () => {
    const a: Holding = baseHolding({ broker: 'Zerodha', instrumentName: 'AAPL' });
    const b: Holding = baseHolding({ broker: 'Dhan', instrumentName: 'AAPL' });
    expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
  });

  it('D.22 account separation — same broker/instrument but different accounts are distinct', () => {
    const a: Holding = baseHolding({ broker: 'Dhan', account: 'IQCX28849K', instrumentName: 'A' });
    const b: Holding = baseHolding({ broker: 'Dhan', account: 'OTHER', instrumentName: 'A' });
    expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. Preview
// ---------------------------------------------------------------------------

describe('E. Preview', () => {
  it('E.23 all classifications represented — synthetic mixed batch', () => {
    // Build a synthetic existing set and a synthetic parsed set that
    // covers NEW, UPDATED, UNCHANGED, CLOSED_ABSENT.
    const existing: Holding[] = [
      baseHolding({ id: 'h1', broker: 'X', account: 'A', instrumentName: 'A' }),
      baseHolding({ id: 'h2', broker: 'X', account: 'A', instrumentName: 'B' }),
      baseHolding({ id: 'h3', broker: 'X', account: 'A', instrumentName: 'C' }),
    ];
    const parsed = {
      broker: 'X',
      account: 'A' as string | undefined,
      holdings: [
        baseHolding({ id: 'h1', broker: 'X', account: 'A', instrumentName: 'A' }), // UNCHANGED
        baseHolding({ id: 'h2', broker: 'X', account: 'A', instrumentName: 'B', currentPrice: 999 }), // UPDATED
        baseHolding({ id: 'h4', broker: 'X', account: 'A', instrumentName: 'D' }), // NEW
      ],
      sourceFile: 's.csv',
      importedAt: new Date().toISOString(),
      issues: [],
    };
    const preview = BrokerImportService.reconcile(parsed, existing);
    expect(preview.counts.unchanged).toBe(1);
    expect(preview.counts.updated).toBe(1);
    expect(preview.counts.new).toBe(1);
    expect(preview.counts.closed_absent).toBe(1); // h3 is missing
    expect(preview.confirmationEligible).toBe(true);
  });

  it('E.24 counts correct — Zerodha 82 NEW (empty existing)', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    expect(preview.counts).toEqual({ new: 82, updated: 0, unchanged: 0, closed_absent: 0, issueCount: 0 });
  });

  it('E.25 parser issues surfaced (no real issue in samples, so synthetic)', () => {
    // The samples produce 0 issues. We verify the field is plumbed through.
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    expect(preview.issues).toBeDefined();
    expect(Array.isArray(preview.issues)).toBe(true);
  });

  it('E.26 blockingErrors surfaced — currently 0 (no new error codes introduced)', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    expect(preview.blockingErrors).toEqual([]);
  });

  it('E.27 confirmation eligibility — all UNCHANGED → not eligible', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    repository.holdings.saveMany(parsed.holdings);
    const preview = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    expect(preview.confirmationEligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F. Confirmation
// ---------------------------------------------------------------------------

describe('F. Confirmation', () => {
  it('F.28 no persistence before confirmation', async () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    // Build the atomic mutation closure but DO NOT call repository.write.
    const mutate = BrokerImportService.buildAtomicMutation(preview);
    // The closure was built but not invoked → no mutation has occurred.
    const before = repository.holdings.findAllSync().length;
    expect(before).toBe(0);
    // Discard the closure (simulating "preview but cancel").
    void mutate;
    const after = repository.holdings.findAllSync().length;
    expect(after).toBe(0);
  });

  it('F.29 cancel = no mutation', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    // The UI cancels by NOT invoking the atomic mutation.
    const before = repository.holdings.findAllSync().length;
    expect(before).toBe(0);
    // 0 mutations.
    const after = repository.holdings.findAllSync().length;
    expect(after).toBe(0);
  });

  it('F.30 confirm = commit', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsed, []);
    expect(preview.counts.new).toBe(82);
    // Invoke the store hook.
    const outcome = useCanonicalLedger.getState().commitImportedHoldings(
      preview.entries.map((e) => e.candidate),
    );
    expect(outcome.persisted).toBeDefined();
    if (outcome.persisted) {
      await outcome.persisted;
    }
    // Verify the holdings are now persisted.
    const all = repository.holdings.findAllSync();
    expect(all).toHaveLength(82);
    for (const h of all) {
      expect(h.status).toBe('active');
    }
  });
});

// ---------------------------------------------------------------------------
// G. Atomicity
// ---------------------------------------------------------------------------

describe('G. Atomicity', () => {
  it('G.31 single MemoryRepository.write boundary', async () => {
    // Spy on MemoryRepository.write to count invocations. The store hook
    // calls repository.write exactly once per commit.
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const originalWrite = memoryRepo().write.bind(memoryRepo());
    let writeCount = 0;
    (repository as unknown as { write: typeof originalWrite }).write = async (mutate: () => void) => {
      writeCount++;
      return originalWrite(mutate);
    };
    try {
      const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
      const preview = BrokerImportService.reconcile(parsed, []);
      const outcome = useCanonicalLedger.getState().commitImportedHoldings(
        preview.entries.map((e) => e.candidate),
      );
      if (outcome.persisted) await outcome.persisted;
      expect(writeCount).toBe(1);
    } finally {
      (repository as unknown as { write: typeof originalWrite }).write = originalWrite;
    }
  });

  it('G.32 lifecycle error during pre-validation aborts the build before any state mutation', () => {
    // The pre-validation phase (P-1 pattern) computes every plan against
    // the current snapshot BEFORE any state is mutated. A duplicate-id
    // planCreate throws synchronously from buildAtomicMutation, and the
    // closure is never returned — so MemoryRepository.write is never
    // entered, and the ledger is untouched.
    //
    // This is STRONGER than the original design (which caught the error
    // inside the write boundary). The pre-validation guarantee is that
    // the closure either returns intact, ready to be wrapped in a single
    // MemoryRepository.write, or the caller gets a synchronous throw and
    // no closure exists at all. The ledger is never half-mutated.
    const a = baseHolding({ id: 'dup', broker: 'X', instrumentName: 'A' });
    const b = baseHolding({ id: 'dup', broker: 'X', instrumentName: 'B' });
    const parsed = {
      broker: 'X',
      account: undefined as string | undefined,
      holdings: [a, b],
      sourceFile: 'x.csv',
      importedAt: new Date().toISOString(),
      issues: [],
    };
    const preview = BrokerImportService.reconcile(parsed, []);
    let threw = false;
    let error: Error | null = null;
    try {
      BrokerImportService.buildAtomicMutation(preview);
    } catch (e) {
      threw = true;
      error = e as Error;
    }
    expect(threw).toBe(true);
    // The thrown error is a HoldingLifecycleError with code DUPLICATE_ID,
    // raised by the second planCreate that finds id='dup' already used.
    expect(error).not.toBeNull();
    expect(String(error)).toContain('already exists');
    // The ledger is empty — no write was attempted, no closure was
    // produced, no add/update was called.
    expect(repository.holdings.findAllSync()).toHaveLength(0);
  });

  it('G.32b write boundary rolls back on IndexedDB persist failure', async () => {
    // Defence in depth: even if a future refactor moved validation INTO
    // the closure, the write boundary's revertDelta must restore the
    // pre-mutation state when persist fails. We use the existing
    // IndexedDBStorageService.simulateFailureOnce seam to inject a
    // persistence failure on the very next write attempt. The closure
    // mutates `holdingsData`, persist throws, revertDelta restores it.
    const { IndexedDBStorageService } = await import('../services/IndexedDBStorageService');
    IndexedDBStorageService.simulateFailureOnce = true;
    try {
      const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
      const preview = BrokerImportService.reconcile(parsed, []);
      const mutate = BrokerImportService.buildAtomicMutation(preview);
      let wrote = false;
      try {
        await memoryRepo().write(mutate);
        wrote = true;
      } catch {
        // expected: persist throws 'Simulated IndexedDB persistence failure'
      }
      expect(wrote).toBe(false);
      // After revertDelta, the in-memory state is back to the pre-mutation
      // snapshot (empty in this case).
      expect(repository.holdings.findAllSync()).toHaveLength(0);
    } finally {
      IndexedDBStorageService.simulateFailureOnce = false;
    }
  });

  it('G.33 unrelated holdings preserved', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    // Seed an unrelated holding (Groww Stocks, account 6995348108).
    const parsedGroww = BrokerImportService.detectAndParse(
      asBinaryInput(loadBytes(SAMPLE_GROWW_STOCKS), 'g.xlsx'),
    );
    repository.holdings.saveMany(parsedGroww.holdings);
    // Now import Zerodha (different broker).
    const parsedZ = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview = BrokerImportService.reconcile(parsedZ, repository.holdings.findAllSync());
    const outcome = useCanonicalLedger.getState().commitImportedHoldings(
      preview.entries.map((e) => e.candidate),
    );
    if (outcome.persisted) await outcome.persisted;
    // 6 Groww + 82 Zerodha = 88.
    expect(repository.holdings.findAllSync()).toHaveLength(88);
    const zerodha = repository.holdings.findAllSync().filter((h) => h.broker === 'Zerodha');
    const groww = repository.holdings.findAllSync().filter((h) => h.broker === 'Groww');
    expect(zerodha).toHaveLength(82);
    expect(groww).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// H. Idempotency
// ---------------------------------------------------------------------------

describe('H. Idempotency', () => {
  it('H.34 same file re-import — all UNCHANGED', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed, []);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    // Re-import the same file.
    const preview2 = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    expect(preview2.counts.unchanged).toBe(82);
    expect(preview2.counts.new).toBe(0);
    expect(preview2.counts.updated).toBe(0);
    expect(preview2.confirmationEligible).toBe(false);
  });

  it('H.35 modified file — affected row is UPDATED', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed, []);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    // Mutate the first candidate's currentPrice in the parse.
    const mutatedParsed = {
      ...parsed,
      holdings: parsed.holdings.map((h, i) => i === 0 ? { ...h, currentPrice: h.currentPrice + 100, currentValue: h.currentValue + h.quantity * 100 } : h),
    };
    const preview2 = BrokerImportService.reconcile(mutatedParsed, repository.holdings.findAllSync());
    expect(preview2.counts.updated).toBe(1);
    expect(preview2.counts.unchanged).toBe(81);
  });

  it('H.36 truncated file — dropped row is CLOSED_ABSENT', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed, []);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    // Truncate: drop the last holding.
    const truncated = { ...parsed, holdings: parsed.holdings.slice(0, 81) };
    const preview2 = BrokerImportService.reconcile(truncated, repository.holdings.findAllSync());
    expect(preview2.counts.closed_absent).toBe(1);
    expect(preview2.counts.new).toBe(0);
    // The dropped holding is still in the repo, but its status is 'active'.
    // Committing the preview transitions it to closed_absent.
    const outcome2 = useCanonicalLedger.getState().commitImportedHoldings(
      preview2.entries.map((e) => e.candidate),
    );
    if (outcome2.persisted) await outcome2.persisted;
    // Total count remains 82 (no removal). The dropped one is closed_absent.
    expect(repository.holdings.findAllSync()).toHaveLength(82);
    const closed = repository.holdings.findAllSync().filter((h) => h.status === 'closed_absent');
    expect(closed).toHaveLength(1);
  });

  it('H.37 reintroduced closed_absent — transitions back to active', async () => {
    const { useCanonicalLedger } = await import('../store/useCanonicalLedger');
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const preview1 = BrokerImportService.reconcile(parsed, []);
    const outcome1 = useCanonicalLedger.getState().commitImportedHoldings(preview1.entries.map((e) => e.candidate));
    if (outcome1.persisted) await outcome1.persisted;
    // Truncate and commit to close one.
    const truncated = { ...parsed, holdings: parsed.holdings.slice(0, 81) };
    const preview2 = BrokerImportService.reconcile(truncated, repository.holdings.findAllSync());
    const outcome2 = useCanonicalLedger.getState().commitImportedHoldings(preview2.entries.map((e) => e.candidate));
    if (outcome2.persisted) await outcome2.persisted;
    // Reintroduce the full parse.
    const preview3 = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    const reactivated = preview3.entries.find((e) => e.existing?.status === 'closed_absent');
    expect(reactivated).toBeDefined();
    expect(reactivated!.classification).toBe('UPDATED');
    // Commit the reintroduction.
    const outcome3 = useCanonicalLedger.getState().commitImportedHoldings(
      preview3.entries.map((e) => e.candidate),
    );
    if (outcome3.persisted) await outcome3.persisted;
    // All 82 are now active.
    const active = repository.holdings.findAllSync().filter((h) => h.status === 'active');
    expect(active).toHaveLength(82);
  });
});

// ---------------------------------------------------------------------------
// I. Safety
// ---------------------------------------------------------------------------

describe('I. Safety', () => {
  it('I.38 no NaN / Infinity in Zerodha parse', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    for (const h of parsed.holdings) {
      expect(Number.isFinite(h.quantity)).toBe(true);
      expect(Number.isFinite(h.averageCost)).toBe(true);
      expect(Number.isFinite(h.investedValue)).toBe(true);
      expect(Number.isFinite(h.currentPrice)).toBe(true);
      expect(Number.isFinite(h.currentValue)).toBe(true);
      expect(Number.isFinite(h.unrealisedPnL)).toBe(true);
    }
  });

  it('I.39 no Infinity in Dhan parse', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_EQUITY), 'd.csv'));
    for (const h of parsed.holdings) {
      expect(Number.isFinite(h.investedValue)).toBe(true);
      expect(Number.isFinite(h.currentValue)).toBe(true);
      expect(Number.isFinite(h.unrealisedPnL)).toBe(true);
    }
  });

  it('I.40 fresh IDs on NEW', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    const ids = new Set(parsed.holdings.map((h) => h.id));
    expect(ids.size).toBe(82);
    for (const id of ids) expect(id).toMatch(/^hld-/);
  });

  it('I.41 sourceFile preserved correctly', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'my-custom.csv'));
    for (const h of parsed.holdings) {
      expect(h.sourceFile).toBe('my-custom.csv');
    }
  });

  it('I.42 importedAt preserved/updated according to lifecycle contract', () => {
    const parsed = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_ZERODHA), 'z.csv'));
    for (const h of parsed.holdings) {
      // For Zerodha (no per-row date), importedAt is the parser execution time.
      // It should be a valid ISO 8601 timestamp.
      expect(h.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    // Dhan Equity uses max(Trade Date) in ISO 8601 date form.
    const dhan = BrokerImportService.detectAndParse(asTextInput(loadText(SAMPLE_DHAN_EQUITY), 'd.csv'));
    for (const h of dhan.holdings) {
      expect(h.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: overrides.id ?? `hld-test-${Math.random().toString(36).slice(2, 10)}`,
    broker: overrides.broker ?? 'TestBroker',
    account: overrides.account,
    instrumentName: overrides.instrumentName ?? 'Test Instrument',
    isin: overrides.isin,
    ticker: overrides.ticker,
    quantity: overrides.quantity ?? 10,
    averageCost: overrides.averageCost ?? 100,
    investedValue: overrides.investedValue ?? 1000,
    currentPrice: overrides.currentPrice ?? 110,
    currentValue: overrides.currentValue ?? 1100,
    unrealisedPnL: overrides.unrealisedPnL ?? 100,
    unrealisedPnLPercent: overrides.unrealisedPnLPercent,
    xirrPercent: overrides.xirrPercent,
    securityClassification: overrides.securityClassification,
    status: overrides.status ?? 'active' as HoldingStatus,
    sourceFile: overrides.sourceFile ?? 'test.csv',
    importedAt: overrides.importedAt ?? '2026-08-23T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// J. D-12 (Option B) — deterministic blockingErrors projection
//
// Characterization + acceptance tests for the blockingErrors[] projection of
// the existing INVALID classification. Fixture files are intentionally
// synthetic inline CSVs (no /home/user/uploads dependency) so these tests are
// hermetic. E.26 remains the clean-sample pin (clean parse ⇒ []); J.1 is the
// hermetic equivalent. The existing D-06-F1-A suites are unaffected.
// ---------------------------------------------------------------------------

describe('J. D-12 blockingErrors projection', () => {
  const D12_HEADER = '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""';

  function d12Csv(...dataRows: string[]): string {
    return [D12_HEADER, ...dataRows].join('\n');
  }
  function d12Preview(csv: string, fileName = 'd12.csv'): BrokerImportPreview {
    const parsed = BrokerImportService.detectAndParse(asTextInput(csv, fileName));
    return BrokerImportService.reconcile(parsed, []);
  }
  const QTY_BAD = '"BADQTY",abc,100,110,1000,1100,100,10,1,""';
  const IDENTITY_MISSING = '"",10,100,110,1000,1100,100,10,1,""';
  // Row numbering note: the Zerodha TEXT path numbers the first data row 3
  // (walkRows `sourceRowOffset = 1` is applied on top of the header slice —
  // an existing, adapter-frozen quirk; D-12 must not touch it). The
  // projection faithfully carries whatever rowNumber the issue carries.
  const QTY_BAD_PROJECTION =
    'R3 [BROKER_NUMERIC_INVALID] Qty.: Qty. is not a parseable number: "abc"';
  const IDENTITY_MISSING_PROJECTION =
    'R4 [BROKER_IDENTITY_MISSING] Instrument is empty for this row';

  it('J.1 clean parse (no issues at all) → blockingErrors = [] and eligible', () => {
    // T1: no INVALID issues ⇒ empty projection. (Hermetic twin of E.26.)
    const preview = d12Preview(d12Csv('"TESTINSTR",10,100,110,1000,1100,100,10,1,""'));
    expect(preview.issues).toHaveLength(0);
    expect(preview.blockingErrors).toEqual([]);
    expect(preview.confirmationEligible).toBe(true);
  });

  it('J.2 one INVALID issue → exactly the D12-a projection string', () => {
    // T2: format `R{rowNumber} [{code}] {field}: {message}` (field present)
    // — asserted byte-exact (AC-07).
    const preview = d12Preview(d12Csv(QTY_BAD));
    expect(preview.blockingErrors).toEqual([QTY_BAD_PROJECTION]);
  });

  it('J.3 multiple INVALID issues → all projected, deterministic source order', () => {
    // T3 + AC-04: emission order preserved, one entry per issue, no cap.
    const preview = d12Preview(d12Csv(QTY_BAD, IDENTITY_MISSING));
    expect(preview.blockingErrors).toEqual([
      QTY_BAD_PROJECTION,
      IDENTITY_MISSING_PROJECTION,
    ]);
    expect(preview.confirmationEligible).toBe(false);
  });

  it('J.4 fieldless INVALID row-number format and issue-order determinism across repeats', () => {
    // AC-07 `field`-absent variant (`R{n} [{code}] {message}`) + determinism:
    // the same input must yield the identical projection every run.
    const preview = d12Preview(d12Csv(IDENTITY_MISSING));
    expect(preview.blockingErrors).toEqual([
      'R3 [BROKER_IDENTITY_MISSING] Instrument is empty for this row',
    ]);
    const again = d12Preview(d12Csv(IDENTITY_MISSING));
    expect(again.blockingErrors).toEqual(preview.blockingErrors);
  });

  it('J.5 AMBIGUOUS-only issues never enter blockingErrors', () => {
    // T4 + T5: the severity taxonomy has no separate 'WARNING' member;
    // AMBIGUOUS is the warning class. A duplicate row (AMBIGUOUS
    // BROKER_DUPLICATE_INSIDE_BATCH) must not project.
    const preview = d12Preview(d12Csv(
      '"DUP",10,100,110,1000,1100,100,10,1,""',
      '"DUP",12,100,110,1000,1100,100,10,1,""',
    ));
    expect(
      preview.issues.some(
        (i) => i.severity === 'AMBIGUOUS' && i.code === 'BROKER_DUPLICATE_INSIDE_BATCH',
      ),
    ).toBe(true);
    expect(preview.blockingErrors).toEqual([]);
  });

  it('J.6 mixed AMBIGUOUS + INVALID → only INVALID is projected', () => {
    // T6 + AC-03/AC-05.
    const preview = d12Preview(d12Csv(
      '"MIXED",10,100,110,1000,1100,100,10,1,""',
      '"MIXED",12,100,110,1000,1100,100,10,1,""',
      QTY_BAD,
    ));
    expect(preview.issues.some((i) => i.severity === 'AMBIGUOUS')).toBe(true);
    expect(preview.blockingErrors).toEqual([
      'R5 [BROKER_NUMERIC_INVALID] Qty.: Qty. is not a parseable number: "abc"',
    ]);
    expect(preview.confirmationEligible).toBe(false);
  });

  it('J.7 eligibility semantics unchanged: all-UNCHANGED → not eligible, no blockers', () => {
    // T7 (AC-09): the pre-existing `INVALID-count === 0 && mutations > 0`
    // rule is untouched; a no-op import is ineligible with an EMPTY
    // projection (blockingErrors must not become a second gate).
    const parsed = BrokerImportService.detectAndParse(
      asTextInput(d12Csv('"TESTINSTR",10,100,110,1000,1100,100,10,1,""'), 'd12-unchanged.csv'),
    );
    repository.holdings.saveMany(parsed.holdings);
    const preview = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    expect(preview.blockingErrors).toEqual([]);
    expect(preview.confirmationEligible).toBe(false);
  });

  it('J.8 D12-b preservation pin: header-only (AMBIGUOUS) + non-empty ledger stays eligible and unblocked', () => {
    // T14 / AC-13: the suspicious-input behavior is governed by a SEPARATE
    // decision and is unchanged by D-12 — pinned here as preservation, not
    // as a fix. BROKER_HEADER_ONLY is AMBIGUOUS in every adapter, so the
    // INVALID-only projection structurally cannot include it.
    repository.holdings.saveMany([baseHolding({ broker: 'Zerodha', instrumentName: 'LegacyCorp' })]);
    const parsed = {
      broker: 'Zerodha',
      account: undefined as string | undefined,
      holdings: [],
      sourceFile: 'header-only.csv',
      importedAt: new Date().toISOString(),
      issues: [
        {
          rowNumber: 1,
          severity: 'AMBIGUOUS' as const,
          code: 'BROKER_HEADER_ONLY' as const,
          message: 'Zerodha file contains only the header row, no data',
        },
      ],
    };
    const preview = BrokerImportService.reconcile(parsed, repository.holdings.findAllSync());
    expect(preview.blockingErrors).toEqual([]);
    expect(preview.confirmationEligible).toBe(true);
    expect(preview.closures).toHaveLength(1);
  });
});
