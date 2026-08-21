/**
 * Regression guard for the WP-21 dashboard entry-point defect.
 *
 * The six Overview dashboard controls were originally authored as
 * `<a href="#money">` / `<a href="#essentials">` anchors. FinBoom has no router
 * — page selection is React state in App.tsx — so those anchors updated the URL
 * fragment and produced no navigation. See FINBOOM-DASHBOARD-FORENSIC-REPORT.md.
 *
 * These tests assert the *behaviour* (a navigation callback fires with the
 * correct page and sub-tab), not merely that the control renders. Layer 1
 * (visual presence) previously passed while Layer 2 (interaction) did not.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverviewPage } from '../pages/OverviewPage';

// The dashboard reads from the canonical ledger store. Force the empty state so
// the empty-state controls (D2, D4, D6) render alongside the header controls.
vi.mock('../store/useCanonicalLedger', () => {
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
    addAsset: vi.fn(),
    addLiability: vi.fn(),
    captureSnapshot: vi.fn(),
    togglePrivacy: vi.fn()
  };
  const useCanonicalLedger: any = (selector?: (s: any) => unknown) =>
    selector ? selector(emptyState) : emptyState;
  useCanonicalLedger.getState = () => emptyState;
  return { useCanonicalLedger };
});

describe('OverviewPage — dashboard entry points', () => {
  let navigateTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigateTo = vi.fn();
    render(<OverviewPage navigateTo={navigateTo} />);
  });

  const cases: Array<{
    id: string;
    name: RegExp;
    tab: string;
    subTab: string;
  }> = [
    // Header controls carry an aria-label, which becomes their accessible name.
    { id: 'D1', name: /^View all financial goals$/, tab: 'essentials', subTab: 'goals' },
    { id: 'D2', name: /Set Financial Goal/, tab: 'essentials', subTab: 'goals' },
    { id: 'D3', name: /^View all accounts$/, tab: 'money', subTab: 'accounts' },
    { id: 'D4', name: /Link Account/, tab: 'money', subTab: 'accounts' },
    { id: 'D5', name: /^Open transaction ledger$/, tab: 'money', subTab: 'transactions' },
    { id: 'D6', name: /Record Transaction/, tab: 'money', subTab: 'transactions' }
  ];

  it.each(cases)(
    '$id — "$name" navigates to $tab/$subTab',
    async ({ name, tab, subTab }) => {
      const control = screen.getByRole('button', { name });
      await userEvent.click(control);
      expect(navigateTo).toHaveBeenCalledWith(tab, subTab);
    }
  );

  it('renders every entry point as a <button>, never an inert anchor', () => {
    for (const { name } of cases) {
      const control = screen.getByRole('button', { name });
      expect(control.tagName).toBe('BUTTON');
      expect(control).not.toHaveAttribute('href');
    }
  });

  it('contains no fragment-href anchors anywhere in the dashboard', () => {
    // Guards against reintroducing `<a href="#money">`-style dead navigation.
    const deadAnchors = document.querySelectorAll('a[href^="#"]');
    expect(deadAnchors.length).toBe(0);
  });
});
