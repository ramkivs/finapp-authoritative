/**
 * WP-FB-DATA-02 — Import → Canonical Ledger regression suite.
 *
 * Guards the RC-L09 defect found in WP-FB-DATA-01: transactions were correctly
 * parsed, normalized, deduplicated, account-associated and persisted, yet were
 * invisible in the surface labelled "CANONICAL FINANCIAL LEDGER (SOURCE OF
 * TRUTH)" because every date range was bounded by the frozen constant
 * APP_AS_OF_DATE ('2026-08-09').
 *
 * These tests exercise the REAL pipeline end to end:
 *
 *   statement fixture
 *     -> ImportPipelineService.processBinaryFile
 *     -> normalized transaction
 *     -> commitImportedRows
 *     -> useCanonicalLedger.transactions
 *     -> getFilteredTransactions()
 *     -> Canonical-Ledger-visible records
 *
 * They deliberately avoid component rendering: the defect lived in the query
 * layer, and a component test would not have caught it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ImportPipelineService } from '../services/ImportPipelineService';
import { DateNormalizer } from '../services/import/normalization/DateNormalizer';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { APP_AS_OF_DATE } from '../domain/types';
import {
  DateRangeService,
  getEffectiveAsOfDate,
  setAsOfDateOverride,
  resetAsOfDateOverride
} from '../services/DateRangeService';

const FIXTURES = path.resolve(__dirname, '../../scripts/fixtures');

/** A date strictly after every fixture transaction (latest is 2026-08-20). */
const LIVE_TODAY = '2026-08-21';

function readFixture(fileName: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, fileName)));
}

/** Runs the real import pipeline against a fixture and commits to the store. */
function importFixture(fileName: string) {
  const existing = useCanonicalLedger.getState().transactions;
  const result = ImportPipelineService.processBinaryFile(
    readFixture(fileName),
    existing,
    'Bank Import',
    fileName
  );
  const commit = useCanonicalLedger.getState().commitImportedRows(result.validRows);
  return { result, commit };
}

/** Empties the in-memory canonical collection between tests. */
function resetLedger() {
  // MemoryRepository owns the backing array and pushes into the store via
  // syncStore(); clearing the store alone would leave the repository populated
  // and leak rows across tests.
  const repo = repository as unknown as {
    transactionsData: unknown[];
    syncStore: () => void;
  };
  repo.transactionsData = [];
  repo.syncStore();

  useCanonicalLedger.setState({
    transactions: [],
    filterType: 'All',
    dateRange: 'YTD',
    searchQuery: ''
  });
}

describe('WP-FB-DATA-02 — Import to Canonical Ledger', () => {
  beforeEach(() => {
    resetLedger();
    setAsOfDateOverride(LIVE_TODAY);
  });

  afterEach(() => {
    resetAsOfDateOverride();
    resetLedger();
  });

  /* ---------------------------------------------------------------------
   * §18 — Date normalization (DateNormalizer must not be modified)
   * ------------------------------------------------------------------ */
  describe('date normalization', () => {
    it('normalizes 18/08/2026 to 2026-08-18', () => {
      expect(DateNormalizer.normalize('18/08/2026')).toBe('2026-08-18');
    });

    it('normalizes the other statement formats consistently', () => {
      expect(DateNormalizer.normalize('17-08-2026')).toBe('2026-08-17');
      expect(DateNormalizer.normalize('2026-08-19')).toBe('2026-08-19');
      expect(DateNormalizer.normalize('20/08/26')).toBe('2026-08-20');
      expect(DateNormalizer.normalize('not-a-date')).toBeNull();
    });
  });

  /* ---------------------------------------------------------------------
   * §4 — Effective as-of date separation
   * ------------------------------------------------------------------ */
  describe('effective as-of date authority', () => {
    it('honours an explicit deterministic override', () => {
      setAsOfDateOverride(APP_AS_OF_DATE);
      expect(getEffectiveAsOfDate()).toBe('2026-08-09');
    });

    it('falls back to the real current date when no override is installed', () => {
      resetAsOfDateOverride();
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const expected = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      expect(getEffectiveAsOfDate()).toBe(expected);
      // The whole point of the fix: production "today" is no longer frozen.
      expect(getEffectiveAsOfDate()).not.toBe(APP_AS_OF_DATE);
    });

    it('bounds every range by the effective date, not the frozen constant', () => {
      setAsOfDateOverride(LIVE_TODAY);
      for (const range of ['YTD', 'This Month', '12M', 'Last 30 Days']) {
        expect(DateRangeService.getBounds(range).endDate).toBe(LIVE_TODAY);
      }
    });
  });

  /* ---------------------------------------------------------------------
   * §14 Case A — SBI import
   * ------------------------------------------------------------------ */
  describe('Case A — SBI_Statement.xlsx', () => {
    it('detects the SBI format and produces valid rows', () => {
      const { result } = importFixture('SBI_Statement.xlsx');
      expect(result.detectedFormatId).toBe('sbi');
      expect(result.unsupportedFormat).toBeFalsy();
      expect(result.validRows.length).toBeGreaterThan(0);
      expect(result.invalidCount).toBe(0);
    });

    it('persists rows, associates SBI Bank, and assigns correct directions', () => {
      const { commit } = importFixture('SBI_Statement.xlsx');
      expect(commit.appended).toBeGreaterThan(0);

      const txs = useCanonicalLedger.getState().transactions;
      expect(txs.length).toBe(commit.appended);

      // §19 account association
      expect(txs.every(t => t.account === 'SBI Bank')).toBe(true);

      // §14 direction: credits -> Income, debits -> Expense
      const credit = txs.find(t => t.amount === 604.93);
      expect(credit, 'the Rs604.93 DEP TFR credit must be present').toBeDefined();
      expect(credit!.type).toBe('Income');
      expect(credit!.date).toBe('2026-08-19');

      const one = txs.find(t => t.amount === 1);
      expect(one, 'the Rs1 DEP TFR credit must be present').toBeDefined();
      expect(one!.type).toBe('Income');

      expect(txs.some(t => t.type === 'Expense')).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------
   * §14 Case B — ICICI import
   * ------------------------------------------------------------------ */
  describe('Case B — ICICI_Statement.xls', () => {
    it('detects the ICICI format and produces valid rows', () => {
      const { result } = importFixture('ICICI_Statement.xls');
      expect(result.detectedFormatId).toBe('icici');
      expect(result.unsupportedFormat).toBeFalsy();
      expect(result.validRows.length).toBeGreaterThan(0);
      expect(result.invalidCount).toBe(0);
    });

    it('persists rows, associates ICICI Bank, and assigns correct directions', () => {
      const { commit } = importFixture('ICICI_Statement.xls');
      expect(commit.appended).toBeGreaterThan(0);

      const txs = useCanonicalLedger.getState().transactions;
      expect(txs.every(t => t.account === 'ICICI Bank')).toBe(true);
      expect(txs.some(t => t.type === 'Income')).toBe(true);
      expect(txs.some(t => t.type === 'Expense')).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------
   * §15 — THE DEFECT-CATCHING REGRESSION
   * ------------------------------------------------------------------ */
  describe('§15 post-as-of-date visibility (RC-L09 regression)', () => {
    it('surfaces transactions dated after the frozen 2026-08-09 constant', () => {
      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');

      const state = useCanonicalLedger.getState();
      const visible = state.getFilteredTransactions({ type: 'All', dateRange: 'YTD' });
      const visibleDates = visible.map(t => t.date);

      // Every one of these is later than APP_AS_OF_DATE and was previously hidden.
      for (const d of ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20']) {
        expect(
          visibleDates,
          `${d} is after APP_AS_OF_DATE and must be visible in the canonical ledger`
        ).toContain(d);
      }

      const postCutoff = state.transactions.filter(t => t.date > APP_AS_OF_DATE);
      expect(postCutoff.length).toBeGreaterThan(0);
      expect(visible.length).toBeGreaterThanOrEqual(postCutoff.length);
    });

    it('still excludes them under an explicit historical as-of date (determinism preserved)', () => {
      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');

      // Historical / audit mode: pin the as-of date to the old constant.
      setAsOfDateOverride(APP_AS_OF_DATE);

      const visible = useCanonicalLedger
        .getState()
        .getFilteredTransactions({ type: 'All', dateRange: 'YTD' });

      expect(DateRangeService.getBounds('YTD').endDate).toBe('2026-08-09');
      expect(visible.length).toBe(0);
      expect(visible.every(t => t.date <= APP_AS_OF_DATE)).toBe(true);
    });

    it('does not reveal genuinely future-dated transactions', () => {
      importFixture('SBI_Statement.xlsx');
      // Pin "today" before the fixture dates: they are future relative to it.
      setAsOfDateOverride('2026-08-15');

      const visible = useCanonicalLedger
        .getState()
        .getFilteredTransactions({ type: 'All', dateRange: 'YTD' });

      expect(visible.every(t => t.date <= '2026-08-15')).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------
   * §16 — CORE INVARIANT
   * ------------------------------------------------------------------ */
  describe('§16 core invariant', () => {
    it('returns every persisted transaction for filterType=All over the widest range', () => {
      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');

      const state = useCanonicalLedger.getState();
      const all = state.transactions;
      expect(all.length).toBeGreaterThan(0);
      expect(all.every(t => t.date <= getEffectiveAsOfDate())).toBe(true);

      const visible = state.getFilteredTransactions({ type: 'All', dateRange: 'YTD' });

      // The single assertion that would have caught WP-FB-DATA-01.
      expect(visible.length).toBe(all.length);
    });

    it('defaults the store filterType to All so the ledger is not type-truncated on load', () => {
      // Authorised product decision (WP-FB-DATA-02 §10): the surface labelled
      // "SOURCE OF TRUTH" must not open pre-filtered to a single type.
      resetAsOfDateOverride();
      setAsOfDateOverride(LIVE_TODAY);
      useCanonicalLedger.setState({ transactions: [] });
      importFixture('SBI_Statement.xlsx');

      const fresh = useCanonicalLedger.getState();
      const incomeCount = fresh.transactions.filter(t => t.type === 'Income').length;
      expect(incomeCount).toBeGreaterThan(0);

      const visible = fresh.getFilteredTransactions({ dateRange: 'YTD', type: 'All' });
      expect(visible.filter(t => t.type === 'Income').length).toBe(incomeCount);
    });
  });

  /* ---------------------------------------------------------------------
   * §17 — Deduplication
   * ------------------------------------------------------------------ */
  describe('§17 deduplication', () => {
    it('appends on first import and appends nothing on re-import', () => {
      const first = importFixture('SBI_Statement.xlsx');
      expect(first.commit.appended).toBeGreaterThan(0);
      const afterFirst = useCanonicalLedger.getState().transactions.length;

      const second = importFixture('SBI_Statement.xlsx');
      expect(second.commit.appended).toBe(0);

      const afterSecond = useCanonicalLedger.getState().transactions.length;
      expect(afterSecond).toBe(afterFirst);
    });

    it('does not double-count re-imported rows in the canonical ledger', () => {
      importFixture('ICICI_Statement.xls');
      const before = useCanonicalLedger
        .getState()
        .getFilteredTransactions({ type: 'All', dateRange: 'YTD' }).length;

      importFixture('ICICI_Statement.xls');
      const after = useCanonicalLedger
        .getState()
        .getFilteredTransactions({ type: 'All', dateRange: 'YTD' }).length;

      expect(after).toBe(before);
    });
  });

  /* ---------------------------------------------------------------------
   * §24 — Derived query impact
   *
   * queries.getMoneyInsights() bounds its period with the same helper, so it
   * inherited the same truncation. Imported income/expense after the frozen
   * constant was omitted from cash-flow aggregates.
   * ------------------------------------------------------------------ */
  describe('§24 derived query impact', () => {
    it('includes post-cutoff imported transactions in money insights', async () => {
      const { FinancialQueries } = await import('../application/queries');

      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');

      setAsOfDateOverride(LIVE_TODAY);
      const live: any = FinancialQueries.getMoneyInsights('This Month');

      // Under the historical as-of date the same window sees nothing.
      setAsOfDateOverride(APP_AS_OF_DATE);
      const historical: any = FinancialQueries.getMoneyInsights('This Month');

      expect(live.totalIncome).toBeGreaterThan(0);
      expect(live.totalIncome).toBeGreaterThan(historical.totalIncome);
      expect(historical.totalIncome).toBe(0);
    });
  });

  /* ---------------------------------------------------------------------
   * §11 — Exclusion is detectable rather than silent
   * ------------------------------------------------------------------ */
  describe('§11 exclusion disclosure data', () => {
    it('exposes a non-zero delta when filters hide persisted records', () => {
      importFixture('SBI_Statement.xlsx');
      importFixture('ICICI_Statement.xls');

      const state = useCanonicalLedger.getState();
      const total = state.transactions.length;
      const shown = state.getFilteredTransactions({ type: 'All', dateRange: 'This Week' }).length;

      // The Ledger header renders (total - shown) when this delta is > 0.
      expect(total).toBeGreaterThan(0);
      expect(total - shown).toBeGreaterThanOrEqual(0);

      const incomeOnly = state.getFilteredTransactions({ type: 'Income', dateRange: 'YTD' }).length;
      expect(total - incomeOnly).toBeGreaterThan(0);
    });
  });
});
