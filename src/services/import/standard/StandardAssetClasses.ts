/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 *
 * Standard Import Asset Class registry.
 *
 * The 20-value `StandardAssetClass` is the Standard Import UI/reference
 * authority. The canonical 8-value `AssetType` (src/domain/types.ts) is
 * UNCHANGED. The explicit `STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP`
 * table is the SINGLE bridge between the two vocabularies.
 *
 * Per the IMPLEMENTATION AUTHORITY REPORT (FINBOOM-REQUIREMENT-1-STANDARD-IMPORT-IMPLEMENTATION-AUTHORITY-REPORT.md):
 *  - 20-value registry: UI/reference authority ONLY in V1
 *  - It is NOT a canonical domain union
 *  - It does NOT propagate to Wealth / Overview / analytics
 *  - The canonical 8-value AssetType MUST NOT be expanded
 *  - `International → Other` with the explanatory per-row note
 *
 * Future features that want to consume the 20-value vocabulary must go
 * through a separate authority gate.
 */

import { AssetType } from '../../../domain/types';

export const STANDARD_IMPORT_ASSET_CLASSES = [
  'Stocks & Equity',
  'Equity Funds',
  'Gold & Silver',
  'FD & RD',
  'EPF / PPF / NPS',
  'Real Estate',
  'Cash & Savings',
  'International',
  'Bonds',
  'Debt Funds',
  'Liquid Funds',
  'Crypto',
  'Employer Stocks',
  'SSY',
  'Arbitrage Funds',
  'Commodities',
  'ULIP',
  'Moneyback Insurance',
  'Endowment Plans',
  'Other'
] as const;

export type StandardAssetClass = typeof STANDARD_IMPORT_ASSET_CLASSES[number];

/**
 * EXPLICIT MAPPING TABLE — Option B per the authority report.
 *
 * Every Standard Import Asset Class maps to ONE canonical AssetType. This
 * table is the single authority for "what canonical type is written to
 * Asset.type when a user picks '<this>' in the Standard Import flow."
 *
 * Notes:
 *  - `Stocks & Equity` / `Equity Funds` / `Employer Stocks` → Equity
 *  - `Gold & Silver` / `Commodities` → Commodities
 *  - `FD & RD` / `EPF / PPF / NPS` / `SSY` / `Bonds` / `Debt Funds` /
 *    `Liquid Funds` / `Arbitrage Funds` / `ULIP` /
 *    `Moneyback Insurance` / `Endowment Plans` → Debt
 *  - `Real Estate` → Real Estate
 *  - `Cash & Savings` → Cash & Savings
 *  - `Crypto` → Crypto
 *  - `International` → Other (per-row note: "International is a
 *    Geography attribute, not an Asset Class. Use the Geography column
 *    for cross-border assets.")
 *  - `Other` → Other
 */
export const STANDARD_IMPORT_TO_CANONICAL_ASSET_TYPE_MAP: Record<StandardAssetClass, AssetType> = {
  'Stocks & Equity':     'Equity',
  'Equity Funds':        'Equity',
  'Gold & Silver':       'Commodities',
  'FD & RD':             'Debt',
  'EPF / PPF / NPS':     'Debt',
  'Real Estate':         'Real Estate',
  'Cash & Savings':      'Cash & Savings',
  'International':       'Other',
  'Bonds':               'Debt',
  'Debt Funds':          'Debt',
  'Liquid Funds':        'Debt',
  'Crypto':              'Crypto',
  'Employer Stocks':     'Equity',
  'SSY':                 'Debt',
  'Arbitrage Funds':     'Debt',
  'Commodities':         'Commodities',
  'ULIP':                'Debt',
  'Moneyback Insurance': 'Debt',
  'Endowment Plans':     'Debt',
  'Other':               'Other'
};

/**
 * Return true if `value` is exactly one of the 20 governed
 * Standard Import Asset Classes. The check is case-sensitive.
 */
export function isStandardAssetClass(value: string | null | undefined): value is StandardAssetClass {
  if (typeof value !== 'string') return false;
  return (STANDARD_IMPORT_ASSET_CLASSES as ReadonlyArray<string>).includes(value);
}

/**
 * Per-row explanatory note for the `International` mapping. This is the
 * authoritative copy (verbatim from the authority report).
 */
export const INTERNATIONAL_MAPPING_NOTE =
  'International is a Geography attribute, not an Asset Class. Use the Geography column for cross-border assets.';
