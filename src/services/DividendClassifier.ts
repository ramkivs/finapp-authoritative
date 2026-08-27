/**
 * FINBOOM-CR-TRANSACTION-CLASSIFICATION — DividendClassifier.
 *
 * Pure, deterministic, post-pipeline classifier that upgrades an imported
 * bank row's `category` from `'GENERAL'` to `'DIVIDEND'` when the row's
 * narration matches a known dividend credit convention.
 *
 * Authority:
 *   - FINBOOM-CR-TRANSACTION-CLASSIFICATION-DISCOVERY-GATE (rule table)
 *   - FINBOOM-CR-TRANSACTION-CLASSIFICATION-AUTHORITY-GATE (25 rules,
 *     including the A4 correction and the TAX_DEDUCT_DIV deferral)
 *   - FINBOOM-CR-TRANSACTION-CLASSIFICATION-TDS-SUBGATE (OPTION (iii):
 *     TDS DIV / TDS-DIV is NOT auto-classified; the user must select
 *     DIVIDEND manually via the per-row override)
 *   - FINBOOM-CR-TRANSACTION-CLASSIFICATION-PREFLIGHT-GATE (placement:
 *     post-pipeline / pre-Review in `ImportPage.runPipeline` and
 *     `ImportPage.handleFileUpload`)
 *   - FINBOOM-CR-TRANSACTION-CLASSIFICATION-IMPLEMENTATION-AUTHORITY-GATE
 *     (all 17 constraints)
 *
 * Scope invariants (per the implementation authority gate):
 *   - Operates ONLY on Transaction[] produced by `ImportPipelineService`.
 *   - Does NOT execute for the broker import path (no Holding[] input,
 *     no commitImportedHoldings call).
 *   - Does NOT modify any protected file (BankTransactionNormalizer,
 *     GenericCsvAdapter, ImportPipelineService, useCanonicalLedger,
 *     domain/types.ts, etc.).
 *   - Does NOT add any field to the Transaction type. Classification
 *     metadata lives outside the committed domain object.
 *   - Does NOT downgrade an existing non-GENERAL category. Generic-CSV
 *     rows with an explicit `category: 'DIVIDEND'` are NOT touched.
 *   - Does NOT mutate the input Transaction. Shallow-copied only on
 *     upgrade.
 *   - Does NOT classify already-committed rows. Forward-only.
 *   - Has no network, persistence, time, or RNG side effects. Pure.
 *   - The TDS-on-dividend pattern (TDS DIV / TDS-DIV) is NOT a positive
 *     rule. Such rows remain `category: 'GENERAL'`; the user can
 *     manually select `DIVIDEND` via the per-row override in
 *     ImportPage.
 *
 * The 25-rule table (5 HIGH positive, 3 MEDIUM positive, 4 ambiguous
 * returning MEDIUM, 13 negative) is implemented verbatim from the
 * authority spec. NO `TAX_DEDUCT_DIV` rule is included.
 */

import { Transaction } from '../domain/types';

/**
 * Confidence level of a classification decision.
 *   HIGH   — auto-classify; the row's `category` becomes 'DIVIDEND'.
 *   MEDIUM — do not auto-classify; the UI surfaces the row with a
 *            confirmation control. The user may promote to DIVIDEND.
 *   NONE   — no rule matched; the row's `category` is unchanged.
 */
export type DividendClassificationConfidence = 'HIGH' | 'MEDIUM' | 'NONE';

/**
 * The outcome of classifying a single Transaction.
 *
 * `candidate` is the (possibly shallow-copied) row. When a HIGH rule
 * matches, `candidate.category` is 'DIVIDEND'. Otherwise `candidate` is
 * the input reference unchanged (or a shallow copy with no semantic
 * difference if the implementation is defensive; the identity is
 * preserved on the no-match path so the user can detect no-ops cheaply).
 *
 * `confidence` is the classification outcome.
 *
 * `ruleId` is the id of the rule that fired (e.g. 'DIV_NL',
 * 'NEG_INTEREST', 'AMBIG_BROKER_CR'), or null if no rule matched.
 *
 * `matchedSubstring` is the substring of `narration` (or `title`) that
 * triggered the rule, for auditability. null if no rule matched.
 */
export interface DividendClassificationResult {
  candidate: Transaction;
  confidence: DividendClassificationConfidence;
  ruleId: string | null;
  matchedSubstring: string | null;
}

/**
 * A bulk summary of a classifyAll() call. Used by the ImportPage
 * Review surface to render an import-level classification summary.
 */
export interface DividendImportSummary {
  classified: number;       // count of rows upgraded to DIVIDEND in this batch
  high: number;             // count of HIGH-confidence classifications
  mediumPending: number;    // count of MEDIUM rows awaiting user confirmation
  medium: number;           // count of MEDIUM rows (== mediumPending; kept for clarity)
  rejected: number;         // count of rows that matched a NEGATIVE rule
  total: number;            // count of rows considered (== input.length)
}

/**
 * The output of a single classifyAll() call.
 *
 *   rows   — the (possibly partially shallow-copied) Transaction[] to
 *            pass forward into the Review surface. Same length as the
 *            input. Rows where a HIGH rule matched have a NEW shallow
 *            copy with `category: 'DIVIDEND'`. Rows where no rule
 *            matched (or only a MEDIUM rule matched) keep the input
 *            reference (identity-preserved). Rows where a NEGATIVE
 *            rule matched also keep the input reference (the row's
 *            `category` stays 'GENERAL').
 *   perRow — one entry per input row, in the same order.
 *   summary — aggregate counts.
 */
export interface DividendClassifyAllResult {
  rows: Transaction[];
  perRow: DividendClassificationResult[];
  summary: DividendImportSummary;
}

// =============================================================================
// Rule table (25 rules; verbatim from the authority spec).
// =============================================================================
//
// Order of evaluation (per the authority spec):
//   1. Guard checks first (no rule evaluation if any guard fails).
//   2. Negative rules in the order listed (first match returns NONE).
//   3. HIGH positive rules in the order listed (first match returns HIGH).
//   4. MEDIUM positive rules in the order listed (first match returns MEDIUM).
//   5. Ambiguous rules in the order listed (first match returns MEDIUM).
//   6. No match returns NONE.
// =============================================================================

type RuleClass = 'POSITIVE_HIGH' | 'POSITIVE_MEDIUM' | 'AMBIG_MEDIUM' | 'NEGATIVE';

interface Rule {
  id: string;
  cls: RuleClass;
  /**
   * The substring pattern to test against the lowercased concatenation
   * of `narration` and `title`. Word-boundary semantics are encoded
   * explicitly via the `\b` regex marker in the pattern itself.
   */
  pattern: RegExp;
}

// Per the authority spec, the rule order within each class is
// MOST-SPECIFIC FIRST, MOST-GENERIC LAST. This ensures that
// phrase-based rules (e.g. 'TDS REFUND', 'FEE REFUND') match
// before generic rules (e.g. plain 'REFUND'), and that specific
// positive rules (e.g. 'DIVIDEND' whole-word) match before
// generic patterns.
const RULES: Rule[] = [
  // ---------------- 13 negative rules (most-specific first) ----------------
  // The negative rules are evaluated in order. The first match
  // short-circuits. Therefore the most-specific phrases
  // (multi-word) must come BEFORE the single-word generic patterns
  // (e.g. plain 'REFUND' should come AFTER 'TDS REFUND', 'TAX REFUND',
  // 'FEE REFUND', etc.).
  { id: 'NEG_TAX', cls: 'NEGATIVE',
    // Phrase match on 'TDS REFUND' / 'TAX REFUND' / etc. Does NOT match
    // 'TDS DIV' (the TDS-on-dividend companion row, per the A10 OPTION
    // (iii) decision). Does NOT match a bare 'TDS'.
    pattern: /\b(?:tds\s*refund|tax\s*refund|it\s*refund|income\s*tax\s*refund)\b/i },
  { id: 'NEG_FEE', cls: 'NEGATIVE',
    // Specific fee-refund phrases. Must come before generic NEG_REFUND.
    pattern: /\b(?:processing\s*fee\s*refund|annual\s*fee\s*refund|charge\s*reversal|fee\s*refund)\b/i },
  { id: 'NEG_TXN_BOUNCE', cls: 'NEGATIVE',
    pattern: /\b(?:cheque\s*bounce|chq\s*bounce|insufficient\s*funds|ecs\s*bounce|si\s*bounce|bounce\s*charges\s*reversal)\b/i },
  { id: 'NEG_INTEREST', cls: 'NEGATIVE',
    pattern: /\b(?:interest|int\.?\s*paid|int\.?\s*credit|sbint|fd\s*interest|rd\s*interest|credit\s*interest)\b/i },
  { id: 'NEG_CORP_ACTION', cls: 'NEGATIVE',
    // Bare 'BONUS' was REMOVED in the authority spec (it would block
    // legitimate 'BONUS' income that the user records via the
    // IncomeModal with the 'BONUS' select). Replaced with the
    // corporate-action-specific phrases 'BONUS SHARES' and 'BONUS ISSUE'.
    pattern: /\b(?:bonus\s*shares|bonus\s*issue|stock\s*split|split\s+\d|demerger|merger|buyback|tender|offer\s*price)\b/i },
  { id: 'NEG_FD_RD', cls: 'NEGATIVE',
    pattern: /\b(?:fd\s*maturity|rd\s*maturity|fd\s*renewal|premature)\b/i },
  { id: 'NEG_LOAN', cls: 'NEGATIVE',
    pattern: /\b(?:loan\s*disbursal|loan\s*credit|personal\s*loan|home\s*loan|loan\s*proceeds)\b/i },
  { id: 'NEG_SALARY', cls: 'NEGATIVE',
    pattern: /\b(?:salary|sal\s*cr|salary\s*credit|payroll|sal\s*pay|monthly\s*salary)\b/i },
  { id: 'NEG_RENT', cls: 'NEGATIVE',
    pattern: /\b(?:rent\s*received|rent\s*cr|tenant)\b/i },
  { id: 'NEG_REIMBURSE', cls: 'NEGATIVE',
    pattern: /\b(?:reimbursement|reimburse)\b/i },
  { id: 'NEG_REFUND', cls: 'NEGATIVE',
    // Plain 'REFUND' / 'REVERSAL' / etc. This is the LAST negative
    // rule so the specific phrase-based rules above (NEG_TAX,
    // NEG_FEE) match first. A standalone 'REFUND' in a bank
    // statement is a non-dividend credit.
    pattern: /\b(?:refund|reversal|reverse|chargeback|cancel)\b/i },
  { id: 'NEG_AMBIG_DIVIDEND', cls: 'NEGATIVE',
    // Inverse word-boundary guard: 'DIVIDEND' appears ONLY as part of
    // a longer word (e.g. 'INDIVIDUAL', 'MANDIVIDEND'). The positive
    // rule DIV_NL uses \b to require the dividend case.
    pattern: /[a-z]dividend|[a-z]dividend[a-z]/i },
  { id: 'NEG_HOSTILE', cls: 'NEGATIVE',
    // Defence-in-depth against formula-injection rows. The
    // ImportPipelineService.sanitizeCell already strips the leading
    // '=' from such rows, but the classifier guards against residual
    // risk.
    pattern: /\b(?:HYPERLINK\s*\(|IMPORTXML\s*\(|cmd\s*\||<script|javascript:)/i },

  // ---------------- 5 HIGH positive rules (most-specific first) ----------------
  // The 'TAX_DEDUCT_DIV' rule is INTENTIONALLY OMITTED per the
  // FINBOOM-CR-TRANSACTION-CLASSIFICATION-TDS-SUBGATE decision
  // (OPTION (iii) — TDS DIV is NOT auto-classified).
  { id: 'DIV_CREDIT', cls: 'POSITIVE_HIGH',
    // 'DIV CREDIT' / 'DIVIDEND CREDIT' / 'DIVIDEND PAYOUT'. Most
    // specific; first.
    pattern: /\b(?:div\s*credit|dividend\s*credit|dividend\s*payout)\b/i },
  { id: 'INT_DIV', cls: 'POSITIVE_HIGH',
    // 'INTDIV', 'INT DIV', 'INTERIM DIV', 'FINAL DIV'. Word-boundary
    // protected; 'INT' alone is NOT matched.
    pattern: /\b(?:intdiv|int\s*div|interim\s*div|final\s*div)\b/i },
  { id: 'DIV_TOKEN_SHORT', cls: 'POSITIVE_HIGH',
    // 'DIV/' as a token (e.g. 'NEFT-DIV/...'). The trailing slash
    // disambiguates from 'INDIVIDUAL' etc.
    pattern: /div\//i },
  { id: 'DIV_TOK_VARIANT', cls: 'POSITIVE_HIGH',
    // Plural form 'DIVS' as a whole word (British plural).
    pattern: /\bdivs\b/i },
  { id: 'DIV_NL', cls: 'POSITIVE_HIGH',
    // Whole-word match for 'DIVIDEND'. Word-boundary protected.
    // This is the MOST GENERAL positive HIGH rule and fires LAST
    // among the positive HIGH rules (e.g. 'ECS/C/COAL INDIA INT
    // DIVIDEND' matches INT_DIV first because the narration
    // contains the more specific 'INT DIV' phrase as well, but if
    // no other rule matches, DIV_NL catches the standalone
    // 'DIVIDEND' word).
    pattern: /\bdividend\b/i },

  // ---------------- 3 MEDIUM positive rules (most-specific first) ----------------
  { id: 'ECS_DIV_PATTERN', cls: 'POSITIVE_MEDIUM',
    // Narration starts with 'ECS/C/' or 'ECS/' AND contains 'DIV'.
    // The 'DIV' must NOT be inside a longer word (word boundary).
    pattern: /^ecs(?:\/c)?\/.*\bdiv\b/i },
  { id: 'NEFT_DIV_PATTERN', cls: 'POSITIVE_MEDIUM',
    // Narration starts with 'NEFT' and contains 'DIV' at a word boundary.
    pattern: /^neft[\s\-/].*\bdiv\b/i },
  { id: 'ACH_DIV_PATTERN', cls: 'POSITIVE_MEDIUM',
    // Narration starts with 'ACH/C/' or 'ACH/' and contains 'DIV' at a
    // word boundary.
    pattern: /^ach\/c?\/.*\bdiv\b/i },

  // ---------------- 4 ambiguous (return MEDIUM) (most-specific first) ----------------
  { id: 'AMBIG_FOREIGN', cls: 'AMBIG_MEDIUM',
    // Foreign / ADR dividend credits. Also covers 'WITHHOLDING' (the
    // Indian equivalent of US 1042-S withholding on dividends).
    pattern: /\b(?:fgn\s*div|foreign\s*div|adr\s*div|w-?8|withholding)\b/i },
  { id: 'AMBIG_MF', cls: 'AMBIG_MEDIUM',
    // Mutual fund dividend payout. 'MF DIV' or 'MUTUAL FUND' near 'DIV'.
    pattern: /\b(?:mf\s*div|mutual\s*fund[^\n]{0,20}\bdiv)\b/i },
  { id: 'AMBIG_BROKER_CR', cls: 'AMBIG_MEDIUM',
    // Broker name + (PAYOUT or DIV). The combined condition avoids
    // misclassifying generic broker transactions.
    pattern: /\b(?:zerodha|groww|dhan|angel\s*one)\b[^\n]{0,30}\b(?:payout|div)\b/i },
  { id: 'AMBIG_BARE_DIV', cls: 'AMBIG_MEDIUM',
    // 'DIV' as exactly 3 letters NOT inside a longer word. The MOST
    // GENERIC ambiguous rule; fires LAST among ambiguous rules.
    // Real example: 'DIV 50.00' (very rare in bank statements).
    pattern: /(?<![a-z])div(?![a-z])/i },
];

// =============================================================================
// Guard checks
// =============================================================================
//
// Per the authority spec, a row is a candidate for classification only if
// it satisfies ALL of the following:
//   - type === 'Income'
//   - direction === 'CREDIT'
//   - amount > 0 (and finite)
//   - status === 'CLEARED'
//   - category === 'GENERAL'
//   - origin === 'IMPORT'
//
// Any row that fails a guard is returned as-is with confidence NONE.

function isClassificationCandidate(tx: Transaction): boolean {
  if (tx.type !== 'Income') return false;
  if (tx.direction !== 'CREDIT') return false;
  if (!Number.isFinite(tx.amount)) return false;
  if (tx.amount <= 0) return false;
  if (tx.status !== 'CLEARED') return false;
  if (tx.category !== 'GENERAL') return false;
  if (tx.origin !== 'IMPORT') return false;
  return true;
}

/**
 * Lowercased concatenation of `narration` and `title`, separated by a
 * space. The classifier matches against this single haystack. For
 * bank-imported rows, `title` and `narration` are identical (the
 * normalizer sets `title = sanitizedNarration`), so this is a
 * defensive join.
 */
function haystack(tx: Transaction): string {
  const nar = (tx.narration || '').toString();
  const tit = (tx.title || '').toString();
  return (nar + ' ' + tit).trim().toLowerCase();
}

// =============================================================================
// DividendClassifier — the public API
// =============================================================================

export class DividendClassifier {
  /**
   * Classify a single Transaction.
   *
   * Pure function. Returns a DividendClassificationResult.
   * Never mutates the input Transaction. When a HIGH rule matches, the
   * returned `candidate` is a shallow-copied Transaction with
   * `category: 'DIVIDEND'`. Otherwise the returned `candidate` is the
   * input reference unchanged.
   */
  static classify(input: Transaction): DividendClassificationResult {
    // Guard: non-candidate rows are returned unchanged.
    if (!isClassificationCandidate(input)) {
      return {
        candidate: input,
        confidence: 'NONE',
        ruleId: null,
        matchedSubstring: null,
      };
    }

    const hay = haystack(input);

    // Step 2: Negative rules (evaluated first; any match short-circuits).
    for (const rule of RULES) {
      if (rule.cls !== 'NEGATIVE') continue;
      const m = rule.pattern.exec(hay);
      if (m) {
        return {
          candidate: input,
          confidence: 'NONE',
          ruleId: rule.id,
          matchedSubstring: m[0],
        };
      }
    }

    // Step 3: HIGH positive rules.
    for (const rule of RULES) {
      if (rule.cls !== 'POSITIVE_HIGH') continue;
      const m = rule.pattern.exec(hay);
      if (m) {
        // Upgrade: shallow copy with `category: 'DIVIDEND'`.
        const upgraded: Transaction = { ...input, category: 'DIVIDEND' };
        return {
          candidate: upgraded,
          confidence: 'HIGH',
          ruleId: rule.id,
          matchedSubstring: m[0],
        };
      }
    }

    // Step 4: MEDIUM positive rules.
    for (const rule of RULES) {
      if (rule.cls !== 'POSITIVE_MEDIUM') continue;
      const m = rule.pattern.exec(hay);
      if (m) {
        return {
          candidate: input,
          confidence: 'MEDIUM',
          ruleId: rule.id,
          matchedSubstring: m[0],
        };
      }
    }

    // Step 5: Ambiguous (return MEDIUM).
    for (const rule of RULES) {
      if (rule.cls !== 'AMBIG_MEDIUM') continue;
      const m = rule.pattern.exec(hay);
      if (m) {
        return {
          candidate: input,
          confidence: 'MEDIUM',
          ruleId: rule.id,
          matchedSubstring: m[0],
        };
      }
    }

    // Step 6: No match.
    return {
      candidate: input,
      confidence: 'NONE',
      ruleId: null,
      matchedSubstring: null,
    };
  }

  /**
   * Classify an array of Transactions.
   *
   * Returns a DividendClassifyAllResult with the (possibly partially
   * shallow-copied) rows, one per-row result, and a summary.
   *
   * The returned `rows` array has the same length and order as the
   * input. Rows where a HIGH rule matched are NEW shallow copies with
   * `category: 'DIVIDEND'`. Rows where no rule matched (or only a
   * MEDIUM rule matched, or a NEGATIVE rule matched) are the input
   * reference unchanged.
   *
   * Identity is preserved on the no-match path so callers can detect
   * no-ops cheaply.
   */
  static classifyAll(inputs: Transaction[]): DividendClassifyAllResult {
    const perRow: DividendClassificationResult[] = new Array(inputs.length);
    const rows: Transaction[] = new Array(inputs.length);

    let classified = 0;
    let high = 0;
    let mediumPending = 0;
    let rejected = 0;

    for (let i = 0; i < inputs.length; i++) {
      const r = DividendClassifier.classify(inputs[i]);
      perRow[i] = r;
      rows[i] = r.candidate;
      if (r.confidence === 'HIGH') {
        classified++;
        high++;
      } else if (r.confidence === 'MEDIUM') {
        mediumPending++;
      } else if (r.ruleId !== null && r.confidence === 'NONE') {
        // NEGATIVE rule fired.
        rejected++;
      }
    }

    return {
      rows,
      perRow,
      summary: {
        classified,
        high,
        mediumPending,
        medium: mediumPending,
        rejected,
        total: inputs.length,
      },
    };
  }

  /**
   * The total rule count (for tests / introspection). 25 rules:
   * 5 HIGH positive + 3 MEDIUM positive + 4 ambiguous + 13 negative.
   * (The authority spec's 26 was reduced to 25 when TAX_DEDUCT_DIV
   * was DEFERRED per the TDS sub-gate.)
   */
  static readonly RULE_COUNT = RULES.length;
}
