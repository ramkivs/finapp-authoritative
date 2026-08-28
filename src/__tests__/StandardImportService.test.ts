/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 * Tests for the Standard Import service:
 *  - template generation (template constant)
 *  - CSV parsing
 *  - precedence (CSV > UI default > error)
 *  - duplicate handling (within-file first-wins; against-existing accept)
 *  - geography handling
 *  - currency handling
 *  - error taxonomy
 *  - canonical Asset[] output
 *  - International → Other
 *  - unchanged-template INFO
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { StandardImportService } from '../services/import/standard/StandardImportService';
import { parseStandardCsv, getCell } from '../services/import/standard/StandardCsvAdapter';
import { StandardImportIssue } from '../services/import/standard/StandardImportErrors';
import { Asset } from '../domain/types';

const FIXTURE_DIR = resolve(__dirname, 'fixtures/standard_import');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf-8');
}

describe('C. CSV adapter', () => {
  it('C.1 parses a well-formed CSV with header and 2 rows', () => {
    const r = parseStandardCsv(loadFixture('standard_template.csv'));
    expect(r.ok).toBe(true);
    expect(r.headers).toEqual(['asset name', 'current value', 'asset class', 'tag', 'currency', 'geography']);
    expect(r.rows.length).toBe(2);
  });

  it('C.2 rejects a CSV with a missing required column', () => {
    const r = parseStandardCsv('Foo,Bar\n1,2\n');
    expect(r.ok).toBe(false);
    expect(r.fileIssues.some((i: StandardImportIssue) => i.code === 'STANDARD_MISSING_REQUIRED_COLUMNS')).toBe(true);
  });

  it('C.3 rejects an empty file', () => {
    const r = parseStandardCsv('');
    expect(r.ok).toBe(false);
    expect(r.fileIssues.some((i: StandardImportIssue) => i.code === 'STANDARD_EMPTY_FILE')).toBe(true);
  });

  it('C.4 rejects an unterminated quoted field (malformed)', () => {
    const r = parseStandardCsv('Asset Name,Current Value\n"unterminated,100\n');
    expect(r.ok).toBe(false);
    expect(r.fileIssues.some((i: StandardImportIssue) => i.code === 'STANDARD_MALFORMED_CSV')).toBe(true);
  });

  it('C.5 supports a quoted field with an embedded comma', () => {
    const r = parseStandardCsv('Asset Name,Current Value,Asset Class,Tag,Currency,Geography\n"Foo, Bar",100,Cash & Savings,Core,INR,India\n');
    expect(r.ok).toBe(true);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0][0]).toBe('Foo, Bar');
  });

  it('C.6 supports an escaped quote inside a quoted field', () => {
    const r = parseStandardCsv('Asset Name,Current Value,Asset Class,Tag,Currency,Geography\n"He said ""hi""",100,Cash & Savings,Core,INR,India\n');
    expect(r.ok).toBe(true);
    expect(r.rows[0][0]).toBe('He said "hi"');
  });

  it('C.7 strips a leading UTF-8 BOM', () => {
    const r = parseStandardCsv('\uFEFFAsset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,100,Cash & Savings,Core,INR,India\n');
    expect(r.ok).toBe(true);
    expect(r.headers).toEqual(['asset name', 'current value', 'asset class', 'tag', 'currency', 'geography']);
  });

  it('C.8 getCell returns trimmed value or undefined', () => {
    const r = parseStandardCsv(loadFixture('standard_template.csv'));
    expect(getCell(r.rows[0], r.headers, 'asset name')).toBe('HDFC Savings Account');
    expect(getCell(r.rows[0], r.headers, 'tag')).toBe('Core');
    expect(getCell(r.rows[0], r.headers, 'missing')).toBeUndefined();
  });
});

describe('D. Template-uploaded-unchanged (INFO, not an error)', () => {
  it('D.1 the unchanged template produces a friendly INFO issue and zero valid rows', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('standard_template.csv'),
      sourceFilename: 'standard_template.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.summary.templateUploadedUnchanged).toBe(true);
    expect(r.validRows.length).toBe(0);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_TEMPLATE_UPLOADED_UNCHANGED')).toBe(true);
  });
});

describe('E. Asset Class precedence: CSV > UI default > error', () => {
  it('E.1 CSV has a valid Asset Class, UI default set -> CSV wins (Source=CSV)', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_with_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: 'Other',
      existingAssets: []
    });
    expect(r.validRows.length).toBe(6);
    // The first row is Cash & Savings (CSV-supplied), so Source=CSV.
    expect(r.perRowResolution[0].source).toBe('CSV');
    expect(r.perRowResolution[0].resolvedAssetType).toBe('Cash & Savings');
  });

  it('E.2 CSV has a valid Asset Class, UI default unset -> CSV wins', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_with_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.perRowResolution[0].source).toBe('CSV');
  });

  it('E.3 CSV Asset Class blank, UI default set -> UI default wins (Source=Default)', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_without_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: 'Cash & Savings',
      existingAssets: []
    });
    expect(r.validRows.length).toBe(3);
    expect(r.perRowResolution[0].source).toBe('Default');
    expect(r.perRowResolution[0].resolvedAssetType).toBe('Cash & Savings');
  });

  it('E.4 CSV Asset Class blank, UI default unset -> row dropped (STANDARD_NO_ASSET_CLASS_RESOLVABLE)', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_without_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(0);
    expect(r.issues.every((i: StandardImportIssue) => i.code === 'STANDARD_NO_ASSET_CLASS_RESOLVABLE')).toBe(true);
  });

  it('E.5 CSV has invalid Asset Class, UI default set -> UI default wins (Source="Default (was invalid)")', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_invalid_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: 'Cash & Savings',
      existingAssets: []
    });
    // The 2 valid rows survive (HDFC + Real Estate Plot); the 2 junk
    // rows get UI default applied.
    expect(r.validRows.length).toBe(4);
    const junkRow0 = r.perRowResolution[1];
    expect(junkRow0.source).toBe('Default (was invalid)');
    expect(junkRow0.resolvedAssetType).toBe('Cash & Savings');
  });

  it('E.6 CSV has invalid Asset Class, UI default unset -> row dropped', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_invalid_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    // The 2 junk rows are dropped; the 2 valid ones survive.
    expect(r.validRows.length).toBe(2);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_NO_ASSET_CLASS_RESOLVABLE')).toBe(true);
  });
});

describe('F. International → Other (with per-row note)', () => {
  it('F.1 CSV Asset Class "International" maps to canonical Other with a per-row note', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_with_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    // Find the International row in the fixture.
    const intlRow = r.perRowResolution.find(
      (p) => p.rawAssetClass === 'International'
    );
    expect(intlRow).toBeDefined();
    expect(intlRow!.resolvedAssetType).toBe('Other');
    expect(intlRow!.note).toBe('International is a Geography attribute, not an Asset Class. Use the Geography column for cross-border assets.');
  });
});

describe('G. Within-file duplicate (Q3: first row wins)', () => {
  it('G.1 two rows with the same normalized name -> first wins, second dropped with STANDARD_DUPLICATE_IN_BATCH', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC Savings,50000,Cash & Savings,Core,INR,India\nhdfc savings,30000,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'dup.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(1);
    expect(r.validRows[0].amount).toBe(50000);
    expect(r.summary.duplicateInBatch).toBe(1);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_DUPLICATE_IN_BATCH')).toBe(true);
  });
});

describe('H. Existing-Asset duplicate (Q4: accept, create new row)', () => {
  it('H.1 a row with the same normalized name as an existing Asset is accepted (new Asset with a distinct id)', () => {
    const existing: Asset[] = [
      { id: 'a-1', name: 'HDFC Savings', amount: 99999, type: 'Cash & Savings' }
    ];
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC Savings,50000,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'dup.csv',
      defaultAssetClass: null,
      existingAssets: existing
    });
    expect(r.validRows.length).toBe(1);
    expect(r.perRowResolution[0].isDuplicateOfExistingAsset).toBe(true);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_DUPLICATE_NAME_EXISTING_ASSET')).toBe(true);
  });
});

describe('I. Validation: blank name, blank value, invalid number', () => {
  it('I.1 blank Asset Name -> STANDARD_BLANK_NAME, row dropped', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\n,50000,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'blank.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(0);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_BLANK_NAME')).toBe(true);
  });

  it('I.2 blank Current Value -> STANDARD_BLANK_VALUE, row dropped', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'blank.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(0);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_BLANK_VALUE')).toBe(true);
  });

  it('I.3 non-numeric Current Value -> STANDARD_INVALID_NUMBER, row dropped', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,not-a-number,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'bad.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(0);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_INVALID_NUMBER')).toBe(true);
  });

  it('I.4 negative Current Value -> STANDARD_INVALID_NUMBER, row dropped', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,-100,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'neg.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(0);
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_INVALID_NUMBER')).toBe(true);
  });

  it('I.5 comma-thousands in Current Value are accepted', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,1234567.89,Cash & Savings,Core,INR,India\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv,
      sourceFilename: 'thousands.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(1);
    expect(r.validRows[0].amount).toBe(1234567.89);
  });
});

describe('J. Geography: blank, invalid, coercion to Other', () => {
  it('J.1 blank Geography -> defaults to India', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,50000,Cash & Savings,Core,INR,\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv, sourceFilename: 'g.csv', defaultAssetClass: null, existingAssets: []
    });
    expect(r.validRows.length).toBe(1);
    expect(r.validRows[0].geography).toBe('India');
  });

  it('J.2 invalid Geography -> coerced to Other, row-level warning', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,50000,Cash & Savings,Core,INR,Antarctica\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv, sourceFilename: 'g.csv', defaultAssetClass: null, existingAssets: []
    });
    expect(r.validRows.length).toBe(1);
    expect(r.validRows[0].geography).toBe('Other');
    expect(r.issues.some((i: StandardImportIssue) => i.code === 'STANDARD_INVALID_GEOGRAPHY')).toBe(true);
  });
});

describe('K. Currency: blank -> INR, free text up to 8 chars', () => {
  it('K.1 blank Currency -> defaults to INR', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nHDFC,50000,Cash & Savings,Core,,\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv, sourceFilename: 'c.csv', defaultAssetClass: null, existingAssets: []
    });
    expect(r.validRows.length).toBe(1);
    expect(r.validRows[0].currency).toBe('INR');
  });

  it('K.2 USD is preserved', () => {
    const csv = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography\nUS Stock,5000,International,Intl,USD,International\n';
    const r = StandardImportService.parseAndValidate({
      csvText: csv, sourceFilename: 'c.csv', defaultAssetClass: null, existingAssets: []
    });
    expect(r.validRows.length).toBe(1);
    expect(r.validRows[0].currency).toBe('USD');
  });
});

describe('L. Canonical Asset[] output', () => {
  it('L.1 the validRows are full Asset objects with the mapped canonical type', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_with_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.validRows.length).toBe(6);
    // Row 0: Cash & Savings -> canonical Cash & Savings
    expect(r.validRows[0]).toMatchObject({
      name: 'HDFC Savings',
      amount: 50000,
      type: 'Cash & Savings',
      tag: 'Core',
      currency: 'INR',
      geography: 'India'
    });
  });

  it('L.2 the summary counts are correct', () => {
    const r = StandardImportService.parseAndValidate({
      csvText: loadFixture('sample_with_asset_class.csv'),
      sourceFilename: 'sample.csv',
      defaultAssetClass: null,
      existingAssets: []
    });
    expect(r.summary.totalRows).toBe(6);
    expect(r.summary.validRows).toBe(6);
    expect(r.summary.invalidRows).toBe(0);
    expect(r.summary.csvSuppliedAssetClass).toBe(6);
    expect(r.summary.uiDefaultApplied).toBe(0);
  });
});
