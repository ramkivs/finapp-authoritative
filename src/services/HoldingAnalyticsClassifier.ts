/**
 * WP-FB-IMPORT-BROKER-01 — D-05 analytics-layer classification.
 *
 * D-05 product authority (PRODUCT-AUTHORITY-DECISIONS.md §A.6):
 *
 *   1. Do not extend the closed `AssetType` vocabulary for broker-native
 *      classifications. The existing 8-value `AssetType` union remains
 *      as-is for manual `Asset` records.
 *   2. Store the broker-native classification as an unconstrained
 *      optional string on `Holding` (`securityClassification?: string`).
 *   3. Do not invent a broker-independent classification when the source
 *      does not provide one.
 *   4. Deterministic canonical analytics buckets (equity / debt / hybrid
 *      / commodity / cash) MAY be derived separately at the analytics
 *      layer from `securityClassification` and/or `instrumentName`. This
 *      derivation is a separate concern from canonical storage.
 *   5. If classification cannot be established deterministically,
 *      preserve the state as unclassified rather than guessing.
 *
 * This module is the single, D-05-grounded analytics classifier for
 * imported Holdings. It is intentionally minimal and is consumed by
 * the allocation / concentration / data-quality analytics. It does NOT
 * mutate the Holding, does NOT create a canonical Asset, and does NOT
 * introduce a new vocabulary.
 *
 * Deterministic rule (D-05 §1, §2, §3, §5):
 *
 *   1. If `holding.securityClassification` is one of the 8 closed
 *      `AssetType` values AND is a non-empty string, return it as the
 *      canonical analytics bucket. (D-05 §4: a broker-native label that
 *      exactly matches a closed value is a deterministic mapping.)
 *   2. Otherwise (undefined, empty, free-form like 'Hybrid', or any
 *      value not in the closed 8-value vocabulary), return
 *      'Unclassified'. (D-05 §5: preserve the unclassified state rather
 *      than guessing.)
 *
 * Notes:
 *
 *   - This module never inspects `broker` as evidence. A 'Hybrid' label
 *     coming from Groww is not coerced into the closed vocabulary; per
 *     D-05 §1 the closed vocabulary is not extended, and per D-05 §5 the
 *     state is preserved as unclassified.
 *   - This module never inspects `instrumentName` to fabricate a
 *     classification. The D-05 §4 right to derive from `instrumentName`
 *     is reserved for future evidence-backed derivations; without
 *     evidence in the current data, this module returns 'Unclassified'.
 *   - This module never throws. It is a pure function over the input.
 */
import { AssetType, Holding } from '../domain/types';

/**
 * The classifier's output type. It is either a closed `AssetType` value
 * (one of the 8 canonical buckets) or the analytics-level unclassified
 * state. The unclassified state is represented as the literal string
 * 'Unclassified', which is already in use by `WealthIntelligenceService`
 * for Assets missing `type`.
 */
export type AnalyticsCategory = AssetType | 'Unclassified';

/**
 * The 8 closed `AssetType` values, in declaration order, used for the
 * closed-vocabulary membership test in `classifyHolding`.
 */
const CLOSED_ASSET_TYPE_VALUES: ReadonlyArray<AssetType> = [
  'Equity',
  'Debt',
  'Real Estate',
  'Commodities',
  'Cash & Savings',
  'Crypto',
  'Alternatives',
  'Other'
];

/**
 * Classify a Holding into a deterministic analytics-layer category.
 *
 * @param holding The imported Holding to classify. The function does
 *   not mutate the input.
 * @returns A closed `AssetType` value when the broker-native
 *   `securityClassification` deterministically matches a closed value,
 *   otherwise 'Unclassified'.
 */
export function classifyHolding(holding: Holding): AnalyticsCategory {
  // Defensive: even though `holding` is typed, runtime callers can
  // pass nullish values. Treat nullish as unclassified.
  if (holding === null || holding === undefined) {
    return 'Unclassified';
  }

  const sc = holding.securityClassification;

  // D-05 §5: if the source does not provide a classification, the
  // state is unclassified. No broker-inference is performed.
  if (typeof sc !== 'string' || sc.length === 0) {
    return 'Unclassified';
  }

  // D-05 §4 + §5: a broker-native label that exactly matches a closed
  // AssetType value is a deterministic mapping. Anything else (free-
  // form like 'Hybrid', or any other unconstrained string) is preserved
  // as unclassified rather than guessed into a closed bucket.
  if ((CLOSED_ASSET_TYPE_VALUES as ReadonlyArray<string>).includes(sc)) {
    return sc as AssetType;
  }

  return 'Unclassified';
}
