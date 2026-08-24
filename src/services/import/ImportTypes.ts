import { Transaction } from '../../domain/types';

export type ImportIssueSeverity = 'INVALID' | 'AMBIGUOUS';

export type ImportIssueCode =
  | 'INVALID_DATE'
  | 'INVALID_AMOUNT'
  | 'MISSING_AMOUNT'
  | 'BOTH_DEBIT_AND_CREDIT_PRESENT'
  | 'ZERO_TRANSACTION'
  | 'UNSUPPORTED_SCHEMA'
  | 'MALFORMED_ROW'
  | 'MULTILINE_RECORD_ERROR'
  | 'UNSUPPORTED_FORMAT'
  | 'BINARY_PARSE_ERROR'
  // WP-FB-IMPORT-BROKER-01 — broker-parse issue codes (WP-04 / WP-05 / WP-06).
  // Authorised in the WP-04 / WP-05 / WP-06 sequencing report §11 and
  // ratified in the WP-04 Zerodha Implementation Authority record §18.
  | 'BROKER_UNSUPPORTED'
  | 'BROKER_HEADER_MISSING'
  | 'BROKER_HEADER_ONLY'
  | 'BROKER_EMPTY'
  | 'BROKER_ROW_MALFORMED'
  | 'BROKER_NUMERIC_INVALID'
  | 'BROKER_IDENTITY_MISSING'
  | 'BROKER_DUPLICATE_INSIDE_BATCH'
  | 'BROKER_QUANTITY_NON_POSITIVE';

export interface ImportRowIssue {
  rowNumber: number;
  severity: ImportIssueSeverity;
  code: ImportIssueCode;
  message: string;
  field?: string;
  rawValue?: string;
}

export interface BankStatementRecord {
  sourceBank: string;
  transactionDate: string;
  valueDate?: string;
  narration: string;
  referenceNumber?: string;
  debitAmount: number;
  creditAmount: number;
  closingBalance?: number;
  sourceRowNumber: number;
  sourceFile?: string;
  rawRecord?: Record<string, string>;
}

export interface NormalizedBankTransaction {
  candidate: Transaction | null;
  issue?: ImportRowIssue;
}

/**
 * Discriminated union for statement inputs.
 * 'text' carries a decoded string (CSV, TSV, fixed-width, HTML).
 * 'binary' carries raw Uint8Array bytes (actual XLS/XLSX binary workbooks).
 * The representation and kind cannot silently disagree.
 */
export type StatementInput =
  | {
      kind: 'text';
      content: string;
      fileName: string;
      selectedProvider?: string;
    }
  | {
      kind: 'binary';
      content: Uint8Array;
      fileName: string;
      selectedProvider?: string;
    };

export interface DetectionResult {
  matched: boolean;
  formatId: 'hdfc' | 'icici' | 'sbi' | 'generic_csv' | 'unsupported';
  displayName: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  reason: string;
}

export interface ParsedCsvRow {
  rowNumber: number;
  data: Record<string, string>;
  rawFields: string[];
}

export interface BankStatementAdapter {
  readonly id: string;
  readonly displayName: string;

  /**
   * Detect if this adapter can handle the given text-kind StatementInput.
   */
  canHandle(input: StatementInput): DetectionResult;

  /**
   * Detect if this adapter can handle the given binary-originated rows.
   * Eliminates the need for synthetic text reconstruction during format detection.
   */
  canHandleRows(headers: string[], rows: ParsedCsvRow[]): DetectionResult;

  /**
   * Parse a text-kind StatementInput into BankStatementRecords.
   */
  parse(input: StatementInput): BankStatementRecord[];

  /**
   * Parse pre-decoded ParsedCsvRow[] (from binary workbook decoding) into BankStatementRecords.
   * Used by the binary ingestion path so no synthetic CSV reconstruction is needed.
   */
  parseRows(rows: ParsedCsvRow[], fileName: string): BankStatementRecord[];

  normalize(record: BankStatementRecord, context: { provider: string; fileName: string; batchId: string }): NormalizedBankTransaction;
}

/**
 * A duplicate whose EXCLUDED-from-fingerprint fields disagree with the row it
 * collided with — specifically `direction` or `type`, the sign-bearing fields
 * (WP-FB-DATA-06a, finding L-02).
 *
 * The row is still excluded as a duplicate. This record exists so the exclusion
 * can be reported instead of being silent.
 */
export interface DivergentDuplicate {
  rowNumber: number;
  fingerprint: string;
  narration: string;
  amount: number;
  incomingType: string;
  existingType: string;
  incomingDirection: string | null;
  existingDirection: string | null;
  message: string;
}

export interface CSVImportResult {
  batchId: string;
  totalDetected: number;
  validRows: Transaction[];
  duplicateCount: number;
  /** Subset of `duplicateCount` that disagreed on direction/type (WP-FB-DATA-06a). */
  divergentDuplicateCount: number;
  divergentDuplicateRows: DivergentDuplicate[];
  ambiguousCount: number;
  invalidCount: number;
  detectedFormatId: string;
  formatDisplayName: string;
  invalidRows: ImportRowIssue[];
  ambiguousRows: ImportRowIssue[];
  unsupportedFormat?: boolean;
}
