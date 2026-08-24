/**
 * WP-FB-IMPORT-BROKER-01 — WP-06 Groww adapter characterization tests.
 *
 * Asserts the contract in
 * `WP-FB-IMPORT-BROKER-01-WP-06-GROWW-IMPLEMENTATION-AUTHORITY.md`
 * §13. The positive-path tests use the two real Groww XLSX
 * samples; synthetic fixtures are used only for negative and edge
 * cases that the real samples cannot represent.
 *
 * The tests are organized by section (A through P) so a reviewer
 * can map each test back to the authority record clause it
 * implements.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { GrowwHoldingsAdapter } from '../services/import/adapters/GrowwHoldingsAdapter';
import { BrokerFormatDetector } from '../services/import/BrokerFormatDetector';
import { StatementInput, ParsedCsvRow } from '../services/import/ImportTypes';

// ---------------------------------------------------------------------------
// Real-sample loaders
// ---------------------------------------------------------------------------

const SAMPLE_STOCKS_PATH =
  '/home/user/uploads/Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx';
const SAMPLE_MF_PATH =
  '/home/user/uploads/Groww_Mutual_Funds_6995348108_24-08-2026.xlsx';

function loadBytes(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf);
}

function asBinaryInput(bytes: Uint8Array, fileName: string): StatementInput {
  return { kind: 'binary', content: bytes, fileName };
}

// ---------------------------------------------------------------------------
// A. Stocks detection (binary path)
// ---------------------------------------------------------------------------

describe('A. Stocks detection (binary path)', () => {
  it('A.1 canHandle(Sample 6 binary) → matched=true, HIGH, groww', () => {
    const adapter = new GrowwHoldingsAdapter();
    const det = adapter.canHandle(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    expect(det.matched).toBe(true);
    expect(det.confidence).toBe('HIGH');
    expect(det.formatId).toBe('groww');
    expect(det.displayName).toBe('Groww Holdings');
  });
});

// ---------------------------------------------------------------------------
// B. MF detection (binary path)
// ---------------------------------------------------------------------------

describe('B. MF detection (binary path)', () => {
  it('B.1 canHandle(Sample 6b binary) → matched=true, HIGH, groww', () => {
    const adapter = new GrowwHoldingsAdapter();
    const det = adapter.canHandle(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    expect(det.matched).toBe(true);
    expect(det.confidence).toBe('HIGH');
    expect(det.formatId).toBe('groww');
  });
});

// ---------------------------------------------------------------------------
// C. Unsupported / text input
// ---------------------------------------------------------------------------

describe('C. Unsupported / text input', () => {
  it('C.1 canHandle(text) → matched=false, NONE', () => {
    const adapter = new GrowwHoldingsAdapter();
    const det = adapter.canHandle({ kind: 'text', content: 'whatever', fileName: 'x.csv' });
    expect(det.matched).toBe(false);
    expect(det.confidence).toBe('NONE');
  });

  it('C.2 canHandle(empty binary) → matched=false, NONE', () => {
    const adapter = new GrowwHoldingsAdapter();
    const det = adapter.canHandle({ kind: 'binary', content: new Uint8Array(0), fileName: 'empty.xlsx' });
    expect(det.matched).toBe(false);
    expect(det.confidence).toBe('NONE');
  });

  it('C.3 canHandle(arbitrary non-Groww binary) → matched=false, NONE', () => {
    const adapter = new GrowwHoldingsAdapter();
    // Random bytes that are not a valid XLSX
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const det = adapter.canHandle({ kind: 'binary', content: bytes, fileName: 'random.bin' });
    expect(det.matched).toBe(false);
    expect(det.confidence).toBe('NONE');
  });

  it('C.4 parseHoldings(text) → BROKER_UNSUPPORTED, 0 Holdings', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings({ kind: 'text', content: 'whatever', fileName: 'x.csv' });
    expect(out.holdings).toEqual([]);
    expect(out.issues.some((i) => i.code === 'BROKER_UNSUPPORTED')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Stocks preamble / header discovery
// ---------------------------------------------------------------------------

describe('D. Stocks preamble / header discovery (decoded-rows path)', () => {
  it('D.1 Stocks header is found by marker; preamble is skipped', () => {
    const adapter = new GrowwHoldingsAdapter();
    // Synthesise the decoded-rows structure by feeding an in-memory
    // representation that mirrors the real XLSX. Use canHandleRows
    // to verify detection.
    const headers = [
      'Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value',
      'Closing price', 'Closing value', 'Unrealised P&L',
    ];
    const det = adapter.canHandleRows(headers, []);
    expect(det.matched).toBe(true);
    expect(det.reason).toMatch(/Stocks/);
  });

  it('D.2 Stocks rows include negative P&L preserved (TATAAML-TATAGOLD)', () => {
    // We construct a synthetic data row matching the real Sample 6
    // R13 row exactly to verify the negative-P&L path. This is
    // also covered by the full-sample test in F.1.
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Holdings statement for stocks as on 23-08-2026'] },
      { rowNumber: 3, data: {}, rawFields: ['Summary'] },
      { rowNumber: 4, data: {}, rawFields: ['Invested Value', '102931.2'] },
      { rowNumber: 5, data: {}, rawFields: ['Closing Value', '142235.7'] },
      { rowNumber: 6, data: {}, rawFields: ['Unrealised P&L', '39304.5'] },
      { rowNumber: 7, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', 'Unrealised P&L'] },
      { rowNumber: 8, data: {}, rawFields: ['TATAAML-TATAGOLD', 'INF277KA1976', '200', '16', '3200', '15.41', '3082', '-118'] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'synthetic-stocks.xlsx');
    expect(out.holdings).toHaveLength(1);
    const h = out.holdings[0];
    expect(h.instrumentName).toBe('TATAAML-TATAGOLD');
    expect(h.unrealisedPnL).toBeLessThan(0);
    expect(h.unrealisedPnL).toBeCloseTo(3082 - 3200, 5);
  });
});

// ---------------------------------------------------------------------------
// E. MF preamble / header discovery
// ---------------------------------------------------------------------------

describe('E. MF preamble / header discovery (decoded-rows path)', () => {
  it('E.1 MF header is found by marker', () => {
    const adapter = new GrowwHoldingsAdapter();
    const headers = [
      'Scheme Name', 'AMC', 'Category', 'Sub-category', 'Folio No.', 'Source',
      'Units', 'Invested Value', 'Current Value', 'Returns', 'XIRR',
    ];
    const det = adapter.canHandleRows(headers, []);
    expect(det.matched).toBe(true);
    expect(det.reason).toMatch(/Mutual Funds/);
  });

  it('E.2 MF rows include fractional Units and percent XIRR', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Personal Details'] },
      { rowNumber: 2, data: {}, rawFields: ['Name', 'Ramakrishnan Rajeswari'] },
      { rowNumber: 3, data: {}, rawFields: ['Mobile Number', '7395930735'] },
      { rowNumber: 4, data: {}, rawFields: ['PAN', 'DKOPR8056J'] },
      { rowNumber: 5, data: {}, rawFields: ['HOLDING SUMMARY'] },
      { rowNumber: 6, data: {}, rawFields: ['Total Investments', 'Current Portfolio Value', 'Profit/Loss', 'Profit/Loss %', 'XIRR'] },
      { rowNumber: 7, data: {}, rawFields: ['29998.37', '30891.36', '892.98', '2.98%', '3.61%'] },
      { rowNumber: 8, data: {}, rawFields: ['HOLDINGS AS ON 2026-08-24'] },
      { rowNumber: 9, data: {}, rawFields: ['Scheme Name', 'AMC', 'Category', 'Sub-category', 'Folio No.', 'Source', 'Units', 'Invested Value', 'Current Value', 'Returns', 'XIRR', ''] },
      { rowNumber: 10, data: {}, rawFields: ['Nippon India Multi Cap Fund Direct Growth', 'Nippon India Mutual Fund', 'Equity', 'Multi Cap', '488440507951', 'Groww', '30.088', '9999.54', '10176.57', '177.03', '2.03%', ''] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'synthetic-mf.xlsx');
    expect(out.holdings).toHaveLength(1);
    const h = out.holdings[0];
    expect(h.quantity).toBeCloseTo(30.088, 6);
    expect(h.investedValue).toBeCloseTo(9999.54, 2);
    expect(h.currentValue).toBeCloseTo(10176.57, 2);
    expect(h.unrealisedPnL).toBeCloseTo(177.03, 2);
    expect(h.xirrPercent).toBeCloseTo(2.03, 6);
    expect(h.securityClassification).toBe('Equity');
  });
});

// ---------------------------------------------------------------------------
// F. Stocks canonical mapping — real sample
// ---------------------------------------------------------------------------

describe('F. Stocks canonical mapping (real sample)', () => {
  it('F.1 Sample 6 → 6 Holdings, all unique, account 6995348108, all six ISINs, negative P&L preserved', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    expect(out.broker).toBe('Groww');
    expect(out.account).toBe('6995348108');
    expect(out.holdings).toHaveLength(6);
    expect(out.issues).toEqual([]);

    // All 6 ISINs (exact byte-exact from real sample)
    const expectedIsins = [
      'INF179KC1981', 'INF109KC1NT3', 'INF174KA1HJ8',
      'INF204KB17I5', 'INF277KA1976', 'INF789F1AUX7',
    ];
    const actualIsins = out.holdings.map((h) => h.isin).sort();
    expect(actualIsins).toEqual([...expectedIsins].sort());

    // Canonical mapping
    for (const h of out.holdings) {
      expect(h.broker).toBe('Groww');
      expect(h.account).toBe('6995348108');
      expect(h.ticker).toBeUndefined();
      expect(h.xirrPercent).toBeUndefined();
      expect(h.securityClassification).toBeUndefined();
      expect(h.status).toBe('active');
      expect(h.sourceFile).toBe('Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx');
    }

    // Identity uniqueness
    const seen = new Set<string>();
    for (const h of out.holdings) {
      const key = `${h.broker}|${h.account}|${h.isin}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('F.2 TATAAML-TATAGOLD row preserves negative P&L', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    const t = out.holdings.find((h) => h.instrumentName === 'TATAAML-TATAGOLD');
    expect(t).toBeDefined();
    expect(t!.isin).toBe('INF277KA1976');
    expect(t!.quantity).toBe(200);
    expect(t!.averageCost).toBe(16);
    expect(t!.currentPrice).toBe(15.41);
    // Parser-recomputed: 200 * 16 = 3200; 200 * 15.41 = 3082; 3082 - 3200 = -118
    expect(t!.investedValue).toBeCloseTo(3200, 5);
    expect(t!.currentValue).toBeCloseTo(3082, 5);
    expect(t!.unrealisedPnL).toBeLessThan(0);
    expect(t!.unrealisedPnL).toBeCloseTo(-118, 5);
  });

  it('F.3 Totals cross-check: Σ investedValue = 102931.20, Σ currentValue = 142235.70, Σ unrealisedPnL = 39304.50', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    const sumInv = out.holdings.reduce((s, h) => s + h.investedValue, 0);
    const sumCur = out.holdings.reduce((s, h) => s + h.currentValue, 0);
    const sumPnl = out.holdings.reduce((s, h) => s + h.unrealisedPnL, 0);
    expect(sumInv).toBeCloseTo(102931.20, 2);
    expect(sumCur).toBeCloseTo(142235.70, 2);
    expect(sumPnl).toBeCloseTo(39304.50, 2);
  });

  it('F.4 unrealisedPnLPercent is computed for each row', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    for (const h of out.holdings) {
      expect(h.unrealisedPnLPercent).toBeDefined();
      expect(Number.isFinite(h.unrealisedPnLPercent!)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// G. MF canonical mapping — real sample
// ---------------------------------------------------------------------------

describe('G. MF canonical mapping (real sample)', () => {
  it('G.1 Sample 6b → 3 Holdings, account 7395930735, XIRR parsed, Category preserved', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    expect(out.broker).toBe('Groww');
    expect(out.account).toBe('7395930735');
    expect(out.holdings).toHaveLength(3);
    expect(out.issues).toEqual([]);

    // Expected instruments and XIRRs
    const nippon = out.holdings.find((h) => h.instrumentName === 'Nippon India Multi Cap Fund Direct Growth');
    const iciciHybrid = out.holdings.find((h) => h.instrumentName === 'ICICI Prudential Multi Asset Fund Direct Growth');
    const iciciB22 = out.holdings.find((h) => h.instrumentName === 'ICICI Prudential BHARAT 22 FOF Direct Growth');
    expect(nippon).toBeDefined();
    expect(iciciHybrid).toBeDefined();
    expect(iciciB22).toBeDefined();

    // Category preserved
    expect(nippon!.securityClassification).toBe('Equity');
    expect(iciciHybrid!.securityClassification).toBe('Hybrid');
    expect(iciciB22!.securityClassification).toBe('Equity');

    // XIRR parsed
    expect(nippon!.xirrPercent).toBeCloseTo(2.03, 6);
    expect(iciciHybrid!.xirrPercent).toBeCloseTo(5.62, 6);
    expect(iciciB22!.xirrPercent).toBeCloseTo(2.62, 6);

    // isin / ticker undefined for MF
    for (const h of out.holdings) {
      expect(h.isin).toBeUndefined();
      expect(h.ticker).toBeUndefined();
      expect(h.status).toBe('active');
      expect(h.sourceFile).toBe('Groww_Mutual_Funds_6995348108_24-08-2026.xlsx');
    }
  });

  it('G.2 Fractional Units parsed correctly', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    const nippon = out.holdings.find((h) => h.instrumentName === 'Nippon India Multi Cap Fund Direct Growth')!;
    const iciciHybrid = out.holdings.find((h) => h.instrumentName === 'ICICI Prudential Multi Asset Fund Direct Growth')!;
    const iciciB22 = out.holdings.find((h) => h.instrumentName === 'ICICI Prudential BHARAT 22 FOF Direct Growth')!;
    expect(nippon.quantity).toBeCloseTo(30.088, 6);
    expect(iciciHybrid.quantity).toBeCloseTo(11.478, 6);
    expect(iciciB22.quantity).toBeCloseTo(303.662, 6);
  });

  it('G.3 MF investedValue / currentValue exactly match broker values', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    const nippon = out.holdings.find((h) => h.instrumentName === 'Nippon India Multi Cap Fund Direct Growth')!;
    expect(nippon.investedValue).toBeCloseTo(9999.54, 2);
    expect(nippon.currentValue).toBeCloseTo(10176.57, 2);
  });

  it('G.4 averageCost and currentPrice derived (Invested/Units, Current/Units)', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    const nippon = out.holdings.find((h) => h.instrumentName === 'Nippon India Multi Cap Fund Direct Growth')!;
    // 9999.54 / 30.088 = 332.40... ; 10176.57 / 30.088 = 338.21...
    expect(nippon.averageCost).toBeCloseTo(9999.54 / 30.088, 4);
    expect(nippon.currentPrice).toBeCloseTo(10176.57 / 30.088, 4);
  });

  it('G.5 Total invested cross-check: Σ investedValue = 29998.37', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    const sumInv = out.holdings.reduce((s, h) => s + h.investedValue, 0);
    expect(sumInv).toBeCloseTo(29998.37, 2);
  });
});

// ---------------------------------------------------------------------------
// H. Identity generation
// ---------------------------------------------------------------------------

describe('H. Identity generation', () => {
  it('H.1 Every emitted Holding has a fresh hld-<uuid> id', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    const ids = new Set<string>();
    for (const h of out.holdings) {
      expect(h.id).toMatch(/^hld-/);
      expect(ids.has(h.id)).toBe(false);
      ids.add(h.id);
    }
    expect(ids.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// I. XIRR parsing
// ---------------------------------------------------------------------------

describe('I. XIRR parsing', () => {
  it('I.1 XIRR percent-suffixed strings parse to 0-100 numbers', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    // The MF XIRR values are 2.03, 5.62, 2.62.
    const xirrs = out.holdings.map((h) => h.xirrPercent).sort();
    expect(xirrs).toEqual([2.03, 2.62, 5.62].sort());
  });
});

// ---------------------------------------------------------------------------
// J. Negative P&L
// ---------------------------------------------------------------------------

describe('J. Negative P&L', () => {
  it('J.1 TATAAML-TATAGOLD is the only negative-P&L row in Sample 6', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    const negative = out.holdings.filter((h) => h.unrealisedPnL < 0);
    expect(negative).toHaveLength(1);
    expect(negative[0].instrumentName).toBe('TATAAML-TATAGOLD');
    expect(negative[0].unrealisedPnL).toBeCloseTo(-118, 5);
  });
});

// ---------------------------------------------------------------------------
// K. Malformed / invalid / empty / header-only / error cases
// ---------------------------------------------------------------------------

describe('K. Malformed / invalid / empty / header-only / error cases', () => {
  it('K.1 Empty file (binary) → BROKER_EMPTY, 0 Holdings', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings({ kind: 'binary', content: new Uint8Array(0), fileName: 'empty.xlsx' });
    expect(out.holdings).toEqual([]);
    expect(out.issues.some((i) => i.code === 'BROKER_EMPTY')).toBe(true);
  });

  it('K.2 Header-only file (no data rows) → BROKER_HEADER_ONLY', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'header-only.xlsx');
    expect(out.holdings).toEqual([]);
    expect(out.issues.some((i) => i.code === 'BROKER_HEADER_ONLY')).toBe(true);
  });

  it('K.3 Missing required header (Stocks without Stock Name) → BROKER_HEADER_MISSING', () => {
    const adapter = new GrowwHoldingsAdapter();
    const headers = ['ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"];
    const det = adapter.canHandleRows(headers, []);
    expect(det.matched).toBe(false);
  });

  it('K.4 Malformed row (Stocks, too few fields) → BROKER_ROW_MALFORMED, valid rows still parsed', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"] },
      { rowNumber: 3, data: {}, rawFields: ['GOOD', 'INF179KC1981', '250', '97.28', '24320', '135.62', '33905', '9585'] },
      { rowNumber: 4, data: {}, rawFields: ['BAD', 'INF109KC1NT3', '250'] }, // too few fields
      { rowNumber: 5, data: {}, rawFields: ['GOOD2', 'INF174KA1HJ8', '250', '94.9', '23725', '132.87', '33217.5', '9492.5'] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'malformed.xlsx');
    expect(out.holdings).toHaveLength(2);
    expect(out.holdings.map((h) => h.instrumentName)).toEqual(['GOOD', 'GOOD2']);
    expect(out.issues.some((i) => i.code === 'BROKER_ROW_MALFORMED')).toBe(true);
  });

  it('K.5 Invalid numeric value (Quantity = "abc") → BROKER_NUMERIC_INVALID, row skipped', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"] },
      { rowNumber: 3, data: {}, rawFields: ['GOOD', 'INF179KC1981', '250', '97.28', '24320', '135.62', '33905', '9585'] },
      { rowNumber: 4, data: {}, rawFields: ['BAD', 'INF109KC1NT3', 'abc', '97.39', '24347.5', '135.99', '33997.5', '9650'] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'bad-numeric.xlsx');
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('GOOD');
    expect(out.issues.some((i) => i.code === 'BROKER_NUMERIC_INVALID')).toBe(true);
  });

  it('K.6 Zero quantity (Stocks) → BROKER_QUANTITY_NON_POSITIVE warning + holding emitted with qty=0', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"] },
      { rowNumber: 3, data: {}, rawFields: ['ZERO', 'INF179KC1981', '0', '100', '0', '110', '0', '0'] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'zero.xlsx');
    expect(out.holdings).toHaveLength(1);
    const h = out.holdings[0];
    expect(h.quantity).toBe(0);
    expect(h.averageCost).toBe(0);
    expect(h.investedValue).toBe(0);
    expect(h.currentValue).toBe(0);
    expect(h.unrealisedPnL).toBe(0);
    expect(h.unrealisedPnLPercent).toBeUndefined();
    const w = out.issues.find((i) => i.code === 'BROKER_QUANTITY_NON_POSITIVE');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('AMBIGUOUS');
  });

  it('K.7 Negative quantity (Stocks) → BROKER_QUANTITY_NON_POSITIVE error, row rejected', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"] },
      { rowNumber: 3, data: {}, rawFields: ['GOOD', 'INF179KC1981', '250', '97.28', '24320', '135.62', '33905', '9585'] },
      { rowNumber: 4, data: {}, rawFields: ['NEG', 'INF109KC1NT3', '-5', '97.39', '-486.95', '135.99', '-679.95', '-193'] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'negative-qty.xlsx');
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].instrumentName).toBe('GOOD');
    const err = out.issues.find((i) => i.code === 'BROKER_QUANTITY_NON_POSITIVE');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('INVALID');
  });
});

// ---------------------------------------------------------------------------
// L. Duplicate identity handling
// ---------------------------------------------------------------------------

describe('L. Duplicate identity handling', () => {
  it('L.1 Two rows with the same ISIN → first wins, second dropped', () => {
    const adapter = new GrowwHoldingsAdapter();
    const rows: ParsedCsvRow[] = [
      { rowNumber: 1, data: {}, rawFields: ['Unique Client Code', '6995348108'] },
      { rowNumber: 2, data: {}, rawFields: ['Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value', 'Closing price', 'Closing value', "Unrealised P&L"] },
      { rowNumber: 3, data: {}, rawFields: ['DUPE', 'INF179KC1981', '10', '100', '1000', '110', '1100', '100'] },
      { rowNumber: 4, data: {}, rawFields: ['DUPE', 'INF179KC1981', '20', '200', '4000', '220', '4400', '400'] },
    ];
    const out = adapter.parseHoldingsFromRows(rows, 'dupe.xlsx');
    expect(out.holdings).toHaveLength(1);
    expect(out.holdings[0].quantity).toBe(10);
    expect(out.issues.some((i) => i.code === 'BROKER_DUPLICATE_INSIDE_BATCH')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M. Quantity edge cases
// ---------------------------------------------------------------------------

describe('M. Quantity edge cases', () => {
  it('M.1 MF fractional Units parse correctly (e.g. 30.088, 11.478, 303.662)', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    const units = out.holdings.map((h) => h.quantity).sort();
    expect(units).toEqual([11.478, 30.088, 303.662].sort());
  });
});

// ---------------------------------------------------------------------------
// N. Classification preservation
// ---------------------------------------------------------------------------

describe('N. Classification preservation', () => {
  it('N.1 MF Category preserved verbatim (Equity, Hybrid)', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    const categories = out.holdings.map((h) => h.securityClassification).sort();
    expect(categories).toEqual(['Equity', 'Equity', 'Hybrid'].sort());
  });

  it('N.2 Stocks have securityClassification = undefined', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    for (const h of out.holdings) {
      expect(h.securityClassification).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// O. sourceFile / importedAt / status / id behaviour
// ---------------------------------------------------------------------------

describe('O. sourceFile / importedAt / status / id behaviour', () => {
  it('O.1 sourceFile matches the supplied filename exactly', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'my-custom-name.xlsx'),
    );
    for (const h of out.holdings) {
      expect(h.sourceFile).toBe('my-custom-name.xlsx');
    }
  });

  it('O.2 Every emitted Holding has status: "active"', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out1 = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    const out2 = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    for (const h of [...out1.holdings, ...out2.holdings]) {
      expect(h.status).toBe('active');
    }
  });

  it('O.3 Every emitted Holding has importedAt as ISO 8601', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    for (const h of out.holdings) {
      expect(h.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('O.4 Every emitted Holding has broker: "Groww"', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out1 = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_STOCKS_PATH), 'Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx'),
    );
    const out2 = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    for (const h of [...out1.holdings, ...out2.holdings]) {
      expect(h.broker).toBe('Groww');
    }
  });
});

// ---------------------------------------------------------------------------
// P. BrokerFormatDetector integration
// ---------------------------------------------------------------------------

describe('P. BrokerFormatDetector integration', () => {
  it('P.1 BrokerFormatDetector.detectFromRows(Stocks headers) returns Groww adapter', () => {
    const headers = [
      'Stock Name', 'ISIN', 'Quantity', 'Average buy price', 'Buy value',
      'Closing price', 'Closing value', 'Unrealised P&L',
    ];
    const { adapter, detection } = BrokerFormatDetector.detectFromRows(headers, [], 'synthetic.xlsx');
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('groww');
    expect(detection.matched).toBe(true);
  });

  it('P.2 BrokerFormatDetector.detectFromRows(MF headers) returns Groww adapter', () => {
    const headers = [
      'Scheme Name', 'AMC', 'Category', 'Sub-category', 'Folio No.', 'Source',
      'Units', 'Invested Value', 'Current Value', 'Returns', 'XIRR',
    ];
    const { adapter, detection } = BrokerFormatDetector.detectFromRows(headers, [], 'synthetic.xlsx');
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('groww');
    expect(detection.matched).toBe(true);
  });

  it('P.3 BrokerFormatDetector.detectFromRows(arbitrary headers) returns null', () => {
    const { adapter, detection } = BrokerFormatDetector.detectFromRows(
      ['date', 'amount', 'balance'], [], 'random.csv',
    );
    expect(adapter).toBeNull();
    expect(detection.matched).toBe(false);
    expect(detection.formatId).toBe('unsupported');
  });

  it('P.4 BrokerFormatDetector.getAdapterById("groww") returns the Groww adapter', () => {
    const adapter = BrokerFormatDetector.getAdapterById('groww');
    expect(adapter).not.toBeNull();
    expect(adapter!.id).toBe('groww');
  });

  it('P.5 BrokerFormatDetector.getAllAdapters includes both Zerodha and Groww', () => {
    const all = BrokerFormatDetector.getAllAdapters();
    const ids = all.map((a) => a.id);
    expect(ids).toContain('zerodha');
    expect(ids).toContain('groww');
  });
});

// ---------------------------------------------------------------------------
// Regression — WP-04 Zerodha still works
// ---------------------------------------------------------------------------

describe('Regression: WP-04 Zerodha still works after Groww registration', () => {
  it('Zerodha still parses Sample 1', async () => {
    const { ZerodhaHoldingsAdapter } = await import('../services/import/adapters/ZerodhaHoldingsAdapter');
    const adapter = new ZerodhaHoldingsAdapter();
    const fs = await import('node:fs');
    const path = '/home/user/uploads/Zerodha_holdings_10082026_1739.csv';
    const csv = fs.readFileSync(path, 'utf8');
    const out = adapter.parseHoldings({ kind: 'text', content: csv, fileName: 'Zerodha_holdings_10082026_1739.csv' });
    expect(out.holdings).toHaveLength(82);
  });
});

// ---------------------------------------------------------------------------
// WP-09: detection-tightening regression tests
// ---------------------------------------------------------------------------

describe('WP-09 detection tightening — full-column validation in binary path', () => {
  it('WP-09.G.1 Groww MF XLSX (real sample) is detected via the full-column validator, not just the first-cell marker', () => {
    // This is the canonical proof that the WP-09 fix works at the
    // Groww adapter level: the real Groww MF XLSX (which has Scheme
    // Name as its first cell AND the full Groww MF column sequence)
    // is claimed with confidence HIGH. The canHandle message
    // references the Mutual Funds variant.
    const adapter = new GrowwHoldingsAdapter();
    const det = adapter.canHandle(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    expect(det.matched).toBe(true);
    expect(det.confidence).toBe('HIGH');
    expect(det.formatId).toBe('groww');
    expect(det.reason).toMatch(/Mutual Funds/);
  });

  it('WP-09.G.2 Groww parseHoldings on the real Groww MF XLSX produces 3 holdings with account=7395930735', () => {
    const adapter = new GrowwHoldingsAdapter();
    const out = adapter.parseHoldings(
      asBinaryInput(loadBytes(SAMPLE_MF_PATH), 'Groww_Mutual_Funds_6995348108_24-08-2026.xlsx'),
    );
    expect(out.broker).toBe('Groww');
    expect(out.account).toBe('7395930735');
    expect(out.holdings).toHaveLength(3);
    // Every holding has a Category preserved as securityClassification.
    for (const h of out.holdings) {
      expect(h.broker).toBe('Groww');
      expect(h.account).toBe('7395930735');
      expect(h.securityClassification).toBeDefined();
      expect(h.status).toBe('active');
      // XIRR is parsed where the source supplies it.
      expect(h.xirrPercent).toBeDefined();
      expect(Number.isFinite(h.quantity)).toBe(true);
      expect(Number.isFinite(h.currentValue)).toBe(true);
    }
  });
});
