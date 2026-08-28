/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 *
 * Error taxonomy for Standard Import.
 *
 * Per the IMPLEMENTATION AUTHORITY REPORT:
 *  - There is NO silent data loss.
 *  - Uploading the unchanged template is a friendly INFO condition, NOT
 *    a row validation error.
 *  - All 13 codes (12 + STANDARD_DUPLICATE_IN_BATCH) are present.
 *
 * These codes are PARALLEL to `ImportIssueCode` (in protected
 * src/services/import/ImportTypes.ts). They are NOT a member of that
 * closed union; the new flow uses a separate `StandardImportIssue`
 * shape so the protected file is not modified for this purpose.
 */

export type StandardImportIssueCode =
  | 'STANDARD_MALFORMED_CSV'
  | 'STANDARD_MISSING_REQUIRED_COLUMNS'
  | 'STANDARD_EMPTY_FILE'
  | 'STANDARD_TEMPLATE_UPLOADED_UNCHANGED'
  | 'STANDARD_BLANK_NAME'
  | 'STANDARD_BLANK_VALUE'
  | 'STANDARD_INVALID_NUMBER'
  | 'STANDARD_INVALID_ASSET_CLASS'
  | 'STANDARD_NO_ASSET_CLASS_RESOLVABLE'
  | 'STANDARD_INVALID_GEOGRAPHY'
  | 'STANDARD_DUPLICATE_IN_BATCH'
  | 'STANDARD_DUPLICATE_NAME_EXISTING_ASSET'
  | 'STANDARD_UNSUPPORTED_ASSET_CLASS';

export type StandardImportIssueSeverity = 'INVALID' | 'WARNING' | 'INFO';

export interface StandardImportIssue {
  code: StandardImportIssueCode;
  severity: StandardImportIssueSeverity;
  message: string;
  /** Source row number (1-indexed from the data section, not the header). Undefined for file-level issues. */
  rowNumber?: number;
  /** The raw value that triggered the issue, when applicable. */
  rawValue?: string;
}

/**
 * Authoritative message text for each code. Kept in one place so the UI
 * renders the exact string the authority report specified.
 */
export const STANDARD_IMPORT_ISSUE_MESSAGES: Record<StandardImportIssueCode, string> = {
  STANDARD_MALFORMED_CSV:
    'The file is not valid CSV (unparseable quoting, unmatched escapes). The entire import was rejected.',
  STANDARD_MISSING_REQUIRED_COLUMNS:
    'The header row is missing one of the required columns: Asset Name, Current Value. The entire import was rejected.',
  STANDARD_EMPTY_FILE:
    'The file has only a header row and no data rows. The entire import was rejected.',
  STANDARD_TEMPLATE_UPLOADED_UNCHANGED:
    "It looks like you uploaded the template. Add your assets and re-upload.",
  STANDARD_BLANK_NAME:
    'Asset Name is blank. The row was skipped.',
  STANDARD_BLANK_VALUE:
    'Current Value is blank. The row was skipped.',
  STANDARD_INVALID_NUMBER:
    'Current Value is not a positive number. The row was skipped.',
  STANDARD_INVALID_ASSET_CLASS:
    'Asset Class is not in the governed 20-value list. The row was processed using the UI default (where present).',
  STANDARD_NO_ASSET_CLASS_RESOLVABLE:
    'Asset Class is required (the row had none and no Default Asset Class was selected). The row was skipped.',
  STANDARD_INVALID_GEOGRAPHY:
    "Geography is not one of India / International / Other. The value was coerced to 'Other'.",
  STANDARD_DUPLICATE_IN_BATCH:
    'Duplicate Asset Name in the uploaded file. Only the first occurrence was imported.',
  STANDARD_DUPLICATE_NAME_EXISTING_ASSET:
    'Duplicate name (existing Asset). A new Asset was created alongside the existing one.',
  STANDARD_UNSUPPORTED_ASSET_CLASS:
    'Unrecognized Asset Class. This row was refused. (Internal error: every governed value must map to a canonical AssetType.)'
};
