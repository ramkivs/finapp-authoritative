/**
 * Deep-link regression guard.
 *
 * Navigating to a page is not sufficient: EssentialsPage defaults to its
 * 'emergency' sub-tab and MoneyPage to 'transactions'. Without deep-link
 * support, "Goals → All" would land on Emergency Fund and "Accounts → View"
 * on the ledger — the correct page, the wrong panel.
 *
 * These tests assert the `initialSubTab` / `navSeq` contract that App.navigateTo
 * relies on. See FINBOOM-DASHBOARD-FORENSIC-REPORT.md §11 Step 3.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EssentialsPage } from '../pages/EssentialsPage';
import { MoneyPage } from '../pages/MoneyPage';

const emptyState = {
  assets: [],
  liabilities: [],
  snapshots: [],
  transactions: [],
  accounts: [],
  goals: [],
  budgets: [],
  policies: [],
  profile: {},
  privacyMasked: false,
  dateRange: 'This Month',
  filterType: 'All',
  searchQuery: '',
  setFilterType: vi.fn(),
  setDateRange: vi.fn(),
  setSearchQuery: vi.fn(),
  getFilteredTransactions: () => [],
  addAsset: vi.fn(),
  addLiability: vi.fn(),
  captureSnapshot: vi.fn(),
  togglePrivacy: vi.fn()
};

vi.mock('../store/useCanonicalLedger', () => {
  const useCanonicalLedger: any = (selector?: (s: any) => unknown) =>
    selector ? selector(emptyState) : emptyState;
  useCanonicalLedger.getState = () => emptyState;
  return { useCanonicalLedger };
});

vi.mock('../application', () => ({
  queries: {
    getMetric: () => ({ value: 0, status: 'NOT_CONFIGURED', provenance: 'NONE' }),
    getFinancialHealthScore: () => ({ score: 0, status: 'NOT_CONFIGURED' }),
    getEmergencyFundAnalysis: () => ({
      liquidReserves: 0,
      runwayMonths: 0,
      status: 'NOT_CONFIGURED'
    })
  }
}));

/** A tab button is active when it carries the highlighted border class. */
const isActive = (el: HTMLElement | null) =>
  !!el && /border-green-500|border-\[#23C55E\]|text-green-400/.test(el.className);

describe('Deep-link sub-tab targeting', () => {
  describe('EssentialsPage', () => {
    it('defaults to the Emergency Fund tab when no deep link is supplied', () => {
      render(<EssentialsPage />);
      expect(isActive(document.getElementById('essentials-tab-emergency'))).toBe(true);
      expect(isActive(document.getElementById('essentials-tab-goals'))).toBe(false);
    });

    it('opens the Goals tab when deep-linked (D1, D2)', () => {
      render(<EssentialsPage initialSubTab="goals" navSeq={1} />);
      expect(isActive(document.getElementById('essentials-tab-goals'))).toBe(true);
      expect(screen.getByText(/No financial goals configured/i)).toBeInTheDocument();
    });

    it('ignores an unknown sub-tab rather than rendering nothing', () => {
      render(<EssentialsPage initialSubTab="does-not-exist" navSeq={1} />);
      expect(isActive(document.getElementById('essentials-tab-emergency'))).toBe(true);
    });
  });

  describe('MoneyPage', () => {
    const props = { openModal: vi.fn(), openSidebarTab: vi.fn() };

    it('defaults to the Transactions tab when no deep link is supplied', () => {
      render(<MoneyPage {...props} />);
      expect(isActive(document.getElementById('money-tab-accounts'))).toBe(false);
    });

    it('opens the Accounts tab when deep-linked (D3, D4)', () => {
      render(<MoneyPage {...props} initialSubTab="accounts" navSeq={1} />);
      expect(isActive(document.getElementById('money-tab-accounts'))).toBe(true);
    });

    it('opens the Transactions tab when deep-linked (D5, D6)', () => {
      render(<MoneyPage {...props} initialSubTab="transactions" navSeq={1} />);
      expect(isActive(document.getElementById('money-tab-transactions'))).toBe(true);
    });

    it('re-applies the same target on a repeat navigation (navSeq bump)', () => {
      const { rerender } = render(
        <MoneyPage {...props} initialSubTab="accounts" navSeq={1} />
      );
      expect(isActive(document.getElementById('money-tab-accounts'))).toBe(true);

      // User manually switches away, then clicks the same dashboard control again.
      rerender(<MoneyPage {...props} initialSubTab="transactions" navSeq={2} />);
      expect(isActive(document.getElementById('money-tab-transactions'))).toBe(true);

      rerender(<MoneyPage {...props} initialSubTab="accounts" navSeq={3} />);
      expect(isActive(document.getElementById('money-tab-accounts'))).toBe(true);
    });
  });
});
