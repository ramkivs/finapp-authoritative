/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 *
 * Standard Import service: validate, resolve precedence, dedup,
 * and produce the canonical `Asset[]` for commit.
 *
 * Authority references:
 *  - Default Asset Class: optional, no default, `— Select —` placeholder.
 *  - Precedence: CSV > UI default > error.
 *  - Within-file dedup: first row wins (identity = normalized name).
 *  - Existing-Asset dedup: accept the imported row, create a NEW Asset
 *    with a distinct id (matches canonical Q-D07b-1a = (c) invariant).
 *  - Geography: India / International / Other; invalid → coerce to Other.
 *  - Currency: blank → INR; free text up to 8 chars; no FX conversion.
 *  - Tag: blank → undefined; trimmed; max 100 chars.
 *
 * The service is PURE — no I/O, no Date.now, no Math.random. The caller
 * (Standard Import UI panel) reads the existing Assets from the store
 * before calling, and passes them in as `existingAssets`. The id
 * assignment is done by `AssetRepository.add` at commit time, not here.
 */

import { Asset, AssetType, GeographyType } from '../../../domain/types';
import { AssetIdentityService } from '../../AssetIdentityService';
import {
  STANDARD_IMPORT_ASSET_CLASSES,
  STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP,
  isStandardAssetClass,
  StandardAssetClass,
  INTERNATIONAL_MAPPING_NOTE
} from './StandardAssetClasses';
import {
  StandardImportIssue,
  StandardImportIssueSeverity,
  STANDARD_IMPORT_ISSUE_MESSAGES
} from './StandardImportErrors';
import {
  StandardImportResult,
  StandardImportRowResolution,
  StandardImportRowSource
} from './StandardImportResult';
import { parseStandardCsv, getCell } from './StandardCsvAdapter';

const KNOWN_GEOGRAPHIES: ReadonlyArray<GeographyType> = ['India', 'International', 'Other'];

/**
 * The two example rows in the Standard Import template. Used to detect
 * "looks like you uploaded the template" — the user uploaded the file
 * without any modifications.
 */
const TEMPLATE_EXAMPLE_ROW_1 = ['HDFC Savings Account', '50000', 'Cash & Savings', 'Core', 'INR', 'India'];
const TEMPLATE_EXAMPLE_ROW_2 = ['EPF Balance', '350000', 'EPF / PPF / NPS', 'Retirement', 'INR', 'India'];

function isTemplateExampleRow(row: string[]): boolean {
  if (row.length < 6) return false;
  const a = row.slice(0, 6).map(c => c.trim());
  if (JSON.stringify(a) === JSON.stringify(TEMPLATE_EXAMPLE_ROW_1)) return true;
  if (JSON.stringify(a) === JSON.stringify(TEMPLATE_EXAMPLE_ROW_2)) return true;
  return false;
}

function isEntirelyTemplate(text: string): boolean {
  // Detect "the user uploaded the template unchanged" by checking that
  // every data row is one of the two example rows. Header + 2 examples =
  // exact match.
  const parsed = parseStandardCsv(text);
  if (!parsed.ok) return false;
  if (parsed.rows.length !== 2) return false;
  return parsed.rows.every(isTemplateExampleRow);
}

function parseCurrentValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  // Strip thousands separators (commas), trim whitespace.
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function normalizeAssetNameForCompare(name: string): string {
  return AssetIdentityService.normalizeName(name);
}

export interface StandardImportServiceInput {
  csvText: string;
  sourceFilename: string;
  /** UI-selected Default Asset Class (or null/undefined if unset). */
  defaultAssetClass: StandardAssetClass | null | undefined;
  /** Existing Assets from the canonical store, for duplicate detection. */
  existingAssets: ReadonlyArray<Asset>;
}

export class StandardImportService {
  /**
   * The single entry point. Returns a `StandardImportResult` containing
   * the valid `Asset[]`, per-row resolution metadata, and a complete
   * list of issues.
   */
  static parseAndValidate(input: StandardImportServiceInput): StandardImportResult {
    const { csvText, sourceFilename, defaultAssetClass, existingAssets } = input;
    const issues: StandardImportIssue[] = [];

    // Template-uploaded-unchanged is detected at the file level. It is
    // an INFO, not an error, and produces zero valid rows.
    if (isEntirelyTemplate(csvText)) {
      issues.push({
        code: 'STANDARD_TEMPLATE_UPLOADED_UNCHANGED',
        severity: 'INFO',
        message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_TEMPLATE_UPLOADED_UNCHANGED
      });
      return {
        validRows: [],
        issues,
        perRowResolution: [],
        summary: {
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          duplicateInBatch: 0,
          duplicateOfExistingAsset: 0,
          csvSuppliedAssetClass: 0,
          uiDefaultApplied: 0,
          uiDefaultReplacedInvalid: 0,
          templateUploadedUnchanged: true
        },
        sourceFilename
      };
    }

    const parsed = parseStandardCsv(csvText);
    issues.push(...parsed.fileIssues);
    if (!parsed.ok) {
      return {
        validRows: [],
        issues,
        perRowResolution: [],
        summary: {
          totalRows: parsed.rows.length,
          validRows: 0,
          invalidRows: parsed.rows.length,
          duplicateInBatch: 0,
          duplicateOfExistingAsset: 0,
          csvSuppliedAssetClass: 0,
          uiDefaultApplied: 0,
          uiDefaultReplacedInvalid: 0,
          templateUploadedUnchanged: false
        },
        sourceFilename
      };
    }

    const validRows: Asset[] = [];
    const perRowResolution: StandardImportRowResolution[] = [];
    const seenNames = new Set<string>();
    let invalidRows = 0;
    let duplicateInBatch = 0;
    let duplicateOfExistingAsset = 0;
    let csvSuppliedAssetClass = 0;
    let uiDefaultApplied = 0;
    let uiDefaultReplacedInvalid = 0;

    // Pre-compute the set of normalized names in the existing Assets,
    // so the per-row duplicate check is O(1).
    const existingNamesNormalized = new Set<string>();
    for (const a of existingAssets) {
      const n = normalizeAssetNameForCompare(a.name ?? '');
      if (n !== '') existingNamesNormalized.add(n);
    }

    for (let r = 0; r < parsed.rows.length; r += 1) {
      const row = parsed.rows[r];
      const rowNumber = r + 1; // 1-indexed for the user.

      const rawName = getCell(row, parsed.headers, 'asset name');
      const rawValue = getCell(row, parsed.headers, 'current value');
      const rawAssetClass = getCell(row, parsed.headers, 'asset class');
      const rawTag = getCell(row, parsed.headers, 'tag');
      const rawCurrency = getCell(row, parsed.headers, 'currency');
      const rawGeography = getCell(row, parsed.headers, 'geography');

      // Validate Asset Name.
      if (rawName === undefined || rawName === '') {
        issues.push({
          code: 'STANDARD_BLANK_NAME',
          severity: 'INVALID',
          message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_BLANK_NAME,
          rowNumber
        });
        invalidRows += 1;
        continue;
      }
      const trimmedName = rawName.trim();
      if (trimmedName.length > 200) {
        issues.push({
          code: 'STANDARD_BLANK_NAME',
          severity: 'INVALID',
          message: 'Asset Name is too long (max 200 characters). The row was skipped.',
          rowNumber,
          rawValue: trimmedName
        });
        invalidRows += 1;
        continue;
      }

      // Validate Current Value.
      const value = parseCurrentValue(rawValue);
      if (value === null) {
        const code = rawValue === undefined || rawValue === ''
          ? 'STANDARD_BLANK_VALUE'
          : 'STANDARD_INVALID_NUMBER';
        issues.push({
          code,
          severity: 'INVALID',
          message: STANDARD_IMPORT_ISSUE_MESSAGES[code],
          rowNumber,
          rawValue: rawValue
        });
        invalidRows += 1;
        continue;
      }

      // Within-file duplicate (Q3): first row wins.
      const nameKey = normalizeAssetNameForCompare(trimmedName);
      if (seenNames.has(nameKey)) {
        issues.push({
          code: 'STANDARD_DUPLICATE_IN_BATCH',
          severity: 'WARNING',
          message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_DUPLICATE_IN_BATCH,
          rowNumber,
          rawValue: trimmedName
        });
        duplicateInBatch += 1;
        continue;
      }

      // Asset Class precedence (D5): CSV > UI default > error.
      let resolvedAssetType: AssetType;
      let source: StandardImportRowSource;
      let note: string | undefined;

      if (rawAssetClass !== undefined && isStandardAssetClass(rawAssetClass)) {
        // CSV supplied a valid 20-value.
        const klass = rawAssetClass as StandardAssetClass;
        resolvedAssetType = STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP[klass];
        source = 'CSV';
        csvSuppliedAssetClass += 1;
        // Special case: International → Other with a per-row note.
        if (klass === 'International') {
          note = INTERNATIONAL_MAPPING_NOTE;
        }
      } else if (rawAssetClass !== undefined && rawAssetClass !== '') {
        // CSV supplied a value but it is NOT in the 20-value list.
        if (defaultAssetClass && isStandardAssetClass(defaultAssetClass)) {
          resolvedAssetType = STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP[defaultAssetClass];
          source = 'Default (was invalid)';
          uiDefaultReplacedInvalid += 1;
          issues.push({
            code: 'STANDARD_INVALID_ASSET_CLASS',
            severity: 'WARNING',
            message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_INVALID_ASSET_CLASS,
            rowNumber,
            rawValue: rawAssetClass
          });
        } else {
          issues.push({
            code: 'STANDARD_NO_ASSET_CLASS_RESOLVABLE',
            severity: 'INVALID',
            message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_NO_ASSET_CLASS_RESOLVABLE,
            rowNumber,
            rawValue: rawAssetClass
          });
          invalidRows += 1;
          continue;
        }
      } else {
        // CSV Asset Class is blank.
        if (defaultAssetClass && isStandardAssetClass(defaultAssetClass)) {
          resolvedAssetType = STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP[defaultAssetClass];
          source = 'Default';
          uiDefaultApplied += 1;
        } else {
          issues.push({
            code: 'STANDARD_NO_ASSET_CLASS_RESOLVABLE',
            severity: 'INVALID',
            message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_NO_ASSET_CLASS_RESOLVABLE,
            rowNumber,
            rawValue: rawAssetClass
          });
          invalidRows += 1;
          continue;
        }
      }

      // Geography.
      let geography: GeographyType | undefined;
      if (rawGeography === undefined || rawGeography === '') {
        geography = 'India';
      } else if ((KNOWN_GEOGRAPHIES as ReadonlyArray<string>).includes(rawGeography)) {
        geography = rawGeography as GeographyType;
      } else {
        issues.push({
          code: 'STANDARD_INVALID_GEOGRAPHY',
          severity: 'WARNING',
          message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_INVALID_GEOGRAPHY,
          rowNumber,
          rawValue: rawGeography
        });
        geography = 'Other';
      }

      // Currency.
      const currency = (rawCurrency && rawCurrency.length > 0 && rawCurrency.length <= 8)
        ? rawCurrency
        : (rawCurrency && rawCurrency.length > 8 ? rawCurrency.slice(0, 8) : 'INR');

      // Tag.
      const tag = (rawTag && rawTag.length > 0)
        ? (rawTag.length > 100 ? rawTag.slice(0, 100) : rawTag)
        : undefined;

      // Existing-Asset duplicate (Q4): the canonical invariant permits
      // duplicate names. We ACCEPT the row and create a new Asset.
      const isDuplicateOfExistingAsset = existingNamesNormalized.has(nameKey);
      if (isDuplicateOfExistingAsset) {
        duplicateOfExistingAsset += 1;
        issues.push({
          code: 'STANDARD_DUPLICATE_NAME_EXISTING_ASSET',
          severity: 'WARNING',
          message: STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_DUPLICATE_NAME_EXISTING_ASSET,
          rowNumber,
          rawValue: trimmedName
        });
      }

      const asset: Asset = {
        name: trimmedName,
        amount: value,
        type: resolvedAssetType,
        tag,
        currency,
        geography
      };
      validRows.push(asset);
      perRowResolution.push({
        index: perRowResolution.length,
        rawAssetClass: (rawAssetClass && isStandardAssetClass(rawAssetClass))
          ? (rawAssetClass as StandardAssetClass)
          : undefined,
        resolvedAssetType,
        source,
        isDuplicateOfExistingAsset,
        note
      });
      seenNames.add(nameKey);
    }

    return {
      validRows,
      issues,
      perRowResolution,
      summary: {
        totalRows: parsed.rows.length,
        validRows: validRows.length,
        invalidRows,
        duplicateInBatch,
        duplicateOfExistingAsset,
        csvSuppliedAssetClass,
        uiDefaultApplied,
        uiDefaultReplacedInvalid,
        templateUploadedUnchanged: false
      },
      sourceFilename
    };
  }
}
