/**
 * WP-FB-IMPORT-BROKER-01 — Zerodha holdings adapter (WP-04).
 *
 * Structural detection + row-level parsing for the Zerodha equity and
 * mutual-fund holdings CSV exports. Both exports use the byte-identical
 * header schema (per the WP-04 authority record §5):
 *
 *   "Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val",
 *   "P&L","Net chg.","Day chg.",""
 *
 * The trailing empty tenth column is structural noise and is tolerated
 * (it does not cause false rejection).
 *
 * Discovered file properties (sequencing report §3.1.2):
 *   - CSV, UTF-8, no BOM
 *   - LF line terminator
 *   - comma delimiter
 *   - all cells quoted
 *   - no preamble, no footer
 *   - header row 1, data begins row 2
 *
 * This adapter:
 *   - Performs structural header-schema detection (NOT filename-only).
 *   - Parses the CSV verbatim (no preamble search, no header-locator
 *     coupling to the bank-statement CsvRecordParser).
 *   - Recomputes `investedValue`, `currentValue`, `unrealisedPnL`
 *     and `unrealisedPnLPercent` from the canonical inputs (qty,
 *     avgCost, LTP). The broker-provided "Invested", "Cur. val",
 *     and "P&L" columns are NOT trusted as canonical values (they
 *     may differ in the last decimal due to rounding).
 *   - Drops `Net chg.` and `Day chg.` (day-over-day metrics, not
 *     canonical P&L percentage).
 *   - Sets `ticker` for equity-like instruments (regex
 *     `^[A-Z0-9&-]{1,10}$`); sets `ticker = undefined` for MF names.
 *   - Sets `account = undefined`, `isin = undefined`,
 *     `xirrPercent = undefined`, `securityClassification = undefined`
 *     (Zerodha provides none of these).
 *   - Emits `status = 'active'` for every Holding. Lifecycle
 *     reconciliation is WP-08's responsibility.
 *   - Produces per-row characterisation issues via ImportRowIssue.
 *     Invalid rows are skipped; valid rows continue. Lifecycle is
 *     NOT the parser's concern.
 *
 * This adapter does NOT:
 *   - Query existing holdings.
 *   - Compare against repository state.
 *   - Compute new/updated/unchanged/closed_absent.
 *   - Persist.
 *   - Call HoldingAssetCollisionGuard.
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
  ImportIssueSeverity,
  ImportRowIssue,
  ParsedCsvRow,
  StatementInput,
} from '../ImportTypes';

/**
 * The exact, byte-identical header schema discovered in both real
 * Zerodha samples (sequencing report §3.1.3). The trailing empty
 * column is structural noise and is NOT a required header.
 */
const ZERODHA_REQUIRED_HEADERS: readonly string[] = [
  'Instrument',
  'Qty.',
  'Avg. cost',
  'LTP',
  'Invested',
  'Cur. val',
  'P&L',
  'Net chg.',
  'Day chg.',
] as const;

/**
 * Zerodha tickers are short, uppercase, alphanumeric with possible
 * `&` and `-` (e.g. "AIIL", "M&M", "L&T"). MF scheme names contain
 * spaces and lower-case content (e.g. "Zerodha Gold ETF FoF").
 *
 * This is a parser-level inference, not a canonical identity rule.
 * It does NOT introduce a new identity algorithm — the existing
 * HoldingIdentityService ISIN > TICKER > NAME precedence handles
 * whichever value the parser sets.
 */
const TICKER_REGEX = /^[A-Z0-9&-]{1,10}$/;

/**
 * Numeric parser that tolerates:
 *   - ASCII hyphen-minus prefix for negatives (e.g. "-143.75")
 *   - Whitespace inside the value (trimmed)
 *   - Empty string (returns null, NOT NaN)
 *
 * Returns null for any other non-finite or non-parseable input. The
 * caller is responsible for surfacing null as a `BROKER_NUMERIC_INVALID`
 * issue.
 */
function parseZerodhaNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // ASCII hyphen-minus is the only sign character observed. Other
  // Unicode minus signs or "+" prefixes are rejected.
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

export class ZerodhaHoldingsAdapter implements BrokerAdapter {
  readonly id = 'zerodha';
  readonly displayName = 'Zerodha Holdings';

  canHandle(input: StatementInput): BrokerDetectionResult {
    if (input.kind !== 'text') {
      return this.noMatch('Not a text StatementInput');
    }
    const text = input.content || '';
    const headerLine = this.firstNonEmptyLine(text);
    if (headerLine === null) {
      return this.noMatch('Empty or headerless content');
    }
    if (this.headerMatchesZerodha(headerLine)) {
      return {
        matched: true,
        formatId: 'zerodha',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Zerodha holdings CSV header signature',
      };
    }
    return this.noMatch('Header does not match Zerodha holdings signature');
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[]): BrokerDetectionResult {
    // Normalise the same way the text path normalises (strip surrounding
    // quotes, trim). The trailing empty column observed in the real
    // samples is not a required header and is filtered out.
    const normalised = headers
      .map((h) => String(h ?? '').replace(/^["']|["']$/g, '').trim())
      .filter((h) => h.length > 0);
    if (this.arrayMatchesZerodha(normalised)) {
      return {
        matched: true,
        formatId: 'zerodha',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched Zerodha holdings header signature (decoded rows)',
      };
    }
    return this.noMatch('Decoded header does not match Zerodha holdings signature');
  }

  parseHoldings(input: StatementInput): BrokerParseOutput {
    if (input.kind !== 'text') {
      return this.emptyOutput(input.fileName, [
        this.issue(1, 'INVALID', 'BROKER_UNSUPPORTED',
          'Zerodha adapter does not accept binary input in V1'),
      ]);
    }
    return this.parseZerodhaCsvText(input.content, input.fileName);
  }

  parseHoldingsFromRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput {
    // The decoded-rows path is meaningful only when the rows were
    // produced from a CSV-shaped source (the binary XLS/XLSX path
    // applies to brokers like Groww). For Zerodha's text-only V1
    // scope this path is exercised only by tests that synthesise
    // ParsedCsvRow[] from the real samples.
    const header = this.extractHeaderFromRows(rows);
    if (header === null) {
      return this.emptyOutput(fileName, [
        this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
          'Cannot locate header row in decoded rows'),
      ]);
    }
    if (!this.arrayMatchesZerodha(header.normalised)) {
      return this.emptyOutput(fileName, [
        this.issue(header.rowNumber, 'INVALID', 'BROKER_HEADER_MISSING',
          'Decoded header does not match the Zerodha holdings signature'),
      ]);
    }
    return this.walkRows(header.normalised, header.dataRows, fileName);
  }

  // =========================================================================
  // TEXT PARSING (Zerodha's V1 scope)
  // =========================================================================

  /**
   * Parse the Zerodha CSV text into canonical Holdings. The text
   * decoder is private to this adapter because the discovered Zerodha
   * schema is regular (always header-on-row-1, always quoted, always
   * LF, no preamble) and the bank-adapter CsvRecordParser applies
   * generic header-locator heuristics that we do not want coupled
   * to the broker path.
   *
   * The decoder handles:
   *   - UTF-8 BOM (stripped if present)
   *   - LF and CRLF line terminators
   *   - Quoted fields (RFC 4180-style double-quote escaping)
   *   - Comma delimiter
   *   - Trailing empty field (column 10 = "")
   */
  private parseZerodhaCsvText(text: string, fileName: string): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];

    // Strip BOM if present.
    let clean = text || '';
    if (clean.charCodeAt(0) === 0xfeff) clean = clean.slice(1);

    const records = this.parseCsvRecords(clean);

    if (records.length === 0) {
      issues.push(this.issue(1, 'INVALID', 'BROKER_EMPTY',
        'Zerodha file is empty or has no parseable content'));
      return this.emptyOutput(fileName, issues);
    }

    const headerRow = records[0];
    const headerNormalised = headerRow.map((h) => this.stripQuotes(h).trim());
    if (!this.arrayMatchesZerodha(headerNormalised)) {
      issues.push(this.issue(1, 'INVALID', 'BROKER_HEADER_MISSING',
        'Header row does not match the Zerodha holdings signature'));
      return this.emptyOutput(fileName, issues);
    }

    if (records.length === 1) {
      issues.push(this.issue(1, 'AMBIGUOUS', 'BROKER_HEADER_ONLY',
        'Zerodha file contains only the header row, no data'));
      return this.emptyOutput(fileName, issues);
    }

    return this.walkRows(headerNormalised, records.slice(1), fileName, /* sourceRowOffset */ 1);
  }

  /**
   * Walk the data rows (post-header) and emit canonical Holdings. Row
   * numbers in issues are 1-based and refer to the file line (header
   * is row 1; first data row is row 2). For the binary-decoded path
   * `sourceRowOffset` is 0 because the header was not in the supplied
   * rows.
   */
  private walkRows(
    headers: string[],
    dataRows: string[][],
    fileName: string,
    sourceRowOffset = 0,
  ): BrokerParseOutput {
    const issues: ImportRowIssue[] = [];
    const holdings: Holding[] = [];
    const seen = new Set<string>(); // for BROKER_DUPLICATE_INSIDE_BATCH

    // Column indices derived from the verified header. The
    // comparison is case-insensitive because binary XLSX decoders
    // may surface lower-cased header keys; the text path produces
    // case-preserved headers and the comparison still works.
    const lower = headers.map((h) => h.toLowerCase());
    const idxInstrument = lower.indexOf('instrument');
    const idxQty = lower.indexOf('qty.');
    const idxAvgCost = lower.indexOf('avg. cost');
    const idxLtp = lower.indexOf('ltp');

    const importedAt = new Date().toISOString();

    dataRows.forEach((rawFields, idx) => {
      const fileRowNumber = idx + 2 + sourceRowOffset; // 1-based; first data row = 2

      // Row shape check: a well-formed Zerodha row has exactly the
      // number of fields implied by the header (9 required + 0-or-1
      // trailing empty). The trailing empty column is observed as an
      // extra "" cell; we accept either width.
      if (rawFields.length < headers.length) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${rawFields.length} fields; expected at least ${headers.length}`));
        return;
      }
      if (rawFields.length > headers.length + 1) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_ROW_MALFORMED',
          `Row has ${rawFields.length} fields; expected ${headers.length} (or ${headers.length + 1} with trailing empty)`));
        return;
      }

      const instrumentRaw = this.stripQuotes(rawFields[idxInstrument] ?? '').trim();
      const qtyRaw = this.stripQuotes(rawFields[idxQty] ?? '');
      const avgCostRaw = this.stripQuotes(rawFields[idxAvgCost] ?? '');
      const ltpRaw = this.stripQuotes(rawFields[idxLtp] ?? '');

      // Identity check
      if (instrumentRaw === '') {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_IDENTITY_MISSING',
          'Instrument is empty for this row'));
        return;
      }

      // Numeric parse
      const quantity = parseZerodhaNumber(qtyRaw);
      if (quantity === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Qty. is not a parseable number: ${JSON.stringify(qtyRaw)}`,
          'Qty.', qtyRaw));
        return;
      }
      if (quantity < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_QUANTITY_NON_POSITIVE',
          `Qty. is negative (${quantity}); row rejected`,
          'Qty.', qtyRaw));
        return;
      }

      const averageCost = parseZerodhaNumber(avgCostRaw);
      if (averageCost === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg. cost is not a parseable number: ${JSON.stringify(avgCostRaw)}`,
          'Avg. cost', avgCostRaw));
        return;
      }
      if (averageCost < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `Avg. cost is negative (${averageCost}); rejected`,
          'Avg. cost', avgCostRaw));
        return;
      }

      const currentPrice = parseZerodhaNumber(ltpRaw);
      if (currentPrice === null) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `LTP is not a parseable number: ${JSON.stringify(ltpRaw)}`,
          'LTP', ltpRaw));
        return;
      }
      if (currentPrice < 0) {
        issues.push(this.issue(fileRowNumber, 'INVALID', 'BROKER_NUMERIC_INVALID',
          `LTP is negative (${currentPrice}); rejected`,
          'LTP', ltpRaw));
        return;
      }

      // Mathematically-valid recomputation. No NaN, no Infinity.
      // quantity === 0 is the authorised zero case; the Holding
      // lifecycle service tolerates averageCost === 0 and
      // investedValue === 0 when quantity === 0.
      const investedValue = quantity * averageCost;
      const currentValue = quantity * currentPrice;
      const unrealisedPnL = currentValue - investedValue;
      const unrealisedPnLPercent =
        investedValue > 0
          ? (unrealisedPnL / investedValue) * 100
          : undefined;

      // Defence-in-depth: every derived value must be a finite
      // number. (Should never trip given the input checks above,
      // but a NaN guard is cheap and prevents lifecycle-service
      // rejection later.)
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
          'Computed value is not finite (NaN/Infinity guard tripped)'));
        return;
      }

      // Authority recommendation: a zero-quantity row is a WARNING
      // and the row is preserved (holding is emitted with all
      // computed values = 0; the import service decides what to
      // do). Average cost of 0 is the documented lifecycle behaviour
      // for quantity = 0.
      if (quantity === 0) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_QUANTITY_NON_POSITIVE',
          'Qty. is zero; holding emitted with all derived values = 0',
          'Qty.', qtyRaw));
      }

      // Ticker heuristic (parser-level inference, not a canonical
      // identity rule). MF names with spaces and lower-case content
      // correctly fail the regex.
      const ticker = TICKER_REGEX.test(instrumentRaw) ? instrumentRaw : undefined;

      // Duplicate-inside-batch detection. The first row with a given
      // (broker, account, instrumentName) wins; subsequent
      // duplicates are dropped with an issue.
      const identityKey = `Zerodha|undefined|${instrumentRaw}`;
      if (seen.has(identityKey)) {
        issues.push(this.issue(fileRowNumber, 'AMBIGUOUS', 'BROKER_DUPLICATE_INSIDE_BATCH',
          `Duplicate instrument inside batch: ${JSON.stringify(instrumentRaw)} (first occurrence retained)`,
          'Instrument', instrumentRaw));
        return;
      }
      seen.add(identityKey);

      const holding: Holding = {
        id: HoldingIdentityService.generateId(),
        broker: 'Zerodha',
        account: undefined,
        instrumentName: instrumentRaw,
        isin: undefined,
        ticker,
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
      broker: 'Zerodha',
      account: undefined,
      holdings,
      sourceFile: fileName,
      importedAt,
      issues,
    };
  }

  // =========================================================================
  // HEADER NORMALISATION
  // =========================================================================

  private headerMatchesZerodha(headerLine: string): boolean {
    // The first line of a Zerodha file is header-on-row-1, comma-
    // delimited, all cells quoted. We tokenize respecting quotes.
    const fields = this.parseCsvRecords(headerLine + '\n')[0] ?? [];
    return this.arrayMatchesZerodha(fields.map((f) => this.stripQuotes(f).trim()));
  }

  private arrayMatchesZerodha(headers: readonly string[]): boolean {
    if (headers.length < ZERODHA_REQUIRED_HEADERS.length) return false;
    // Case-insensitive comparison: the real Zerodha exports use
    // exact-case headers ("Instrument", "Qty.", "Avg. cost"), but
    // binary workbook decoders (XLSX) may surface headers in any
    // case. The authority-record's essential content is the column
    // order and the names modulo case, not the case itself.
    for (let i = 0; i < ZERODHA_REQUIRED_HEADERS.length; i++) {
      if ((headers[i] ?? '').toLowerCase() !== ZERODHA_REQUIRED_HEADERS[i].toLowerCase()) {
        return false;
      }
    }
    // The trailing empty column (if present) is structural noise and
    // is permitted but not required.
    if (headers.length > ZERODHA_REQUIRED_HEADERS.length) {
      const extra = headers.slice(ZERODHA_REQUIRED_HEADERS.length);
      if (extra.some((e) => e !== '')) return false;
    }
    return true;
  }

  private firstNonEmptyLine(text: string): string | null {
    const lines = (text || '').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) return line;
    }
    return null;
  }

  /**
   * Extract the header row from a ParsedCsvRow[]. The supplied rows
   * are post-header data rows; the header is recovered by
   * reconstructing the textual header from the rawFields layout. For
   * the binary path, callers may also pass the rows in header-prefix
   * form; in that case the first row IS the header.
   */
  private extractHeaderFromRows(
    rows: ParsedCsvRow[],
  ): { normalised: string[]; dataRows: string[][]; rowNumber: number } | null {
    if (rows.length === 0) return null;
    // Convention: the binary path supplies data rows only (no
    // header in the array). We detect the header by looking at the
    // first row's lower-case fields for any "instrument" / "qty." /
    // etc. signature. If the first row IS the header, drop it.
    const first = rows[0];
    const firstKeys = Object.keys(first.data).map((k) => k.toLowerCase());
    const isHeaderRow = firstKeys.some((k) => k === 'instrument') ||
                        firstKeys.some((k) => k === 'qty.') ||
                        firstKeys.some((k) => k === 'avg. cost');
    let headerNormalised: string[];
    let dataRows: string[][];
    let headerRowNumber: number;
    if (isHeaderRow) {
      headerNormalised = Object.keys(first.data);
      dataRows = rows.slice(1).map((r) => r.rawFields);
      headerRowNumber = first.rowNumber;
    } else {
      // No header in the array — use the discovered schema.
      headerNormalised = [...ZERODHA_REQUIRED_HEADERS];
      dataRows = rows.map((r) => r.rawFields);
      headerRowNumber = first.rowNumber - 1; // 1-based header row above the first data row
    }
    return { normalised: headerNormalised, dataRows, rowNumber: headerRowNumber };
  }

  // =========================================================================
  // CSV TOKENIZER (RFC 4180-compatible; private to this adapter)
  // =========================================================================

  /**
   * Tokenize CSV text into rows of raw field strings. Handles:
   *   - Quoted fields with embedded commas, newlines, and double-quote
   *     escapes ("")
   *   - LF and CRLF line terminators
   *   - Trailing empty field (preserved)
   *
   * The output is a `string[][]` — each row is an array of raw field
   * strings with surrounding quotes preserved. Callers that need
   * unquoted values use `stripQuotes`.
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
            // Escaped double-quote inside a quoted field
            field += '"';
            i += 2;
            continue;
          }
          // End of quoted field
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }

      // Not in quotes
      if (ch === '"') {
        // Start of a quoted field. Per RFC 4180, a field that begins
        // with a quote is a quoted field. We accept the leading
        // quote unconditionally; if the field is unquoted the token
        // simply won't be double-quote-delimited.
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

    // Flush the trailing field / row, if any.
    if (field.length > 0 || current.length > 0) {
      current.push(field);
      records.push(current);
    }

    // Drop completely-empty trailing records (one trailing newline
    // produces an empty record after the last row; that is structural
    // and must not be confused with a data row).
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

  // =========================================================================
  // HELPERS
  // =========================================================================

  private noMatch(reason: string): BrokerDetectionResult {
    return {
      matched: false,
      formatId: 'zerodha',
      displayName: this.displayName,
      confidence: 'NONE',
      reason,
    };
  }

  private emptyOutput(fileName: string, issues: ImportRowIssue[]): BrokerParseOutput {
    return {
      broker: 'Zerodha',
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
