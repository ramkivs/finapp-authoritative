/**
 * WP-FB-IMPORT-BROKER-01 — FINBOOM-CR (CR-05) Angel One holdings adapter.
 *
 * Structural detection + row-level parsing for the Angel One Stocks
 * XLSX export. The supplied fixture is a single-sheet workbook
 * (sheet name: "Portfolio") with a metadata preamble (rows 1-6),
 * a `Holding Details` section marker (row 7 in the supplied
 * fixture), a 15-column header row (row 8 in the supplied fixture),
 * and 6 data rows (rows 9-14 in the supplied fixture).
 *
 * The supplied file is named `Angelonestockholdings.txt` but is
 * actually XLSX (ZIP magic `PK\003\004`). The adapter detects by
 * content (XLSX magic + workbook structure), not by extension.
 *
 * CR decisions encoded in this adapter:
 *   - CR-04: `unrealisedPnL` = column L "Overall Gain/Loss" only.
 *     `Realised Gain/Loss` (col M) is read but NEVER combined
 *     with Overall Gain/Loss. `Holding Weightage` (col N) is
 *     read but NEVER used as a valuation denominator.
 *   - CR-05: `Sector` (col E) and `MarketCap` (col D) are read
 *     but NEVER silently mapped to `AssetType`. The adapter sets
 *     `Holding.securityClassification = undefined` for every
 *     emitted Holding. Downstream classification is the closed-
 *     vocabulary D-05 classifier's job.
 *   - CR-06: `Holding.quantity = Quantity` (col F). `Blocked_qty`
 *     (col G) is read but NEVER used in any calculation. A row
 *     with `Quantity = 5, Blocked_qty = 5` produces a Holding
 *     with `quantity = 5` (NOT `0`, NOT `5 - 5`).
 *
 * This adapter:
 *   - Performs structural detection (XLSX magic + Portfolio sheet
 *     + `Holding Details` section marker + 15-column header).
 *     Filename is NOT the only signal.
 *   - Decodes the XLSX internally using the vendored xlsx@0.20.3
 *     library. The bank-statement `SpreadsheetStatementParser` is
 *     intentionally NOT reused.
 *   - Walks the supplied Portfolio sheet by scanning column A
 *     downward from row 1 to find the `Holding Details` section
 *     marker (case-sensitive), then taking the next non-blank row
 *     as the header. Data is from header+1 to the first all-blank
 *     row (or end of sheet).
 *   - Sets broker = "Angel One".
 *   - Sets account = undefined (Angel One has no account column).
 *   - Sets ticker = Scrip/Contract, instrumentName = Company Name,
 *     isin = ISIN (all three are broker-native).
 *   - Sets xirrPercent = undefined, securityClassification =
 *     undefined, unrealisedPnLPercent = undefined.
 *   - Sets status = 'active' for every emitted Holding.
 *   - Produces per-row characterisation issues via ImportRowIssue.
 *
 * This adapter does NOT:
 *   - Query existing holdings.
 *   - Compare against repository state.
 *   - Compute new / updated / unchanged / closed_absent.
 *   - Persist.
 *   - Call HoldingAssetCollisionGuard.
 *   - Reuse the bank-statement SpreadsheetStatementParser.
 *   - Use `Blocked_qty` in any calculation (CR-06).
 *   - Combine `Realised Gain/Loss` with `Overall Gain/Loss`
 *     (CR-04).
 *   - Use `Holding Weightage` as a valuation denominator
 *     (CR-04).
 *   - Map `Sector` or `MarketCap` to `AssetType` (CR-05).
 *   - Read the file's filename extension to decide XLSX vs. text
 *     (detection is by content/magic).
 */

import { Holding } from '../../../domain/types';
import { HoldingIdentityService } from '../../HoldingIdentityService';
import {
  ACTIVE_HOLDING_STATUS,
  BrokerAdapter,
  BrokerDetectionResult,
  BrokerParseOutput,
} from '../BrokerAdapter';
import {
  ImportRowIssue,
  ImportIssueSeverity,
  ParsedCsvRow,
  StatementInput,
} from '../ImportTypes';
import * as XLSX from 'xlsx';

/**
 * Sheet name hint for Angel One. The adapter selects the sheet by
 * content (presence of `Holding Details` marker and the 15-column
 * header), not by sheet name. Sheet name is a hint, not a
 * structural signal.
 */
const PORTFOLIO_SHEET_HINT = 'Portfolio';

/**
 * Section marker text that prefixes the data table. Case-sensitive.
 * The CR spec's dynamic-discovery rule: scan column A from row 1
 * downward; the first row whose first cell matches this literal
 * (after trim) is the section marker. The next non-blank row is
 * the header.
 */
const HOLDING_DETAILS_MARKER = 'Holding Details';

/**
 * Canonical Angel One 15-column header (verbatim, byte-exact,
 * case-sensitive). The detection routine validates the discovered
 * header against this sequence (case-insensitive, whitespace-
 * collapsed) before parsing.
 */
const ANGEL_ONE_HEADERS: readonly string[] = [
  'Scrip/Contract',
  'Company Name',
  'ISIN',
  'MarketCap',
  'Sector',
  'Quantity',
  'Blocked_qty',
  'Avg Trading Price',
  'Prev closing Price',
  'Invested Value',
  'Market Value as of last trading day',
  'Overall Gain/Loss',
  'Realised Gain/Loss',
  'Holding Weightage',
  'ARQ Prime Quantity',
] as const;

/**
 * Required columns (per CR-05 / CR-06). The header MUST contain all
 * of these (case-insensitive match) for the file to be recognised
 * as Angel One. `ARQ Prime Quantity` is read for completeness but
 * is not part of the required set (it is not used in any canonical
 * Holding field; some broker exports may omit it).
 */
const REQUIRED_HEADERS: readonly string[] = [
  'Scrip/Contract',
  'Company Name',
  'ISIN',
  'Quantity',
  'Blocked_qty',
  'Avg Trading Price',
  'Prev closing Price',
  'Invested Value',
  'Market Value as of last trading day',
  'Overall Gain/Loss',
  'Realised Gain/Loss',
  'Holding Weightage',
] as const;

/**
 * Numeric parser that tolerates:
 *   - ASCII hyphen-minus prefix for negatives (e.g. "-1638.50")
 *   - Whitespace inside the value (trimmed)
 *   - Empty string (returns null, NOT NaN)
 *   - Thousands-separator commas (e.g. "16,431" → 16431)
 *     (defensive; the supplied fixture has no commas)
 *
 * Returns null for any other non-finite or non-parseable input.
 */
function parseAngelOneNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let trimmed = String(raw).trim();
  if (trimmed === '') return null;
  trimmed = trimmed.replace(/,/g, '');
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Normalise a column header for case-insensitive comparison.
 * - Lowercase
 * - Collapse all runs of whitespace into a single space
 * - Trim
 *
 * Example: "Market Value as of last trading day" →
 *          "market value as of last trading day"
 */
function normaliseHeader(h: string): string {
  return String(h ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export class AngelOneHoldingsAdapter implements BrokerAdapter {
  readonly id = 'angelone';
  readonly displayName = 'Angel One';

  // =========================================================================
  // DETECTION
  // =========================================================================

  canHandle(input: StatementInput): BrokerDetectionResult {
    if (input.kind !== 'binary') {
      // Defensive: Angel One exports are XLSX (binary). A text
      // StatementInput cannot be an Angel One file. This matches
      // the Groww adapter's symmetric defensive no-match for text
      // inputs.
      return this.noMatch('Angel One exports are binary XLSX; text input cannot match.');
    }
    const bytes = input.content;
    if (!bytes || bytes.length === 0) {
      return this.noMatch('Empty or missing binary content.');
    }
    // Verify XLSX magic (PK\003\004). The supplied file is named
    // with a .txt extension; the adapter must detect by content.
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
        bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      return this.noMatch('Binary content does not have XLSX magic (PK\\003\\004).');
    }
    const decoded = this.decodeXlsx(bytes);
    if (decoded.error) {
      return this.noMatch(decoded.error);
    }
    if (decoded.sheetName === '' || decoded.rows.length === 0) {
      return this.noMatch('No usable sheet found in the XLSX workbook.');
    }
    if (decoded.headerIdx === -1) {
      return this.noMatch('Cannot locate the Angel One "Holding Details" section marker in the Portfolio sheet.');
    }
    const missing = this.missingRequiredHeaders(decoded.rows[decoded.headerIdx]);
    if (missing.length > 0) {
      return this.noMatch(`Angel One header is missing required columns: ${missing.join(', ')}.`);
    }
    return {
      matched: true,
      formatId: 'angelone',
      displayName: this.displayName,
      confidence: 'HIGH',
      reason: `Matched Angel One header signature on sheet "${decoded.sheetName}" (Holding Details at row ${decoded.sectionMarkerRow + 1}, header at row ${decoded.headerIdx + 1}).`,
    };
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[]): BrokerDetectionResult {
    // The decoded-rows path is for binary workbooks decoded by the
    // pipeline. The header must contain all required columns.
    const missing = this.missingRequiredHeaders(headers);
    if (missing.length > 0) {
      return this.noMatch(`Decoded header is missing required columns: ${missing.join(', ')}.`);
    }
    return {
      matched: true,
      formatId: 'angelone',
      displayName: this.displayName,
      confidence: 'HIGH',
      reason: 'Matched Angel One header signature (decoded rows).',
    };
  }

  // =========================================================================
  // PARSING
  // =========================================================================

  parseHoldings(input: StatementInput): BrokerParseOutput {
    if (input.kind !== 'binary') {
      return this.emptyOutput(input.fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
          'Angel One adapter does not accept text input in V1 (Angel One exports are XLSX).'),
      ]);
    }
    return this.parseFromBytes(input.content, input.fileName);
  }

  parseHoldingsFromRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    // The decoded-rows path receives pre-decoded string[][] from
    // the import pipeline. We use the same walker as the binary
    // path; the rows preserve their original `rowNumber` from the
    // decoder.
    if (rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Decoded rows are empty.'),
      ]);
    }
    // Find the Holding Details marker.
    let sectionMarkerRow = -1;
    for (let r = 0; r < rows.length; r++) {
      const first = String(rows[r].rawFields[0] ?? '').trim();
      if (first === HOLDING_DETAILS_MARKER) {
        sectionMarkerRow = r;
        break;
      }
    }
    if (sectionMarkerRow === -1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          `Cannot locate the Angel One "${HOLDING_DETAILS_MARKER}" section marker in the decoded rows.`),
      ]);
    }
    // The header is the next non-blank row after the marker.
    let headerIdx = -1;
    for (let r = sectionMarkerRow + 1; r < rows.length; r++) {
      const first = String(rows[r].rawFields[0] ?? '').trim();
      if (first !== '') {
        headerIdx = r;
        break;
      }
    }
    if (headerIdx === -1) {
      return this.emptyOutput(fileName, [
        this.issue(rows[sectionMarkerRow].rowNumber, 'INVALID', 'BROKER_HEADER_MISSING',
          `Cannot locate the Angel One header row after the "${HOLDING_DETAILS_MARKER}" marker.`),
      ]);
    }
    const headerFields = rows[headerIdx].rawFields.map((f) => String(f ?? '').trim());
    const missing = this.missingRequiredHeaders(headerFields);
    if (missing.length > 0) {
      return this.emptyOutput(fileName, [
        this.issue(rows[headerIdx].rowNumber, 'INVALID', 'BROKER_HEADER_MISSING',
          `Angel One header is missing required columns: ${missing.join(', ')}.`),
      ]);
    }
    const columnMap = this.buildColumnMap(headerFields);
    const dataRows = this.collectDataRows(rows, headerIdx);
    if (dataRows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(rows[headerIdx].rowNumber, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Angel One file contains only the header row, no data rows.'),
      ]);
    }
    return this.walkDataRows(dataRows, columnMap, fileName);
  }

  // =========================================================================
  // XLSX DECODE (PRIVATE)
  // =========================================================================

  private decodeXlsx(bytes: Uint8Array): {
    rows: string[][];
    sheetName: string;
    sectionMarkerRow: number;
    headerIdx: number;
    error?: string;
  } {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(bytes, { type: 'array', cellText: true, cellDates: false });
    } catch (err) {
      return {
        rows: [],
        sheetName: '',
        sectionMarkerRow: -1,
        headerIdx: -1,
        error: `XLSX decode failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { rows: [], sheetName: '', sectionMarkerRow: -1, headerIdx: -1,
        error: 'Workbook contains no worksheets.' };
    }

    // Sheet selection: prefer a sheet whose name is "Portfolio"
    // (case-insensitive). Otherwise fall back to scanning every
    // sheet for the `Holding Details` marker.
    const candidateSheets: string[] = [];
    // Try the hint sheet first.
    for (const sn of workbook.SheetNames) {
      if (sn.toLowerCase() === PORTFOLIO_SHEET_HINT.toLowerCase()) {
        candidateSheets.push(sn);
        break;
      }
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
      // Scan column A from row 1 downward for the section marker.
      let sectionMarkerRow = -1;
      for (let r = 0; r < aoa.length; r++) {
        const first = String(aoa[r]?.[0] ?? '').trim();
        if (first === HOLDING_DETAILS_MARKER) {
          sectionMarkerRow = r;
          break;
        }
      }
      if (sectionMarkerRow === -1) continue; // try next sheet
      // Header is the next non-blank row.
      let headerIdx = -1;
      for (let r = sectionMarkerRow + 1; r < aoa.length; r++) {
        const first = String(aoa[r]?.[0] ?? '').trim();
        if (first !== '') {
          headerIdx = r;
          break;
        }
      }
      if (headerIdx === -1) continue;
      // Verify the discovered header has all required columns.
      const headerFields = (aoa[headerIdx] ?? []).map((f) => String(f ?? '').trim());
      const missing = this.missingRequiredHeaders(headerFields);
      if (missing.length > 0) continue;
      return { rows: aoa, sheetName: sn, sectionMarkerRow, headerIdx };
    }

    return { rows: [], sheetName: '', sectionMarkerRow: -1, headerIdx: -1 };
  }

  private parseFromBytes(bytes: Uint8Array, fileName: string): BrokerParseOutput {
    if (!bytes || bytes.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_EMPTY', 'Empty or missing binary content.'),
      ]);
    }
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
        bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
          'Binary content does not have XLSX magic (PK\\003\\004).'),
      ]);
    }
    const decoded = this.decodeXlsx(bytes);
    if (decoded.error) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED', decoded.error),
      ]);
    }
    if (decoded.sheetName === '' || decoded.rows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'No usable sheet found in the XLSX workbook (looking for "Portfolio" with the "Holding Details" marker).'),
      ]);
    }
    if (decoded.headerIdx === -1) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          `Cannot locate the Angel One "${HOLDING_DETAILS_MARKER}" section marker in any sheet.`),
      ]);
    }
    const headerFields = decoded.rows[decoded.headerIdx].map((f) => String(f ?? '').trim());
    const missing = this.missingRequiredHeaders(headerFields);
    if (missing.length > 0) {
      return this.emptyOutput(fileName, [
        this.issue(decoded.headerIdx + 1, 'INVALID', 'BROKER_HEADER_MISSING',
          `Angel One header is missing required columns: ${missing.join(', ')}.`),
      ]);
    }
    const columnMap = this.buildColumnMap(headerFields);
    // Data rows: from header+1 to the first all-blank row, or end
    // of sheet. Use 1-based file row numbers.
    const dataRows: { rowNumber: number; fields: string[] }[] = [];
    for (let r = decoded.headerIdx + 1; r < decoded.rows.length; r++) {
      const fields = (decoded.rows[r] ?? []).map((f) => String(f ?? ''));
      const isBlank = fields.every((f) => String(f).trim() === '');
      if (isBlank) break;
      dataRows.push({ rowNumber: r + 1, fields });
    }
    if (dataRows.length === 0) {
      return this.emptyOutput(fileName, [
        this.issue(decoded.headerIdx + 1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
          'Angel One file contains only the header row, no data rows.'),
      ]);
    }
    return this.walkDataRows(dataRows, columnMap, fileName);
  }

  // =========================================================================
  // HEADER VALIDATION + COLUMN MAP
  // =========================================================================

  /**
   * Return the list of required header names that are missing
   * from the given header (case-insensitive, whitespace-
   * collapsed). Empty array = all required columns are present.
   */
  private missingRequiredHeaders(headers: readonly string[]): string[] {
    const normalised = new Set(headers.map(normaliseHeader));
    const missing: string[] = [];
    for (const required of REQUIRED_HEADERS) {
      if (!normalised.has(normaliseHeader(required))) {
        missing.push(required);
      }
    }
    return missing;
  }

  /**
   * Build a column-name → column-index map for the discovered
   * header. Required columns that are present are mapped to their
   * index; missing required columns would have been caught by
   * `missingRequiredHeaders` before this is called.
   */
  private buildColumnMap(headerFields: readonly string[]): {
    scrip: number; company: number; isin: number;
    quantity: number; blockedQty: number;
    avgPrice: number; prevClose: number;
    invested: number; marketValue: number;
    overallGainLoss: number; realisedGainLoss: number;
    holdingWeightage: number;
    sector: number; marketCap: number; arqPrime: number;
  } {
    const map: Record<string, number> = {};
    headerFields.forEach((h, i) => {
      map[normaliseHeader(h)] = i;
    });
    const find = (name: string): number => {
      const idx = map[normaliseHeader(name)];
      return typeof idx === 'number' ? idx : -1;
    };
    return {
      scrip: find('Scrip/Contract'),
      company: find('Company Name'),
      isin: find('ISIN'),
      quantity: find('Quantity'),
      blockedQty: find('Blocked_qty'),
      avgPrice: find('Avg Trading Price'),
      prevClose: find('Prev closing Price'),
      invested: find('Invested Value'),
      marketValue: find('Market Value as of last trading day'),
      overallGainLoss: find('Overall Gain/Loss'),
      realisedGainLoss: find('Realised Gain/Loss'),
      holdingWeightage: find('Holding Weightage'),
      sector: find('Sector'),
      marketCap: find('MarketCap'),
      arqPrime: find('ARQ Prime Quantity'),
    };
  }

  // =========================================================================
  // DATA ROW COLLECTION (decoded-rows path)
  // =========================================================================

  /**
   * From the decoded ParsedCsvRow[], find the first all-blank row
   * after the header and return the data rows in between. Each
   * data row preserves its original `rowNumber`.
   */
  private collectDataRows(
    rows: ParsedCsvRow[],
    headerIdx: number,
  ): { rowNumber: number; fields: string[] }[] {
    const out: { rowNumber: number; fields: string[] }[] = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const fields = (rows[r].rawFields ?? []).map((f) => String(f ?? ''));
      const isBlank = fields.every((f) => String(f).trim() === '');
      if (isBlank) break;
      out.push({ rowNumber: rows[r].rowNumber, fields });
    }
    return out;
  }

  // =========================================================================
  // ROW WALKER
  // =========================================================================

  private walkDataRows(
    dataRows: { rowNumber: number; fields: string[] }[],
    columnMap: ReturnType<AngelOneHoldingsAdapter['buildColumnMap']>,
    fileName: string,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>();
    const importedAt = new Date().toISOString();

    dataRows.forEach(({ rowNumber, fields }) => {
      const fileRowNumber = rowNumber;

      // Row must have enough cells to reach the rightmost required
      // column. If a row has fewer cells, the missing-cell value
      // is treated as an empty string and will likely produce a
      // BROKER_NUMERIC_INVALID for the missing required column.
      const cell = (idx: number): string =>
        idx >= 0 && idx < fields.length ? String(fields[idx] ?? '').trim() : '';

      const ticker = cell(columnMap.scrip);
      if (ticker === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Scrip/Contract is empty for this row.'));
        return;
      }

      const instrumentName = cell(columnMap.company);
      if (instrumentName === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Company Name is empty for this row.'));
        return;
      }

      const isinRaw = cell(columnMap.isin);
      const isin = isinRaw === '' ? undefined : isinRaw;

      // CR-06: quantity = Quantity only. Blocked_qty is read but
      // never used.
      const quantity = parseAngelOneNumber(cell(columnMap.quantity));
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Quantity is not a parseable number: ${JSON.stringify(cell(columnMap.quantity))}`,
          'Quantity', cell(columnMap.quantity)));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Quantity is negative (${quantity}); row rejected.`,
          'Quantity', cell(columnMap.quantity)));
        return;
      }
      if (!Number.isInteger(quantity)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_NUMERIC_INVALID',
          `Quantity is not an integer (${quantity}); row accepted but flagged.`,
          'Quantity', cell(columnMap.quantity)));
      }

      // Read Blocked_qty (parse only for row-shape validation; the
      // value is NEVER used in any canonical Holding field per CR-06).
      const blockedQtyRaw = cell(columnMap.blockedQty);
      if (blockedQtyRaw !== '') {
        const blockedQty = parseAngelOneNumber(blockedQtyRaw);
        if (blockedQty === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `Blocked_qty is not a parseable number: ${JSON.stringify(blockedQtyRaw)}; the value will be IGNORED per CR-06.`,
            'Blocked_qty', blockedQtyRaw));
          // Continue — Blocked_qty parsing failure is non-blocking
          // because the value is not used.
        }
      }

      const averageCost = parseAngelOneNumber(cell(columnMap.avgPrice));
      if (averageCost === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg Trading Price is not a parseable number: ${JSON.stringify(cell(columnMap.avgPrice))}`,
          'Avg Trading Price', cell(columnMap.avgPrice)));
        return;
      }
      if (averageCost < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg Trading Price is negative (${averageCost}); rejected.`,
          'Avg Trading Price', cell(columnMap.avgPrice)));
        return;
      }

      const currentPrice = parseAngelOneNumber(cell(columnMap.prevClose));
      if (currentPrice === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Prev closing Price is not a parseable number: ${JSON.stringify(cell(columnMap.prevClose))}`,
          'Prev closing Price', cell(columnMap.prevClose)));
        return;
      }
      if (currentPrice < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Prev closing Price is negative (${currentPrice}); rejected.`,
          'Prev closing Price', cell(columnMap.prevClose)));
        return;
      }

      const investedValue = parseAngelOneNumber(cell(columnMap.invested));
      if (investedValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested Value is not a parseable number: ${JSON.stringify(cell(columnMap.invested))}`,
          'Invested Value', cell(columnMap.invested)));
        return;
      }
      if (investedValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Invested Value is negative (${investedValue}); rejected.`,
          'Invested Value', cell(columnMap.invested)));
        return;
      }

      const currentValue = parseAngelOneNumber(cell(columnMap.marketValue));
      if (currentValue === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Market Value as of last trading day is not a parseable number: ${JSON.stringify(cell(columnMap.marketValue))}`,
          'Market Value as of last trading day', cell(columnMap.marketValue)));
        return;
      }
      if (currentValue < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Market Value as of last trading day is negative (${currentValue}); rejected.`,
          'Market Value as of last trading day', cell(columnMap.marketValue)));
        return;
      }

      // CR-04: unrealisedPnL = Overall Gain/Loss only. Realised
      // Gain/Loss is read but NEVER combined.
      const unrealisedPnL = parseAngelOneNumber(cell(columnMap.overallGainLoss));
      if (unrealisedPnL === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Overall Gain/Loss is not a parseable number: ${JSON.stringify(cell(columnMap.overallGainLoss))}`,
          'Overall Gain/Loss', cell(columnMap.overallGainLoss)));
        return;
      }

      // Read the remaining ignored columns for row-shape
      // validation only. We do not store their values anywhere.
      const realisedGainLossRaw = cell(columnMap.realisedGainLoss);
      if (realisedGainLossRaw !== '') {
        const rg = parseAngelOneNumber(realisedGainLossRaw);
        if (rg === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `Realised Gain/Loss is not a parseable number: ${JSON.stringify(realisedGainLossRaw)}; the value will be IGNORED per CR-04.`,
            'Realised Gain/Loss', realisedGainLossRaw));
          // Non-blocking: the value is not used.
        }
      }
      const holdingWeightageRaw = cell(columnMap.holdingWeightage);
      if (holdingWeightageRaw !== '') {
        const hw = parseAngelOneNumber(holdingWeightageRaw);
        if (hw === null) {
          issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
            `Holding Weightage is not a parseable number: ${JSON.stringify(holdingWeightageRaw)}; the value will be IGNORED per CR-04.`,
            'Holding Weightage', holdingWeightageRaw));
          // Non-blocking.
        }
      }
      // Sector and MarketCap are read (for row-shape completeness)
      // but are NEVER mapped to securityClassification (CR-05).
      // We deliberately do not parse them; they are strings.
      void cell(columnMap.sector);
      void cell(columnMap.marketCap);
      void cell(columnMap.arqPrime);

      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Quantity is zero; holding emitted with derived zeros (averageCost and currentPrice set to 0).',
          'Quantity', cell(columnMap.quantity)));
      }

      // Defensive: Invested Value = 0 with non-zero Quantity is
      // degenerate. We still emit the Holding (canonical rule is
      // "use broker values"), but we flag it.
      if (investedValue === 0 && quantity > 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_NUMERIC_INVALID',
          `Invested Value is zero with non-zero Quantity (${quantity}); degenerate but accepted per broker values.`));
      }

      // NaN/Infinity guard.
      if (
        !Number.isFinite(quantity) ||
        !Number.isFinite(averageCost) ||
        !Number.isFinite(currentPrice) ||
        !Number.isFinite(investedValue) ||
        !Number.isFinite(currentValue) ||
        !Number.isFinite(unrealisedPnL)
      ) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          'Computed value is not finite (NaN/Infinity guard tripped).'));
        return;
      }

      // Duplicate-inside-batch detection. The strongest available
      // identifier is (ISIN if present) + ticker; the supplied
      // fixture uses (ticker, ISIN) as the broker-native pair.
      const identityKey = `Angel One|${isin ?? ticker}|${ticker}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate identity inside batch: ${JSON.stringify(ticker)} (first occurrence retained).`,
          'Scrip/Contract', ticker));
        return;
      }
      seen.add(identityKey);

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Angel One',
        account: undefined,
        instrumentName,
        ...(isin !== undefined ? { isin } : {}),
        ticker,
        quantity,
        averageCost: quantity === 0 ? 0 : averageCost,
        investedValue,
        currentPrice: quantity === 0 ? 0 : currentPrice,
        currentValue,
        unrealisedPnL,
        // CR-04/CR-05: these fields are not in the Angel One
        // source; they are explicitly undefined.
        xirrPercent: undefined,
        securityClassification: undefined,
        unrealisedPnLPercent: undefined,
        status: ACTIVE_HOLDING_STATUS,
        sourceFile: fileName,
        importedAt,
      };
      holdings.push(holding);
    });

    return {
      broker: 'Angel One',
      account: undefined,
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
      formatId: 'angelone',
      displayName: this.displayName,
      confidence: 'NONE',
      reason,
    };
  }

  private emptyOutput(fileName: string, issues: ImportRowIssue[]): BrokerParseOutput {
    return {
      broker: 'Angel One',
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
