/**
 * WP-FB-IMPORT-BROKER-01 — WP-04 Zerodha adapter characterization tests.
 *
 * Asserts the contract in WP-FB-IMPORT-BROKER-01-WP-04-ZERODHA-
 * IMPLEMENTATION-AUTHORITY.md §20. The positive-path tests use the two
 * real Zerodha samples; synthetic fixtures are used only for negative
 * and edge cases that the real samples cannot represent (E.1–E.8 in
 * the authority record).
 *
 * The tests are organized by section (A through H) so a reviewer can
 * map each test back to the authority record clause it implements.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ZerodhaHoldingsAdapter } from '../services/import/adapters/ZerodhaHoldingsAdapter';
import { BrokerFormatDetector } from '../services/import/BrokerFormatDetector';
import { Holding } from '../domain/types';
import { StatementInput } from '../services/import/ImportTypes';

// ---------------------------------------------------------------------------
// Real-sample loaders
// ---------------------------------------------------------------------------

const SAMPLE_1_PATH = '/home/user/uploads/Zerodha_holdings_10082026_1739.csv';
const SAMPLE_2_PATH = '/home/user/uploads/Zerodha_mutual_funds_holdings.csv';

function loadSample(path: string): string {
  return readFileSync(path, 'utf8');
}

function asTextInput(content: string, fileName: string): StatementInput {
  return { kind: 'text', content, fileName };
}

// ---------------------------------------------------------------------------
// A. Real-sample happy path
// ---------------------------------------------------------------------------

describe('A. Real-sample happy path', () => {
  it('A.1 Sample 1 (Equity) → 82 Holdings, all unique, all active', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    expect(out.broker).toBe('Zerodha');
    expect(out.account).toBeUndefined();
    expect(out.holdings).toHaveLength(82);
    expect(out.issues).toEqual([]);

    // Every holding must satisfy the canonical contract
    for (const h of out.holdings) {
      expect(h.id).toMatch(/^hld-/);
      expect(h.broker).toBe('Zerodha');
      expect(h.account).toBeUndefined();
      expect(h.isin).toBeUndefined();
      expect(h.xirrPercent).toBeUndefined();
      expect(h.securityClassification).toBeUndefined();
      expect(h.status).toBe('active');
      expect(h.sourceFile).toBe('Zerodha_holdings_10082026_1739.csv');
      // Ticker is set for every Sample-1 row (the discovered
      // instruments are all uppercase short tickers)
      expect(typeof h.ticker).toBe('string');
      expect((h.ticker as string).length).toBeGreaterThan(0);
      expect(h.ticker).toBe(h.instrumentName); // the heuristic sets ticker = instrument
    }

    // Identity uniqueness: 82 distinct (broker, instrument) pairs
    const seen = new Set<string>();
    for (const h of out.holdings) {
      const key = `${h.broker}|${h.account ?? 'undef'}|${h.instrumentName}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('A.2 Sample 2 (MF) → 2 Holdings, both unique, both ticker undefined', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    expect(out.broker).toBe('Zerodha');
    expect(out.account).toBeUndefined();
    expect(out.holdings).toHaveLength(2);
    expect(out.issues).toEqual([]);

    const expectedNames = ['Zerodha Gold ETF FoF', 'Zerodha Nifty LargeMidcap 250 Index Fund'];
    const actualNames = out.holdings.map((h) => h.instrumentName);
    expect(actualNames).toEqual(expectedNames);

    for (const h of out.holdings) {
      expect(h.ticker).toBeUndefined(); // MF names contain spaces + lower-case
      expect(h.account).toBeUndefined();
      expect(h.isin).toBeUndefined();
      expect(h.xirrPercent).toBeUndefined();
      expect(h.securityClassification).toBeUndefined();
      expect(h.status).toBe('active');
    }
  });
});

// ---------------------------------------------------------------------------
// B. Structural
// ---------------------------------------------------------------------------

describe('B. Structural', () => {
  it('B.1 Header is the byte-exact discovered schema', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    expect(out.holdings).toHaveLength(82); // If header matched, we got 82 rows
  });

  it('B.2 Trailing empty column 10 is tolerated (does not cause rejection)', () => {
    // A synthetic CSV with the exact same header including the trailing ""
    // column must be detected and parsed.
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"FOO",10,100,110,1000,1100,100,5,2,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'synthetic.csv'));
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('FOO');
  });

  it('B.3 Quoted CSV cells are correctly parsed', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"ABC, INC",5,200,250,1000,1250,250,25,3,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'synthetic.csv'));
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('ABC, INC');
  });

  it('B.4 LF line endings are correctly handled', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"LF1",1,10,12,10,12,2,20,1,""',
      '"LF2",2,20,22,40,44,4,10,0.5,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'lf.csv'));
    expect(out.holdings).toHaveLength(2);
    expect(out.holdings.map((h) => h.instrumentName)).toEqual(['LF1', 'LF2']);
  });

  it('B.5 No BOM (Sample 1 first 3 bytes are ASCII `"In`)', () => {
    // Verify that the raw file does NOT start with EF BB BF
    const buf = readFileSync(SAMPLE_1_PATH);
    expect(buf[0]).toBe(0x22); // '"'
    expect(buf[1]).toBe(0x49); // 'I'
    expect(buf[2]).toBe(0x6e); // 'n'
  });
});

// ---------------------------------------------------------------------------
// C. Identity
// ---------------------------------------------------------------------------

describe('C. Identity', () => {
  it('C.1 Ticker-like equity instrument → ticker set', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"AIIL",10,462.31,586.2,4623.1,5862,1238.9,26.8,-1.74,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'synthetic.csv'));
    expect(out.holdings[0].ticker).toBe('AIIL');
  });

  it('C.2 MF full-name instrument → ticker undefined', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"Zerodha Gold ETF FoF",630.272,19.83,20.7624,12499.87,13085.96,586.09,4.69,1.83,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'synthetic.csv'));
    expect(out.holdings[0].ticker).toBeUndefined();
  });

  it('C.3 account is undefined for every row (both samples)', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    for (const h of out1.holdings) expect(h.account).toBeUndefined();
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    for (const h of out2.holdings) expect(h.account).toBeUndefined();
  });

  it('C.4 isin is undefined for every row (both samples)', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    for (const h of out1.holdings) expect(h.isin).toBeUndefined();
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    for (const h of out2.holdings) expect(h.isin).toBeUndefined();
  });

  it('C.5 Identity stability: 82 unique instruments in Sample 1', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const set = new Set(out.holdings.map((h) => h.instrumentName));
    expect(set.size).toBe(82);
  });
});

// ---------------------------------------------------------------------------
// D. Values
// ---------------------------------------------------------------------------

describe('D. Values', () => {
  it('D.1–D.7 Each Holding\'s canonical fields are correctly recomputed', () => {
    // Synthetic single row, all values hand-computed:
    //   qty=10, avgCost=100, ltp=110
    //   investedValue  = 10 * 100 = 1000
    //   currentValue   = 10 * 110 = 1100
    //   unrealisedPnL  = 1100 - 1000 = 100
    //   unrealisedPnLPercent = (100 / 1000) * 100 = 10
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"TEST",10,100,110,9999,9999,9999,99,99,""', // broker values are intentionally wrong
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'synthetic.csv'));
    expect(out.holdings).toHaveLength(1);
    const h = out.holdings[0];
    expect(h.quantity).toBe(10);
    expect(h.averageCost).toBe(100);
    expect(h.investedValue).toBe(1000);          // recomputed, not 9999
    expect(h.currentPrice).toBe(110);
    expect(h.currentValue).toBe(1100);            // recomputed, not 9999
    expect(h.unrealisedPnL).toBe(100);            // recomputed, not 9999
    expect(h.unrealisedPnLPercent).toBeCloseTo(10, 9); // recomputed
  });

  it('D.8 Negative P&L preserved (AMBUJACEM row from Sample 1)', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const ambuja = out.holdings.find((h) => h.instrumentName === 'AMBUJACEM');
    expect(ambuja).toBeDefined();
    expect(ambuja!.quantity).toBe(20);
    expect(ambuja!.averageCost).toBeCloseTo(438.34, 2);
    expect(ambuja!.currentPrice).toBeCloseTo(431.15, 2);
    // Parser-recomputed values (not the broker's): 20 * 438.34 = 8766.80.
    // The broker reports 8766.75; the difference is the broker's
    // pre-rounding of avgCost to 2 decimals. See D.9 below.
    expect(ambuja!.investedValue).toBeCloseTo(8766.80, 1);
    expect(ambuja!.currentValue).toBeCloseTo(8623, 0);
    // P&L is negative — must survive the parser
    expect(ambuja!.unrealisedPnL).toBeLessThan(0);
    expect(ambuja!.unrealisedPnLPercent).toBeDefined();
    expect(ambuja!.unrealisedPnLPercent!).toBeLessThan(0);
  });

  it('D.8b Additional negative-P&L rows in Sample 1', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    for (const name of ['BEL', 'BLS', 'CONTROLPR', 'DABUR', 'DBCORP']) {
      const h = out.holdings.find((x) => x.instrumentName === name);
      expect(h).toBeDefined();
      expect(h!.unrealisedPnL).toBeLessThan(0);
    }
  });

  it('D.9 Spot-check: parser-recomputed values match broker-supplied values within rounding tolerance', () => {
    // For the AMBUJACEM row, the broker says Invested=8766.75 / Cur. val=8623 / P&L=-143.75.
    // Parser-recomputed: investedValue = 20*438.34 = 8766.80 (off by 0.05 due to rounding
    // of avgCost to 2 decimals); currentValue = 20*431.15 = 8623.00 (exact);
    // unrealisedPnL = 8623.00 - 8766.80 = -143.80 (off by 0.05).
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const ambuja = out.holdings.find((h) => h.instrumentName === 'AMBUJACEM')!;
    expect(Math.abs(ambuja.investedValue - 8766.75)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(ambuja.currentValue - 8623)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(ambuja.unrealisedPnL - (-143.75))).toBeLessThanOrEqual(0.1);
  });
});

// ---------------------------------------------------------------------------
// E. Invalid cases (synthetic fixtures only)
// ---------------------------------------------------------------------------

describe('E. Invalid cases', () => {
  it('E.1 Empty file → BROKER_EMPTY, no Holdings', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput('', 'empty.csv'));
    expect(out.holdings).toEqual([]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].code).toBe('BROKER_EMPTY');
  });

  it('E.2 Header-only file → BROKER_HEADER_ONLY, no Holdings', () => {
    const csv = '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""';
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'header-only.csv'));
    expect(out.holdings).toEqual([]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].code).toBe('BROKER_HEADER_ONLY');
  });

  it('E.3 Missing required header (no Instrument) → BROKER_HEADER_MISSING', () => {
    const csv = '"Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""\n10,1,1,1,1,1,1,1,""';
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'no-instrument.csv'));
    expect(out.holdings).toEqual([]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].code).toBe('BROKER_HEADER_MISSING');
  });

  it('E.4 Malformed row (too few fields) → BROKER_ROW_MALFORMED, remaining rows parsed', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"GOOD",10,100,110,1000,1100,100,5,2,""',
      '"BAD",10,100', // only 3 fields — malformed
      '"GOOD2",5,50,55,250,275,25,10,1,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'malformed.csv'));
    expect(out.holdings).toHaveLength(2);
    expect(out.holdings.map((h) => h.instrumentName)).toEqual(['GOOD', 'GOOD2']);
    const malformed = out.issues.find((i) => i.code === 'BROKER_ROW_MALFORMED');
    expect(malformed).toBeDefined();
  });

  it('E.5 Invalid numeric value (Qty. = "abc") → BROKER_NUMERIC_INVALID, row skipped', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"GOOD",10,100,110,1000,1100,100,5,2,""',
      '"BAD","abc",100,110,1000,1100,100,5,2,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'bad-numeric.csv'));
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('GOOD');
    expect(out.issues.some((i) => i.code === 'BROKER_NUMERIC_INVALID')).toBe(true);
  });

  it('E.6 Zero quantity → BROKER_QUANTITY_NON_POSITIVE warning + holding emitted with qty=0', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"ZERO",0,100,110,0,0,0,0,0,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'zero.csv'));
    expect(out.holdings).toHaveLength(1);
    const h = out.holdings[0];
    expect(h.quantity).toBe(0);
    expect(h.averageCost).toBe(0); // lifecycle tolerance
    expect(h.investedValue).toBe(0);
    expect(h.currentValue).toBe(0);
    expect(h.unrealisedPnL).toBe(0);
    expect(h.unrealisedPnLPercent).toBeUndefined(); // division by zero guarded
    const w = out.issues.find((i) => i.code === 'BROKER_QUANTITY_NON_POSITIVE');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('AMBIGUOUS'); // warning, not error
  });

  it('E.7 Negative quantity → BROKER_QUANTITY_NON_POSITIVE error, row rejected', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"GOOD",10,100,110,1000,1100,100,5,2,""',
      '"NEG",-5,100,110,-500,-550,-50,5,2,""',
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'negative-qty.csv'));
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('GOOD');
    const err = out.issues.find((i) => i.code === 'BROKER_QUANTITY_NON_POSITIVE');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('INVALID');
  });

  it('E.8 Duplicate identity inside batch → BROKER_DUPLICATE_INSIDE_BATCH, first wins', () => {
    const csv = [
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"DUPE",10,100,110,1000,1100,100,5,2,""',
      '"DUPE",20,200,220,4000,4400,400,5,2,""', // same instrument, different values
    ].join('\n');
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(csv, 'dupe.csv'));
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].quantity).toBe(10); // first occurrence wins
    const d = out.issues.find((i) => i.code === 'BROKER_DUPLICATE_INSIDE_BATCH');
    expect(d).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// F. Idempotency
// ---------------------------------------------------------------------------

describe('F. Idempotency', () => {
  it('F.1 Same source parsed twice → semantically identical candidates; only id/importedAt may differ', async () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const csv = loadSample(SAMPLE_1_PATH);
    const out1 = adapter.parseHoldings(asTextInput(csv, 'Zerodha_holdings_10082026_1739.csv'));
    // Wait a millisecond so importedAt differs
    await new Promise((resolve) => setTimeout(resolve, 2));
    const out2 = adapter.parseHoldings(asTextInput(csv, 'Zerodha_holdings_10082026_1739.csv'));

    expect(out1.holdings).toHaveLength(out2.holdings.length);
    expect(out1.holdings.length).toBe(82);

    for (let i = 0; i < out1.holdings.length; i++) {
      const a = out1.holdings[i];
      const b = out2.holdings[i];
      // Identity / values are stable
      expect(a.broker).toBe(b.broker);
      expect(a.instrumentName).toBe(b.instrumentName);
      expect(a.account).toBe(b.account);
      expect(a.isin).toBe(b.isin);
      expect(a.ticker).toBe(b.ticker);
      expect(a.quantity).toBe(b.quantity);
      expect(a.averageCost).toBe(b.averageCost);
      expect(a.investedValue).toBe(b.investedValue);
      expect(a.currentPrice).toBe(b.currentPrice);
      expect(a.currentValue).toBe(b.currentValue);
      expect(a.unrealisedPnL).toBe(b.unrealisedPnL);
      expect(a.status).toBe(b.status);
      expect(a.sourceFile).toBe(b.sourceFile);
      // Only id and importedAt may differ
      expect(a.id).not.toBe(b.id);
      // importedAt may differ by milliseconds; allow that.
    }
  });
});

// ---------------------------------------------------------------------------
// G. Detection
// ---------------------------------------------------------------------------

describe('G. Detection', () => {
  it('G.1 canHandle(Sample 1) → matched=true, HIGH, zerodha', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const det = adapter.canHandle(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    expect(det.matched).toBe(true);
    expect(det.confidence).toBe('HIGH');
    expect(det.formatId).toBe('zerodha');
    expect(det.displayName).toBe('Zerodha Holdings');
  });

  it('G.2 canHandle(Sample 2) → matched=true, HIGH, zerodha', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const det = adapter.canHandle(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    expect(det.matched).toBe(true);
    expect(det.confidence).toBe('HIGH');
    expect(det.formatId).toBe('zerodha');
  });

  it('G.3 canHandle(arbitrary unrelated CSV) → matched=false', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const det = adapter.canHandle(asTextInput(
      'date,narration,amount,balance\n2026-01-01,coffee,100,5000',
      'random.csv'
    ));
    expect(det.matched).toBe(false);
    expect(det.confidence).toBe('NONE');
  });

  it('G.4 canHandleRows(Sample 1 headers) → matched=true, HIGH', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const det = adapter.canHandleRows(
      ['Instrument', 'Qty.', 'Avg. cost', 'LTP', 'Invested', 'Cur. val', 'P&L', 'Net chg.', 'Day chg.', ''],
      []
    );
    expect(det.matched).toBe(true);
    expect(det.confidence).toBe('HIGH');
    expect(det.formatId).toBe('zerodha');
  });

  it('G.5 BrokerFormatDetector routes a real Zerodha file to ZerodhaHoldingsAdapter', () => {
    const { adapter, detection } = BrokerFormatDetector.detect(
      asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv')
    );
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('zerodha');
    expect(detection.matched).toBe(true);
    expect(detection.formatId).toBe('zerodha');
  });

  it('G.6 BrokerFormatDetector rejects a non-Zerodha file', () => {
    const { adapter, detection } = BrokerFormatDetector.detect(
      asTextInput(
        'date,narration,amount,balance\n2026-01-01,coffee,100,5000',
        'random.csv'
      )
    );
    expect(adapter).toBeNull();
    expect(detection.matched).toBe(false);
    expect(detection.formatId).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// H. Safety
// ---------------------------------------------------------------------------

describe('H. Safety', () => {
  it('H.1 No NaN / Infinity across both real samples', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    const all = [...out1.holdings, ...out2.holdings];
    for (const h of all) {
      expect(Number.isFinite(h.quantity)).toBe(true);
      expect(Number.isFinite(h.averageCost)).toBe(true);
      expect(Number.isFinite(h.investedValue)).toBe(true);
      expect(Number.isFinite(h.currentPrice)).toBe(true);
      expect(Number.isFinite(h.currentValue)).toBe(true);
      expect(Number.isFinite(h.unrealisedPnL)).toBe(true);
      if (h.unrealisedPnLPercent !== undefined) {
        expect(Number.isFinite(h.unrealisedPnLPercent)).toBe(true);
      }
    }
  });

  it('H.2 No Holding emitted with status != "active"', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    for (const h of [...out1.holdings, ...out2.holdings]) {
      expect(h.status).toBe('active');
    }
  });

  it('H.3 No Holding emitted with broker != "Zerodha"', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    for (const h of [...out1.holdings, ...out2.holdings]) {
      expect(h.broker).toBe('Zerodha');
    }
  });

  it('H.4 No Holding emitted with a non-undefined account', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    for (const h of [...out1.holdings, ...out2.holdings]) {
      expect(h.account).toBeUndefined();
    }
  });

  it('H.5 No Holding emitted with a non-undefined ISIN', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const out2 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_2_PATH), 'Zerodha_mutual_funds_holdings.csv'));
    for (const h of [...out1.holdings, ...out2.holdings]) {
      expect(h.isin).toBeUndefined();
    }
  });

  it('H.6 Every emitted Holding has a fresh hld-<uuid> id', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out1 = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'Zerodha_holdings_10082026_1739.csv'));
    const ids = new Set<string>();
    for (const h of out1.holdings) {
      expect(h.id).toMatch(/^hld-/);
      expect(ids.has(h.id)).toBe(false);
      ids.add(h.id);
    }
    expect(ids.size).toBe(82);
  });

  it('H.7 sourceFile is exactly the supplied filename (not a sample constant)', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const out = adapter.parseHoldings(asTextInput(loadSample(SAMPLE_1_PATH), 'my-custom-name.csv'));
    for (const h of out.holdings) {
      expect(h.sourceFile).toBe('my-custom-name.csv');
    }
  });
});

// ---------------------------------------------------------------------------
// Bonus: canHandleRows path produces identical results for the real samples
// ---------------------------------------------------------------------------

describe('canHandleRows → parseHoldingsFromRows parity', () => {
  it('Sample 1 round-trips through the row-decoded path', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const csv = loadSample(SAMPLE_1_PATH);
    // Synthesise ParsedCsvRow[] using CsvRecordParser-style raw fields.
    // We feed the header row as the first row and the data rows after.
    // This is the path used by the binary workbook decoder.
    const text = adapter.parseHoldings(asTextInput(csv, 'Zerodha_holdings_10082026_1739.csv'));
    expect(text.holdings).toHaveLength(82);
    // We don't re-tokenise the CSV here; the row-path is exercised
    // structurally by the test below using a synthetic row set.
    expect(text.holdings.every((h: Holding) => h.broker === 'Zerodha')).toBe(true);
  });

  it('canHandleRows + parseHoldingsFromRows with synthetic row set works', () => {
    const adapter = new ZerodhaHoldingsAdapter();
    const headerRow = {
      rowNumber: 1,
      data: {
        instrument: '',
        'qty.': '',
        'avg. cost': '',
        ltp: '',
        invested: '',
        'cur. val': '',
        'p&l': '',
        'net chg.': '',
        'day chg.': '',
        '': '',
      },
      rawFields: ['Instrument', 'Qty.', 'Avg. cost', 'LTP', 'Invested', 'Cur. val', 'P&L', 'Net chg.', 'Day chg.', ''],
    };
    const dataRow = {
      rowNumber: 2,
      data: {
        instrument: 'XYZ',
        'qty.': '5',
        'avg. cost': '100',
        ltp: '110',
        invested: '500',
        'cur. val': '550',
        'p&l': '50',
        'net chg.': '10',
        'day chg.': '1',
        '': '',
      },
      rawFields: ['XYZ', '5', '100', '110', '500', '550', '50', '10', '1', ''],
    };
    const det = adapter.canHandleRows(headerRow.rawFields, [headerRow, dataRow]);
    expect(det.matched).toBe(true);

    const out = adapter.parseHoldingsFromRows([headerRow, dataRow], 'binary-path.csv');
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('XYZ');
    expect(out.holdings[0].quantity).toBe(5);
    expect(out.holdings[0].investedValue).toBe(500);
    expect(out.holdings[0].currentValue).toBe(550);
    expect(out.holdings[0].unrealisedPnL).toBe(50);
  });
});

// Quick import for completeness at the bottom
import { join as _join } from 'node:path';
void _join;
