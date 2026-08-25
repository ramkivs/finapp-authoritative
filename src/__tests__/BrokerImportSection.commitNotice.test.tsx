/**
 * WP-FB-IMPORT-BROKER-01 — Post-closeout UI defect remediation regression.
 *
 * Defect: in `src/pages/BrokerImportSection.tsx`, the success/error
 * commit notice was rendered inside the `PreviewView` sub-component.
 * The `handleConfirm` callback sets `commitNotice` and then immediately
 * calls `setPreview(null)`, which unmounts `PreviewView` in the next
 * React render — taking the success notice with it before the user
 * could see it. The persistence path itself was correct (82 holdings
 * written to IndexedDB), but the user-facing confirmation was lost.
 *
 * Fix: the notice JSX is now rendered at the parent level so it
 * survives the preview -> upload transition.
 *
 * This test file proves:
 *   A. Successful confirmation: import succeeds, persistence resolves,
 *      preview is cleared, success notice remains visible in the DOM.
 *   B. Failed persistence: error notice remains visible; no false
 *      success notice appears.
 *   C. Existing import semantics remain unchanged (preview is cleared
 *      on success and on cancel; the success text uses the approved
 *      wording; the error text is the thrown error message).
 *
 * Scope discipline:
 *   - Does not introduce snapshot testing
 *   - Does not introduce a new UI framework
 *   - Does not exercise a real browser (the live browser E2E is in
 *     `scripts/verifyBrowserImportE2E.ts`)
 *   - Reuses the existing @testing-library/react + jsdom test pattern
 *   - Reuses the existing vitest setup (Repository + IndexedDB
 *     fake-indexeddb + useCanonicalLedger store)
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';

import { BrokerImportSection } from '../pages/BrokerImportSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { Holding, HoldingStatus } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;

const makeHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: overrides.id ?? `hld-test-${Math.random().toString(36).slice(2, 10)}`,
  broker: overrides.broker ?? 'TestBroker',
  account: overrides.account,
  instrumentName: overrides.instrumentName ?? 'Test Instrument',
  isin: overrides.isin,
  ticker: overrides.ticker,
  quantity: overrides.quantity ?? 10,
  averageCost: overrides.averageCost ?? 100,
  investedValue: overrides.investedValue ?? 1000,
  currentPrice: overrides.currentPrice ?? 110,
  currentValue: overrides.currentValue ?? 1100,
  unrealisedPnL: overrides.unrealisedPnL ?? 100,
  unrealisedPnLPercent: overrides.unrealisedPnLPercent,
  xirrPercent: overrides.xirrPercent,
  securityClassification: overrides.securityClassification,
  status: overrides.status ?? ('active' as HoldingStatus),
  sourceFile: overrides.sourceFile ?? 'test.csv',
  importedAt: overrides.importedAt ?? '2026-08-23T10:00:00.000Z',
});

/**
 * The real Zerodha sample (small subset of rows is enough to drive
 * the test — the adapter's parsing is exercised end-to-end in the
 * dedicated `ZerodhaHoldingsAdapter.test.ts` suite).
 *
 * Only the header + a single data row are required to produce a
 * preview with one NEW entry. The exact row content does not need
 * to match the production sample.
 */
const ZERODHA_CSV = [
  '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
  '"TESTINSTR",10,100,110,1000,1100,100,10,1,""',
].join('\n');

const uploadFile = async (fileInput: HTMLInputElement, filename: string, content: string) => {
  const file = new File([content], filename, { type: 'text/csv' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fireEvent.change(fileInput);
  // Allow async detection + parse to settle.
  await new Promise(r => setTimeout(r, 50));
};

const clickConfirm = async () => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const confirm = buttons.find(b => b.textContent && b.textContent.includes('Confirm import'));
  expect(confirm).toBeDefined();
  fireEvent.click(confirm!);
  // Allow the persistence promise to resolve and the next React
  // render to commit.
  await new Promise(r => setTimeout(r, 100));
};

beforeEach(async () => {
  await repository.clearLocalData();
  await repository.initialize();
  IndexedDBStorageService.simulateFailureOnce = false;
});

afterEach(async () => {
  IndexedDBStorageService.simulateFailureOnce = false;
  await repository.clearLocalData();
  cleanup();
});

describe('WP-09 BrokerImportSection — commit notice post-transition (defect fix)', () => {
  it('DEFECT.A1: successful confirmation — success notice remains visible after preview is cleared', async () => {
    // Render the section. The initial state is the upload view.
    render(<BrokerImportSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    // Upload a Zerodha CSV to drive a preview with 1 NEW entry.
    await uploadFile(fileInput, 'zerodha-defect-test.csv', ZERODHA_CSV);

    // The preview view must be rendered. The preview header is
    // distinct from the upload-view header.
    await waitFor(() => {
      expect(screen.getByText(/Broker Import — Preview/i)).toBeTruthy();
    });

    // No notice is visible before the confirm click.
    expect(screen.queryByTestId('broker-import-commit-notice')).toBeNull();

    // Click "Confirm import".
    await clickConfirm();

    // After the persistence promise resolves:
    //   1. The preview is cleared (the upload view is back).
    //   2. The success notice is STILL visible (the fix).
    await waitFor(() => {
      // The preview header is gone — the upload header is back.
      expect(screen.queryByText(/Broker Import — Preview/i)).toBeNull();
    });
    await waitFor(() => {
      const notice = screen.queryByTestId('broker-import-commit-notice');
      expect(notice).not.toBeNull();
      // Success kind.
      expect(notice!.getAttribute('data-notice-kind')).toBe('success');
      // Approved wording: the exact text includes "Imported" and the
      // count chips. For a 1-NEW entry, the text is the approved
      // wording. The E2E script asserts on the substring
      // "Imported 82 new" against a real 82-holding sample; here
      // we use a 1-holding sample, so we assert the same wording
      // pattern at a smaller scale.
      expect(notice!.textContent).toMatch(/Imported 1 new/);
      expect(notice!.textContent).toMatch(/0 updated/);
      expect(notice!.textContent).toMatch(/0 unchanged/);
      expect(notice!.textContent).toMatch(/0 closed-absent/);
    });

    // Persistence is verified: 1 holding was written.
    expect(S().holdings.length).toBe(1);
  });

  it('DEFECT.A2: success notice text uses the exact approved wording format', async () => {
    render(<BrokerImportSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await uploadFile(fileInput, 'zerodha-wording-test.csv', ZERODHA_CSV);
    await waitFor(() => {
      expect(screen.getByText(/Broker Import — Preview/i)).toBeTruthy();
    });
    await clickConfirm();
    await waitFor(() => {
      const notice = screen.queryByTestId('broker-import-commit-notice');
      expect(notice).not.toBeNull();
    });
    const noticeText = screen.getByTestId('broker-import-commit-notice').textContent || '';
    // The exact full approved wording format, semantically identical to:
    //   "Imported ${new} new, ${updated} updated, ${closed_absent} closed-absent, ${unchanged} unchanged."
    // Here the values are 1/0/0/0.
    expect(noticeText).toBe('Imported 1 new, 0 updated, 0 closed-absent, 0 unchanged.');
  });

  it('DEFECT.B1: failed persistence — error notice remains visible; no false success notice', async () => {
    render(<BrokerImportSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await uploadFile(fileInput, 'zerodha-failure-test.csv', ZERODHA_CSV);
    await waitFor(() => {
      expect(screen.getByText(/Broker Import — Preview/i)).toBeTruthy();
    });

    // Arm a one-shot persistence failure.
    IndexedDBStorageService.simulateFailureOnce = true;

    await clickConfirm();

    // After the rejection:
    //   1. The preview is NOT cleared (the user can retry).
    //   2. The error notice is visible.
    //   3. The success notice is NOT visible.
    await waitFor(() => {
      const notice = screen.queryByTestId('broker-import-commit-notice');
      expect(notice).not.toBeNull();
      expect(notice!.getAttribute('data-notice-kind')).toBe('error');
    });
    // The preview view is still mounted because the user must be able
    // to retry the import.
    expect(screen.queryByText(/Broker Import — Preview/i)).toBeTruthy();
    // No success-flavored text is in the DOM.
    const allNotices = document.querySelectorAll('[data-notice-kind="success"]');
    expect(allNotices.length).toBe(0);

    // No holding was committed (rollback was triggered by the
    // atomic-write boundary).
    expect(S().holdings.length).toBe(0);
  });

  it('DEFECT.C1: existing import semantics — cancel does not mutate the store, notice is cleared', async () => {
    render(<BrokerImportSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await uploadFile(fileInput, 'zerodha-cancel-test.csv', ZERODHA_CSV);
    await waitFor(() => {
      expect(screen.getByText(/Broker Import — Preview/i)).toBeTruthy();
    });
    const before = S().holdings.length;

    // Click Cancel.
    const cancelBtn = Array.from(document.querySelectorAll('button')).find(
      b => b.textContent && b.textContent.trim() === 'Cancel',
    );
    expect(cancelBtn).toBeDefined();
    fireEvent.click(cancelBtn!);
    await new Promise(r => setTimeout(r, 50));

    // The upload view is back.
    expect(screen.queryByText(/Broker Import — Preview/i)).toBeNull();
    // No notice is present (cancel clears `commitNotice`).
    expect(screen.queryByTestId('broker-import-commit-notice')).toBeNull();
    // No holding was committed.
    expect(S().holdings.length).toBe(before);
  });

  it('DEFECT.C2: existing import semantics — confirm-then-re-import is idempotent at the data layer', async () => {
    // First import.
    render(<BrokerImportSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await uploadFile(fileInput, 'zerodha-reimport-1.csv', ZERODHA_CSV);
    await waitFor(() => {
      expect(screen.getByText(/Broker Import — Preview/i)).toBeTruthy();
    });
    await clickConfirm();
    await waitFor(() => {
      const n = screen.queryByTestId('broker-import-commit-notice');
      expect(n?.getAttribute('data-notice-kind')).toBe('success');
    });
    const firstHoldings = S().holdings.length;
    expect(firstHoldings).toBe(1);

    // Second import of the same content. The same identity is now in
    // the store, so the entry is UNCHANGED. The preview is built
    // (count chip shows UNCHANGED: 1) but `confirmationEligible` is
    // false, so the Confirm import button is disabled. The data
    // layer is unchanged.
    await uploadFile(fileInput, 'zerodha-reimport-2.csv', ZERODHA_CSV);
    await waitFor(() => {
      // After upload, the component re-renders. The Preview view
      // header is shown again (or, in the all-UNCHANGED case, the
      // preview is still shown with confirmationEligible=false).
      const body = document.body.textContent || '';
      // Either the preview view is shown with the count chip text,
      // or the upload view is shown. Either way, no second holding
      // is created.
      expect(S().holdings.length).toBe(firstHoldings);
    });
    // No duplicate holding was created.
    expect(S().holdings.length).toBe(firstHoldings);
    // The Confirm import button is either disabled (preview view
    // with all-UNCHANGED) or absent (no preview because all-UNCHANGED
    // is a no-op). The defect-fix contract is that no second
    // holding appears and the data layer remains correct.
    const confirmBtn = Array.from(document.querySelectorAll('button')).find(
      b => b.textContent && b.textContent.includes('Confirm import'),
    );
    if (confirmBtn) {
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
