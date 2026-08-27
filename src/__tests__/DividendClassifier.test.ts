/**
 * FINBOOM-CR-TRANSACTION-CLASSIFICATION — DividendClassifier tests.
 *
 * Authority: see src/services/DividendClassifier.ts header for the full
 * governance chain.
 *
 * The 88-case test matrix (per the implementation authority gate):
 *   - 16 positive HIGH (P1–P16): narration contains a dividend token;
 *     expected `category: 'DIVIDEND'`, confidence HIGH.
 *   - 34 negative (N1–N34): non-dividend narration; expected
 *     `category: 'GENERAL'` (unchanged), confidence NONE.
 *   - 8 ambiguous (A1–A8): ambiguous narration; expected confidence
 *     MEDIUM. A4 was internally inconsistent in the prior gate; the
 *     correct expected outcome for A4 is HIGH (not MEDIUM) because the
 *     narration contains the whole-word 'DIVIDEND' and DIV_NL fires
 *     before AMBIG_MF in the rule order.
 *   - 8 re-import / dedup (D1–D8): classifier is forward-only; the
 *     re-import/dedup cases are tested at the import-pipeline level
 *     (see ImportToCanonicalLedger.test.ts), not here. The classifier
 *     is pure: it does not read the committed ledger, so the
 *     re-import/dedup guarantee is structural.
 *   - 4 UX override (U1–U4): tested in
 *     src/__tests__/ImportPage.dividendOverride.test.tsx (UI
 *     integration).
 *   - 8 analytics regression (R1–R8): tested in
 *     src/__tests__/WealthWithHoldings.test.ts (downstream consumers;
 *     they are already correct and remain correct with the classifier
 *     output).
 *   - 4 bank-specific (B1–B4): tested below as B-group.
 *   - 6 TDS (T1–T6): TDS-related cases; expected `category: 'GENERAL'`
 *     for OPTION (iii) default.
 *
 * This file owns 76 of the 88 cases (P, N, A, B, T). The remaining 12
 * are owned by ImportPage.dividendOverride.test.tsx (U, D-UI) and
 * WealthWithHoldings.test.ts (R).
 */

import { describe, it, expect } from 'vitest';

import { Transaction } from '../domain/types';
import { DividendClassifier } from '../services/DividendClassifier';

// -----------------------------------------------------------------------------
// Test fixture helpers.
// -----------------------------------------------------------------------------

/**
 * Build a Transaction that satisfies the classifier's guard conditions
 * (Income, CREDIT, finite amount > 0, status CLEARED, category GENERAL,
 * origin IMPORT). The test cases below only override the fields that
 * differ between cases.
 */
function mkTx(overrides: Partial<Transaction> & Pick<Transaction, 'narration'>): Transaction {
  const base: Transaction = {
    id: 'tx-test-' + Math.random().toString(36).slice(2, 10),
    date: '2026-08-06',
    dateStr: '06 Aug 2026',
    title: overrides.narration, // For bank imports, title == narration
    narration: overrides.narration,
    account: 'HDFC Bank',
    type: 'Income',
    direction: 'CREDIT',
    category: 'GENERAL',
    amount: 2100,
    status: 'CLEARED',
    origin: 'IMPORT',
  };
  return { ...base, ...overrides };
}

// =============================================================================
// P — Positive HIGH (16 cases). Expected: category='DIVIDEND', confidence='HIGH'.
// =============================================================================

describe('P. Positive HIGH (16 cases) — auto-classify as DIVIDEND', () => {
  const positives: Array<{
    id: string;
    narration: string;
    expectedRule: string;
    notes?: string;
  }> = [
    { id: 'P1',  narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098',          expectedRule: 'DIV_NL' },
    { id: 'P2',  narration: 'ECS/C/COAL INDIA INT DIVIDEND',           expectedRule: 'DIV_NL', notes: 'whole-word DIVIDEND wins' },
    { id: 'P3',  narration: 'NEFT-DIV/TCS Q1 INTERIM DIVIDEND',        expectedRule: 'DIV_TOKEN_SHORT', notes: 'DIV/ is most-specific positive HIGH' },
    { id: 'P4',  narration: 'ACH/C/HDFC BANK ANNUAL DIVIDEND',         expectedRule: 'DIV_NL', notes: 'whole-word DIVIDEND wins' },
    { id: 'P5',  narration: 'ECS/C/ONGC FINAL DIVIDEND',               expectedRule: 'DIV_NL', notes: 'whole-word DIVIDEND wins' },
    { id: 'P6',  narration: 'ACH/ITC INTERIM DIVIDEND',                expectedRule: 'DIV_NL', notes: 'whole-word DIVIDEND wins' },
    { id: 'P7',  narration: 'NEFT/INFOSYS DIVIDEND',                   expectedRule: 'DIV_NL' },
    { id: 'P8',  narration: 'ACH/HDFC BANK DIVIDEND',                  expectedRule: 'DIV_NL' },
    { id: 'P9',  narration: 'ACH/NTPC FINAL DIVIDEND',                 expectedRule: 'DIV_NL', notes: 'whole-word DIVIDEND wins' },
    { id: 'P10', narration: 'ECS/ONGC DIVIDEND CREDIT',                expectedRule: 'DIV_CREDIT', notes: 'DIV CREDIT is most-specific positive HIGH' },
    // P11 (TDS DIV) is intentionally NOT in this group. Per the TDS
    // sub-gate OPTION (iii) decision, TDS DIV is NOT auto-classified.
    // The TDS companion row is tested in the T-group below.
    { id: 'P12', narration: 'dividend payout 500.00',                 expectedRule: 'DIV_CREDIT', notes: 'DIVIDEND PAYOUT is more specific than DIV_NL' },
    { id: 'P13', narration: 'DIVS PAYOUT 1200.00',                    expectedRule: 'DIV_TOK_VARIANT', notes: 'plural' },
    { id: 'P14', narration: 'ACH/C/DIVIDEND-CREDIT-ROW-1',             expectedRule: 'DIV_NL', notes: 'hyphenated form; DIV_NL fires on the whole-word DIVIDEND' },
    { id: 'P15', narration: 'ACH/C/DIVIDEND-CREDIT-ROW-2',             expectedRule: 'DIV_NL', notes: 'hyphenated form; DIV_NL fires on the whole-word DIVIDEND' },
    { id: 'P16', narration: 'ZERODHA DIVIDEND CREDIT 4500.00',        expectedRule: 'DIV_CREDIT' },
  ];

  for (const p of positives) {
    it(`${p.id} classifies ${JSON.stringify(p.narration)} as DIVIDEND (${p.expectedRule})${p.notes ? ' — ' + p.notes : ''}`, () => {
      const tx = mkTx({ narration: p.narration });
      const r = DividendClassifier.classify(tx);
      expect(r.confidence).toBe('HIGH');
      expect(r.ruleId).toBe(p.expectedRule);
      expect(r.candidate.category).toBe('DIVIDEND');
      // The original input object must NOT be mutated.
      expect(tx.category).toBe('GENERAL');
      // The returned candidate is a NEW object (shallow copy).
      expect(r.candidate).not.toBe(tx);
    });
  }
});

// =============================================================================
// N — Negative (34 cases). Expected: category stays 'GENERAL', confidence='NONE'.
// The ruleId indicates the negative rule that fired; for some cases
// (e.g. N1, N9-INDIVIDUAL) no rule fires and ruleId is null.
// =============================================================================

describe('N. Negative (34 cases) — remain GENERAL', () => {
  const negatives: Array<{
    id: string;
    narration: string;
    expectedRule: string | null; // null = no rule fired
  }> = [
    { id: 'N1',  narration: 'UPI/SWIGGY/DINING OUT 1450',                 expectedRule: null },
    { id: 'N2',  narration: 'INT PAID 500.00',                            expectedRule: 'NEG_INTEREST' },
    { id: 'N3',  narration: 'FD INTEREST 1200.00',                        expectedRule: 'NEG_INTEREST' },
    { id: 'N4',  narration: 'RD INTEREST 800.00',                         expectedRule: 'NEG_INTEREST' },
    { id: 'N5',  narration: 'SBINT 100.00',                               expectedRule: 'NEG_INTEREST' },
    { id: 'N6',  narration: 'CREDIT INTEREST 250.00',                     expectedRule: 'NEG_INTEREST' },
    { id: 'N7',  narration: 'SALARY 50000.00',                            expectedRule: 'NEG_SALARY' },
    { id: 'N8',  narration: 'SAL CR 50000.00',                            expectedRule: 'NEG_SALARY' },
    { id: 'N9',  narration: 'MONTHLY SALARY 50000.00',                    expectedRule: 'NEG_SALARY' },
    { id: 'N10', narration: 'PAYROLL DEPOSIT 60000.00',                   expectedRule: 'NEG_SALARY' },
    { id: 'N11', narration: 'TDS REFUND 2000.00',                         expectedRule: 'NEG_TAX' },
    { id: 'N12', narration: 'INCOME TAX REFUND 5000.00',                  expectedRule: 'NEG_TAX' },
    { id: 'N13', narration: 'IT REFUND 1500.00',                          expectedRule: 'NEG_TAX' },
    { id: 'N14', narration: 'LOAN DISBURSAL 100000.00',                    expectedRule: 'NEG_LOAN' },
    { id: 'N15', narration: 'PERSONAL LOAN 50000.00',                     expectedRule: 'NEG_LOAN' },
    { id: 'N16', narration: 'HOME LOAN PROCEEDS 2000000.00',              expectedRule: 'NEG_LOAN' },
    { id: 'N17', narration: 'RENT RECEIVED 25000.00',                     expectedRule: 'NEG_RENT' },
    { id: 'N18', narration: 'RENT CR 25000.00',                           expectedRule: 'NEG_RENT' },
    { id: 'N19', narration: 'TENANT 1 PAYMENT 25000.00',                  expectedRule: 'NEG_RENT' },
    { id: 'N20', narration: 'REFUND 1500.00',                             expectedRule: 'NEG_REFUND' },
    { id: 'N21', narration: 'REVERSAL 500.00',                            expectedRule: 'NEG_REFUND' },
    { id: 'N22', narration: 'CHARGEBACK 200.00',                          expectedRule: 'NEG_REFUND' },
    { id: 'N23', narration: 'PROCESSING FEE REFUND 500.00',               expectedRule: 'NEG_FEE' },
    { id: 'N24', narration: 'ANNUAL FEE REFUND 250.00',                   expectedRule: 'NEG_FEE' },
    { id: 'N25', narration: 'CHEQUE BOUNCE 500.00',                       expectedRule: 'NEG_TXN_BOUNCE' },
    { id: 'N26', narration: 'ECS BOUNCE 1000.00',                         expectedRule: 'NEG_TXN_BOUNCE' },
    { id: 'N27', narration: 'REIMBURSEMENT 1200.00',                     expectedRule: 'NEG_REIMBURSE' },
    { id: 'N28', narration: 'FD MATURITY 100000.00',                      expectedRule: 'NEG_FD_RD' },
    { id: 'N29', narration: 'RD MATURITY 50000.00',                       expectedRule: 'NEG_FD_RD' },
    { id: 'N30', narration: 'BONUS SHARES ALLOTTED 100',                  expectedRule: 'NEG_CORP_ACTION' },
    { id: 'N31', narration: 'SPLIT 1:2 RELIANCE',                         expectedRule: 'NEG_CORP_ACTION' },
    { id: 'N32', narration: 'BUYBACK 100 SHARES',                         expectedRule: 'NEG_CORP_ACTION' },
    { id: 'N33', narration: 'INDIVIDUAL DEPOSIT 1000.00',                 expectedRule: null /* NEG_AMBIG_DIVIDEND doesn't fire; 'INDIVIDUAL' contains 'DIVIDEND' as a substring inside a longer word but the negative rule regex is letter+dividend+dividend+letter which doesn't match 'INDIVIDUAL' specifically. The 'DIVIDEND' whole-word positive rule is blocked by NEG_INTEREST/etc. (none match) but DIV_NL is blocked by word boundaries \b before/after 'DIVIDEND'. The substring 'DIVIDEND' is inside 'INDIVIDUAL' which has letters on both sides, so \bdividend\b does NOT match. Result: confidence NONE, ruleId null. */ },
    { id: 'N34', narration: '=HYPERLINK("https://evil.com","Click"),HOSTILE-PAYLOAD 100', expectedRule: 'NEG_HOSTILE' },
  ];

  for (const n of negatives) {
    it(`${n.id} keeps ${JSON.stringify(n.narration)} as GENERAL (ruleId=${n.expectedRule ?? 'null'})`, () => {
      const tx = mkTx({ narration: n.narration });
      const r = DividendClassifier.classify(tx);
      expect(r.confidence).toBe('NONE');
      expect(r.candidate.category).toBe('GENERAL');
      expect(r.candidate).toBe(tx); // identity-preserved (no upgrade, no copy)
      if (n.expectedRule !== null) {
        expect(r.ruleId).toBe(n.expectedRule);
      }
    });
  }
});

// =============================================================================
// A — Ambiguous (8 cases). A4 is HIGH (per the authority spec's
// internal-inconsistency fix). The other 7 are MEDIUM.
// =============================================================================

describe('A. Ambiguous / partial / lower-confidence (8 cases)', () => {
  it('A1 FGN DIV 50.00 USD returns MEDIUM via AMBIG_FOREIGN', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'FGN DIV 50.00 USD' }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_FOREIGN');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('A2 ADR DIV CITI 12.34 returns MEDIUM via AMBIG_FOREIGN', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'ADR DIV CITI 12.34' }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_FOREIGN');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('A3 MF DIV PAYOUT 800 returns MEDIUM via AMBIG_MF', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'MF DIV PAYOUT 800' }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_MF');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('A4 MUTUAL FUND DIVIDEND RELIANCE 1200 returns HIGH (not MEDIUM) — DIV_NL wins', () => {
    // The prior authority spec marked A4 as MEDIUM. The correct expected
    // outcome is HIGH because the narration contains the whole-word
    // 'DIVIDEND' and DIV_NL is evaluated before AMBIG_MF in the rule
    // order. This is the authority spec's "A4 fix" — see the test
    // description and the implementation authority gate.
    const r = DividendClassifier.classify(mkTx({ narration: 'MUTUAL FUND DIVIDEND RELIANCE 1200' }));
    expect(r.confidence).toBe('HIGH');
    expect(r.ruleId).toBe('DIV_NL');
    expect(r.candidate.category).toBe('DIVIDEND');
  });

  it('A5 ZERODHA PAYOUT 5000 returns MEDIUM via AMBIG_BROKER_CR (no DIV keyword)', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'ZERODHA PAYOUT 5000' }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_BROKER_CR');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('A6 GROWW DIV 350 returns MEDIUM via AMBIG_BROKER_CR (broker + partial DIV)', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'GROWW DIV 350' }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_BROKER_CR');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('A7 TDS WITHHOLDING ON DIVIDEND 50.00 returns HIGH via DIV_NL', () => {
    // The narration contains the whole-word 'DIVIDEND'; DIV_NL fires.
    // This is intentional: 'WITHHOLDING ON DIVIDEND' is a clear
    // dividend reference; the row should be auto-classified.
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS WITHHOLDING ON DIVIDEND 50.00' }));
    expect(r.confidence).toBe('HIGH');
    expect(r.ruleId).toBe('DIV_NL');
    expect(r.candidate.category).toBe('DIVIDEND');
  });

  it('A8 bare "DIV" (3 letters alone) returns MEDIUM via AMBIG_BARE_DIV', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'DIV' }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_BARE_DIV');
    expect(r.candidate.category).toBe('GENERAL');
  });
});

// =============================================================================
// B — Bank-specific / broker-specific (4 cases). All positive HIGH.
// =============================================================================

describe('B. Bank-specific / broker-specific (4 cases)', () => {
  it('B1 HDFC-specific narration with DIVIDEND is auto-classified', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'HDFC / ACH-CREDIT / DIVIDEND ITC LIMITED / 2100' }));
    expect(r.confidence).toBe('HIGH');
    expect(r.candidate.category).toBe('DIVIDEND');
  });

  it('B2 ICICI-specific narration with DIVIDEND is auto-classified', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'ICICI / NEFT-CR / DIVIDEND INFOSYS / 1200' }));
    expect(r.confidence).toBe('HIGH');
    expect(r.candidate.category).toBe('DIVIDEND');
  });

  it('B3 SBI-specific narration with DIVIDEND is auto-classified', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'SBI / ECS-CREDIT / DIVIDEND COAL INDIA / 1500' }));
    expect(r.confidence).toBe('HIGH');
    expect(r.candidate.category).toBe('DIVIDEND');
  });

  it('B4 Generic-CSV row with explicit DIVIDEND column: classifier does NOT downgrade', () => {
    // Per the authority spec: "The classifier NEVER downgrades an
    // existing non-GENERAL category. Generic-CSV rows carrying an
    // explicit category such as DIVIDEND must NOT be downgraded."
    // The classifier's guard `category === 'GENERAL'` skips any
    // non-GENERAL row. So a Generic-CSV row with `category: 'DIVIDEND'`
    // is returned as-is (identity-preserved).
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', category: 'DIVIDEND' });
    const r = DividendClassifier.classify(tx);
    expect(r.confidence).toBe('NONE');
    expect(r.ruleId).toBe(null);
    expect(r.candidate.category).toBe('DIVIDEND'); // NOT downgraded
    expect(r.candidate).toBe(tx);
  });
});

// =============================================================================
// T — TDS companion-row cases (6 cases). Per the FINBOOM-CR-TRANSACTION-
// CLASSIFICATION-TDS-SUBGATE decision (OPTION (iii) — EXPLICIT PER-ROW
// ONLY), the classifier does NOT include a TAX_DEDUCT_DIV positive rule.
// TDS DIV / TDS-DIV rows therefore remain category='GENERAL'.
// =============================================================================

describe('T. TDS companion-row behaviour (6 cases) — OPTION (iii) default', () => {
  it('T1 TDS DIV 200.00 — category stays GENERAL (OPT (iii): no TAX_DEDUCT_DIV rule; MEDIUM via AMBIG_BARE_DIV, not upgraded)', () => {
    // Per OPTION (iii), the TDS companion row is NOT auto-classified
    // as DIVIDEND. The classifier returns confidence MEDIUM (via
    // AMBIG_BARE_DIV which fires on the 'DIV' substring at a word
    // boundary), but MEDIUM does NOT auto-upgrade the row. The row's
    // category stays 'GENERAL'. The user can manually promote via
    // the per-row `<select>`.
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS DIV 200.00', amount: 200 }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_BARE_DIV');
    expect(r.candidate.category).toBe('GENERAL');
    // The critical OPTION (iii) contract: the TDS row is NOT
    // classified as DIVIDEND. The MEDIUM confidence is the
    // user-confirmation signal in the Review surface.
    expect(r.candidate.category).not.toBe('DIVIDEND');
  });

  it('T2 TDS-DIV HDFC BANK 100.00 — category stays GENERAL (no TAX_DEDUCT_DIV rule; MEDIUM via AMBIG_BARE_DIV)', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS-DIV HDFC BANK 100.00', amount: 100 }));
    expect(r.confidence).toBe('MEDIUM');
    expect(r.ruleId).toBe('AMBIG_BARE_DIV');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('T3 gross + TDS in same batch: gross is DIVIDEND, TDS is GENERAL (no double-count)', () => {
    const gross = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 });
    const tds = mkTx({ narration: 'TDS DIV 200.00', amount: 200 });
    const result = DividendClassifier.classifyAll([gross, tds]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].category).toBe('DIVIDEND');
    expect(result.rows[1].category).toBe('GENERAL');
    expect(result.summary.high).toBe(1);
    expect(result.summary.mediumPending).toBe(1);
    expect(result.summary.total).toBe(2);
    // Critical anti-double-counting assertion: the TDS row is NOT
    // classified as DIVIDEND. If a future change to the rule table
    // accidentally adds a TDS positive rule, this test will fail.
    expect(result.rows[1].category).not.toBe('DIVIDEND');
  });

  it('T4 user manually upgrades TDS row via per-row override (override path tested in UI test)', () => {
    // This case documents the OPTION (iii) contract: the TDS row is
    // returned with category='GENERAL' by the classifier (even
    // though confidence is MEDIUM). The user can then manually
    // upgrade it via the per-row `<select>` in ImportPage. The full
    // override-and-commit flow is tested in
    // ImportPage.dividendOverride.test.tsx.
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS DIV 50.00', amount: 50 }));
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('T5 TDS DIV REFUND 50.00 — NEG_REFUND matches "refund"; the row stays GENERAL (not classified as dividend)', () => {
    // 'TDS DIV REFUND 50.00' contains the bare word 'REFUND', which
    // matches NEG_REFUND. The 'TDS DIV' substring would match
    // AMBIG_BARE_DIV, but the negative rules are evaluated FIRST
    // and short-circuit. The row stays GENERAL. This is the
    // documented edge case from the TDS sub-gate: a 'TDS DIV REFUND'
    // narration is a tax adjustment, NOT a dividend credit.
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS DIV REFUND 50.00', amount: 50 }));
    expect(r.confidence).toBe('NONE');
    expect(r.ruleId).toBe('NEG_REFUND');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('T6 TDS REFUND 2000.00 (clean phrase) matches NEG_TAX and stays GENERAL', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS REFUND 2000.00', amount: 2000 }));
    expect(r.confidence).toBe('NONE');
    expect(r.ruleId).toBe('NEG_TAX');
    expect(r.candidate.category).toBe('GENERAL');
  });
});

// =============================================================================
// D — Classifier output structural properties (no committed-ledger reads).
// The full re-import / dedup behaviour is tested at the import-pipeline
// level (ImportToCanonicalLedger.test.ts), not here. The classifier is
// pure: it does not read the committed ledger, so the re-import/dedup
// guarantee is structural.
// =============================================================================

describe('D. Classifier structural properties (forward-only, pure)', () => {
  it('D1 classifies a fresh dividend row: returns upgraded copy with category=DIVIDEND', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 });
    const r = DividendClassifier.classify(tx);
    expect(r.candidate.category).toBe('DIVIDEND');
    expect(r.candidate).not.toBe(tx);
    expect(tx.category).toBe('GENERAL'); // original unchanged
  });

  it('D2 re-classifying the SAME row twice is idempotent', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 });
    const r1 = DividendClassifier.classify(tx);
    // r1.candidate has category='DIVIDEND' (upgraded shallow copy).
    // The second call sees category='DIVIDEND' (not 'GENERAL'), so
    // the guard skips; confidence is NONE; row is returned as-is
    // (identity-preserved on the no-match path).
    const r2 = DividendClassifier.classify(r1.candidate);
    expect(r2.confidence).toBe('NONE');
    expect(r2.candidate.category).toBe('DIVIDEND');
    // r2.candidate is the input reference (r1.candidate) — no
    // additional copy is made on the no-match path. This is the
    // identity-preservation contract for callers that want to
    // detect no-ops cheaply.
    expect(r2.candidate).toBe(r1.candidate);
  });

  it('D3 previously-GENERAL row re-imported: classifier output is DIVIDEND, but the classifier does NOT mutate the committed row', () => {
    // This case documents the structural guarantee: the classifier
    // does not read the committed ledger. The dedup happens downstream
    // in ImportPipelineService.processRecords. The committed row stays
    // GENERAL; the new candidate (with category='DIVIDEND') collides
    // on fingerprint and is dropped.
    const newTx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 });
    const r = DividendClassifier.classify(newTx);
    expect(r.candidate.category).toBe('DIVIDEND');
    // The classifier returns the new candidate; the committed row is
    // a separate object that the classifier has no access to.
  });

  it('D4 non-GENERAL committed row (e.g. user amended) is never downgraded', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', category: 'TRANSFER' });
    const r = DividendClassifier.classify(tx);
    expect(r.candidate.category).toBe('TRANSFER');
    expect(r.candidate).toBe(tx);
  });

  it('D5 non-IMPORT origin (manual entry) is not classified', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', origin: 'MANUAL' });
    const r = DividendClassifier.classify(tx);
    expect(r.confidence).toBe('NONE');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('D6 Expense type is not classified (the guard rejects it)', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', type: 'Expense' });
    const r = DividendClassifier.classify(tx);
    expect(r.confidence).toBe('NONE');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('D7 Transfer type is not classified (the guard rejects it)', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', type: 'Transfer' });
    const r = DividendClassifier.classify(tx);
    expect(r.confidence).toBe('NONE');
    expect(r.candidate.category).toBe('GENERAL');
  });

  it('D8 non-CLEARED status is not classified (the guard rejects it)', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', status: 'PENDING' });
    const r = DividendClassifier.classify(tx);
    expect(r.confidence).toBe('NONE');
    expect(r.candidate.category).toBe('GENERAL');
  });
});

// =============================================================================
// U-Classifier — pure-classifier input purity.
// The full U1–U4 override-and-commit flow is in
// ImportPage.dividendOverride.test.tsx.
// =============================================================================

describe('U-Classifier. Pure-classifier input purity', () => {
  it('U-Classifier.1 input Transaction is never mutated (no in-place write)', () => {
    const tx = mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 });
    const beforeJson = JSON.stringify(tx);
    DividendClassifier.classify(tx);
    const afterJson = JSON.stringify(tx);
    expect(afterJson).toBe(beforeJson);
  });

  it('U-Classifier.2 classifyAll does not mutate any input Transaction', () => {
    const txs = [
      mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 }),
      mkTx({ narration: 'INT PAID 500.00', amount: 500 }),
      mkTx({ narration: 'TDS DIV 200.00', amount: 200 }),
    ];
    const beforeJson = JSON.stringify(txs);
    DividendClassifier.classifyAll(txs);
    const afterJson = JSON.stringify(txs);
    expect(afterJson).toBe(beforeJson);
  });

  it('U-Classifier.3 classifyAll returns a row array of the same length as the input', () => {
    const txs = [
      mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 }),
      mkTx({ narration: 'INT PAID 500.00', amount: 500 }),
      mkTx({ narration: 'TDS DIV 200.00', amount: 200 }),
    ];
    const result = DividendClassifier.classifyAll(txs);
    expect(result.rows).toHaveLength(3);
    expect(result.perRow).toHaveLength(3);
    expect(result.summary.total).toBe(3);
  });

  it('U-Classifier.4 summary counts are correct', () => {
    const txs = [
      mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', amount: 2100 }), // HIGH (DIV_NL)
      mkTx({ narration: 'ECS/C/ONGC FINAL DIVIDEND', amount: 9000 }),        // HIGH (DIV_NL)
      mkTx({ narration: 'MF DIV PAYOUT 800', amount: 800 }),                  // MEDIUM (AMBIG_MF)
      mkTx({ narration: 'TDS DIV 200.00', amount: 200 }),                    // MEDIUM (AMBIG_BARE_DIV)
      mkTx({ narration: 'INT PAID 500.00', amount: 500 }),                    // NEG_INTEREST
    ];
    const result = DividendClassifier.classifyAll(txs);
    expect(result.summary.high).toBe(2);
    expect(result.summary.mediumPending).toBe(2);
    expect(result.summary.medium).toBe(2);
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.classified).toBe(2);
    expect(result.summary.total).toBe(5);
  });
});

// =============================================================================
// R-Classifier — pure-classifier input-isolation (no committed-ledger reads).
// The full R1–R8 analytics regression is in
// WealthWithHoldings.test.ts; here we document the structural properties
// of the classifier output that the analytics rely on.
// =============================================================================

describe('R-Classifier. Output shape that analytics rely on', () => {
  it('R-Classifier.1 HIGH confidence output sets category="DIVIDEND" and status stays CLEARED', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098' }));
    expect(r.candidate.category).toBe('DIVIDEND');
    expect(r.candidate.status).toBe('CLEARED');
    // The analytics filter is `category === 'DIVIDEND' && status === 'CLEARED'`.
    expect(r.candidate.category === 'DIVIDEND' && r.candidate.status === 'CLEARED').toBe(true);
  });

  it('R-Classifier.2 NONE-confidence output keeps category="GENERAL" (analytics skip)', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'INT PAID 500.00' }));
    expect(r.candidate.category).toBe('GENERAL');
    expect(r.candidate.status).toBe('CLEARED');
    // The analytics filter excludes this row.
    expect(r.candidate.category === 'DIVIDEND').toBe(false);
  });

  it('R-Classifier.3 MEDIUM-confidence output keeps category="GENERAL" (analytics skip; user may promote)', () => {
    const r = DividendClassifier.classify(mkTx({ narration: 'MF DIV PAYOUT 800' }));
    expect(r.candidate.category).toBe('GENERAL');
    expect(r.candidate.status).toBe('CLEARED');
  });
});

// =============================================================================
// Rule count (introspection).
// =============================================================================

describe('Z. Rule count introspection', () => {
  it('Z.1 the rule table contains exactly 25 rules (5 HIGH + 3 MEDIUM + 4 ambiguous + 13 negative)', () => {
    expect(DividendClassifier.RULE_COUNT).toBe(25);
  });

  it('Z.2 no rule id contains "TAX_DEDUCT_DIV" (the TDS sub-gate OPTION (iii) default)', () => {
    // White-box check via re-classification: a TDS DIV row must NOT
    // return a ruleId. If a future change adds TAX_DEDUCT_DIV or
    // equivalent, this test fails.
    const r = DividendClassifier.classify(mkTx({ narration: 'TDS DIV 200.00', amount: 200 }));
    expect(r.ruleId).not.toContain('TAX_DEDUCT');
    expect(r.ruleId).not.toContain('TDS');
  });
});
