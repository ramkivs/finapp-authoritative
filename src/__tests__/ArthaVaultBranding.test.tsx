import 'fake-indexeddb/auto';
import React from 'react';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import App from '../App';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { SettingsPage } from '../pages/SettingsPage';
import { ARTHAVAULT_TOKENS, FINBOOM_TOKENS } from '../design/tokens';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import {
  BACKUP_FORMAT_ID,
  LAST_BACKUP_RECEIPT_STORAGE_KEY,
  LocalBackupService,
} from '../services/LocalBackupService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { repository } from '../repositories';
import { useCanonicalLedger, runStartupInitialization } from '../store/useCanonicalLedger';

const REPO_ROOT = resolve(__dirname, '../..');
const SRC_ROOT = resolve(__dirname, '..');

function walkSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const name of entries) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ArthaVault Application Rebranding & Compatibility Verification', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
    (IndexedDBStorageService as any).simulateFailureOnce = false;
    (IndexedDBStorageService as any).simulateQueueFailureOnce = false;
    (IndexedDBStorageService as any).simulateReadFailureOnce = false;
    await IndexedDBStorageService.clearAll();
    await useCanonicalLedger.getState().initialize();
  });

  it('1. Browser title, HTML metadata, package metadata, and SVG favicon reflect ArthaVault with zero external URLs', () => {
    const indexHtml = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
    expect(indexHtml).toContain('<title>ArthaVault');
    expect(indexHtml).toContain('<meta name="application-name" content="ArthaVault" />');
    expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(indexHtml).not.toMatch(/finboom/i);
    expect(indexHtml).not.toMatch(/https?:\/\//i);

    const faviconPath = join(REPO_ROOT, 'public/favicon.svg');
    expect(existsSync(faviconPath)).toBe(true);
    const faviconSvg = readFileSync(faviconPath, 'utf8');
    expect(faviconSvg).toContain('aria-label="ArthaVault"');
    expect(faviconSvg).toContain('>AV</text>');
    expect(faviconSvg).not.toMatch(/finboom/i);

    const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkgJson.name).toBe('arthavault');
    expect(ARTHAVAULT_TOKENS).toBeDefined();
    expect(FINBOOM_TOKENS).toBe(ARTHAVAULT_TOKENS);
  });

  it('2. Shipped frontend code contains zero non-technical FinBoom strings while preserving finboom_db and finboom.local-backup', () => {
    const files = walkSourceFiles(SRC_ROOT);
    const offendingHits: Array<{ file: string; snippet: string }> = [];

    for (const file of files) {
      const codeOnly = stripComments(readFileSync(file, 'utf8'))
        .replace(/'finboom_db'|\"finboom_db\"/g, '')
        .replace(/'finboom\.local-backup'|\"finboom\.local-backup\"/g, '')
        .replace(/\bFINBOOM_TOKENS\b/g, '');

      const match = codeOnly.match(/finboom/i);
      if (match) {
        offendingHits.push({
          file: file.slice(REPO_ROOT.length + 1),
          snippet: match[0],
        });
      }
    }

    expect(offendingHits).toEqual([]);
  });

  it('3. Sidebar, Header, Footer, dialogs, StartupNotice, and all primary pages render ArthaVault and zero FinBoom branding', async () => {
    // Verify Sidebar expanded, collapsed, and Load Demo Data dialog copy
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const sbExpanded = render(<Sidebar activeTab="overview" setActiveTab={vi.fn()} />);
    expect(sbExpanded.container.textContent).toContain('ArthaVault');
    expect(sbExpanded.container.textContent).not.toMatch(/finboom/i);

    fireEvent.click(sbExpanded.container.querySelector('#btn-load-demo-data')!);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain('ArthaVault');
    expect(confirmSpy.mock.calls[0][0]).not.toMatch(/finboom/i);
    sbExpanded.unmount();

    const sbCollapsed = render(
      <Sidebar activeTab="overview" setActiveTab={vi.fn()} isCollapsed={true} />
    );
    expect(sbCollapsed.container.querySelector('[title="ArthaVault"]')).toBeTruthy();
    expect(sbCollapsed.container.textContent).not.toMatch(/finboom/i);
    sbCollapsed.unmount();

    // Verify Header identity & Local Vault disclosure
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const hdr = render(<Header toggleDark={vi.fn()} isDark={true} />);
    expect(hdr.container.textContent).toContain('ArthaVault');
    expect(hdr.container.textContent).toContain('Local Vault');
    expect(hdr.container.textContent).not.toMatch(/finboom/i);
    fireEvent.click(hdr.container.querySelector('#btn-user-profile')!);
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('ArthaVault'));
    hdr.unmount();

    // Mount full App and navigate across every primary screen + Import sub-tabs + StartupNotice
    const appView = render(<App />);
    await act(async () => {
      await runStartupInitialization();
    });

    const navIds = [
      '#sidebar-nav-overview',
      '#sidebar-nav-wealth',
      '#sidebar-nav-money',
      '#sidebar-nav-essentials',
      '#sidebar-nav-import',
      '#sidebar-nav-calculators',
      '#sidebar-nav-settings',
    ];

    for (const selector of navIds) {
      const btn = appView.container.querySelector(selector) as HTMLElement;
      expect(btn).toBeTruthy();
      fireEvent.click(btn);
      expect(appView.container.textContent).toContain('ArthaVault');
      expect(appView.container.textContent).not.toMatch(/finboom/i);
    }

    // Also check failed-startup banner inside App
    await act(async () => {
      useCanonicalLedger.setState({
        initStatus: 'failed',
        initError: 'Simulated blocked IndexedDB',
      } as any);
    });
    expect(appView.container.querySelector('#startup-notice')).toBeTruthy();
    expect(appView.container.textContent).not.toMatch(/finboom/i);
  });

  it('4. Preserves existing IndexedDB data (finboom_db), localStorage keys, fingerprints, and legacy finboom-backup-*.json restore compatibility', async () => {
    // 1) Confirm technical identifiers remain untouched
    expect(BACKUP_FORMAT_ID).toBe('finboom.local-backup');
    expect(LAST_BACKUP_RECEIPT_STORAGE_KEY).toBe('finapp.backup.lastReceipt');

    // 2) Confirm direct IndexedDB ('finboom_db') records remain accessible on startup
    await IndexedDBStorageService.saveAll({
      transactions: [
        {
          id: 'tx-pre-rebrand-1',
          date: '2026-09-15',
          dateStr: '15 Sep 2026',
          title: 'Pre-Rebrand Salary',
          narration: 'NEFT/SALARY/SEP',
          account: 'HDFC Bank',
          direction: 'CREDIT',
          type: 'Income',
          category: 'SALARY',
          amount: 140_000,
          status: 'CLEARED',
        },
      ],
      assets: [{ id: 'ast-pre-rebrand-1', name: 'PPF Account', amount: 650_000, type: 'Debt' }],
      liabilities: [],
      holdings: [
        {
          id: 'hld-pre-rebrand-1',
          broker: 'Zerodha',
          account: 'ZR77',
          instrumentName: 'Reliance Industries',
          ticker: 'RELIANCE',
          quantity: 25,
          averageCost: 2400,
          investedValue: 60_000,
          currentPrice: 2800,
          currentValue: 70_000,
          unrealisedPnL: 10_000,
          status: 'active',
          sourceFile: 'zerodha.csv',
          importedAt: '2026-09-15T10:00:00.000Z',
        },
      ],
      holdingDeletionLog: [],
      snapshots: [],
      accounts: [{ id: 'acc-pre-rebrand-1', name: 'HDFC Bank', type: 'Bank', openingBalance: 25_000, linkedAssetId: null }],
      budgets: [],
      policies: [],
      goals: [],
      profile: null,
    });

    // Verify raw IndexedDB database name is literally 'finboom_db'
    const dbRecordCount = await new Promise<number>((resolveCount, rejectCount) => {
      const req = window.indexedDB.open('finboom_db');
      req.onerror = () => rejectCount(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('transactions', 'readonly');
        const countReq = tx.objectStore('transactions').count();
        countReq.onsuccess = () => {
          db.close();
          resolveCount(countReq.result);
        };
      };
    });
    expect(dbRecordCount).toBe(1);

    await useCanonicalLedger.getState().initialize();
    expect(useCanonicalLedger.getState().transactions).toHaveLength(1);
    expect(useCanonicalLedger.getState().holdings).toHaveLength(1);

    // 3) Export backup (verifying new arthavault-backup-*.json filename + preserved 'finboom.local-backup' format)
    const exported = await repository.exportBackup({
      createdAt: '2026-10-01T08:00:00.000Z',
    });
    expect(exported.fileName).toBe('arthavault-backup-2026-10-01T08-00-00-000Z.json');
    expect(exported.envelope.manifest.format).toBe('finboom.local-backup');

    // 4) Clear local data and restore from a previously generated 'finboom-backup-*.json' file via SettingsPage UI
    await act(async () => {
      await useCanonicalLedger.getState().clearLocalData();
    });
    expect(useCanonicalLedger.getState().transactions).toHaveLength(0);

    render(<SettingsPage />);
    expect(screen.getByTestId('settings-page').textContent).toContain('ArthaVault');

    const legacyNamedBackupFile = new File(
      [exported.json],
      'finboom-backup-2026-10-01T08-00-00-000Z.json',
      { type: 'application/json' }
    );
    fireEvent.change(screen.getByTestId('input-restore-backup-file'), {
      target: { files: [legacyNamedBackupFile] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('backup-verify-preview')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('btn-confirm-restore-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('backup-restore-success')).toBeTruthy();
    });
    expect(useCanonicalLedger.getState().transactions).toHaveLength(1);
    expect(useCanonicalLedger.getState().assets).toHaveLength(1);
    expect(useCanonicalLedger.getState().holdings).toHaveLength(1);

    // 5) Canonical transaction fingerprint remains byte-identical across rebranding
    expect(
      TransactionIdentityService.canonicalString(
        useCanonicalLedger.getState().transactions[0]
      )
    ).toBe('HDFC Bank|2026-09-15|140000|neft/salary/sep');
  });
});
