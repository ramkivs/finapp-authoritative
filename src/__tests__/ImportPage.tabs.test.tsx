/**
 * FINBOOM-CR (CR-02) — ImportPage sub-tab isolation tests.
 *
 * Asserts the contract in `FINBOOM-CR-BROKER-BANK-IMPORT-AUTHORITY-SPEC.md`
 * for the two sub-tab UI in `ImportPage.tsx`.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import { ImportPage } from '../pages/ImportPage';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';

const repo = repository as any;

describe('A. Default tab is broker (CR-02 default tab)', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
  });
  afterEach(() => { cleanup(); });

  it('A.1 default subTab is broker (broker button has aria-selected=true)', () => {
    render(<ImportPage />);
    const brokerTab = document.querySelector('[data-testid="import-subtab-broker"]') as HTMLButtonElement;
    const bankTab = document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement;
    expect(brokerTab.getAttribute('aria-selected')).toBe('true');
    expect(bankTab.getAttribute('aria-selected')).toBe('false');
  });

  it('A.2 default subTab renders BrokerImportSection (broker panel visible)', () => {
    render(<ImportPage />);
    const brokerPanel = document.querySelector('[data-testid="import-subtab-panel-broker"]');
    const bankPanel = document.querySelector('[data-testid="import-subtab-panel-bank"]');
    expect(brokerPanel).toBeTruthy();
    expect(bankPanel).toBeNull();
  });
});

describe('B. Tab switching', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
  });
  afterEach(() => { cleanup(); });

  it('B.1 clicking the bank tab hides the broker panel and shows the bank panel', () => {
    render(<ImportPage />);
    fireEvent.click(document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement);
    expect(document.querySelector('[data-testid="import-subtab-panel-broker"]')).toBeNull();
    expect(document.querySelector('[data-testid="import-subtab-panel-bank"]')).toBeTruthy();
  });

  it('B.2 clicking the broker tab again hides the bank panel and shows the broker panel', () => {
    render(<ImportPage />);
    fireEvent.click(document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement);
    fireEvent.click(document.querySelector('[data-testid="import-subtab-broker"]') as HTMLButtonElement);
    expect(document.querySelector('[data-testid="import-subtab-panel-broker"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="import-subtab-panel-bank"]')).toBeNull();
  });

  it('B.3 top-level import sub-tab buttons are reachable in the DOM in order: Broker, Bank', () => {
    render(<ImportPage />);
    // The ImportPage now has THREE tablists (the top-level import sub-tabs
    // + the bank-institution tablist + the broker-institution tablist, the
    // last being inside BrokerImportSection). The original test asserted
    // there were exactly 2 [role="tab"] elements; that assertion is no
    // longer accurate. We instead target the top-level sub-tab buttons
    // by their data-testid, which remains the unique identifier for the
    // two import sub-tabs.
    const brokerTab = document.querySelector('[data-testid="import-subtab-broker"]');
    const bankTab = document.querySelector('[data-testid="import-subtab-bank"]');
    expect(brokerTab).toBeTruthy();
    expect(bankTab).toBeTruthy();
    expect(brokerTab!.getAttribute('role')).toBe('tab');
    expect(bankTab!.getAttribute('role')).toBe('tab');
    // The broker tab appears first in the DOM
    expect(
      brokerTab!.compareDocumentPosition(bankTab as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe('C. 5-stage engine heading renamed (CR-02 rename)', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
  });
  afterEach(() => { cleanup(); });

  it('C.1 bank sub-tab shows heading "Bank Statement Import" (NOT "5-Stage Bulk Import Engine")', () => {
    render(<ImportPage />);
    fireEvent.click(document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement);
    const h1 = document.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1!.textContent).toBe('Bank Statement Import');
    expect(h1!.textContent).not.toContain('5-Stage Bulk Import Engine');
  });

  it('C.2 broker sub-tab does NOT show the bank engine heading', () => {
    render(<ImportPage />);
    const h1s = [...document.querySelectorAll('h1')];
    for (const h of h1s) {
      expect(h.textContent).not.toContain('5-Stage Bulk Import Engine');
      expect(h.textContent).not.toBe('Bank Statement Import');
    }
  });
});

describe('D. Tab isolation (CR-02 isolation)', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
  });
  afterEach(() => { cleanup(); });

  it('D.1 broker sub-tab does not render bank engine controls (no Simulate Upload button)', () => {
    render(<ImportPage />);
    const brokerPanel = document.querySelector('[data-testid="import-subtab-panel-broker"]');
    expect(brokerPanel).toBeTruthy();
    // The bank engine's "Simulate Upload" button is NOT in the broker panel
    const allButtons = [...document.querySelectorAll('button')];
    const simulateButton = allButtons.find(b => /Simulate Upload/i.test(b.textContent || ''));
    expect(simulateButton).toBeUndefined();
  });

  it('D.2 bank sub-tab does not render the BrokerImportSection heading', () => {
    render(<ImportPage />);
    fireEvent.click(document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement);
    const bankPanel = document.querySelector('[data-testid="import-subtab-panel-bank"]');
    expect(bankPanel).toBeTruthy();
    // The BrokerImportSection heading "Broker Import (Zerodha / Groww / Dhan)"
    // is NOT in the bank panel
    const allHeadings = [...bankPanel!.querySelectorAll('h2')];
    for (const h of allHeadings) {
      expect(h.textContent).not.toMatch(/^Broker Import \(Zerodha/);
    }
  });
});

describe('E. Import History panel is cross-cutting (CR-04 panel placement)', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
  });
  afterEach(() => { cleanup(); });

  it('E.1 history panel toggle is visible regardless of active sub-tab', () => {
    render(<ImportPage />);
    const brokerHistoryToggle = document.querySelector('[data-testid="import-history-toggle"]');
    expect(brokerHistoryToggle).toBeTruthy();
    fireEvent.click(document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement);
    const bankHistoryToggle = document.querySelector('[data-testid="import-history-toggle"]');
    expect(bankHistoryToggle).toBeTruthy();
  });

  it('E.2 history panel content expands when toggle clicked', () => {
    render(<ImportPage />);
    fireEvent.click(document.querySelector('[data-testid="import-history-toggle"]') as HTMLButtonElement);
    const content = document.querySelector('[data-testid="import-history-content"]');
    expect(content).toBeTruthy();
  });
});
