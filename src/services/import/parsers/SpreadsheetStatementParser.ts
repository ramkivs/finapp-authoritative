import { ParsedCsvRow } from '../ImportTypes';
import { CsvRecordParser } from './CsvRecordParser';
import * as XLSX from 'xlsx';

function isLikelyTransactionHeaderRow(cells: unknown[]): boolean {
  const lower = cells.map(c => String(c ?? '').trim().toLowerCase());
  const nonEmptyCount = lower.filter(c => c.length > 0).length;
  if (nonEmptyCount < 3) return false;

  const hasDate = lower.some(c => c.includes('date') || c === 'dt' || c === 'txn dt');
  const hasMonetary = lower.some(
    c =>
      c.includes('amount') ||
      c.includes('debit') ||
      c.includes('credit') ||
      c.includes('withdrawal') ||
      c.includes('deposit') ||
      c.includes('balance')
  );
  return hasDate && hasMonetary;
}

export class SpreadsheetStatementParser {
  /**
   * Parse a text string (HTML .xls, XML spreadsheet, or CSV fallback).
   * Handles HTML-table based spreadsheet exports (e.g. ICICI/SBI/PPF .xls statement downloads),
   * including multi-line preamble metadata above the transaction header row.
   */
  static parse(content: string): { headers: string[]; rows: ParsedCsvRow[]; preambleText?: string } {
    const trimmed = (content || '').trim();

    // Check if content is HTML-table spreadsheet download (contains <table> or <html>)
    if (/<table[^>]*>/i.test(trimmed) || /<html[^>]*>/i.test(trimmed)) {
      return this.parseHtmlTableSpreadsheet(trimmed);
    }

    // CSV / delimited text exports may also carry preamble metadata lines before the header row
    const rawLines = trimmed.split(/\r?\n/);
    let headerLineIdx = 0;
    const scanLimit = Math.min(40, rawLines.length);
    for (let i = 0; i < scanLimit; i++) {
      const line = rawLines[i].trim();
      if (!line || !line.includes(',')) continue;
      const sampleParsed = CsvRecordParser.parse(line);
      if (isLikelyTransactionHeaderRow(sampleParsed.headers)) {
        headerLineIdx = i;
        break;
      }
    }

    const preambleText = headerLineIdx > 0 ? rawLines.slice(0, headerLineIdx).join('\n') : '';
    const effectiveCsv = headerLineIdx > 0 ? rawLines.slice(headerLineIdx).join('\n') : trimmed;
    const parsed = CsvRecordParser.parse(effectiveCsv);
    return {
      headers: parsed.headers,
      rows: parsed.rows.map(r => ({ ...r, rowNumber: r.rowNumber + headerLineIdx })),
      preambleText
    };
  }

  /**
   * Parse a native binary XLS or XLSX workbook supplied as a Uint8Array.
   * Uses SheetJS Community Edition 0.20.3 (vendored at vendor/xlsx-0.20.3.tgz).
   * Accepts browser-produced Uint8Array without requiring Node Buffer or filesystem APIs.
   * Returns decoded ParsedCsvRow[] from the first worksheet containing transaction data.
   */
  static parseBytes(
    bytes: Uint8Array,
    _fileName: string
  ): { headers: string[]; rows: ParsedCsvRow[]; preambleText?: string; error?: string } {
    if (!bytes || bytes.length === 0) {
      return { headers: [], rows: [], error: 'Empty or missing binary content' };
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(bytes, { type: 'array', cellText: true, cellDates: false });
    } catch (err) {
      return {
        headers: [],
        rows: [],
        error: `Binary workbook parse failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { headers: [], rows: [], error: 'Workbook contains no worksheets' };
    }

    // Scan sheets (up to 40 preamble rows) for one with transaction-like headers; fall back to first sheet
    let targetSheetName = workbook.SheetNames[0];
    outerSheetLoop: for (const sheetName of workbook.SheetNames) {
      const ws = workbook.Sheets[sheetName];
      if (!ws) continue;
      const aoa: string[][] = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: '',
        blankrows: false,
        raw: false
      }) as string[][];
      if (aoa.length === 0) continue;
      for (const row of aoa.slice(0, 40)) {
        if (isLikelyTransactionHeaderRow(row)) {
          targetSheetName = sheetName;
          break outerSheetLoop;
        }
      }
    }

    const worksheet = workbook.Sheets[targetSheetName];
    if (!worksheet) {
      return { headers: [], rows: [], error: `Target worksheet "${targetSheetName}" not found` };
    }

    const aoa: string[][] = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      blankrows: false,
      raw: false
    }) as string[][];

    if (aoa.length === 0) {
      return { headers: [], rows: [] };
    }

    // Locate the header row (skip up to 40 preamble metadata rows)
    let headerIdx = 0;
    for (let r = 0; r < Math.min(40, aoa.length); r++) {
      if (isLikelyTransactionHeaderRow(aoa[r])) {
        headerIdx = r;
        break;
      }
    }

    const preambleText = aoa
      .slice(0, headerIdx)
      .map(row => row.map(c => String(c ?? '').trim()).filter(Boolean).join(' '))
      .filter(Boolean)
      .join('\n');

    const headers = aoa[headerIdx].map(h => String(h).toLowerCase().trim());

    const rows: ParsedCsvRow[] = [];
    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const rawFields = aoa[r].map(c => String(c));
      const data: Record<string, string> = {};
      headers.forEach((h, idx) => {
        data[h] = rawFields[idx] !== undefined ? rawFields[idx].trim() : '';
      });
      if (rawFields.every(f => f.trim() === '')) continue;
      rows.push({
        rowNumber: r + 1,
        data,
        rawFields
      });
    }

    return { headers, rows, preambleText };
  }

  private static parseHtmlTableSpreadsheet(
    html: string
  ): { headers: string[]; rows: ParsedCsvRow[]; preambleText?: string } {
    const rowMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (!rowMatches || rowMatches.length === 0) {
      return { headers: [], rows: [] };
    }

    const parsedTable: string[][] = [];

    for (const trHtml of rowMatches) {
      const cellMatches = trHtml.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
      if (!cellMatches || cellMatches.length === 0) continue;

      const cells = cellMatches.map(cellHtml =>
        cellHtml
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .trim()
      );

      if (cells.some(c => c.length > 0)) {
        parsedTable.push(cells);
      }
    }

    if (parsedTable.length === 0) {
      return { headers: [], rows: [] };
    }

    let headerIdx = 0;
    for (let r = 0; r < Math.min(40, parsedTable.length); r++) {
      if (isLikelyTransactionHeaderRow(parsedTable[r])) {
        headerIdx = r;
        break;
      }
    }

    const strippedPrefix = html.split(/<table/i)[0]?.replace(/<[^>]+>/g, ' ').trim() || '';
    const tablePreamble = parsedTable
      .slice(0, headerIdx)
      .map(row => row.filter(Boolean).join(' '))
      .join('\n');
    const preambleText = [strippedPrefix, tablePreamble].filter(Boolean).join('\n');

    const headers = parsedTable[headerIdx].map(h => h.toLowerCase().replace(/^["']|["']$/g, '').trim());

    const rows: ParsedCsvRow[] = [];
    for (let r = headerIdx + 1; r < parsedTable.length; r++) {
      const rawFields = parsedTable[r];
      const data: Record<string, string> = {};
      headers.forEach((h, idx) => {
        const val = rawFields[idx] !== undefined ? rawFields[idx].trim() : '';
        data[h] = val;
      });

      rows.push({
        rowNumber: r + 1,
        data,
        rawFields
      });
    }

    return { headers, rows, preambleText };
  }
}
