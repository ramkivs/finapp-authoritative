/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 * Tests for the Standard Import panel UI:
 *  - third sub-tab presence and isolation from broker/bank
 *  - template download produces a Blob with the exact header
 *  - Default Asset Class selector has no default value
 *  - upload + review + commit flow
 *  - read-only review (no cell editing)
 *  - source chips
 *  - unchanged-template INFO
 *  - import-history STANDARD_IMPORT recording
 *  - regression: broker / bank / dividend untouched
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

import { ImportPage } from '../pages/ImportPage';
import { StandardImportSection } from '../pages/StandardImportSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { ImportHistoryService } from '../services/ImportHistoryService';
import { repository } from '../repositories';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repo = repository as any;

const FIXTURE_DIR = resolve(__dirname, 'fixtures/standard_import');
function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf-8');
}

function makeFile(text: string, name: string): File {
  return new File([text], name, { type: 'text/csv' });
}

describe('M. Third sub-tab presence and isolation', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.assetsData = [];
    repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], assets: [], liabilities: [], holdings: [],
      filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
    ImportHistoryService.clear();
  });
  afterEach(() => { cleanup(); });

  it('M.1 the third sub-tab "Standard Import" exists and is reachable', () => {
    render(<ImportPage />);
    const stdTab = document.querySelector('[data-testid="import-subtab-standard"]') as HTMLButtonElement;
    expect(stdTab).toBeTruthy();
    expect(stdTab.textContent).toContain('Standard Import');
  });

  it('M.2 clicking the third sub-tab shows the Standard Import panel', () => {
    render(<ImportPage />);
    const stdTab = document.querySelector('[data-testid="import-subtab-standard"]') as HTMLButtonElement;
    fireEvent.click(stdTab);
    const panel = document.querySelector('[data-testid="import-subtab-panel-standard"]');
    expect(panel).toBeTruthy();
  });

  it('M.3 the broker and bank panels are NOT rendered when Standard is active', () => {
    render(<ImportPage />);
    const stdTab = document.querySelector('[data-testid="import-subtab-standard"]') as HTMLButtonElement;
    fireEvent.click(stdTab);
    expect(document.querySelector('[data-testid="import-subtab-panel-broker"]')).toBeNull();
    expect(document.querySelector('[data-testid="import-subtab-panel-bank"]')).toBeNull();
  });

  it('M.4 the third sub-tab does NOT contaminate the bank dividend-classification UI', () => {
    render(<ImportPage />);
    const stdTab = document.querySelector('[data-testid="import-subtab-standard"]') as HTMLButtonElement;
    fireEvent.click(stdTab);
    // The dividend-classification table is bank-only and must not appear here.
    expect(document.querySelector('[data-testid="dividend-classification-table"]')).toBeNull();
    expect(document.querySelector('[data-testid="dividend-classification-summary"]')).toBeNull();
  });
});

describe('N. Default Asset Class selector', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.assetsData = [];
    repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], assets: [], liabilities: [], holdings: [],
      filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
    ImportHistoryService.clear();
  });
  afterEach(() => { cleanup(); });

  it('N.1 the selector has no default value (placeholder is "— Select —")', () => {
    render(<StandardImportSection />);
    const sel = document.querySelector('[data-testid="standard-default-asset-class"]') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect(sel.value).toBe('');
    // The first option is the placeholder.
    const firstOption = sel.options[0];
    expect(firstOption.textContent).toBe('— Select —');
    expect(firstOption.value).toBe('');
  });

  it('N.2 the selector exposes all 20 governed values + the placeholder', () => {
    render(<StandardImportSection />);
    const sel = document.querySelector('[data-testid="standard-default-asset-class"]') as HTMLSelectElement;
    expect(sel.options.length).toBe(21); // placeholder + 20 governed values
  });

  it('N.3 selecting a default value updates the selector', () => {
    render(<StandardImportSection />);
    const sel = document.querySelector('[data-testid="standard-default-asset-class"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'Cash & Savings' } });
    expect(sel.value).toBe('Cash & Savings');
  });
});

describe('O. Template download', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.assetsData = [];
    repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], assets: [], liabilities: [], holdings: [],
      filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
    ImportHistoryService.clear();
  });
  afterEach(() => { cleanup(); });

  it('O.1 clicking the download button produces a Blob with the exact template content', () => {
    // Spy on Blob construction to capture the template content.
    const originalBlob = globalThis.Blob;
    let captured: any = null;
    const spy = vi.spyOn(globalThis, 'Blob').mockImplementation((parts: any, opts: any) => {
      captured = { parts, opts };
      return new originalBlob(parts, opts);
    });
    // Spy on URL.createObjectURL to prevent the actual download.
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });
    // Spy on anchor click.
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: any) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = clickSpy;
      }
      return el;
    });

    try {
      render(<StandardImportSection />);
      const btn = document.querySelector('[data-testid="standard-download-template"]') as HTMLButtonElement;
      fireEvent.click(btn);

      expect(captured).toBeTruthy();
      const text = (captured.parts as string[]).join('');
      // Header is exact.
      expect(text.split('\n')[0]).toBe('Asset Name,Current Value,Asset Class,Tag,Currency,Geography');
      // Exactly 2 example rows follow.
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBe(3);
      // MIME type.
      expect(captured.opts.type).toBe('text/csv;charset=utf-8;');
      // Anchor click was called.
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      createSpy.mockRestore();
    }
  });
});

describe('P. Upload + review flow', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.assetsData = [];
    repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], assets: [], liabilities: [], holdings: [],
      filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
    ImportHistoryService.clear();
  });
  afterEach(() => { cleanup(); });

  it('P.1 uploading a valid CSV produces a review table with N rows', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_with_asset_class.csv'), 'sample.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    // Wait for the async file read.
    await new Promise((r) => setTimeout(r, 50));
    const table = document.querySelector('[data-testid="standard-review-table"]');
    expect(table).toBeTruthy();
    const rows = document.querySelectorAll('[data-testid^="standard-review-row-"]');
    expect(rows.length).toBe(6);
  });

  it('P.2 the review table is read-only (no editable inputs)', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_with_asset_class.csv'), 'sample.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    // No <input> or <select> in the review table itself.
    const table = document.querySelector('[data-testid="standard-review-table"]') as HTMLTableElement;
    expect(table.querySelectorAll('input').length).toBe(0);
    expect(table.querySelectorAll('select').length).toBe(0);
  });

  it('P.3 per-row source chips render the correct label', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_with_asset_class.csv'), 'sample.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    const chip0 = document.querySelector('[data-testid="standard-row-source-chip-0"]');
    expect(chip0?.textContent).toContain('CSV');
  });

  it('P.4 unchanged template shows the friendly INFO notice', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('standard_template.csv'), 'standard_template.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    const notice = document.querySelector('[data-testid="standard-template-unchanged"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('template');
  });

  it('P.5 invalid Asset Class + UI default -> per-row chip reads "Default (was invalid)"', async () => {
    render(<StandardImportSection />);
    // Set the default first.
    const sel = document.querySelector('[data-testid="standard-default-asset-class"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'Cash & Savings' } });
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_invalid_asset_class.csv'), 'invalid.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    // Row 1 in the fixture is "Random Junk" with class "NotARealClass".
    const chip1 = document.querySelector('[data-testid="standard-row-source-chip-1"]');
    expect(chip1?.textContent).toContain('Default');
  });
});

describe('Q. Commit + import-history recording', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.assetsData = [];
    repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], assets: [], liabilities: [], holdings: [],
      filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
    ImportHistoryService.clear();
  });
  afterEach(() => { cleanup(); });

  it('Q.1 committing a valid CSV writes the assets to the canonical Asset[]', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_with_asset_class.csv'), 'sample.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    const commitBtn = document.querySelector('[data-testid="standard-commit"]') as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(commitBtn);
    });
    // Wait for the async commit.
    await new Promise((r) => setTimeout(r, 100));
    // Check the assets were written.
    const assets = useCanonicalLedger.getState().assets as any[];
    expect(assets.length).toBe(6);
  });

  it('Q.2 committing records a STANDARD_IMPORT entry in the import history', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_with_asset_class.csv'), 'sample.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    const commitBtn = document.querySelector('[data-testid="standard-commit"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(commitBtn);
    });
    await new Promise((r) => setTimeout(r, 100));
    const entries = ImportHistoryService.list();
    const std = entries.find((e) => e.importType === 'STANDARD_IMPORT');
    expect(std).toBeDefined();
    expect(std!.importedCount).toBe(6);
    expect(std!.sourceFilename).toBe('sample.csv');
  });

  it('Q.3 the commit-success message includes the V1 no-rollback note', async () => {
    render(<StandardImportSection />);
    const input = document.querySelector('[data-testid="standard-file-input"]') as HTMLInputElement;
    const file = makeFile(loadFixture('sample_with_asset_class.csv'), 'sample.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await new Promise((r) => setTimeout(r, 50));
    const commitBtn = document.querySelector('[data-testid="standard-commit"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(commitBtn);
    });
    await new Promise((r) => setTimeout(r, 100));
    const notice = document.querySelector('[data-testid="standard-commit-notice"]');
    expect(notice?.textContent).toContain('rollback');
  });
});

describe('R. ImportHistoryType union: STANDARD_IMPORT accepted', () => {
  it('R.1 ImportHistoryService.record accepts importType: "STANDARD_IMPORT"', () => {
    const e = ImportHistoryService.record({
      importType: 'STANDARD_IMPORT',
      institution: 'Standard Import',
      sourceFilename: 'sample.csv',
      result: 'success',
      processedCount: 6,
      importedCount: 6,
      rejectedCount: 0
    });
    expect(e.importType).toBe('STANDARD_IMPORT');
    expect(e.importedCount).toBe(6);
  });
});

describe('S. Regression: broker / bank / dividend flows are untouched', () => {
  beforeEach(() => {
    repo.transactionsData = []; repo.accountsData = []; repo.assetsData = [];
    repo.syncStore();
    useCanonicalLedger.setState({
      transactions: [], accounts: [], assets: [], liabilities: [], holdings: [],
      filterType: 'All', dateRange: 'YTD', searchQuery: ''
    } as any);
    ImportHistoryService.clear();
  });
  afterEach(() => { cleanup(); });

  it('S.1 the default sub-tab is still broker (Standard is third, not first)', () => {
    render(<ImportPage />);
    const brokerTab = document.querySelector('[data-testid="import-subtab-broker"]') as HTMLButtonElement;
    expect(brokerTab.getAttribute('aria-selected')).toBe('true');
  });

  it('S.2 the bank sub-tab still renders the existing bank flow', () => {
    render(<ImportPage />);
    const bankTab = document.querySelector('[data-testid="import-subtab-bank"]') as HTMLButtonElement;
    fireEvent.click(bankTab);
    const bankPanel = document.querySelector('[data-testid="import-subtab-panel-bank"]');
    expect(bankPanel).toBeTruthy();
  });
});
