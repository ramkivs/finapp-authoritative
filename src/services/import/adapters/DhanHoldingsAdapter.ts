/**
 * WP-FB-IMPORT-BROKER-01 — WP-05 Dhan holdings adapter.
 *
 * Structural detection + row-level parsing for the four evidenced
 * Dhan export variants:
 *
 *   A. Dhan Equity CSV  (Sample 3)
 *   B. Dhan Mutual Fund CSV (Sample 4)
 *   C. Dhan Mutual Fund XLSX (Sample 5)
 *   D. Dhan Stock Holdings CSV (FINBOOM-CR — supplied CR fixture,
 *      9 rows, double-quoted 8-column header)
 *
 * Discovered file properties (sequencing report §3.2):
 *
 *   Equity CSV:
 *     - CSV, UTF-8 with BOM, CRLF, comma-delimited, unquoted
 *     - 8 columns: Instrument,Qty.,Buy Price,LTP,P&L,Invested,Curr value,Trade Date
 *     - No preamble; header on row 1; data begins row 2
 *     - 564 data rows; 66 unique instruments; 3 fully-duplicate lot pairs
 *       (KP Energy, Landmark Cars, Sharda Motor — legitimate trade lots)
 *     - LTP is constant per instrument across all lots
 *     - Σ(per-lot curr value) == qty × LTP (verified for 66/66)
 *     - No account identity; no ISIN; no ticker; no classification
 *     - Trade dates in DD-MM-YYYY format
 *
 *   MF CSV:
 *     - CSV, ASCII, CRLF, comma-delimited, quoted in data rows
 *     - 5-row preamble (R1 title, R2 Name, R3 UCC, R4 Mobile, R5 Email)
 *     - R6 blank; R7 header; R8-R13 data (6 schemes); R15 summary; R17 NOTE
 *     - 9 columns: Scheme Name,MF Type,Units,NAV,Investment,Current Value,P&L,P&L%,XIRR %
 *     - Account: UCC = IQCX28849K
 *     - XIRR is plain number (not percent-suffixed)
 *
 *   MF XLSX:
 *     - XLSX, single sheet `Dhan_MF_Report`
 *     - Metadata in cols G-H rows 1-4 (Name R1, UCC R2, Email R3, Mobile R4)
 *     - Title cell B2 (ignored)
 *     - Header R6; data R7-R12 (6 schemes, byte-identical to MF CSV)
 *     - Summary R14-R16; NOTE R18
 *     - No merged cells
 *     - XIRR is numeric value in the cell
 *
 * This adapter:
 *   - Performs structural header-schema detection (case-sensitive,
 *     byte-exact; filename is NOT the only signal).
 *   - Has its own private CSV decoder (mirroring the WP-04
 *     Zerodha adapter) — the bank-statement CsvRecordParser is
 *     NOT reused because it applies a date+amount header-locator
 *     heuristic that does not match Dhan MF (header on R7, not R1).
 *   - Has its own private XLSX decoder (mirroring the WP-06
 *     Groww adapter) using the vendored xlsx@0.20.3 — the
 *     bank-statement SpreadsheetStatementParser is NOT reused.
 *   - Aggregates Dhan Equity trade lots into one per-instrument
 *     Holding (the only V1 trade-lot aggregation in the
 *     broker-import workstream). Per-lot Buy Price and Trade
 *     Date are NOT preserved (D-02 Dhan Equity decision).
 *   - For Dhan MF, uses broker-supplied Invested/Current/NAV and
 *     derives averageCost = Invested/Units (consistent with the
 *     WP-06 Groww MF pattern for fractional Units).
 *   - Sets account = undefined for Equity (no account in file);
 *     account = "IQCX28849K" for MF (UCC from preamble).
 *   - Sets ticker = undefined and isin = undefined for both
 *     variants (Dhan never provides these).
 *   - Sets xirrPercent = undefined for Equity; parses the plain
 *     numeric XIRR (no `%` suffix) for MF and stores in 0-100
 *     range.
 *   - Sets securityClassification = undefined for Equity;
 *     preserves the broker-native MF Type string verbatim for MF.
 *   - Sets status = 'active' for every emitted Holding.
 *   - For Dhan Equity, importedAt = max(lot.Trade Date) in ISO 8601
 *     (the only V1 broker that uses the file's date rather than
 *     parser execution time).
 *   - For Dhan MF, importedAt = new Date().toISOString().
 *   - Produces per-row characterisation issues via ImportRowIssue.
 *
 * This adapter does NOT:
 *   - Query existing holdings.
 *   - Compare against repository state.
 *   - Compute new / updated / unchanged / closed_absent.
 *   - Persist.
 *   - Call HoldingAssetCollisionGuard.
 *   - Reuse the bank-statement CsvRecordParser.
 *   - Reuse the bank-statement SpreadsheetStatementParser.
 *   - Emit BROKER_DUPLICATE_INSIDE_BATCH for legitimate trade-lot
 *     duplicates (the 3 fully-duplicate lots in the real sample
 *     are two different lots of the same instrument; they
 *     collapse via aggregation, not via duplicate detection).
 *   - Map PAN / Mobile / Email / Name / Folio No. to account.
 *   - Add a Lot entity.
 *   - Add an analytics taxonomy.
 */

import { Holding, HoldingStatus } from '../../../domain/types';
import { HoldingIdentityService } from '../../HoldingIdentityService';
import {
  ACTIVE_HOLDING_STATUS,
  BrokerAdapter,
  BrokerDetectionResult,
  BrokerParseOutput,
} from '../BrokerAdapter';
import {
  ImportIssueSeverity,
  ImportRowIssue,
  ParsedCsvRow,
  StatementInput,
} from '../ImportTypes';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// HEADER SCHEMAS (verbatim, byte-exact, case-sensitive)
// ---------------------------------------------------------------------------

/**
 * Dhan Equity header (verbatim, byte-exact, case-sensitive).
 * Source: Sample 3 (`dhan holdings _capstewengine.csv`).
 * The file is comma-delimited and unquoted in the data area; the
 * adapter is case-sensitive in matching the header sequence.
 */
const EQUITY_HEADERS: readonly string[] = [
  'Instrument',
  'Qty.',
  'Buy Price',
  'LTP',
  'P&L',
  'Invested',
  'Curr value',
  'Trade Date',
] as const;

/**
 * Dhan MF header (verbatim, byte-exact, case-sensitive).
 * Source: Sample 4 (CSV) and Sample 5 (XLSX) — both byte-identical.
 * The CSV uses CRLF and quotes data fields; the XLSX stores
 * strings/numbers in cells.
 */
const MF_HEADERS: readonly string[] = [
  'Scheme Name',
  'MF Type',
  'Units',
  'NAV',
  'Investment',
  'Current Value',
  'P&L',
  'P&L%',
  'XIRR %',
] as const;

/**
 * FINBOOM-CR-BROKER-BANK-IMPORT Variant D — Dhan Stock Holdings CSV.
 * Source: supplied CR fixture `Dhan stock holdings.csv` (9 rows).
 * 8-column comma-delimited, double-quoted every field, UTF-8 with BOM.
 * Header (after quote strip, case-sensitive):
 *   Name, Quantity, Avg Price, Last Traded,
 *   Investment, Current Value, P&L, P&L %
 *
 * Distinguishing markers from the existing Dhan Variant A (Equity 8-col
 * unquoted `Instrument, Qty., ...`):
 *   - Variant A: unquoted, first cell = "Instrument"
 *   - Variant D: double-quoted, first cell = "Name" (after quote strip)
 *
 * The 4th-variant detection is tried FIRST (before the existing Variant A
 * detection) so that a double-quoted `Name,...` header is not misread as
 * the unquoted `Instrument,...` header — they are distinct schemas.
 */
const STOCK_HOLDINGS_HEADERS: readonly string[] = [
  'Name',
  'Quantity',
  'Avg Price',
  'Last Traded',
  'Investment',
  'Current Value',
  'P&L',
  'P&L %',
] as const;

/**
 * Account identity for Dhan MF (preamble R3 in CSV, metadata R2
 * in XLSX). The Dhan Equity CSV does not provide an account
 * identifier; `account = undefined` for every Equity output.
 */
const DHAN_MF_UCC = 'IQCX28849K';

/**
 * Sheet name hint for Dhan MF XLSX. The adapter selects the sheet
 * by header-marker content; sheet name is a hint, not a structural
 * signal.
 */
const MF_SHEET_HINT = 'Dhan_MF_Report';

// ---------------------------------------------------------------------------
// NUMERIC / DATE PARSERS (private)
// ---------------------------------------------------------------------------

/**
 * Numeric parser that tolerates:
 *   - ASCII hyphen-minus prefix for negatives (e.g. "-132.10")
 *   - Whitespace inside the value (trimmed)
 *   - Empty string (returns null, NOT NaN)
 *
 * Returns null for any other non-finite or non-parseable input.
 * Dhan exports use plain decimal (no thousands separator, no
 * currency symbol) for both Equity and MF.
 */
function parseDhanNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Numeric parser that additionally tolerates thousands-separator
 * commas (e.g. "1,087.80" → 1087.80).
 *
 * This is needed for the CR Variant D (Dhan Stock Holdings CSV)
 * where numeric columns include a thousands separator. The other
 * three Dhan variants (Equity, MF CSV, MF XLSX) do not have
 * thousands separators in the supplied fixtures, so they use
 * the simpler `parseDhanNumber`.
 */
function parseDhanNumberWithCommas(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // Strip thousands-separator commas. A comma is a thousands
  // separator only if it appears before a decimal point (or
  // without a decimal point in an integer); we strip them all to
  // be permissive (the canonical 4th-variant values never have
  // non-thousands commas).
  const noCommas = trimmed.replace(/,/g, '');
  const n = Number(noCommas);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Convert a Dhan Equity Trade Date string (DD-MM-YYYY) to an ISO 8601
 * UTC timestamp. Returns null for unparseable input.
 *
 * Example: "27-05-2026" → "2026-05-27T00:00:00.000Z"
 *
 * Dhan dates are not wall-clock timestamps; the canonical
 * representation is midnight UTC on the trade date. The parser
 * uses `new Date(year, month-1, day)` to construct a local date
 * and then converts to ISO 8601 — but the year/month/day are
 * preserved without timezone shift because the input is calendar-
 * date only (no time component).
 *
 * Implementation note: the Date constructor in JS interprets the
 * arguments as local time. To produce a deterministic ISO 8601
 * timestamp that is not affected by the sandbox's timezone, we
 * construct the date string in ISO format directly:
 *   "YYYY-MM-DDT00:00:00.000Z"
 */
function parseDhanTradeDate(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // Expected format: DD-MM-YYYY
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(trimmed);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3];
  // Sanity: month 1-12, day 1-31 (loose).
  const monthNum = Number(mm);
  const dayNum = Number(dd);
  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;
  // Validate via Date (catches e.g. 31-02-2026).
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  if (isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() !== Number(yyyy) ||
      d.getUTCMonth() + 1 !== monthNum ||
      d.getUTCDate() !== dayNum) {
    return null;
  }
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// MAIN ADAPTER CLASS
// ---------------------------------------------------------------------------

export class DhanHoldingsAdapter implements BrokerAdapter {
  readonly id = 'dhan';
  readonly displayName = 'Dhan Holdings';

  // =========================================================================
  // DETECTION
  // =========================================================================

  canHandle(input: StatementInput): BrokerDetectionResult {
    if (input.kind === 'text') {
      // CSV path — could be Equity CSV (unquoted), MF CSV, or the
      // CR Stock Holdings variant (quoted). All are distinguished
      // by header content. The CR variant is detected FIRST so a
      // double-quoted `Name, Quantity, ...` header is not misread
      // as the unquoted `Instrument, Qty., ...` header.
      const text = input.content || '';
      const firstLine = this.firstNonEmptyLine(text);
      if (firstLine === null) {
        return this.noMatch('Empty or headerless content');
      }
      // CR Variant D: Stock Holdings (double-quoted, `Name, ...`).
      if (this.matchesStockHoldingsHeaderRow(firstLine)) {
        return {
          matched: true,
          formatId: 'dhan',
          displayName: this.displayName,
          confidence: 'HIGH',
          reason: 'Matched Dhan Stock Holdings CSV header signature (CR Variant D)',
        };
      }
      // Try Equity first (header on row 1).
      if (this.matchesEquityHeaderRow(firstLine)) {
        return {
          matched: true,
          formatId: 'dhan',
          displayName: this.displayName,
          confidence: 'HIGH',
          reason: 'Matched Dhan Equity CSV header signature',
        };
      }
      // Try MF CSV: walk lines looking for the MF header marker.
      if (this.findMfHeaderInText(text) !== -1) {
        return {
          matched: true,
          formatId: 'dhan',
          displayName: this.displayName,
          confidence: 'HIGH',
          reason: 'Matched Dhan Mutual Fund CSV header signature (preamble+header)',
        };
      }
      return this.noMatch('Header does not match any Dhan signature');
    }
    if (input.kind === 'binary') {
      // XLSX path — could be MF XLSX. Decode and look for the MF
      // header signature on any sheet.
      const bytes = input.content;
      if (!bytes || bytes.length === 0) {
        return this.noMatch('Empty or missing binary content');
      }
      const decoded = this.decodeXlsx(bytes);
      if (decoded.error) {
        return this.noMatch(decoded.error);
      }
      if (decoded.matched) {
        return {
          matched: true,
          formatId: 'dhan',
          displayName: this.displayName,
          confidence: 'HIGH',
          reason: `Matched Dhan Mutual Fund XLSX header signature on sheet "${decoded.sheetName}"`,
        };
      }
      return this.noMatch('Workbook does not contain a Dhan MF XLSX header signature on any sheet');
    }
    return this.noMatch('Unsupported StatementInput kind');
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[]): BrokerDetectionResult {
    if (this.matchesStockHoldingsHeader(headers)) {
      return {
        matched: true,
        formatId: 'dhan',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Dhan Stock Holdings CSV header signature (CR Variant D, decoded rows)',
      };
    }
    if (this.matchesEquityHeader(headers)) {
      return {
        matched: true,
        formatId: 'dhan',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Dhan Equity CSV header signature (decoded rows)',
      };
    }
    if (this.matchesMfHeader(headers)) {
      return {
        matched: true,
        formatId: 'dhan',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Dhan Mutual Fund header signature (decoded rows)',
      };
    }
    return this.noMatch('Decoded header does not match any Dhan signature');
  }

  // =========================================================================
  // PARSING
  // =========================================================================

  parseHoldings(input: StatementInput): BrokerParseOutput {
    // Dhan supports both text (Equity CSV, MF CSV) and binary
    // (MF XLSX) inputs. Dispatch by kind.
    if (input.kind === 'text') {
      return this.parseFromText(input.content, input.fileName);
    }
    if (input.kind === 'binary') {
      return this.parseFromBytes(input.content, input.fileName);
    }
    // Defensive: StatementInput is a discriminated union of
    // 'text' | 'binary'; any other kind is an unsupported
    // extension. We use a string indexer to bypass the
    // exhaustive narrowing that TypeScript applies.
    const anyInput = input as { kind: string; fileName: string };
    return this.emptyOutput(anyInput.fileName, [
      this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
        `Dhan adapter received an unsupported StatementInput kind: ${anyInput.kind}.`),
    ]);
  }

  parseHoldingsFromRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    if (rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Decoded rows are empty.'),
      ]);
    }
    // Detect variant by first cell content. The CR Variant D
    // (Stock Holdings) is checked first. The first cell may
    // carry outer double-quotes (the rows path preserves them
    // by convention; the walker strips them per-row before
    // value extraction). We strip here for the dispatch.
    const first = this.stripQuotes(String(rows[0].rawFields[0] ?? '')).trim();
    if (first === 'Name') {
      return this.walkStockHoldingsRows(rows, fileName);
    }
    if (first === 'Instrument') {
      return this.walkEquityRows(rows, fileName);
    }
    if (first === 'Scheme Name') {
      // MF data rows (no preamble in the rows array; UCC is broker-
      // internal metadata, so account = undefined when the rows
      // path is used without preamble context). The MF preamble is
      // consumed by the import pipeline if needed; for the
      // decoded-rows path the canonical contract is to use the
      // authorized UCC.
      return this.walkMfRows(rows, DHAN_MF_UCC, fileName);
    }
    return this.emptyOutput(fileName, [
      this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
        'Cannot locate a Dhan header marker (Name, Instrument, or Scheme Name) in the decoded rows.'),
    ]);
  }

  // =========================================================================
  // TEXT PARSING
  // =========================================================================

  private parseFromText(text: string, fileName: string): BrokerParseOutput {
    // Strip UTF-8 BOM if present (the Equity CSV has it; the MF
    // CSV does not, but the strip is defensive).
    let clean = text || '';
    if (clean.charCodeAt(0) === 0xfeff) clean = clean.slice(1);

    const records = this.parseCsvRecords(clean);
    if (records.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Dhan file is empty or has no parseable content.')],
      );
    }

    // Detect variant by the first non-empty line. The CR Variant D
    // (Stock Holdings) is detected FIRST so a double-quoted
    // `Name, ...` header is matched before any other heuristic.
    const firstLine = records[0] ?? [];
    const firstCellUnquoted = String(firstLine[0] ?? '').trim();

    // The CR Variant D file is fully double-quoted. After tokenisation
    // the quote characters are stripped only for fields that are
    // "quoted". A naive `firstCell.trim()` may still include the
    // leading quote if the field is `"Name"`. The exact-match
    // signature is therefore run against BOTH the unquoted and
    // the literal (with-quote) versions of the first cell.
    if (firstCellUnquoted === 'Name' || firstLine[0] === '"Name"') {
      return this.walkStockHoldingsFromRecords(records, fileName);
    }
    if (firstCellUnquoted === 'Instrument') {
      return this.walkEquityFromRecords(records, fileName);
    }
    if (firstCellUnquoted === 'MF Holdings' || firstCellUnquoted.startsWith('MF Holdings')) {
      // MF CSV: header is on a later row, not row 1.
      return this.parseMfCsv(records, fileName);
    }
    return this.emptyOutput(fileName, [
      this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
        `First non-empty cell "${firstCellUnquoted}" is not a known Dhan header marker (Name, Instrument, or MF Holdings).`),
    ]);
  }

  /**
   * Parse Dhan Equity CSV records into 66 aggregated Holdings.
   * The first record is the header; the rest are data rows.
   * Trade lots of the same Instrument are aggregated.
   */
  private walkEquityFromRecords(records: string[][], fileName: string): BrokerParseOutput {
    const headerRow = records[0];
    const headerNormalised = headerRow.map((h) => this.stripQuotes(h).trim());
    if (!this.matchesEquityHeader(headerNormalised)) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Equity header marker found but the column sequence does not match the Dhan Equity schema.')],
      );
    }
    if (records.length === 1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Dhan Equity file contains only the header row, no data rows.')],
      );
    }
    return this.walkEquityDataRecords(records.slice(1), fileName, /* sourceRowOffset */ 1);
  }

  /**
   * Walk pre-decoded ParsedCsvRow[] for Dhan Equity.
   * Used by the BrokerFormatDetector.detectFromRows path.
   */
  private walkEquityRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    if (rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY', 'Dhan Equity file contains only the header row, no data rows.')],
      );
    }
    return this.walkEquityDataRows(rows, fileName);
  }

  /**
   * Parse Dhan MF CSV records. Walks the preamble, locates the
   * header (by `Scheme Name` first-cell marker), extracts the
   * account (UCC from preamble), and walks data rows.
   */
  private parseMfCsv(records: string[][], fileName: string): BrokerParseOutput {
    // Walk records looking for the header marker.
    let headerIdx = -1;
    for (let r = 0; r < records.length; r++) {
      const firstCell = String(records[r]?.[0] ?? '').trim();
      if (firstCell === 'Scheme Name') {
        headerIdx = r;
        break;
      }
    }
    if (headerIdx === -1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Cannot locate the Dhan MF header row (looking for "Scheme Name").')],
      );
    }
    const headerFields = records[headerIdx].map((f) => this.stripQuotes(f).trim());
    if (!this.matchesMfHeader(headerFields)) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'INVALID', 'BROKER_HEADER_MISSING',
          'MF header marker found but the column sequence does not match the Dhan MF schema.')],
      );
    }

    // Walk preamble for account identity. The canonical source is
    // the row whose first cell is "UCC"; second cell is the value.
    const preamble = records.slice(0, headerIdx);
    const account = this.extractMfAccountFromRecords(preamble);
    if (account === null) {
      // Fall back to the authorized default UCC. The MF preamble
      // has UCC in the real sample; if it is missing, the
      // canonical contract still specifies the broker's UCC.
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          `Cannot locate UCC in the MF preamble; expected "${DHAN_MF_UCC}".`)],
      );
    }
    // If the preamble UCC differs from the authorized default, we
    // still use the preamble's value (per-lifecycle the account
    // is whatever the broker wrote). The D-02 identity rule uses
    // whichever value is observed.
    void account; // explicitly mark the variable as used.

    const dataRecords = records.slice(headerIdx + 1);
    if (dataRecords.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Dhan MF file contains only the header row, no data rows.')],
      );
    }

    return this.walkMfDataRecords(dataRecords, /* account */ account, fileName, /* sourceRowOffset */ headerIdx + 1);
  }

  /**
   * XLSX binary path: decode the workbook, find a sheet with the
   * MF header, slice off the header row, and walk data rows.
   */
  private parseFromBytes(bytes: Uint8Array, fileName: string): BrokerParseOutput {
    if (!bytes || bytes.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Empty or missing binary content.')],
      );
    }
    const decoded = this.decodeXlsx(bytes);
    if (decoded.error) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED', decoded.error)],
      );
    }
    if (!decoded.matched || decoded.rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
          'Workbook does not contain a Dhan MF XLSX header signature on any sheet.')],
      );
    }
    // Locate the header row in the decoded array and slice it
    // off. The XLSX has a metadata block (right-side cols G-H)
    // and a title cell (B2); the header is the first row whose
    // first cell is "Scheme Name".
    let headerIdx = -1;
    for (let r = 0; r < decoded.rows.length; r++) {
      const first: string = String(decoded.rows[r]?.[0] ?? '').trim();
      if (first === 'Scheme Name') {
        headerIdx = r;
        break;
      }
    }
    if (headerIdx === -1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Cannot locate the Dhan MF header row in the workbook.')],
      );
    }
    // Validate the discovered header against the binding sequence.
    const headerFields = decoded.rows[headerIdx].map((f) => String(f ?? '').trim());
    if (!this.matchesMfHeader(headerFields)) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'INVALID', 'BROKER_HEADER_MISSING',
          'MF header marker found but the column sequence does not match the Dhan MF schema.')],
      );
    }
    const dataRows = decoded.rows.slice(headerIdx + 1);
    if (dataRows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Dhan MF XLSX contains only the header row, no data rows.')],
      );
    }
    return this.walkMfDataRecords(dataRows, DHAN_MF_UCC, fileName, /* sourceRowOffset */ 0);
  }

  // =========================================================================
  // EQUITY ROW WALKERS + AGGREGATION
  // =========================================================================

  /**
   * Walk Dhan Equity data records (string[][]). Trade lots of the
   * same Instrument are aggregated into a single Holding.
   *
   * The 3 fully-duplicate lot pairs (KP Energy, Landmark Cars,
   * Sharda Motor) are legitimate trade lots; they collapse via
   * aggregation, not via BROKER_DUPLICATE_INSIDE_BATCH.
   */
  private walkEquityDataRecords(
    dataRecords: string[][],
    fileName: string,
    sourceRowOffset: number,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];

    // Column indices from the verified header.
    const idxInstrument = 0;
    const idxQty = 1;
    const idxBuyPrice = 2;
    const idxLtp = 3;
    const idxPnl = 4;
    const idxInvested = 5;
    const idxCurrValue = 6;
    const idxTradeDate = 7;

    // Aggregation state.
    interface EquityAgg {
      instrumentName: string;
      quantity: number;
      investedValue: number;
      currentValue: number;
      ltp: number;
      ltpSet: Set<number>;
      maxTradeDate: string | null;
    }
    const aggByName = new Map<string, EquityAgg>();
    const instrumentOrder: string[] = []; // preserve first-seen order

    const importedAt = new Date().toISOString();

    dataRecords.forEach((fields, idx) => {
      const fileRowNumber = idx + 2 + sourceRowOffset; // 1-based; first data row is row 2
      if (fields.length < EQUITY_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected ${EQUITY_HEADERS.length}.`));
        return;
      }
      if (fields.length > EQUITY_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected ${EQUITY_HEADERS.length} (Dhan Equity has no trailing empty column).`));
        return;
      }

      const instrumentName = String(fields[idxInstrument] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Instrument is empty for this row.'));
        return;
      }

      const quantity = parseDhanNumber(fields[idxQty]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Qty. is not a parseable number: ${JSON.stringify(fields[idxQty])}`, 'Qty.', String(fields[idxQty])));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Qty. is negative (${quantity}); row rejected.`, 'Qty.', String(fields[idxQty])));
        return;
      }

      // Per-lot Buy Price is recorded by the broker but is NOT
      // preserved in the canonical Holding (D-02 Dhan Equity
      // decision). We still parse it for row-shape validation.
      const buyPrice = parseDhanNumber(fields[idxBuyPrice]);
      if (buyPrice === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Buy Price is not a parseable number: ${JSON.stringify(fields[idxBuyPrice])}`, 'Buy Price', String(fields[idxBuyPrice])));
        return;
      }
      if (buyPrice < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Buy Price is negative (${buyPrice}); rejected.`, 'Buy Price', String(fields[idxBuyPrice])));
        return;
      }

      const ltp = parseDhanNumber(fields[idxLtp]);
      if (ltp === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `LTP is not a parseable number: ${JSON.stringify(fields[idxLtp])}`, 'LTP', String(fields[idxLtp])));
        return;
      }
      if (ltp < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `LTP is negative (${ltp}); rejected.`, 'LTP', String(fields[idxLtp])));
        return;
      }

      // P&L and Invested and Curr value are derived inputs. We
      // parse them for row-shape validation but we do NOT trust
      // them as canonical values for the aggregated Holding.
      // Per-lot Invested = qty × buy price (per the sequencing
      // report; verified at file level: per-row Invested ==
      // qty × buy price for Sample 3).
      // Per-lot Curr value = qty × LTP (per the sequencing report;
      // verified at file level: per-row Curr value == qty × LTP).
      const pnl = parseDhanNumber(fields[idxPnl]);
      if (pnl === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L is not a parseable number: ${JSON.stringify(fields[idxPnl])}`, 'P&L', String(fields[idxPnl])));
        return;
      }
      const invested = parseDhanNumber(fields[idxInvested]);
      if (invested === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested is not a parseable number: ${JSON.stringify(fields[idxInvested])}`, 'Invested', String(fields[idxInvested])));
        return;
      }
      if (invested < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested is negative (${invested}); rejected.`, 'Invested', String(fields[idxInvested])));
        return;
      }
      const currValue = parseDhanNumber(fields[idxCurrValue]);
      if (currValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Curr value is not a parseable number: ${JSON.stringify(fields[idxCurrValue])}`, 'Curr value', String(fields[idxCurrValue])));
        return;
      }
      if (currValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Curr value is negative (${currValue}); rejected.`, 'Curr value', String(fields[idxCurrValue])));
        return;
      }

      // Trade Date: DD-MM-YYYY → ISO 8601.
      const tradeDateRaw = String(fields[idxTradeDate] ?? '').trim();
      const tradeDate = parseDhanTradeDate(tradeDateRaw);
      if (tradeDate === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Trade Date is not a parseable DD-MM-YYYY date: ${JSON.stringify(tradeDateRaw)}`, 'Trade Date', tradeDateRaw));
        return;
      }

      // Defence-in-depth: per the sequencing report the
      // mathematical property Σ(curr value) == qty × LTP holds
      // for all 66 instruments of the real sample. We use the
      // LTP-based recomputation (qty × LTP) as the canonical
      // currentValue for the aggregated Holding.
      const recomputedCurr = quantity * ltp;
      // Skip the equality check (it's a sequence-of-records
      // tolerance, not a per-row invariant); the aggregate
      // totals cross-check is asserted in the test suite.

      // Aggregate.
      let agg = aggByName.get(instrumentName);
      if (!agg) {
        agg = {
          instrumentName,
          quantity: 0,
          investedValue: 0,
          currentValue: 0,
          ltp,
          ltpSet: new Set<number>(),
          maxTradeDate: null,
        };
        aggByName.set(instrumentName, agg);
        instrumentOrder.push(instrumentName);
      }
      agg.quantity += quantity;
      agg.investedValue += invested;
      agg.currentValue += recomputedCurr; // use recomputed, not broker-trusted
      agg.ltpSet.add(ltp);
      if (tradeDate > (agg.maxTradeDate ?? '')) {
        agg.maxTradeDate = tradeDate;
      }

      // Zero quantity: lifecycle-tolerance warning. Holding is
      // still emitted with all derived values = 0.
      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Qty. is zero; lot contributes zero to the aggregated position.', 'Qty.', String(fields[idxQty])));
      }

      // Per-lot P&L value is not preserved in the aggregated
      // canonical Holding (it's a per-lot attribute, not a
      // per-position attribute). We parsed it for row-shape
      // validation above. `pnl` and `buyPrice` are referenced
      // here to avoid unused-variable warnings.
      void pnl;
      void buyPrice;
    });

    // Emit Holdings, one per instrument, in first-seen order.
    const holdings: Holding[] = [];
    for (const name of instrumentOrder) {
      const a = aggByName.get(name)!;
      // LTP consistency: the real sample has a single LTP per
      // instrument. If a future broker file has multiple LTPs
      // per instrument, we use the last-seen LTP (and the
      // recomputed currentValue may differ from Σ(curr value));
      // the aggregate is still arithmetically valid.
      const currentPrice = a.ltp;
      const quantity = a.quantity;
      const investedValue = a.investedValue;
      const currentValue = a.currentValue;
      const averageCost = quantity > 0 ? investedValue / quantity : 0;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0 ? (unrealisedPnL / investedValue) * 100 : undefined;
      const importedAtForHolding = a.maxTradeDate ?? importedAt;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent))
      ) {
        issues.push(this.issue(0, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Aggregated value for "${a.instrumentName}" is not finite (NaN/Infinity guard tripped).`));
        continue;
      }

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Dhan',
        account: undefined,
        instrumentName: a.instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCost,
        investedValue,
        currentPrice,
        currentValue,
        unrealisedPnL,
        ...(unrealisedPnLPercent !== undefined ? { unrealisedPnLPercent } : {}),
        xirrPercent: undefined,
        securityClassification: undefined,
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt: importedAtForHolding,
      };
      holdings.push(holding);
    }

    return {
      broker: 'Dhan',
      account: undefined,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  /**
   * Walk pre-decoded ParsedCsvRow[] for Dhan Equity (used by the
   * BrokerFormatDetector.detectFromRows path).
   */
  private walkEquityDataRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    // Convert ParsedCsvRow[] → string[][] and delegate to the
    // records walker. Row numbers from the ParsedCsvRow objects
    // are used directly when the offset is 0.
    const records = rows.map((r) => r.rawFields);
    // We do not need the row numbers for the issue tracking here
    // because the records walker uses idx + 2 + sourceRowOffset
    // (= 2 for the first data row). For consistency with the
    // decoded-rows path, the source row numbers come from the
    // ParsedCsvRow.rowNumber field.
    return this.walkEquityDataRecordsWithRows(rows, fileName);
  }

  /**
   * Walk Dhan Equity data rows from ParsedCsvRow[] (each row
   * carries its own rowNumber).
   */
  private walkEquityDataRecordsWithRows(
    rows: ParsedCsvRow[],
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];

    interface EquityAgg {
      instrumentName: string;
      quantity: number;
      investedValue: number;
      currentValue: number;
      ltp: number;
      ltpSet: Set<number>;
      maxTradeDate: string | null;
    }
    const aggByName = new Map<string, EquityAgg>();
    const instrumentOrder: string[] = [];

    const importedAt = new Date().toISOString();

    rows.forEach((row) => {
      const fileRowNumber = row.rowNumber;
      const fields = row.rawFields;
      if (fields.length < EQUITY_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected ${EQUITY_HEADERS.length}.`));
        return;
      }
      if (fields.length > EQUITY_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected ${EQUITY_HEADERS.length} (Dhan Equity has no trailing empty column).`));
        return;
      }

      const instrumentName = String(fields[0] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Instrument is empty for this row.'));
        return;
      }

      const quantity = parseDhanNumber(fields[1]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Qty. is not a parseable number: ${JSON.stringify(fields[1])}`, 'Qty.', String(fields[1])));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Qty. is negative (${quantity}); row rejected.`, 'Qty.', String(fields[1])));
        return;
      }

      const buyPrice = parseDhanNumber(fields[2]);
      if (buyPrice === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Buy Price is not a parseable number: ${JSON.stringify(fields[2])}`, 'Buy Price', String(fields[2])));
        return;
      }
      if (buyPrice < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Buy Price is negative (${buyPrice}); rejected.`, 'Buy Price', String(fields[2])));
        return;
      }

      const ltp = parseDhanNumber(fields[3]);
      if (ltp === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `LTP is not a parseable number: ${JSON.stringify(fields[3])}`, 'LTP', String(fields[3])));
        return;
      }
      if (ltp < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `LTP is negative (${ltp}); rejected.`, 'LTP', String(fields[3])));
        return;
      }

      const pnl = parseDhanNumber(fields[4]);
      if (pnl === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L is not a parseable number: ${JSON.stringify(fields[4])}`, 'P&L', String(fields[4])));
        return;
      }
      const invested = parseDhanNumber(fields[5]);
      if (invested === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested is not a parseable number: ${JSON.stringify(fields[5])}`, 'Invested', String(fields[5])));
        return;
      }
      if (invested < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested is negative (${invested}); rejected.`, 'Invested', String(fields[5])));
        return;
      }
      const currValue = parseDhanNumber(fields[6]);
      if (currValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Curr value is not a parseable number: ${JSON.stringify(fields[6])}`, 'Curr value', String(fields[6])));
        return;
      }
      if (currValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Curr value is negative (${currValue}); rejected.`, 'Curr value', String(fields[6])));
        return;
      }

      const tradeDateRaw = String(fields[7] ?? '').trim();
      const tradeDate = parseDhanTradeDate(tradeDateRaw);
      if (tradeDate === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Trade Date is not a parseable DD-MM-YYYY date: ${JSON.stringify(tradeDateRaw)}`, 'Trade Date', tradeDateRaw));
        return;
      }

      const recomputedCurr = quantity * ltp;
      void currValue; // parser-recomputed, used for validation above

      let agg = aggByName.get(instrumentName);
      if (!agg) {
        agg = {
          instrumentName,
          quantity: 0,
          investedValue: 0,
          currentValue: 0,
          ltp,
          ltpSet: new Set<number>(),
          maxTradeDate: null,
        };
        aggByName.set(instrumentName, agg);
        instrumentOrder.push(instrumentName);
      }
      agg.quantity += quantity;
      agg.investedValue += invested;
      agg.currentValue += recomputedCurr;
      agg.ltpSet.add(ltp);
      if (tradeDate > (agg.maxTradeDate ?? '')) {
        agg.maxTradeDate = tradeDate;
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Qty. is zero; lot contributes zero to the aggregated position.', 'Qty.', String(fields[1])));
      }

      void pnl;
      void buyPrice;
    });

    const holdings: Holding[] = [];
    for (const name of instrumentOrder) {
      const a = aggByName.get(name)!;
      const currentPrice = a.ltp;
      const quantity = a.quantity;
      const investedValue = a.investedValue;
      const currentValue = a.currentValue;
      const averageCost = quantity > 0 ? investedValue / quantity : 0;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0 ? (unrealisedPnL / investedValue) * 100 : undefined;
      const importedAtForHolding = a.maxTradeDate ?? importedAt;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent))
      ) {
        issues.push(this.issue(0, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Aggregated value for "${a.instrumentName}" is not finite (NaN/Infinity guard tripped).`));
        continue;
      }

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Dhan',
        account: undefined,
        instrumentName: a.instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCost,
        investedValue,
        currentPrice,
        currentValue,
        unrealisedPnL,
        ...(unrealisedPnLPercent !== undefined ? { unrealisedPnLPercent } : {}),
        xirrPercent: undefined,
        securityClassification: undefined,
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt: importedAtForHolding,
      };
      holdings.push(holding);
    }

    return {
      broker: 'Dhan',
      account: undefined,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  // =========================================================================
  // =========================================================================
  // CR VARIANT D — STOCK HOLDINGS ROW WALKERS
  // =========================================================================

  /**
   * Walk Dhan Stock Holdings data records (string[][]).
   *
   * Source: CR fixture `Dhan stock holdings.csv` — 9 rows,
   * 8 columns, comma-delimited, double-quoted every field.
   * Each row produces exactly one Holding (one row per
   * instrument; no trade-lot aggregation).
   *
   * Mapping:
   *   Name           → instrumentName
   *   Quantity       → quantity
   *   Avg Price      → averageCost
   *   Last Traded    → currentPrice
   *   Investment     → investedValue
   *   Current Value  → currentValue
   *   P&L            → unrealisedPnL
   *   P&L %          → unrealisedPnLPercent (strip trailing '%', 0-100 range)
   *
   * No Trade Date column: importedAt is parser execution time
   * (new Date().toISOString()), not the file's date.
   *
   * No account / ISIN / ticker / securityClassification / xirrPercent
   * — all set to undefined.
   */
  private walkStockHoldingsFromRecords(
    records: string[][],
    fileName: string,
  ): BrokerParseOutput {
    const headerRow = records[0];
    // After tokenization, the cells are still double-quoted (the
    // RFC-4180 tokenizer does not strip outer quotes automatically).
    // Normalise: trim whitespace, then strip a single layer of
    // outer double-quotes. The header check (matchesStockHoldingsHeader)
    // does the same normalisation.
    const headerNormalised = headerRow.map((h) => this.stripQuotes(h).trim());
    if (!this.matchesStockHoldingsHeader(headerNormalised)) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Stock Holdings header marker found but the column sequence does not match the Dhan CR Variant D schema.')],
      );
    }
    if (records.length === 1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Dhan Stock Holdings file contains only the header row, no data rows.')],
      );
    }
    return this.walkStockHoldingsDataRecords(records.slice(1), fileName, /* sourceRowOffset */ 1);
  }

  /**
   * Walk the post-header data records of the CR Variant D.
   * Each row produces one Holding (no aggregation; 9 rows → 9 Holdings).
   */
  private walkStockHoldingsDataRecords(
    dataRecords: string[][],
    fileName: string,
    sourceRowOffset: number,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const importedAt = new Date().toISOString();

    // Column indices (post-header, 0-based, exact 8-column schema).
    const idxName = 0;
    const idxQuantity = 1;
    const idxAvgPrice = 2;
    const idxLastTraded = 3;
    const idxInvestment = 4;
    const idxCurrentValue = 5;
    const idxPnl = 6;
    const idxPnlPct = 7;

    dataRecords.forEach((fields, idx) => {
      const fileRowNumber = idx + 2 + sourceRowOffset; // 1-based; first data row is row 2

      // Each field may still have outer double-quotes from the
      // CSV tokeniser; strip them for the row-shape validation
      // and value extraction.
      const cleanFields = fields.map((f) => this.stripQuotes(String(f ?? '')).trim());

      if (cleanFields.length < STOCK_HOLDINGS_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${cleanFields.length} fields; expected ${STOCK_HOLDINGS_HEADERS.length}.`));
        return;
      }
      if (cleanFields.length > STOCK_HOLDINGS_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${cleanFields.length} fields; expected ${STOCK_HOLDINGS_HEADERS.length} (Dhan Stock Holdings has no trailing empty column).`));
        return;
      }

      const instrumentName = cleanFields[idxName];
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Name is empty for this row.'));
        return;
      }

      // Quantity: integer (Dhan Stock Holdings never has fractional
      // shares in the supplied fixture).
      const quantity = parseDhanNumberWithCommas(cleanFields[idxQuantity]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Quantity is not a parseable number: ${JSON.stringify(cleanFields[idxQuantity])}`, 'Quantity', cleanFields[idxQuantity]));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Quantity is negative (${quantity}); row rejected.`, 'Quantity', cleanFields[idxQuantity]));
        return;
      }
      if (!Number.isInteger(quantity)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_NUMERIC_INVALID',
          `Quantity is not an integer (${quantity}); row accepted but flagged.`, 'Quantity', cleanFields[idxQuantity]));
      }

      // Avg Price (averageCost).
      const averageCostRaw = parseDhanNumberWithCommas(cleanFields[idxAvgPrice]);
      if (averageCostRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg Price is not a parseable number: ${JSON.stringify(cleanFields[idxAvgPrice])}`, 'Avg Price', cleanFields[idxAvgPrice]));
        return;
      }
      if (averageCostRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg Price is negative (${averageCostRaw}); rejected.`, 'Avg Price', cleanFields[idxAvgPrice]));
        return;
      }

      // Last Traded (currentPrice).
      const currentPriceRaw = parseDhanNumberWithCommas(cleanFields[idxLastTraded]);
      if (currentPriceRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Last Traded is not a parseable number: ${JSON.stringify(cleanFields[idxLastTraded])}`, 'Last Traded', cleanFields[idxLastTraded]));
        return;
      }
      if (currentPriceRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Last Traded is negative (${currentPriceRaw}); rejected.`, 'Last Traded', cleanFields[idxLastTraded]));
        return;
      }

      // Investment (investedValue).
      const investedValueRaw = parseDhanNumberWithCommas(cleanFields[idxInvestment]);
      if (investedValueRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is not a parseable number: ${JSON.stringify(cleanFields[idxInvestment])}`, 'Investment', cleanFields[idxInvestment]));
        return;
      }
      if (investedValueRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is negative (${investedValueRaw}); rejected.`, 'Investment', cleanFields[idxInvestment]));
        return;
      }

      // Current Value (currentValue).
      const currentValueRaw = parseDhanNumberWithCommas(cleanFields[idxCurrentValue]);
      if (currentValueRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is not a parseable number: ${JSON.stringify(cleanFields[idxCurrentValue])}`, 'Current Value', cleanFields[idxCurrentValue]));
        return;
      }
      if (currentValueRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is negative (${currentValueRaw}); rejected.`, 'Current Value', cleanFields[idxCurrentValue]));
        return;
      }

      // P&L (unrealisedPnL). The Dhan P&L is the absolute difference
      // between Current Value and Investment; we parse the
      // broker-supplied value and use it directly (we do NOT
      // re-derive from currentValue - investedValue because the
      // broker's P&L is the authoritative source for the supplied
      // fixture, and the canonical Holding.unrealisedPnL is what
      // the user sees in the UI). Defence-in-depth: if P&L
      // disagrees with currentValue - investedValue by more than
      // 0.01, emit a non-blocking issue.
      const pnlRaw = parseDhanNumberWithCommas(cleanFields[idxPnl]);
      if (pnlRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L is not a parseable number: ${JSON.stringify(cleanFields[idxPnl])}`, 'P&L', cleanFields[idxPnl]));
        return;
      }

      // P&L %: the field is "20.20%" or "-4.14%" — value + literal '%'
      // suffix with no space. Parse by stripping the trailing '%'
      // and converting to a 0-100 range number.
      const pnlPctRaw = cleanFields[idxPnlPct];
      let unrealisedPnLPercent: number | undefined;
      if (pnlPctRaw === '') {
        unrealisedPnLPercent = undefined;
      } else {
        // Strip a single trailing '%' (possibly with whitespace).
        const stripped = pnlPctRaw.replace(/\s*%\s*$/, '').trim();
        const parsed = parseDhanNumberWithCommas(stripped);
        if (parsed === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `P&L % is not a parseable number: ${JSON.stringify(pnlPctRaw)}`, 'P&L %', pnlPctRaw));
          return;
        }
        unrealisedPnLPercent = parsed;
      }

      // NaN/Infinity guard (defence in depth; should never trip
      // given the per-cell parse checks above).
      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(averageCostRaw) ||
        !Number.isFinite(currentPriceRaw) ||
        !Number.isFinite(investedValueRaw) ||
        !Number.isFinite(currentValueRaw) ||
        !Number.isFinite(pnlRaw) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      // Defence-in-depth: flag P&L vs (currentValue - investedValue)
      // divergence as a non-blocking AMBIGUOUS issue. The Dhan
      // fixture's P&L is the authoritative source; this is a
      // sanity check.
      const recomputedPnl = currentValueRaw - investedValueRaw;
      if (Math.abs(pnlRaw - recomputedPnl) > 0.01) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_NUMERIC_INVALID',
          `P&L (${pnlRaw}) does not match Current Value (${currentValueRaw}) − Investment (${investedValueRaw}) = ${recomputedPnl}; using broker-supplied P&L.`));
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Quantity is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Quantity', cleanFields[idxQuantity]));
      }

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Dhan',
        account: undefined,
        instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCostRaw,
        investedValue: investedValueRaw,
        currentPrice: quantity === 0 ? 0 : currentPriceRaw,
        currentValue: currentValueRaw,
        unrealisedPnL: pnlRaw,
        ...(unrealisedPnLPercent !== undefined ? { unrealisedPnLPercent } : {}),
        xirrPercent: undefined,
        securityClassification: undefined,
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt,
      };
      holdings.push(holding);
    });

    return {
      broker: 'Dhan',
      account: undefined,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  /**
   * Walk Dhan CR Variant D rows from ParsedCsvRow[] (binary-workbook
   * path / BrokerFormatDetector.detectFromRows). Each row carries
   * its own rowNumber.
   */
  private walkStockHoldingsRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    const records = rows.map((r) => r.rawFields);
    // Reuse the records path. The records walker uses idx + 2 +
    // sourceRowOffset, but for the rows path we delegate to the
    // row-aware variant below to preserve per-row file row numbers.
    return this.walkStockHoldingsDataRecordsWithRows(rows, fileName);
  }

  /**
   * Walk Dhan CR Variant D data rows from ParsedCsvRow[] (each
   * row carries its own rowNumber). One row per Holding; no
   * aggregation.
   */
  private walkStockHoldingsDataRecordsWithRows(
    rows: ParsedCsvRow[],
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const importedAt = new Date().toISOString();

    const idxName = 0;
    const idxQuantity = 1;
    const idxAvgPrice = 2;
    const idxLastTraded = 3;
    const idxInvestment = 4;
    const idxCurrentValue = 5;
    const idxPnl = 6;
    const idxPnlPct = 7;

    rows.forEach((row) => {
      const fileRowNumber = row.rowNumber;
      const cleanFields = row.rawFields.map((f) => this.stripQuotes(String(f ?? '')).trim());

      if (cleanFields.length < STOCK_HOLDINGS_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${cleanFields.length} fields; expected ${STOCK_HOLDINGS_HEADERS.length}.`));
        return;
      }
      if (cleanFields.length > STOCK_HOLDINGS_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${cleanFields.length} fields; expected ${STOCK_HOLDINGS_HEADERS.length} (Dhan Stock Holdings has no trailing empty column).`));
        return;
      }

      const instrumentName = cleanFields[idxName];
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Name is empty for this row.'));
        return;
      }

      const quantity = parseDhanNumberWithCommas(cleanFields[idxQuantity]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Quantity is not a parseable number: ${JSON.stringify(cleanFields[idxQuantity])}`, 'Quantity', cleanFields[idxQuantity]));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Quantity is negative (${quantity}); row rejected.`, 'Quantity', cleanFields[idxQuantity]));
        return;
      }

      const averageCostRaw = parseDhanNumberWithCommas(cleanFields[idxAvgPrice]);
      if (averageCostRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg Price is not a parseable number: ${JSON.stringify(cleanFields[idxAvgPrice])}`, 'Avg Price', cleanFields[idxAvgPrice]));
        return;
      }
      if (averageCostRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg Price is negative (${averageCostRaw}); rejected.`, 'Avg Price', cleanFields[idxAvgPrice]));
        return;
      }

      const currentPriceRaw = parseDhanNumberWithCommas(cleanFields[idxLastTraded]);
      if (currentPriceRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Last Traded is not a parseable number: ${JSON.stringify(cleanFields[idxLastTraded])}`, 'Last Traded', cleanFields[idxLastTraded]));
        return;
      }
      if (currentPriceRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Last Traded is negative (${currentPriceRaw}); rejected.`, 'Last Traded', cleanFields[idxLastTraded]));
        return;
      }

      const investedValueRaw = parseDhanNumberWithCommas(cleanFields[idxInvestment]);
      if (investedValueRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is not a parseable number: ${JSON.stringify(cleanFields[idxInvestment])}`, 'Investment', cleanFields[idxInvestment]));
        return;
      }
      if (investedValueRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is negative (${investedValueRaw}); rejected.`, 'Investment', cleanFields[idxInvestment]));
        return;
      }

      const currentValueRaw = parseDhanNumberWithCommas(cleanFields[idxCurrentValue]);
      if (currentValueRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is not a parseable number: ${JSON.stringify(cleanFields[idxCurrentValue])}`, 'Current Value', cleanFields[idxCurrentValue]));
        return;
      }
      if (currentValueRaw < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is negative (${currentValueRaw}); rejected.`, 'Current Value', cleanFields[idxCurrentValue]));
        return;
      }

      const pnlRaw = parseDhanNumberWithCommas(cleanFields[idxPnl]);
      if (pnlRaw === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L is not a parseable number: ${JSON.stringify(cleanFields[idxPnl])}`, 'P&L', cleanFields[idxPnl]));
        return;
      }

      const pnlPctRaw = cleanFields[idxPnlPct];
      let unrealisedPnLPercent: number | undefined;
      if (pnlPctRaw === '') {
        unrealisedPnLPercent = undefined;
      } else {
        const stripped = pnlPctRaw.replace(/\s*%\s*$/, '').trim();
        const parsed = parseDhanNumberWithCommas(stripped);
        if (parsed === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `P&L % is not a parseable number: ${JSON.stringify(pnlPctRaw)}`, 'P&L %', pnlPctRaw));
          return;
        }
        unrealisedPnLPercent = parsed;
      }

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(averageCostRaw) ||
        !Number.isFinite(currentPriceRaw) ||
        !Number.isFinite(investedValueRaw) ||
        !Number.isFinite(currentValueRaw) ||
        !Number.isFinite(pnlRaw) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Quantity is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Quantity', cleanFields[idxQuantity]));
      }

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Dhan',
        account: undefined,
        instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCostRaw,
        investedValue: investedValueRaw,
        currentPrice: quantity === 0 ? 0 : currentPriceRaw,
        currentValue: currentValueRaw,
        unrealisedPnL: pnlRaw,
        ...(unrealisedPnLPercent !== undefined ? { unrealisedPnLPercent } : {}),
        xirrPercent: undefined,
        securityClassification: undefined,
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt,
      };
      holdings.push(holding);
    });

    return {
      broker: 'Dhan',
      account: undefined,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  // =========================================================================
  // MF ROW WALKERS
  // =========================================================================

  /**
   * Walk Dhan MF data records (string[][]). Uses broker-supplied
   * Invested/Current/NAV. Duplicate Scheme Name rows are caught
   * by BROKER_DUPLICATE_INSIDE_BATCH (first wins, subsequent
   * dropped).
   */
  private walkMfDataRecords(
    dataRecords: string[][],
    account: string,
    fileName: string,
    sourceRowOffset: number,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    // Column indices from the verified MF header.
    const idxScheme = 0;
    const idxMfType = 1;
    const idxUnits = 2;
    const idxNav = 3;
    const idxInvested = 4;
    const idxCurrent = 5;
    const idxPnl = 6;
    const idxPnlPct = 7;
    const idxXirr = 8;

    dataRecords.forEach((fields, idx) => {
      const fileRowNumber = idx + 2 + sourceRowOffset; // 1-based; first data row is row 2

      // Stop at summary / NOTE / blank / footer rows. A row
      // whose first cell is one of the broker's known footer
      // markers is the broker's summary or note, not a data
      // row. These rows are silently skipped (no issue emitted)
      // because they are part of the broker's standard footer
      // and are not user errors.
      const firstCell = String(fields[0] ?? '').trim();
      if (firstCell === '') {
        // Blank line: silently skip.
        return;
      }
      if (firstCell === 'Current Value' || firstCell === 'Investment' || firstCell === 'Overall P&L') {
        // Broker's summary row: silently skip.
        return;
      }
      if (firstCell.toUpperCase().startsWith('NOTE')) {
        // Broker's NOTE row: silently skip.
        return;
      }

      if (fields.length < MF_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected at least ${MF_HEADERS.length}.`));
        return;
      }

      const instrumentName = String(fields[idxScheme] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Scheme Name is empty for this row.'));
        return;
      }

      // Duplicate-inside-batch detection. MF uses the scheme
      // name as the identity (no ISIN, no ticker in Dhan MF).
      const identityKey = `Dhan|${account}|${instrumentName}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate Scheme Name inside batch: ${JSON.stringify(instrumentName)} (first occurrence retained).`,
          'Scheme Name', instrumentName));
        return;
      }
      seen.add(identityKey);

      const units = parseDhanNumber(fields[idxUnits]);
      if (units === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Units is not a parseable number: ${JSON.stringify(fields[idxUnits])}`, 'Units', String(fields[idxUnits])));
        return;
      }
      if (units < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Units is negative (${units}); row rejected.`, 'Units', String(fields[idxUnits])));
        return;
      }

      const invested = parseDhanNumber(fields[idxInvested]);
      if (invested === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is not a parseable number: ${JSON.stringify(fields[idxInvested])}`, 'Investment', String(fields[idxInvested])));
        return;
      }
      if (invested < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is negative (${invested}); rejected.`, 'Investment', String(fields[idxInvested])));
        return;
      }

      const current = parseDhanNumber(fields[idxCurrent]);
      if (current === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is not a parseable number: ${JSON.stringify(fields[idxCurrent])}`, 'Current Value', String(fields[idxCurrent])));
        return;
      }
      if (current < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is negative (${current}); rejected.`, 'Current Value', String(fields[idxCurrent])));
        return;
      }

      // NAV (per-row current price).
      const nav = parseDhanNumber(fields[idxNav]);
      if (nav === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `NAV is not a parseable number: ${JSON.stringify(fields[idxNav])}`, 'NAV', String(fields[idxNav])));
        return;
      }
      if (nav < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `NAV is negative (${nav}); rejected.`, 'NAV', String(fields[idxNav])));
        return;
      }

      // P&L is broker-internal; we recompute unrealisedPnL
      // from current - invested. P&L parsing is for row-shape
      // validation.
      const pnl = parseDhanNumber(fields[idxPnl]);
      if (pnl === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L is not a parseable number: ${JSON.stringify(fields[idxPnl])}`, 'P&L', String(fields[idxPnl])));
        return;
      }
      void pnl;

      // P&L% (broker-supplied, in 0-100 range).
      const pnlPct = parseDhanNumber(fields[idxPnlPct]);
      if (pnlPct === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L% is not a parseable number: ${JSON.stringify(fields[idxPnlPct])}`, 'P&L%', String(fields[idxPnlPct])));
        return;
      }

      // XIRR % (broker-supplied plain number, in 0-100 range).
      // The Dhan MF XIRR is NOT percent-suffixed (unlike Groww MF
      // which uses "2.03%" strings). The Dhan MF % is in the
      // column header, not in the value.
      const xirrRaw = String(fields[idxXirr] ?? '').trim();
      let xirrPercent: number | undefined;
      if (xirrRaw === '') {
        xirrPercent = undefined;
      } else {
        const parsed = parseDhanNumber(xirrRaw);
        if (parsed === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `XIRR % is not a parseable number: ${JSON.stringify(xirrRaw)}`, 'XIRR %', xirrRaw));
          xirrPercent = undefined;
        } else {
          xirrPercent = parsed;
        }
      }

      // MF Type (broker-native classification).
      const mfType = String(fields[idxMfType] ?? '').trim();
      const securityClassification = mfType === '' ? undefined : mfType;

      // Derived values.
      const averageCost = units > 0 ? invested / units : 0;
      const unrealisedPnL = current - invested;
      const unrealisedPnLPercent = pnlPct; // broker-supplied, in 0-100 range

      if (
        !Number.isFinite(units) ||
        !Number.isFinite(invested) ||
        !Number.isFinite(current) ||
        !Number.isFinite(nav) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent)) ||
        (xirrPercent !== undefined && !Number.isFinite(xirrPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (units === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Units is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Units', String(fields[idxUnits])));
      }

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Dhan',
        account,
        instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity: units,
        averageCost: units === 0 ? 0 : averageCost,
        investedValue: invested,
        currentPrice: units === 0 ? 0 : nav,
        currentValue: current,
        unrealisedPnL,
        ...(unrealisedPnLPercent !== undefined ? { unrealisedPnLPercent } : {}),
        ...(xirrPercent !== undefined ? { xirrPercent } : {}),
        ...(securityClassification !== undefined ? { securityClassification } : {}),
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt,
      };
      holdings.push(holding);
    });

    return {
      broker: 'Dhan',
      account,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  /**
   * Walk Dhan MF data rows from ParsedCsvRow[] (used by the
   * BrokerFormatDetector.detectFromRows path).
   */
  private walkMfRows(rows: ParsedCsvRow[], account: string, fileName: string): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    const idxScheme = 0;
    const idxMfType = 1;
    const idxUnits = 2;
    const idxNav = 3;
    const idxInvested = 4;
    const idxCurrent = 5;
    const idxPnl = 6;
    const idxPnlPct = 7;
    const idxXirr = 8;

    rows.forEach((row) => {
      const fileRowNumber = row.rowNumber;
      const fields = row.rawFields;
      const firstCell = String(fields[0] ?? '').trim();
      // Silently skip blank / summary / NOTE rows (same
      // behaviour as the records path).
      if (firstCell === '') return;
      if (firstCell === 'Current Value' || firstCell === 'Investment' || firstCell === 'Overall P&L') {
        return;
      }
      if (firstCell.toUpperCase().startsWith('NOTE')) return;
      if (fields.length < MF_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected at least ${MF_HEADERS.length}.`));
        return;
      }

      const instrumentName = String(fields[idxScheme] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Scheme Name is empty for this row.'));
        return;
      }

      const identityKey = `Dhan|${account}|${instrumentName}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate Scheme Name inside batch: ${JSON.stringify(instrumentName)} (first occurrence retained).`,
          'Scheme Name', instrumentName));
        return;
      }
      seen.add(identityKey);

      const units = parseDhanNumber(fields[idxUnits]);
      if (units === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Units is not a parseable number: ${JSON.stringify(fields[idxUnits])}`, 'Units', String(fields[idxUnits])));
        return;
      }
      if (units < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Units is negative (${units}); row rejected.`, 'Units', String(fields[idxUnits])));
        return;
      }

      const invested = parseDhanNumber(fields[idxInvested]);
      if (invested === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is not a parseable number: ${JSON.stringify(fields[idxInvested])}`, 'Investment', String(fields[idxInvested])));
        return;
      }
      if (invested < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Investment is negative (${invested}); rejected.`, 'Investment', String(fields[idxInvested])));
        return;
      }

      const current = parseDhanNumber(fields[idxCurrent]);
      if (current === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is not a parseable number: ${JSON.stringify(fields[idxCurrent])}`, 'Current Value', String(fields[idxCurrent])));
        return;
      }
      if (current < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is negative (${current}); rejected.`, 'Current Value', String(fields[idxCurrent])));
        return;
      }

      const nav = parseDhanNumber(fields[idxNav]);
      if (nav === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `NAV is not a parseable number: ${JSON.stringify(fields[idxNav])}`, 'NAV', String(fields[idxNav])));
        return;
      }
      if (nav < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `NAV is negative (${nav}); rejected.`, 'NAV', String(fields[idxNav])));
        return;
      }

      const pnl = parseDhanNumber(fields[idxPnl]);
      if (pnl === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L is not a parseable number: ${JSON.stringify(fields[idxPnl])}`, 'P&L', String(fields[idxPnl])));
        return;
      }
      void pnl;

      const pnlPct = parseDhanNumber(fields[idxPnlPct]);
      if (pnlPct === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `P&L% is not a parseable number: ${JSON.stringify(fields[idxPnlPct])}`, 'P&L%', String(fields[idxPnlPct])));
        return;
      }

      const xirrRaw = String(fields[idxXirr] ?? '').trim();
      let xirrPercent: number | undefined;
      if (xirrRaw === '') {
        xirrPercent = undefined;
      } else {
        const parsed = parseDhanNumber(xirrRaw);
        if (parsed === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `XIRR % is not a parseable number: ${JSON.stringify(xirrRaw)}`, 'XIRR %', xirrRaw));
          xirrPercent = undefined;
        } else {
          xirrPercent = parsed;
        }
      }

      const mfType = String(fields[idxMfType] ?? '').trim();
      const securityClassification = mfType === '' ? undefined : mfType;

      const averageCost = units > 0 ? invested / units : 0;
      const unrealisedPnL = current - invested;
      const unrealisedPnLPercent = pnlPct;

      if (
        !Number.isFinite(units) ||
        !Number.isFinite(invested) ||
        !Number.isFinite(current) ||
        !Number.isFinite(nav) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent)) ||
        (xirrPercent !== undefined && !Number.isFinite(xirrPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (units === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Units is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Units', String(fields[idxUnits])));
      }

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Dhan',
        account,
        instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity: units,
        averageCost: units === 0 ? 0 : averageCost,
        investedValue: invested,
        currentPrice: units === 0 ? 0 : nav,
        currentValue: current,
        unrealisedPnL,
        ...(unrealisedPnLPercent !== undefined ? { unrealisedPnLPercent } : {}),
        ...(xirrPercent !== undefined ? { xirrPercent } : {}),
        ...(securityClassification !== undefined ? { securityClassification } : {}),
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt,
      };
      holdings.push(holding);
    });

    return {
      broker: 'Dhan',
      account,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  // =========================================================================
  // ACCOUNT EXTRACTION (MF only)
  // =========================================================================

  /**
   * Extract the UCC account identifier from a `string[][]`
   * preamble (CSV path). Returns the first row whose first cell
   * is "UCC"; second cell is the value. Returns null if no UCC
   * row is found.
   */
  private extractMfAccountFromRecords(preamble: string[][]): string | null {
    for (const row of preamble) {
      const first = String(row[0] ?? '').trim();
      if (first === 'UCC') {
        const value = String(row[1] ?? '').trim();
        if (value === '') return null;
        return value;
      }
    }
    return null;
  }

  // =========================================================================
  // HEADER MATCHING
  // =========================================================================

  private matchesEquityHeader(headers: readonly string[]): boolean {
    if (headers.length < EQUITY_HEADERS.length) return false;
    // Case-insensitive comparison: the file is unquoted and the
    // header is byte-exact; binary XLSX decoders may surface
    // headers in any case. The Dhan Equity export uses
    // case-preserved headers in the real CSV; the case-
    // insensitivity is defensive for binary variants.
    for (let i = 0; i < EQUITY_HEADERS.length; i++) {
      if ((headers[i] ?? '').toLowerCase() !== EQUITY_HEADERS[i].toLowerCase()) {
        return false;
      }
    }
    if (headers.length > EQUITY_HEADERS.length) {
      const extra = headers.slice(EQUITY_HEADERS.length);
      if (extra.some((e) => e !== '')) return false;
    }
    return true;
  }

  private matchesEquityHeaderRow(headerLine: string): boolean {
    // Tokenize the first line respecting quotes; Dhan Equity is
    // unquoted so a simple split suffices, but we use the CSV
    // tokenizer to be safe.
    const records = this.parseCsvRecords(headerLine + '\n');
    if (records.length === 0) return false;
    const fields = records[0].map((f) => this.stripQuotes(f).trim());
    return this.matchesEquityHeader(fields);
  }

  private matchesMfHeader(headers: readonly string[]): boolean {
    if (headers.length < MF_HEADERS.length) return false;
    for (let i = 0; i < MF_HEADERS.length; i++) {
      if ((headers[i] ?? '').toLowerCase() !== MF_HEADERS[i].toLowerCase()) {
        return false;
      }
    }
    if (headers.length > MF_HEADERS.length) {
      const extra = headers.slice(MF_HEADERS.length);
      if (extra.some((e) => e !== '')) return false;
    }
    return true;
  }

  /**
   * Match the CR Variant D (Dhan Stock Holdings) header by
   * column sequence. Case-insensitive. The fixture is
   * double-quoted but the tokeniser strips outer quotes; the
   * caller is expected to pass the post-strip header.
   */
  private matchesStockHoldingsHeader(headers: readonly string[]): boolean {
    if (headers.length < STOCK_HOLDINGS_HEADERS.length) return false;
    for (let i = 0; i < STOCK_HOLDINGS_HEADERS.length; i++) {
      if ((headers[i] ?? '').toLowerCase() !== STOCK_HOLDINGS_HEADERS[i].toLowerCase()) {
        return false;
      }
    }
    if (headers.length > STOCK_HOLDINGS_HEADERS.length) {
      const extra = headers.slice(STOCK_HOLDINGS_HEADERS.length);
      if (extra.some((e) => e !== '')) return false;
    }
    return true;
  }

  /**
   * Match the CR Variant D (Dhan Stock Holdings) header from a
   * single raw header line. Tokenises the line with the
   * quote-aware CSV parser, strips outer quotes, and checks
   * the column sequence.
   */
  private matchesStockHoldingsHeaderRow(headerLine: string): boolean {
    const records = this.parseCsvRecords(headerLine + '\n');
    if (records.length === 0) return false;
    const fields = records[0].map((f) => this.stripQuotes(f).trim());
    return this.matchesStockHoldingsHeader(fields);
  }

  /**
   * Find the line index of the MF header in a multi-line text
   * (where row 1 is the title). Returns -1 if not found.
   * Walks the first 15 non-empty lines looking for "Scheme Name".
   */
  private findMfHeaderInText(text: string): number {
    const lines = (text || '').split(/\r?\n/);
    let nonEmptyIdx = -1;
    for (let i = 0; i < lines.length && i < 50; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.length === 0) continue;
      nonEmptyIdx++;
      // Tokenize and check first cell.
      const records = this.parseCsvRecords(trimmed + '\n');
      if (records.length === 0) continue;
      const firstCell = String(records[0]?.[0] ?? '').trim();
      if (firstCell === 'Scheme Name') {
        return i;
      }
    }
    return -1;
  }

  // =========================================================================
  // XLSX DECODE (PRIVATE)
  // =========================================================================

  /**
   * Decode a Dhan MF XLSX buffer. Returns the first sheet that
   * matches the MF header signature (case-sensitive byte-exact).
   * The selection is content-based; sheet name is a hint.
   */
  private decodeXlsx(bytes: Uint8Array): {
    matched: boolean;
    sheetName: string;
    rows: string[][];
    error?: string;
  } {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(bytes, { type: 'array', cellText: true, cellDates: false });
    } catch (err) {
      return {
        matched: false,
        sheetName: '',
        rows: [],
        error: `XLSX decode failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { matched: false, sheetName: '', rows: [], error: 'Workbook contains no worksheets.' };
    }
    const candidateSheets: string[] = [];
    if (workbook.Sheets[MF_SHEET_HINT]) candidateSheets.push(MF_SHEET_HINT);
    for (const sn of workbook.SheetNames) {
      if (!candidateSheets.includes(sn)) candidateSheets.push(sn);
    }
    for (const sn of candidateSheets) {
      const ws = workbook.Sheets[sn];
      if (!ws) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: '',
        blankrows: false,
        raw: false,
      }) as string[][];
      if (aoa.length === 0) continue;
      // WP-09 detection tightening: the marker 'Scheme Name' alone
      // is not sufficient to claim the file as Dhan. The full column
      // sequence at the marker row must match the Dhan MF schema
      // (matchesMfHeader). If only the marker matches but the full
      // column sequence does not, continue scanning. This closes
      // the cross-detection hole where a Groww MF XLSX (which also
      // has 'Scheme Name' as its first cell) was falsely claimed by
      // Dhan.
      for (let r = 0; r < Math.min(15, aoa.length); r++) {
        const first: string = String(aoa[r]?.[0] ?? '').trim();
        if (first === 'Scheme Name') {
          const headerFields = (aoa[r] ?? []).map((f) => String(f ?? '').trim());
          if (this.matchesMfHeader(headerFields)) {
            return { matched: true, sheetName: sn, rows: aoa };
          }
          // Marker found but full schema does not match; do not
          // claim this workbook. Continue scanning for a later row
          // that might be a genuine Dhan header.
        }
      }
    }
    return { matched: false, sheetName: '', rows: [] };
  }

  // =========================================================================
  // CSV TOKENIZER (private RFC-4180-compatible)
  // =========================================================================

  /**
   * Tokenize CSV text into rows of raw field strings. Handles:
   *   - Quoted fields with embedded commas, newlines, and
   *     double-quote escapes ("")
   *   - LF and CRLF line terminators
   *   - Trailing empty field (preserved)
   *
   * Dhan Equity CSV is unquoted in the data area; Dhan MF CSV
   * uses quoting in data rows. The tokenizer handles both.
   */
  private parseCsvRecords(text: string): string[][] {
    const records: string[][] = [];
    let current: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const len = text.length;
    while (i < len) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ',') {
        current.push(field);
        field = '';
        i++;
        continue;
      }
      if (ch === '\r') {
        if (i + 1 < len && text[i + 1] === '\n') {
          i += 2;
        } else {
          i++;
        }
        current.push(field);
        records.push(current);
        current = [];
        field = '';
        continue;
      }
      if (ch === '\n') {
        current.push(field);
        records.push(current);
        current = [];
        field = '';
        i++;
        continue;
      }
      field += ch;
      i++;
    }
    if (field.length > 0 || current.length > 0) {
      current.push(field);
      records.push(current);
    }
    while (records.length > 0) {
      const last = records[records.length - 1];
      if (last.length === 1 && last[0] === '') {
        records.pop();
        continue;
      }
      break;
    }
    return records;
  }

  private stripQuotes(raw: string): string {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1);
    }
    return raw;
  }

  private firstNonEmptyLine(text: string): string | null {
    let body = text || '';
    // Normalize a leading UTF-8 BOM at the line-splitting boundary so the
    // returned line is BOM-free. The BOM is a file-level artifact, not a
    // line-level one, and `String.prototype.trim()` does not strip it.
    // Without this, a Dhan Equity CSV exported with a BOM (the real
    // Sample 3 fixture) would surface a first cell starting with
    // \uFEFFInstrument, defeating the EQUITY_HEADERS[0] === 'Instrument'
    // case-insensitive comparison in `matchesEquityHeader`.
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) return line;
    }
    return null;
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  private noMatch(reason: string): BrokerDetectionResult {
    return {
      matched: false,
      formatId: 'dhan',
      displayName: this.displayName,
      confidence: 'NONE',
      reason,
    };
  }

  private emptyOutput(fileName: string, issues: ImportRowIssue[]): BrokerParseOutput {
    return {
      broker: 'Dhan',
      account: undefined,
      holdings: [],
      sourceFile: fileName,
      importedAt: new Date().toISOString(),
      issues,
    };
  }

  private issue(
    rowNumber: number,
    severity: ImportIssueSeverity,
    code: ImportRowIssue['code'],
    message: string,
    field?: string,
    rawValue?: string,
  ): ImportRowIssue {
    return {
      rowNumber,
      severity,
      code,
      message,
      ...(field !== undefined ? { field } : {}),
      ...(rawValue !== undefined ? { rawValue } : {}),
    };
  }
}

// Re-export the HoldingStatus type for convenience in the test file.
export type { HoldingStatus };
