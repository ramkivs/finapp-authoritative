import { Transaction } from '../domain/types';
import { TransactionIdentityService } from './TransactionIdentityService';
import { CSVImportResult, ImportRowIssue, DivergentDuplicate, BankStatementRecord, BankStatementAdapter } from './import/ImportTypes';
import { ImportFormatDetector } from './import/ImportFormatDetector';
import { SpreadsheetStatementParser } from './import/parsers/SpreadsheetStatementParser';

export type { CSVImportResult, ImportRowIssue, DivergentDuplicate } from './import/ImportTypes';

export class ImportPipelineService {
  /**
   * Generates a genuine SHA-256 hexadecimal digest (64 hex characters)
   * of the canonical transaction string `${account}|${date}|${amount}|${narration}`.
   *
   * WP-FB-DATA-06a: this is now a thin delegation. The definition lives in
   * `TransactionIdentityService` — the single fingerprint authority. Retained as
   * a static method because adapters and existing callers reference it by this
   * name; the behaviour is byte-identical to the pre-06a implementation.
   */
  static generateFingerprint(tx: { account: string; date: string; amount: number; narration: string }): string {
    return TransactionIdentityService.fingerprint(tx);
  }

  /**
   * Enforces security sanitization against spreadsheet formula injections.
   * Legitimate negative financial numbers (e.g. -1250, -50000, -235.50) are preserved verbatim.
   */
  static sanitizeCell(val: string): string {
    if (!val) return '';
    let s = val.trim();
    // Legitimate signed financial numbers (-1250, -50000, -235.50, +500) are NEVER hostile formulas
    if (/^[-+]\s*\d+(\.\d+)?$/.test(s)) {
      return s;
    }
    // Check for hostile spreadsheet formulas (=HYPERLINK(...), =IMPORTXML(...), =cmd|... or leading =, @, +, -)
    if (/^[=@+\-]/.test(s) || /=(HYPERLINK|IMPORTXML|cmd\|)/i.test(s)) {
      s = s.replace(/^[=@+\-]+/, '').trim();
      if (/^(HYPERLINK|IMPORTXML|cmd\|)/i.test(s)) {
        s = s.replace(/^(HYPERLINK|IMPORTXML|cmd\|)\s*\(?/i, '[Sanitized-Formula] ');
      } else {
        s = '[Sanitized-Formula] ' + s;
      }
    }
    return s;
  }

  static isHostileFormula(val: string): boolean {
    if (!val) return false;
    const s = val.trim();
    if (/^[-+]\s*\d+(\.\d+)?$/.test(s)) {
      return false;
    }
    return /^[=@]/.test(s) || /^[-+]\s*[^0-9\s]/.test(s) || /=(HYPERLINK|IMPORTXML|cmd\|)/i.test(s);
  }

  /**
   * Backward-compatibility helper retained for external callers/tests.
   */
  static parseCSVText(csvText: string): Array<Record<string, string>> {
    const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const parseLine = (line: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      let inParens = 0;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
          current += char;
        } else if (char === '(' && !inQuotes) {
          inParens++;
          current += char;
        } else if (char === ')' && !inQuotes) {
          if (inParens > 0) inParens--;
          current += char;
        } else if (char === ',' && !inQuotes && inParens === 0) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/['"]/g, ''));
    const rows: Array<Record<string, string>> = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i]).map(v => v.replace(/^["']|["']$/g, ''));
      if (values.length < headers.length) continue;
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] || '';
      });
      rows.push(row);
    }
    return rows;
  }

  /**
   * TEXT PATH: Main bulk import entrypoint for CSV, TXT, HTML .xls, and HDFC fixed-width text files.
   * Detects source format (HDFC, ICICI, SBI, Generic CSV), routes to matching bank adapter,
   * normalizes rows into canonical Transactions, applies SHA-256 fingerprint deduplication.
   */
  static processCSV(
    csvText: string,
    existingTransactions: Transaction[],
    provider: string = 'CSV Import',
    fileName: string = 'upload.csv'
  ): CSVImportResult {
    const batchId = 'batch-' + Date.now();
    const input = { kind: 'text' as const, content: csvText, fileName, selectedProvider: provider };

    const { adapter, detection } = ImportFormatDetector.detect(input);

    if (!detection.matched || !adapter) {
      return this.unsupportedFormatResult(batchId);
    }

    const records = adapter.parse(input);
    return this.processRecords(records, adapter, existingTransactions, provider, fileName, batchId);
  }

  /**
   * BINARY PATH: Import entrypoint for native XLS and XLSX binary workbooks.
   * Accepts raw Uint8Array bytes from browser FileReader.readAsArrayBuffer().
   * Uses SheetJS 0.20.3 (vendored) to decode binary → ParsedCsvRow[].
   * Detects bank format from decoded column headers (NOT from raw binary bytes).
   * Converges with the text path at processRecords() — one shared normalization/fingerprint/dedup pipeline.
   */
  static processBinaryFile(
    bytes: Uint8Array,
    existingTransactions: Transaction[],
    provider: string = 'Bank Import',
    fileName: string = 'upload.xls'
  ): CSVImportResult {
    const batchId = 'batch-' + Date.now();

    // Decode binary workbook bytes → ParsedCsvRow[] using SheetJS
    const { headers, rows, error } = SpreadsheetStatementParser.parseBytes(bytes, fileName);

    if (error || headers.length === 0) {
      return {
        batchId,
        totalDetected: 0,
        validRows: [],
        duplicateCount: 0,
        divergentDuplicateCount: 0,
        divergentDuplicateRows: [],
        ambiguousCount: 0,
        invalidCount: 1,
        detectedFormatId: 'unsupported',
        formatDisplayName: 'Binary Parse Error',
        invalidRows: [{
          rowNumber: 0,
          severity: 'INVALID',
          code: 'BINARY_PARSE_ERROR',
          message: error || 'Unable to decode binary workbook — no column headers found.'
        }],
        ambiguousRows: [],
        unsupportedFormat: true
      };
    }

    // Detection operates on decoded headers + first sample row — NOT on raw binary bytes
    const { adapter, detection } = ImportFormatDetector.detectFromRows(headers, rows, fileName, provider);

    if (!detection.matched || !adapter) {
      return this.unsupportedFormatResult(batchId);
    }

    // Parse decoded rows directly — no synthetic CSV reconstruction
    const records = adapter.parseRows(rows, fileName);
    return this.processRecords(records, adapter, existingTransactions, provider, fileName, batchId);
  }

  /**
   * SHARED CONVERGENCE POINT: One implementation of normalization, security sanitization,
   * fingerprinting, and duplicate detection used by both processCSV() and processBinaryFile().
   * This is the single source of truth for import deduplication semantics.
   */
  private static processRecords(
    records: BankStatementRecord[],
    adapter: BankStatementAdapter,
    existingTransactions: Transaction[],
    provider: string,
    fileName: string,
    batchId: string
  ): CSVImportResult {
    const validRows: Transaction[] = [];
    const invalidRows: ImportRowIssue[] = [];
    const ambiguousRows: ImportRowIssue[] = [];
    let duplicateCount = 0;
    const divergentDuplicateRows: DivergentDuplicate[] = [];

    // WP-FB-DATA-06a: fingerprints are resolved through the single identity
    // authority, which PREFERS the persisted fingerprint over a recomputed one.
    // Pre-06a this site recomputed unconditionally while the store preferred the
    // persisted value — two dedup sites disagreeing about how to identify a row.
    // They now agree. (No outcome changes: every fingerprint this application has
    // ever written uses the same canonical string, so persisted == recomputed.)
    const existingByFingerprint = new Map<string, Transaction>();
    for (const tx of existingTransactions) {
      const fp = TransactionIdentityService.fingerprintOf(tx);
      if (!existingByFingerprint.has(fp)) existingByFingerprint.set(fp, tx);
    }

    const seenInBatch = new Map<string, Transaction>();

    records.forEach(record => {
      const normResult = adapter.normalize(record, {
        provider,
        fileName,
        batchId
      });

      if (normResult.issue) {
        if (normResult.issue.severity === 'AMBIGUOUS') {
          ambiguousRows.push(normResult.issue);
        } else {
          invalidRows.push(normResult.issue);
        }
        return;
      }

      if (!normResult.candidate) return;

      const candidate = normResult.candidate;
      const fp = TransactionIdentityService.fingerprintOf(candidate);

      const collision = existingByFingerprint.get(fp) || seenInBatch.get(fp);
      if (collision) {
        duplicateCount++;

        // WP-FB-DATA-06a / finding L-02 — DISCLOSURE ONLY, NOT A BEHAVIOUR CHANGE.
        //
        // The row is still dropped, exactly as before. But when the colliding
        // rows disagree on `direction` or `type` — the two fields that decide the
        // SIGN of the money — the drop is no longer silent. Discovery scenario G
        // showed a user correcting a row's direction and re-importing it, and the
        // application discarding the correction without a word.
        //
        // Making such a row APPEND instead is a product decision (it changes a
        // balance by twice the amount) and is deferred to DATA-06c decision #12.
        if (TransactionIdentityService.isDivergentDuplicate(candidate, collision)) {
          divergentDuplicateRows.push({
            rowNumber: record.sourceRowNumber,
            fingerprint: fp,
            narration: candidate.narration,
            amount: candidate.amount,
            incomingType: String(candidate.type),
            existingType: String(collision.type),
            incomingDirection: candidate.direction ?? null,
            existingDirection: collision.direction ?? null,
            message:
              `Row ${record.sourceRowNumber} matches an existing transaction's fingerprint ` +
              `but disagrees on direction/type ` +
              `(incoming ${candidate.direction ?? candidate.type} vs existing ${collision.direction ?? collision.type}). ` +
              `It was excluded as a duplicate and the difference was NOT applied.`
          });
        }
        return;
      }

      seenInBatch.set(fp, candidate);
      existingByFingerprint.set(fp, candidate);
      validRows.push(candidate);
    });

    return {
      batchId,
      totalDetected: records.length,
      validRows,
      duplicateCount,
      divergentDuplicateCount: divergentDuplicateRows.length,
      divergentDuplicateRows,
      ambiguousCount: ambiguousRows.length,
      invalidCount: invalidRows.length,
      detectedFormatId: adapter.id,
      formatDisplayName: adapter.displayName,
      invalidRows,
      ambiguousRows,
      unsupportedFormat: false
    };
  }

  private static unsupportedFormatResult(batchId: string): CSVImportResult {
    return {
      batchId,
      totalDetected: 0,
      validRows: [],
      duplicateCount: 0,
      divergentDuplicateCount: 0,
      divergentDuplicateRows: [],
      ambiguousCount: 0,
      invalidCount: 0,
      detectedFormatId: 'unsupported',
      formatDisplayName: 'Unsupported / Unrecognized Statement Format',
      invalidRows: [{
        rowNumber: 0,
        severity: 'INVALID',
        code: 'UNSUPPORTED_FORMAT',
        message: 'File content does not match any recognized bank (HDFC, ICICI, SBI) or generic CSV header signature.'
      }],
      ambiguousRows: [],
      unsupportedFormat: true
    };
  }
}
