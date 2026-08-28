/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 * Tests for the 20-value Asset Class registry and the explicit mapping
 * table.
 */

import { describe, it, expect } from 'vitest';
import {
  STANDARD_IMPORT_ASSET_CLASSES,
  STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP,
  isStandardAssetClass,
  INTERNATIONAL_MAPPING_NOTE
} from '../services/import/standard/StandardAssetClasses';
import { AssetType } from '../domain/types';

describe('StandardAssetClass registry (20-value)', () => {
  it('A.1 the registry contains exactly 20 governed values (verbatim from the user reference)', () => {
    expect(STANDARD_IMPORT_ASSET_CLASSES.length).toBe(20);
  });

  it('A.2 the registry contains the user-supplied reference list verbatim', () => {
    const expected = [
      'Stocks & Equity', 'Equity Funds', 'Gold & Silver', 'FD & RD',
      'EPF / PPF / NPS', 'Real Estate', 'Cash & Savings', 'International',
      'Bonds', 'Debt Funds', 'Liquid Funds', 'Crypto',
      'Employer Stocks', 'SSY', 'Arbitrage Funds', 'Commodities',
      'ULIP', 'Moneyback Insurance', 'Endowment Plans', 'Other'
    ];
    expect([...STANDARD_IMPORT_ASSET_CLASSES]).toEqual(expected);
  });

  it('A.3 isStandardAssetClass returns true for every value in the registry', () => {
    for (const c of STANDARD_IMPORT_ASSET_CLASSES) {
      expect(isStandardAssetClass(c)).toBe(true);
    }
  });

  it('A.4 isStandardAssetClass returns false for empty/null/unknown values', () => {
    expect(isStandardAssetClass('')).toBe(false);
    expect(isStandardAssetClass(null)).toBe(false);
    expect(isStandardAssetClass(undefined)).toBe(false);
    expect(isStandardAssetClass('NotAClass')).toBe(false);
    expect(isStandardAssetClass('cash & savings')).toBe(false); // case-sensitive
  });
});

describe('STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP (explicit 20→8 mapping)', () => {
  it('B.1 the mapping table has an entry for every StandardAssetClass', () => {
    for (const c of STANDARD_IMPORT_ASSET_CLASSES) {
      expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP).toHaveProperty(c);
    }
  });

  it('B.2 every mapping value is a canonical AssetType (one of the 8 closed values)', () => {
    const canonical: ReadonlyArray<AssetType> = [
      'Equity', 'Debt', 'Real Estate', 'Commodities',
      'Cash & Savings', 'Crypto', 'Alternatives', 'Other'
    ];
    for (const c of STANDARD_IMPORT_ASSET_CLASSES) {
      const v = STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP[c];
      expect(canonical).toContain(v);
    }
  });

  it('B.3 International maps to Other (per authority)', () => {
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['International']).toBe('Other');
  });

  it('B.4 Stocks & Equity, Equity Funds, Employer Stocks all map to Equity', () => {
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Stocks & Equity']).toBe('Equity');
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Equity Funds']).toBe('Equity');
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Employer Stocks']).toBe('Equity');
  });

  it('B.5 FD & RD, EPF/PPF/NPS, SSY, Bonds, Debt Funds, Liquid Funds, Arbitrage Funds, ULIP, Moneyback Insurance, Endowment Plans all map to Debt', () => {
    const debtClasses = ['FD & RD', 'EPF / PPF / NPS', 'SSY', 'Bonds', 'Debt Funds', 'Liquid Funds', 'Arbitrage Funds', 'ULIP', 'Moneyback Insurance', 'Endowment Plans'];
    for (const c of debtClasses) {
      expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP[c]).toBe('Debt');
    }
  });

  it('B.6 Gold & Silver and Commodities map to Commodities', () => {
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Gold & Silver']).toBe('Commodities');
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Commodities']).toBe('Commodities');
  });

  it('B.7 Real Estate, Cash & Savings, Crypto, Other map to themselves', () => {
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Real Estate']).toBe('Real Estate');
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Cash & Savings']).toBe('Cash & Savings');
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Crypto']).toBe('Crypto');
    expect(STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP['Other']).toBe('Other');
  });

  it('B.8 INTERNATIONAL_MAPPING_NOTE is the authoritative copy', () => {
    expect(INTERNATIONAL_MAPPING_NOTE).toBe('International is a Geography attribute, not an Asset Class. Use the Geography column for cross-border assets.');
  });
});
