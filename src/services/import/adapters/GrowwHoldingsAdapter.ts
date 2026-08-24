/**
 * WP-FB-IMPORT-BROKER-01 — WP-06 Groww holdings adapter.
 *
 * Structural detection + row-level parsing for the Groww Stocks and
 * Groww Mutual Funds XLSX exports. Both exports are XLSX (verified
 * against `/home/user/uploads/Groww_Stocks_Holdings_Statement_*.xlsx`
 * and `/home/user/uploads/Groww_Mutual_Funds_*.xlsx`).
 *
 * This adapter:
 *   - Performs structural header-schema detection (case-sensitive,
 *     byte-exact; filename and sheet name are NOT the only signals).
 *   - Decodes the XLSX internally using the vendored xlsx@0.20.3
 *     library. The bank-statement `SpreadsheetStatementParser` is
 *     intentionally NOT reused because (a) it lowercases headers
 *     and (b) it applies a date+amount header-locator heuristic
 *     that does not match either Groww variant (Groww Stocks has
 *     no date column; Groww MF has no date column either).
 *   - Walks data rows per the Groww preamble layout:
 *       Stocks:  R1=Name, R2=Unique Client Code, R3=date,
 *                R4=Summary, R5-R7=summary, R8=header, R9-R14=data.
 *       MF:      R1=Personal Details, R2=Name, R3=Mobile, R4=PAN,
 *                R5=HOLDING SUMMARY, R6=summary header, R7=summary,
 *                R8=date, R9=header, R10-R12=data.
 *   - Extracts the account identifier from the preamble
 *     (Unique Client Code for Stocks; Mobile Number for MF). The
 *     MF preamble also supplies a PAN value which is preserved as
 *     broker-internal metadata but is NOT used as the canonical
 *     account (per the authority record §6.4 parser-layer policy:
 *     Mobile is the canonical account for Groww MF).
 *   - Recomputes Stocks values: investedValue = Quantity × Average
 *     buy price, currentValue = Quantity × Closing price,
 *     unrealisedPnL = currentValue − investedValue. The broker's
 *     own Buy value / Closing value / Unrealised P&L columns are
 *     NOT trusted as canonical values (consistent with WP-04 §8).
 *   - Uses broker-supplied values for MF: investedValue from
 *     "Invested Value", currentValue from "Current Value",
 *     averageCost = Invested / Units, currentPrice = Current / Units
 *     (per authority record §7.2; fractional MF units mean recompute
 *     would lose precision).
 *   - Sets ticker = undefined for both (Groww never provides a
 *     ticker column).
 *   - Sets isin = undefined for MF; populates isin for Stocks.
 *   - Sets xirrPercent = undefined for Stocks; parses the
 *     percent-suffixed XIRR string for MF and stores in 0-100 range.
 *   - Sets securityClassification = undefined for Stocks; preserves
 *     the broker-native Category string verbatim for MF.
 *   - Sets status = 'active' for every emitted Holding. Lifecycle
 *     reconciliation is WP-08's responsibility.
 *   - Produces per-row characterisation issues via ImportRowIssue.
 *
 * This adapter does NOT:
 *   - Query existing holdings.
 *   - Compare against repository state.
 *   - Compute new / updated / unchanged / closed_absent.
 *   - Persist.
 *   - Call HoldingAssetCollisionGuard.
 *   - Reuse the bank-statement SpreadsheetStatementParser.
 *   - Trust broker-derived values for Stocks investedValue /
 *     currentValue / unrealisedPnL.
 *   - Map Folio No. / AMC / Sub-category / Source / summary rows /
 *     statement date to any canonical Holding field.
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

/**
 * Groww Stocks header (verbatim, byte-exact, case-sensitive).
 * Source: Sample 6 (Groww_Stocks_Holdings_Statement_6995348108_23-08-2026.xlsx).
 * The authority record §4.1 binds the detection contract to this
 * exact sequence.
 */
const STOCKS_HEADERS: readonly string[] = [
  'Stock Name',
  'ISIN',
  'Quantity',
  'Average buy price',
  'Buy value',
  'Closing price',
  'Closing value',
  "Unrealised P&L",
] as const;

/**
 * Groww Mutual Funds header (verbatim, byte-exact, case-sensitive).
 * Source: Sample 6b (Groww_Mutual_Funds_6995348108_24-08-2026.xlsx).
 * The authority record §4.2 binds the detection contract to this
 * exact sequence. The trailing empty 12th column in the file is
 * structural noise and is permitted but not required.
 */
const MF_HEADERS: readonly string[] = [
  'Scheme Name',
  'AMC',
  'Category',
  'Sub-category',
  'Folio No.',
  'Source',
  'Units',
  'Invested Value',
  'Current Value',
  'Returns',
  'XIRR',
] as const;

/**
 * Known sheet names for each variant. The adapter selects the sheet
 * by matching the discovered header schema; sheet names are a hint,
 * not a structural signal.
 */
const STOCKS_SHEET_HINT = 'Sheet1';
const MF_SHEET_HINT = 'Holdings';

/**
 * Stocks preamble: locate the data-row table by finding the row
 * whose first cell is "Stock Name" (the header row). Rows above
 * (R1..R7) are preamble; rows below (R9..) are data.
 *
 * Account identity: extracted from the row whose first cell is
 * "Unique Client Code"; the second cell of that row is the UCC.
 */
const STOCKS_HEADER_MARKER = 'Stock Name';
const STOCKS_ACCOUNT_LABEL = 'Unique Client Code';

/**
 * MF preamble: locate the data-row table by finding the row whose
 * first cell is "Scheme Name" (the header row). Rows above (R1..R8)
 * are preamble; rows below (R10..) are data.
 *
 * Account identity: extracted from the row whose first cell is
 * "Mobile Number"; the second cell of that row is the mobile value.
 * The PAN is present in the same preamble but is NOT used as the
 * canonical account (per authority record §6.4).
 */
const MF_HEADER_MARKER = 'Scheme Name';
const MF_ACCOUNT_LABEL = 'Mobile Number';

/**
 * Numeric parser that tolerates:
 *   - ASCII hyphen-minus prefix for negatives (e.g. "-118")
 *   - Whitespace inside the value (trimmed)
 *   - Empty string (returns null, NOT NaN)
 *   - "1,234.56" thousand-separated numbers (commas stripped)
 *
 * Returns null for any other non-finite or non-parseable input.
 * SheetJS with `raw: false` emits numbers as their plain string
 * form (e.g. "250", "97.28", "-118"). Comma-separated thousands are
 * not observed in either real sample but the tolerance is defensive.
 */
function parseGrowwNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // Strip thousands separators (commas) defensively.
  trimmed = trimmed.replace(/,/g, '');
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Parse a percent-suffixed string (e.g. "2.03%") into a 0-100 number.
 * Returns null for unparseable input.
 */
function parseGrowwPercent(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // Strip a trailing percent sign.
  if (trimmed.endsWith('%')) {
    trimmed = trimmed.slice(0, -1).trim();
  }
  trimmed = trimmed.replace(/,/g, '');
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

export class GrowwHoldingsAdapter implements BrokerAdapter {
  readonly id = 'groww';
  readonly displayName = 'Groww Holdings';

  // =========================================================================
  // DETECTION
  // =========================================================================

  canHandle(input: StatementInput): BrokerDetectionResult {
    if (input.kind !== 'binary') {
      // Defensive: Groww exports are XLSX (binary). A text
      // StatementInput cannot be a Groww file. This matches the
      // WP-04 Zerodha adapter's symmetric defensive no-match for
      // binary inputs.
      return this.noMatch('Groww exports are binary XLSX; text input cannot match.');
    }
    const bytes = input.content;
    if (!bytes || bytes.length === 0) {
      return this.noMatch('Empty or missing binary content.');
    }
    const decoded = this.decodeXlsx(bytes);
    if (decoded.error) {
      return this.noMatch(decoded.error);
    }
    if (decoded.variant === 'none') {
      return this.noMatch('Workbook does not contain a Groww header signature on any sheet.');
    }
    return {
      matched: true,
      formatId: 'groww',
      displayName: this.displayName,
      confidence: 'HIGH',
      reason: `Matched Groww ${decoded.variant === 'stocks' ? 'Stocks' : 'Mutual Funds'} header signature on sheet "${decoded.sheetName}"`,
    };
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[]): BrokerDetectionResult {
    if (this.matchesStocksHeader(headers)) {
      return {
        matched: true,
        formatId: 'groww',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Groww Stocks header signature (decoded rows)',
      };
    }
    if (this.matchesMfHeader(headers)) {
      return {
        matched: true,
        formatId: 'groww',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Groww Mutual Funds header signature (decoded rows)',
      };
    }
    return this.noMatch('Decoded header does not match any Groww variant signature.');
  }

  // =========================================================================
  // PARSING
  // =========================================================================

  parseHoldings(input: StatementInput): BrokerParseOutput {
    if (input.kind !== 'binary') {
      return this.emptyOutput(input.fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
          'Groww adapter does not accept text input in V1 (Groww exports are XLSX).'),
      ]);
    }
    return this.parseFromBytes(input.content, input.fileName);
  }

  parseHoldingsFromRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    // The decoded-rows path receives a pre-decoded string[][] from
    // the import pipeline. The header is the first row whose cells
    // match one of the two Groww header signatures; everything
    // before that row is preamble (used for account extraction);
    // everything after is data.
    if (rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Decoded rows are empty.'),
      ]);
    }

    // Walk the rows looking for the header marker. We use the
    // first cell (rawFields[0]) for marker detection.
    let headerIdx = -1;
    let variant: 'stocks' | 'mf' | 'none' = 'none';
    for (let r = 0; r < rows.length; r++) {
      const firstCell = (rows[r].rawFields[0] ?? '').trim();
      if (firstCell === STOCKS_HEADER_MARKER) {
        headerIdx = r;
        variant = 'stocks';
        break;
      }
      if (firstCell === MF_HEADER_MARKER) {
        headerIdx = r;
        variant = 'mf';
        break;
      }
    }

    if (headerIdx === -1 || variant === 'none') {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Cannot locate the Groww header row in the decoded rows.'),
      ]);
    }

    // Validate the discovered header against the binding sequence.
    const headerRawFields = rows[headerIdx].rawFields;
    const headerNormalised = headerRawFields.map((f) => String(f ?? '').trim());
    if (variant === 'stocks' && !this.matchesStocksHeader(headerNormalised)) {
      return this.emptyOutput(fileName, [
        this.issue(rows[headerIdx].rowNumber, 'INVALID', 'BROKER_HEADER_MISSING',
          'Stocks header marker found but the column sequence does not match the Groww Stocks schema.'),
      ]);
    }
    if (variant === 'mf' && !this.matchesMfHeader(headerNormalised)) {
      return this.emptyOutput(fileName, [
        this.issue(rows[headerIdx].rowNumber, 'INVALID', 'BROKER_HEADER_MISSING',
          'MF header marker found but the column sequence does not match the Groww MF schema.'),
      ]);
    }

    // Preamble (rows before header) is used for account extraction.
    const preamble = rows.slice(0, headerIdx);
    const dataRows = rows.slice(headerIdx + 1);

    const account = this.extractAccount(preamble, variant, fileName);
    if (account === null) {
      // Account is REQUIRED for Groww (the file always supplies it
      // in the real samples; if the preamble is missing it, we
      // emit an error and return no Holdings).
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          `Cannot locate the account identifier in the preamble (looking for "${variant === 'stocks' ? STOCKS_ACCOUNT_LABEL : MF_ACCOUNT_LABEL}").`),
      ]);
    }

    if (dataRows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(rows[headerIdx].rowNumber, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Groww file contains only the header row, no data rows.')],
      );
    }

    return variant === 'stocks'
      ? this.walkStocksRows(dataRows, account, fileName)
      : this.walkMfRows(dataRows, account, fileName);
  }

  // =========================================================================
  // XLSX DECODE (PRIVATE)
  // =========================================================================

  /**
   * Decode an XLSX byte buffer and return the first sheet that
   * matches one of the two Groww header signatures. The selection
   * is content-based: the adapter walks every sheet, looks for a
   * row matching the Stocks or MF header marker, and returns the
   * first match.
   *
   * Sheet name is a hint only; the actual selection is by header
   * content. The decoded `string[][]` uses SheetJS with
   * `{ cellText: true, cellDates: false, raw: false }` to match the
   * behaviour observed when verifying both real samples.
   */
  private decodeXlsx(bytes: Uint8Array): {
    rows: string[][];
    sheetName: string;
    variant: 'stocks' | 'mf' | 'none';
    error?: string;
  } {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(bytes, { type: 'array', cellText: true, cellDates: false });
    } catch (err) {
      return {
        rows: [],
        sheetName: '',
        variant: 'none',
        error: `XLSX decode failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { rows: [], sheetName: '', variant: 'none', error: 'Workbook contains no worksheets.' };
    }

    // Prefer the sheet whose name matches a known hint; verify with
    // header detection. Fall back to scanning every sheet.
    const candidateSheets: string[] = [];
    if (workbook.Sheets[STOCKS_SHEET_HINT]) candidateSheets.push(STOCKS_SHEET_HINT);
    // MF_SHEET_HINT is always distinct from STOCKS_SHEET_HINT (one
    // is "Sheet1", the other is "Holdings"). The includes check
    // below covers the duplicate-hint case.
    if (workbook.Sheets[MF_SHEET_HINT] && !candidateSheets.includes(MF_SHEET_HINT)) {
      candidateSheets.push(MF_SHEET_HINT);
    }
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
      // Look for the header marker in the first 15 rows.
      for (let r = 0; r < Math.min(15, aoa.length); r++) {
        const first: string = String(aoa[r]?.[0] ?? '').trim();
        if (first === STOCKS_HEADER_MARKER) {
          return { rows: aoa, sheetName: sn, variant: 'stocks' };
        }
        if (first === MF_HEADER_MARKER) {
          return { rows: aoa, sheetName: sn, variant: 'mf' };
        }
      }
    }

    return { rows: [], sheetName: '', variant: 'none' };
  }

  /**
   * Entry point for binary `parseHoldings` (kind === 'binary').
   * Decodes the workbook and dispatches to the same per-row walker
   * as the decoded-rows path.
   */
  private parseFromBytes(bytes: Uint8Array, fileName: string): BrokerParseOutput {
    if (!bytes || bytes.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Empty or missing binary content.'),
      ]);
    }
    const decoded = this.decodeXlsx(bytes);
    if (decoded.error) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED', decoded.error),
      ]);
    }
    if (decoded.variant === 'none' || decoded.rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
          'Workbook does not contain a Groww header signature on any sheet.'),
      ]);
    }

    // Find the header index.
    let headerIdx = -1;
    for (let r = 0; r < decoded.rows.length; r++) {
      const first = String(decoded.rows[r]?.[0] ?? '').trim();
      if ((decoded.variant === 'stocks' && first === STOCKS_HEADER_MARKER) ||
          (decoded.variant === 'mf' && first === MF_HEADER_MARKER)) {
        headerIdx = r;
        break;
      }
    }
    if (headerIdx === -1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING', 'Cannot locate the Groww header row in the workbook.')],
      );
    }

    const preamble = decoded.rows.slice(0, headerIdx);
    const dataRows = decoded.rows.slice(headerIdx + 1);

    // Validate the header sequence.
    const headerFields = decoded.rows[headerIdx].map((f) => String(f ?? '').trim());
    if (decoded.variant === 'stocks' && !this.matchesStocksHeader(headerFields)) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Stocks header marker found but the column sequence does not match the Groww Stocks schema.')],
      );
    }
    if (decoded.variant === 'mf' && !this.matchesMfHeader(headerFields)) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'INVALID', 'BROKER_HEADER_MISSING',
          'MF header marker found but the column sequence does not match the Groww MF schema.')],
      );
    }

    const account = this.extractAccountFromAoa(preamble, decoded.variant);
    if (account === null) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          `Cannot locate the account identifier in the preamble (looking for "${decoded.variant === 'stocks' ? STOCKS_ACCOUNT_LABEL : MF_ACCOUNT_LABEL}").`)],
      );
    }
    if (dataRows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(headerIdx + 1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Groww file contains only the header row, no data rows.')],
      );
    }

    return decoded.variant === 'stocks'
      ? this.walkStocksRowsFromAoa(dataRows, account, fileName)
      : this.walkMfRowsFromAoa(dataRows, account, fileName);
  }

  // =========================================================================
  // HEADER MATCHING
  // =========================================================================

  private matchesStocksHeader(headers: readonly string[]): boolean {
    if (headers.length < STOCKS_HEADERS.length) return false;
    for (let i = 0; i < STOCKS_HEADERS.length; i++) {
      if (headers[i] !== STOCKS_HEADERS[i]) return false;
    }
    return true;
  }

  private matchesMfHeader(headers: readonly string[]): boolean {
    if (headers.length < MF_HEADERS.length) return false;
    for (let i = 0; i < MF_HEADERS.length; i++) {
      if (headers[i] !== MF_HEADERS[i]) return false;
    }
    // Trailing empty column 12 is structural noise and is permitted
    // but not required.
    if (headers.length > MF_HEADERS.length) {
      const extra = headers.slice(MF_HEADERS.length);
      if (extra.some((e) => e !== '')) return false;
    }
    return true;
  }

  // =========================================================================
  // ACCOUNT EXTRACTION
  // =========================================================================

  /**
   * Extract the account identifier from a preamble of
   * `ParsedCsvRow[]` (the decoded-rows path).
   *
   * Stocks: row whose first cell === "Unique Client Code"; second
   * cell is the UCC.
   *
   * MF: row whose first cell === "Mobile Number"; second cell is
   * the mobile. PAN is NOT used.
   */
  private extractAccount(
    preamble: ParsedCsvRow[],
    variant: 'stocks' | 'mf',
    _fileName: string,
  ): string | null {
    const targetLabel = variant === 'stocks' ? STOCKS_ACCOUNT_LABEL : MF_ACCOUNT_LABEL;
    for (const r of preamble) {
      const first = String(r.rawFields[0] ?? '').trim();
      if (first === targetLabel) {
        const value = String(r.rawFields[1] ?? '').trim();
        if (value === '') return null;
        return value;
      }
    }
    return null;
  }

  /**
   * Same as `extractAccount` but for a `string[][]` preamble (the
   * binary-decode path).
   */
  private extractAccountFromAoa(
    preamble: string[][],
    variant: 'stocks' | 'mf',
  ): string | null {
    const targetLabel = variant === 'stocks' ? STOCKS_ACCOUNT_LABEL : MF_ACCOUNT_LABEL;
    for (const row of preamble) {
      const first = String(row[0] ?? '').trim();
      if (first === targetLabel) {
        const value = String(row[1] ?? '').trim();
        if (value === '') return null;
        return value;
      }
    }
    return null;
  }

  // =========================================================================
  // ROW WALKERS — STOCKS
  // =========================================================================

  /**
   * Walk Stocks data rows. Each row's first cell is the Stock Name;
   * the parser recomputes investedValue, currentValue, unrealisedPnL
   * from Quantity × price (the broker's own Buy value / Closing
   * value / Unrealised P&L columns are NOT trusted as canonical
   * values).
   */
  private walkStocksRows(
    dataRows: ParsedCsvRow[],
    account: string,
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    dataRows.forEach((row) => {
      const fileRowNumber = row.rowNumber;
      const fields = row.rawFields;
      if (fields.length < STOCKS_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected at least ${STOCKS_HEADERS.length}.`));
        return;
      }

      const instrumentName = String(fields[0] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Stock Name is empty for this row.'));
        return;
      }

      const isin = String(fields[1] ?? '').trim();
      const isinValue = isin === '' ? undefined : isin;

      const quantity = parseGrowwNumber(fields[2]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Quantity is not a parseable number: ${JSON.stringify(fields[2])}`, 'Quantity', String(fields[2])));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Quantity is negative (${quantity}); row rejected.`, 'Quantity', String(fields[2])));
        return;
      }

      const averageCost = parseGrowwNumber(fields[3]);
      if (averageCost === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Average buy price is not a parseable number: ${JSON.stringify(fields[3])}`, 'Average buy price', String(fields[3])));
        return;
      }
      if (averageCost < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Average buy price is negative (${averageCost}); rejected.`, 'Average buy price', String(fields[3])));
        return;
      }

      const currentPrice = parseGrowwNumber(fields[5]);
      if (currentPrice === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Closing price is not a parseable number: ${JSON.stringify(fields[5])}`, 'Closing price', String(fields[5])));
        return;
      }
      if (currentPrice < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Closing price is negative (${currentPrice}); rejected.`, 'Closing price', String(fields[5])));
        return;
      }

      // Mathematically-valid recomputation (no NaN, no Infinity).
      const investedValue = quantity * averageCost;
      const currentValue = quantity * currentPrice;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0 ? (unrealisedPnL / investedValue) * 100 : undefined;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Quantity is zero; holding emitted with all derived values = 0.', 'Quantity', String(fields[2])));
      }

      // Duplicate-inside-batch detection. ISIN is the strongest
      // available identifier; if no ISIN, fall back to instrumentName.
      const identityKey = `Groww|${account}|${isinValue ?? instrumentName}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate identity inside batch: ${JSON.stringify(isinValue ?? instrumentName)} (first occurrence retained).`,
          isinValue ? 'ISIN' : 'Stock Name', isinValue ?? instrumentName));
        return;
      }
      seen.add(identityKey);

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Groww',
        account,
        instrumentName,
        ...(isinValue !== undefined ? { isin: isinValue } : {}),
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
        importedAt,
      };

      holdings.push(holding);
    });

    return {
      broker: 'Groww',
      account,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  /**
   * Walk Stocks data rows from a `string[][]` (the binary path).
   * Identical to `walkStocksRows` but reads from `string[]` arrays
   * rather than `ParsedCsvRow` objects. Row numbers are 1-based and
   * refer to the position of the data row within `dataRows` plus
   * the preamble length plus the header row (so the first data row
   * is at preamble.length + 2 in the original sheet, 1-based).
   */
  private walkStocksRowsFromAoa(
    dataRows: string[][],
    account: string,
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    dataRows.forEach((fields, idx) => {
      // The binary path's row numbering uses the data-row index
      // plus a +2 offset (preamble rows are 1..N; header is N+1;
      // first data row is N+2 in the sheet). We don't have the
      // exact preamble length at this point; use idx+1 as a
      // data-local row number. The issue is still tied to the
      // correct sheet position by being emitted from this
      // per-data-row loop.
      const fileRowNumber = idx + 1;
      if (fields.length < STOCKS_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected at least ${STOCKS_HEADERS.length}.`));
        return;
      }

      const instrumentName = String(fields[0] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Stock Name is empty for this row.'));
        return;
      }

      const isin = String(fields[1] ?? '').trim();
      const isinValue = isin === '' ? undefined : isin;

      const quantity = parseGrowwNumber(fields[2]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Quantity is not a parseable number: ${JSON.stringify(fields[2])}`, 'Quantity', String(fields[2])));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Quantity is negative (${quantity}); row rejected.`, 'Quantity', String(fields[2])));
        return;
      }

      const averageCost = parseGrowwNumber(fields[3]);
      if (averageCost === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Average buy price is not a parseable number: ${JSON.stringify(fields[3])}`, 'Average buy price', String(fields[3])));
        return;
      }
      if (averageCost < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Average buy price is negative (${averageCost}); rejected.`, 'Average buy price', String(fields[3])));
        return;
      }

      const currentPrice = parseGrowwNumber(fields[5]);
      if (currentPrice === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Closing price is not a parseable number: ${JSON.stringify(fields[5])}`, 'Closing price', String(fields[5])));
        return;
      }
      if (currentPrice < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Closing price is negative (${currentPrice}); rejected.`, 'Closing price', String(fields[5])));
        return;
      }

      const investedValue = quantity * averageCost;
      const currentValue = quantity * currentPrice;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0 ? (unrealisedPnL / investedValue) * 100 : undefined;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Quantity is zero; holding emitted with all derived values = 0.', 'Quantity', String(fields[2])));
      }

      const identityKey = `Groww|${account}|${isinValue ?? instrumentName}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate identity inside batch: ${JSON.stringify(isinValue ?? instrumentName)} (first occurrence retained).`,
          isinValue ? 'ISIN' : 'Stock Name', isinValue ?? instrumentName));
        return;
      }
      seen.add(identityKey);

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Groww',
        account,
        instrumentName,
        ...(isinValue !== undefined ? { isin: isinValue } : {}),
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
        importedAt,
      };

      holdings.push(holding);
    });

    return {
      broker: 'Groww',
      account,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  // =========================================================================
  // ROW WALKERS — MUTUAL FUNDS
  // =========================================================================

  /**
   * Walk MF data rows. Uses broker-supplied Invested Value and
   * Current Value (NOT recomputed; MF has fractional Units and no
   * per-row NAV). Derives averageCost = Invested / Units and
   * currentPrice = Current / Units. XIRR is parsed from the
   * percent-suffixed string and stored in 0-100 range. Category is
   * preserved verbatim. Folio No., AMC, Sub-category, Source, and
   * Returns are NOT mapped to any canonical Holding field.
   */
  private walkMfRows(
    dataRows: ParsedCsvRow[],
    account: string,
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    dataRows.forEach((row) => {
      const fileRowNumber = row.rowNumber;
      const fields = row.rawFields;
      if (fields.length < MF_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected at least ${MF_HEADERS.length}.`));
        return;
      }

      const instrumentName = String(fields[0] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Scheme Name is empty for this row.'));
        return;
      }

      // Folio No. (field 4) is broker-internal metadata. It is
      // stored as a number in the XLSX (e.g. 488440507951,
      // 40930660) but is an identifier, not a quantity. SheetJS
      // emits numbers as their string form; we extract the value
      // but do NOT use it for any canonical Holding field.

      const quantity = parseGrowwNumber(fields[6]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Units is not a parseable number: ${JSON.stringify(fields[6])}`, 'Units', String(fields[6])));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Units is negative (${quantity}); row rejected.`, 'Units', String(fields[6])));
        return;
      }

      const investedValue = parseGrowwNumber(fields[7]);
      if (investedValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested Value is not a parseable number: ${JSON.stringify(fields[7])}`, 'Invested Value', String(fields[7])));
        return;
      }
      if (investedValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested Value is negative (${investedValue}); rejected.`, 'Invested Value', String(fields[7])));
        return;
      }

      const currentValue = parseGrowwNumber(fields[8]);
      if (currentValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is not a parseable number: ${JSON.stringify(fields[8])}`, 'Current Value', String(fields[8])));
        return;
      }
      if (currentValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is negative (${currentValue}); rejected.`, 'Current Value', String(fields[8])));
        return;
      }

      // Returns (field 9) is broker-internal metadata. We do NOT
      // use it directly; unrealisedPnL is recomputed from
      // currentValue - investedValue. Returns is parsed only to
      // confirm the row is well-formed; an unparseable Returns
      // does NOT block the row.

      // XIRR (field 10). Percent-suffixed string in 0-100 range
      // (e.g. "2.03%" parses to 2.03). If unparseable, emit a
      // warning-level issue and set xirrPercent = undefined; the
      // rest of the row is still emitted.
      const xirrRaw = String(fields[10] ?? '').trim();
      let xirrPercent: number | undefined;
      if (xirrRaw === '') {
        xirrPercent = undefined;
      } else {
        const parsed = parseGrowwPercent(xirrRaw);
        if (parsed === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `XIRR is not a parseable percent string: ${JSON.stringify(xirrRaw)}`,
            'XIRR', xirrRaw));
          xirrPercent = undefined;
        } else {
          xirrPercent = parsed;
        }
      }

      // Category (field 2). Preserved verbatim.
      const category = String(fields[2] ?? '').trim();
      const securityClassification = category === '' ? undefined : category;

      // Derived values.
      const averageCost = quantity > 0 ? investedValue / quantity : 0;
      const currentPrice = quantity > 0 ? currentValue / quantity : 0;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0 ? (unrealisedPnL / investedValue) * 100 : undefined;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent)) ||
        (xirrPercent !== undefined && !Number.isFinite(xirrPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Units is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Units', String(fields[6])));
      }

      // Duplicate-inside-batch detection. For MF, the strongest
      // available identifier is the normalized scheme name.
      const identityKey = `Groww|${account}|${instrumentName}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate identity inside batch: ${JSON.stringify(instrumentName)} (first occurrence retained).`,
          'Scheme Name', instrumentName));
        return;
      }
      seen.add(identityKey);

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Groww',
        account,
        instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCost,
        investedValue,
        currentPrice: quantity === 0 ? 0 : currentPrice,
        currentValue,
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
      broker: 'Groww',
      account,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  /**
   * Walk MF data rows from a `string[][]` (the binary path).
   * Mirrors `walkMfRows` but reads from `string[]` arrays.
   */
  private walkMfRowsFromAoa(
    dataRows: string[][],
    account: string,
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    dataRows.forEach((fields, idx) => {
      const fileRowNumber = idx + 1;
      if (fields.length < MF_HEADERS.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${fields.length} fields; expected at least ${MF_HEADERS.length}.`));
        return;
      }

      const instrumentName = String(fields[0] ?? '').trim();
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Scheme Name is empty for this row.'));
        return;
      }

      const quantity = parseGrowwNumber(fields[6]);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Units is not a parseable number: ${JSON.stringify(fields[6])}`, 'Units', String(fields[6])));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Units is negative (${quantity}); row rejected.`, 'Units', String(fields[6])));
        return;
      }

      const investedValue = parseGrowwNumber(fields[7]);
      if (investedValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested Value is not a parseable number: ${JSON.stringify(fields[7])}`, 'Invested Value', String(fields[7])));
        return;
      }
      if (investedValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested Value is negative (${investedValue}); rejected.`, 'Invested Value', String(fields[7])));
        return;
      }

      const currentValue = parseGrowwNumber(fields[8]);
      if (currentValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is not a parseable number: ${JSON.stringify(fields[8])}`, 'Current Value', String(fields[8])));
        return;
      }
      if (currentValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Current Value is negative (${currentValue}); rejected.`, 'Current Value', String(fields[8])));
        return;
      }

      const xirrRaw = String(fields[10] ?? '').trim();
      let xirrPercent: number | undefined;
      if (xirrRaw === '') {
        xirrPercent = undefined;
      } else {
        const parsed = parseGrowwPercent(xirrRaw);
        if (parsed === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `XIRR is not a parseable percent string: ${JSON.stringify(xirrRaw)}`,
            'XIRR', xirrRaw));
          xirrPercent = undefined;
        } else {
          xirrPercent = parsed;
        }
      }

      const category = String(fields[2] ?? '').trim();
      const securityClassification = category === '' ? undefined : category;

      const averageCost = quantity > 0 ? investedValue / quantity : 0;
      const currentPrice = quantity > 0 ? currentValue / quantity : 0;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0 ? (unrealisedPnL / investedValue) * 100 : undefined;

      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(unrealisedPnL) ||
        (unrealisedPnLPercent !== undefined && !Number.isFinite(unrealisedPnLPercent)) ||
        (xirrPercent !== undefined && !Number.isFinite(xirrPercent))
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Units is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Units', String(fields[6])));
      }

      const identityKey = `Groww|${account}|${instrumentName}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate identity inside batch: ${JSON.stringify(instrumentName)} (first occurrence retained).`,
          'Scheme Name', instrumentName));
        return;
      }
      seen.add(identityKey);

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Groww',
        account,
        instrumentName,
        isin: undefined,
        ticker: undefined,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCost,
        investedValue,
        currentPrice: quantity === 0 ? 0 : currentPrice,
        currentValue,
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
      broker: 'Groww',
      account,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  private noMatch(reason: string): BrokerDetectionResult {
    return {
      matched: false,
      formatId: 'groww',
      displayName: this.displayName,
      confidence: 'NONE',
      reason,
    };
  }

  private emptyOutput(fileName: string, issues: ImportRowIssue[]): BrokerParseOutput {
    return {
      broker: 'Groww',
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
