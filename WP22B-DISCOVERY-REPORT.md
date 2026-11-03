# ArthaVault WP-22B: CONTROLLED DISCOVERY REPORT
## Canonical Mathematical Intelligence — Application Integration & UI Binding

---

## 1. Executive Summary & Authoritative Production Baseline

```text
============================================================
WP-22B DISCOVERY BASELINE
============================================================
Production Main SHA            : 3ced3aa63fc3ea6eea0cbe0a9d5fbbcf43cf4ad4
Production Tree SHA            : 77036911bccf07e52a96e3f8f7b4b4f738414379
WP-22 Implementation SHA       : fc972e69f3db7f1755b859c47743f2cdade94898
WP-21 Base SHA                 : 09395df67a7f5b340b9a0ad913b869d746270246
Release Tag                    : v2.11.9-wp22-mathematical-intelligence
Release Tag Object SHA         : f36b99d97e85b9063dc9d6814fcb98e0ae597e34
Working Tree Status            : CLEAN (0 uncommitted changes)
Discovery Status               : PASS — READY FOR ARCHITECTURE REVIEW
============================================================
```

---

## 2. Current Calculator Architecture & Routing

ArthaVault's current calculators architecture resides on `/calculators` (`src/pages/CalculatorsPage.tsx`) composed of 4 tiers:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ CALCULATORS HUB (/calculators)                                         │
├────────────────────────────────────────────────────────────────────────┤
│ TIER 1: POPULAR CALCULATORS (6 Quick-Access Cards)                     │
│ • SIP Calculator (Live)       • EMI Calculator (Live)                  │
│ • RD Calculator (Roadmap)     • PPF Calculator (Roadmap)               │
│ • Retirement Calc (Roadmap)   • Goal Calculator (Roadmap)              │
├────────────────────────────────────────────────────────────────────────┤
│ TIER 2: ALL CALCULATORS DIRECTORY (8 List Items)                       │
│ • SIP Calculator (Live Engine)       • Lumpsum Calculator (Live Engine)│
│ • SWP Calculator (Roadmap)           • EMI Calculator (Live Engine)    │
│ • RD Calculator (Roadmap)            • PPF Calculator (Roadmap)        │
│ • Inflation Calculator (Modal)       • Retirement Calculator (Roadmap) │
├────────────────────────────────────────────────────────────────────────┤
│ TIER 3: INTERACTIVE MATHEMATICAL WORKSPACE CONTAINER & SUBTABS         │
│ [#calc-tab-sip]      → <SipCalculator />                               │
│ [#calc-tab-lumpsum]  → <LumpsumCalculator />                           │
│ [#calc-tab-xirr]     → <XirrCalculator />                              │
│ [#calc-tab-cagr]     → <CagrCalculator />                              │
│ [#calc-tab-loan]     → <LoanEmiCalculator />                           │
│                                                                        │
│ • Roadmap Section    → <Expanded Mathematical Engine Roadmap />        │
│ • Inflation Modal    → <InflationCalculatorModal />                    │
├────────────────────────────────────────────────────────────────────────┤
│ TIER 4: CANONICAL LIVE LEDGER DERIVED METRICS (3 KPI Cards)            │
│ • Dividend Yield (TTM)  • Net Worth CAGR  • Emergency Fund Goal        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. WP-20 vs. WP-22 Mathematical Engine Mapping

```text
========================================================================================================================
ENGINE           WP-20 BASELINE SERVICE              WP-22 CANONICAL ENGINE           INTEGRATION STATUS
========================================================================================================================
SIP              CalculatorsService.calculateSip     Wp20Adapters.calculateSip        Certified Adapter Ready
Lumpsum          CalculatorsService.calculateLump    Wp20Adapters.calculateLumpsum    Certified Adapter Ready
Loan EMI         CalculatorsService.calculateLoan    Wp20Adapters.calculateLoanEmi    Certified Adapter Ready
CAGR             CalculatorsService.calculateCagr    Wp20Adapters.calculateCagr       Certified Adapter Ready
XIRR             CalculatorsService.calculateXirr    XirrEngine.calculate             Hardened Multi-Stage Solver Ready
RD               None (Roadmap UI card only)         RecurringDepositEngine.calculate Certified Model A Engine Ready
PPF              None (Roadmap UI card only)         PpfEngine.calculate              Statutory 2019 Scheme Engine Ready
SWP              None (Roadmap UI card only)         SwpEngine.calculate              Annuity Depletion Engine Ready
Reverse SIP      None (Roadmap UI card only)         GoalReverseSipEngine.calculate   Milestone Inversion Solver Ready
Retirement FIRE  None (Roadmap UI card only)         RetirementFireEngine.calculate   SWR & Coast FIRE Model Ready
========================================================================================================================
```

---

## 4. Integration Gaps Identified

1. **Direct Service Bypass**:
   - Current UI components (`SipCalculator.tsx`, `LoanEmiCalculator.tsx`, etc.) import `CalculatorsService` directly rather than invoking the application query boundary.
   - *Requirement*: Route calculator queries through `src/application/queries.ts` to return strongly-typed `CalculationResult<T>` envelopes containing full provenance and RFC 8785 execution fingerprints.
2. **Provenance Exposure**:
   - The UI does not currently expose execution fingerprints or algorithm metadata.
   - *Requirement*: Provide an expandable "Institutional Provenance & Audit" badge displaying `algorithmId`, `algorithmVersion`, `executionFingerprint`, and statutory citation.
3. **Roadmap vs. Interactive Exposure**:
   - The certified WP-22 engines (RD, PPF, SWP, Reverse SIP, Retirement FIRE) currently lack dedicated interactive UI modals/workspaces.

---

## 5. Calculator Exposure & Roadmap Reconciliation Matrix

```text
========================================================================================================================
CAPABILITY       UI STATUS   WP-20 BASE   WP-22 ENGINE         APP INTEGRATION   UI ROUTE / PLACEMENT     WP-22B ACTION
========================================================================================================================
SIP              LIVE        Yes          Wp20Adapters         Queries.calcSip   CalculatorsPage (#sip)   Wrap via Canonical Envelope
Lumpsum          LIVE        Yes          Wp20Adapters         Queries.calcLump  CalculatorsPage (#lump)  Wrap via Canonical Envelope
Loan EMI         LIVE        Yes          Wp20Adapters         Queries.calcEmi   CalculatorsPage (#loan)  Wrap via Canonical Envelope
CAGR             LIVE        Yes          Wp20Adapters         Queries.calcCagr  CalculatorsPage (#cagr)  Wrap via Canonical Envelope
XIRR             LIVE        Yes          XirrEngine           Queries.calcXirr  CalculatorsPage (#xirr)  Bind Hardened XirrEngine
RD               ROADMAP     No           RecurringDeposit     Queries.calcRd    Directory / Modal        Ready for Modal Exposure
PPF              ROADMAP     No           PpfEngine            Queries.calcPpf   Directory / Modal        Ready for Modal Exposure
SWP              ROADMAP     No           SwpEngine            Queries.calcSwp   Directory / Modal        Ready for Modal Exposure
Reverse SIP      ROADMAP     No           GoalReverseSip       Queries.calcGoal  Directory / Modal        Ready for Modal Exposure
Retirement FIRE  ROADMAP     No           RetirementFire       Queries.calcFire  Directory / Modal        Ready for Modal Exposure
========================================================================================================================
```

### Product Semantics Determination:
1. **Recurring Deposit (RD)**: Certified Model A ($A = P \sum (1 + r/4)^{4(n-k+1)/12}$) provides exact quarterly compounded maturity (₹62,311) and reconciled schedule. Expose via interactive calculator modal/subtab with input fields (`monthlyDeposit`, `annualRate`, `tenureMonths`, `compoundingFrequency`).
2. **Public Provident Fund (PPF)**: Evaluates statutory Scheme 2019 rules (15-year tenure, March 31 interest credit). Expose with policy disclaimer and statutory parameters.
3. **Systematic Withdrawal (SWP)**: Evaluates monthly annuity depletion and flags exhaustion month. Expose with withdrawal inputs and longevity schedule.
4. **Retirement / FIRE**: Evaluates SWR (4.0% default) target corpus, inflation-adjusted future expenses, and Coast FIRE number. Expose with FIRE multiplier indicators.
5. **Goal Reverse SIP**: Solves required monthly contribution to reach target corpus.

---

## 6. Proposed Integration Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│ UI LAYER (React Components)                                            │
│ • SipCalculator | LoanEmiCalculator | XirrCalculator | New Modals      │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Invokes
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ APPLICATION QUERY BOUNDARY (`src/application/queries.ts`)              │
│ • FinancialQueries.calculateSip(params)                                │
│ • FinancialQueries.calculateXirr(flows)                                │
│ • FinancialQueries.calculateRecurringDeposit(params)                   │
│ • FinancialQueries.calculatePpf(params)                                │
│ • FinancialQueries.calculateSwp(params)                                │
│ • FinancialQueries.calculateGoalReverseSip(params)                     │
│ • FinancialQueries.calculateRetirementFire(params)                     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Returns
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ CANONICAL CALCULATION RESULT ENVELOPE (`CalculationResult<T>`)         │
│ • state: 'VALID' | 'ZERO' | 'NOT_CONFIGURED' | 'INVALID_INPUT' ...     │
│ • data: Exact typed numerical payload                                  │
│ • provenance: { algorithmVersion, executionFingerprint, citation }     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Exact Files Expected to Change in WP-22B

### A. Expected Source Modifications:
1. `src/application/queries.ts`: Expose canonical calculation queries returning `CalculationResult<T>`.
2. `src/components/calculators/SipCalculator.tsx`: Consume canonical query and display provenance badge.
3. `src/components/calculators/LumpsumCalculator.tsx`: Consume canonical query and display provenance badge.
4. `src/components/calculators/LoanEmiCalculator.tsx`: Consume canonical query and display provenance badge.
5. `src/components/calculators/CagrCalculator.tsx`: Consume canonical query and display provenance badge.
6. `src/components/calculators/XirrCalculator.tsx`: Bind hardened `XirrEngine` and multi-root diagnostics.
7. `src/pages/CalculatorsPage.tsx`: Add interactive modal triggers for RD, PPF, SWP, and Retirement FIRE.
8. `scripts/runRegressionSuite.ts`: Add WP-22B application integration test suite.
9. `scripts/verifyChromeIndexedDBAcceptance.ts`: Add browser acceptance tests for new modal interactions.

### B. Files Explicitly Excluded (Protected Surfaces):
* `src/domain/types.ts` & `src/domain/demoFixtures.ts`
* `src/store/useCanonicalLedger.ts`
* `src/services/CalculatorsService.ts` (Certified WP-20 mathematical baseline)
* `src/services/WealthIntelligenceService.ts`
* `src/services/mathematics/*` (Certified WP-22 mathematical foundation)
* `package.json` & `package-lock.json`
* `.env.example` & `.gitignore`

---

## 8. Risk Analysis & Rollback Strategy

* **Risk 1: WP-20 Numerical Drift**:
  - *Mitigation*: Differential test suite `WP22-C20` asserts byte-for-byte numerical equality before and after adapter integration.
* **Risk 2: UI Layout Regressions**:
  - *Mitigation*: Preserves existing 64px header, collapsible sidebar, 1280x800 reference alignment, and 0px horizontal page overflow.
* **Rollback Strategy**: Clean git branch isolation on `feat/wp22b-mathematical-application-integration` allowing instantaneous rollback to `v2.11.9-wp22-mathematical-intelligence` without repository contamination.

---

## 9. Discovery Status & Exit Gate

```text
============================================================
DISCOVERY STATUS: PASS
============================================================
All 10 mathematical capabilities mapped.
Integration gaps identified.
Protected surfaces cataloged.
Working tree clean at baseline 3ced3aa63fc3ea6eea0cbe0a9d5fbbcf43cf4ad4.
============================================================
```

*Standing hard stop strictly observed. Zero repository files modified during discovery. Awaiting human review and authorization to begin **WP-22B Phase B/C Implementation**.*
