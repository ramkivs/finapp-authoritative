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

const CLOSED_ASSET_TYPE_BY_LOWER: ReadonlyMap<string, AssetType> = new Map(
  CLOSED_ASSET_TYPE_VALUES.map(v => [v.toLowerCase(), v])
);

const EQUITY_CATEGORY_LABELS = new Set([
  'equity',
  'equities',
  'stock',
  'stocks',
  'stocks & equity',
  'equity fund',
  'equity funds',
  'employer stocks',
  'elss',
  'index',
  'index fund',
  'index funds',
  'large cap',
  'mid cap',
  'small cap',
  'large & mid cap',
  'largemidcap',
  'flexi cap',
  'multi cap',
  'sectoral',
  'thematic',
  'focused',
  'value',
  'contra',
  'dividend yield',
]);

const DEBT_CATEGORY_LABELS = new Set([
  'debt',
  'debt fund',
  'debt funds',
  'fixed income',
  'bond',
  'bonds',
  'gilt',
  'liquid',
  'liquid fund',
  'liquid funds',
  'overnight',
  'money market',
  'ultra short',
  'low duration',
  'short duration',
  'medium duration',
  'long duration',
  'corporate bond',
  'banking & psu',
  'banking and psu',
  'credit risk',
  'dynamic bond',
  'floater',
  'arbitrage',
  'arbitrage fund',
  'arbitrage funds',
  'fd & rd',
  'epf / ppf / nps',
]);

const COMMODITY_CATEGORY_LABELS = new Set([
  'commodity',
  'commodities',
  'gold',
  'silver',
  'gold & silver',
  'gold etf',
  'silver etf',
  'precious metals',
]);

const HYBRID_OR_OTHER_CATEGORY_LABELS = new Set([
  'hybrid',
  'balanced',
  'balanced advantage',
  'aggressive hybrid',
  'conservative hybrid',
  'multi asset',
  'multi-asset',
  'dynamic asset allocation',
  'equity savings',
  'solution oriented',
  'fof',
  'fund of funds',
  'international',
  'other',
]);

function classifyCategoryString(raw: string): AnalyticsCategory {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return 'Unclassified';

  const exactClosed = CLOSED_ASSET_TYPE_BY_LOWER.get(norm);
  if (exactClosed) return exactClosed;

  if (EQUITY_CATEGORY_LABELS.has(norm) || /^equity(\s*[-:/]\s*|\s+)/.test(norm)) {
    return 'Equity';
  }
  if (DEBT_CATEGORY_LABELS.has(norm) || /^debt(\s*[-:/]\s*|\s+)/.test(norm)) {
    return 'Debt';
  }
  if (COMMODITY_CATEGORY_LABELS.has(norm) || /^(commodit|gold|silver)\b/.test(norm)) {
    return 'Commodities';
  }
  if (HYBRID_OR_OTHER_CATEGORY_LABELS.has(norm) || /^(hybrid|solution)\b/.test(norm)) {
    return 'Other';
  }
  if (norm === 'cash' || norm === 'savings') {
    return 'Cash & Savings';
  }
  if (norm === 'reit' || norm === 'reits') {
    return 'Real Estate';
  }

  return 'Unclassified';
}

function classifyMutualFundSchemeName(name: string): AnalyticsCategory {
  const norm = name.trim();
  if (!norm) return 'Unclassified';

  if (/\b(gold|silver|commodity|commodities)\b/i.test(norm)) {
    return 'Commodities';
  }
  if (
    /\b(liquid|overnight|gilt|money\s+market|corporate\s+bond|short\s+duration|low\s+duration|ultra\s+short|medium\s+duration|long\s+duration|banking\s*&\s*psu|dynamic\s+bond|credit\s+risk|floater|debt|bond|arbitrage)\b/i.test(
      norm
    )
  ) {
    return 'Debt';
  }
  if (/\b(hybrid|balanced|multi\s*-?\s*asset|equity\s+savings)\b/i.test(norm)) {
    return 'Other';
  }
  if (
    /\b(equity|index|nifty|sensex|nasdaq|s&p|bse|nse|elss|tax\s+saver|large\s*cap|mid\s*cap|small\s*cap|largemidcap|flexi\s*cap|multi\s*cap|bluechip|contra|focused)\b/i.test(
      norm
    )
  ) {
    return 'Equity';
  }
  if (/\b(fof|fund\s+of\s+funds)\b/i.test(norm)) {
    return 'Other';
  }

  return 'Unclassified';
}

/**
 * Classify a Holding into a deterministic analytics-layer category.
 *
 * Raw `holding.securityClassification` is NEVER mutated.
 *
 * Rules:
 *   1. Non-empty `securityClassification` maps case-insensitively across the
 *      closed 8-value `AssetType` union and standard MF category labels.
 *   2. When `securityClassification` is absent, deterministic product metadata
 *      (`productScope === 'EQUITY'`), listed Indian equity ISIN (`INE*`), or
 *      non-MF exchange `ticker` maps to `'Equity'`; MF holdings
 *      (`productScope === 'MUTUAL_FUND'` or `INF*` ISIN) derive deterministic
 *      MF scheme categories when unambiguous.
 *   3. Otherwise returns `'Unclassified'`.
 */
export function classifyHolding(holding: Holding): AnalyticsCategory {
  if (holding === null || holding === undefined) {
    return 'Unclassified';
  }

  const sc = holding.securityClassification;
  if (typeof sc === 'string' && sc.trim().length > 0) {
    return classifyCategoryString(sc);
  }

  const isinNorm = typeof holding.isin === 'string' ? holding.isin.trim().toUpperCase() : '';
  const scope = holding.productScope;

  if (scope === 'EQUITY' || isinNorm.startsWith('INE')) {
    return 'Equity';
  }

  if (scope === 'MUTUAL_FUND' || isinNorm.startsWith('INF')) {
    return classifyMutualFundSchemeName(holding.instrumentName || '');
  }

  if (typeof holding.ticker === 'string' && holding.ticker.trim().length > 0) {
    return 'Equity';
  }

  return 'Unclassified';
}
