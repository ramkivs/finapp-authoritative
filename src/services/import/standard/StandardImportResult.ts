/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 *
 * Result types for the Standard Import flow.
 *
 * The flow produces:
 *  - `validRows: Asset[]` — rows that survived validation, precedence
 *    resolution, and within-file dedup. These are passed to
 *    `commitImportedStandardAssets`.
 *  - `issues: StandardImportIssue[]` — file-level, row-level, and INFO
 *    notices, surfaced verbatim in the review surface.
 *  - `perRowSource: Record<assetId, StandardImportRowSource>` — the
 *    per-row source-of-truth for the Asset Class chip in the review
 *    surface. The assetId is the REPOSITORY-ASSIGNED id (assigned by
 *    `AssetRepository.add`); for review-time rendering, the caller can
 *    also index by the row number, see `perRowByIndex`.
 *  - `perRowByIndex: StandardImportRowSource[]` — same as `perRowSource`
 *    but indexed by the 0-based row position in `validRows`, for the
 *    review surface which renders rows in the order they appear in
 *    `validRows`.
 */

import { Asset, AssetType, GeographyType } from '../../../domain/types';
import { StandardAssetClass } from './StandardAssetClasses';
import { StandardImportIssue } from './StandardImportErrors';

/**
 * The source of the Asset Class for a single row, as resolved by the
 * precedence rules. The per-row chip in the review surface renders this
 * verbatim.
 */
export type StandardImportRowSource =
  | 'CSV'                       // CSV supplied a valid Asset Class
  | 'Default'                   // UI default was applied because CSV was blank
  | 'Default (was invalid)'     // CSV had a value, it was invalid, UI default was applied
  | 'Error';                    // Row is dropped, reason in `issues`

export interface StandardImportRowResolution {
  /** The 0-based row position in `validRows`. */
  index: number;
  /** The 20-value source label as supplied by the CSV (undefined if not supplied). */
  rawAssetClass: StandardAssetClass | undefined;
  /** The mapped canonical 8-value AssetType that was written to Asset.type. */
  resolvedAssetType: AssetType;
  /** How the resolution was arrived at. */
  source: StandardImportRowSource;
  /** True if this row shares its normalized name with an existing Asset. */
  isDuplicateOfExistingAsset: boolean;
  /** Per-row note (e.g. for the `International → Other` mapping). */
  note?: string;
}

export interface StandardImportResult {
  validRows: Asset[];
  /** Issues at the file level (no rowNumber) and at the row level. */
  issues: StandardImportIssue[];
  /** Per-row resolution metadata, indexed by 0-based position in `validRows`. */
  perRowResolution: StandardImportRowResolution[];
  /** Summary counts, surfaced in the review-surface summary line. */
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateInBatch: number;
    duplicateOfExistingAsset: number;
    csvSuppliedAssetClass: number;
    uiDefaultApplied: number;
    uiDefaultReplacedInvalid: number;
    /** True iff the file matches the template fixture and produced zero valid rows with one INFO. */
    templateUploadedUnchanged: boolean;
  };
  /** The source filename (audit trail). */
  sourceFilename: string;
}

/** Re-export GeographyType for callers that import from this module. */
export type { GeographyType };
