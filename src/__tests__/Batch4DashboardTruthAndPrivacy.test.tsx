import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialCommands } from '../application/commands';
import { repository } from '../repositories';
import { OverviewPage } from '../pages/OverviewPage';
import { MoneyPage } from '../pages/MoneyPage';
import { WealthPage } from '../pages/WealthPage';
import { EssentialsPage } from '../pages/EssentialsPage';
import { CalculatorsPage } from '../pages/CalculatorsPage';
import { Header } from '../components/Header';

describe('FINAPP Batch 4 — Step 8: Dashboard Truthfulness & Local Privacy Hygiene (DEF-07a, DEF-13a)', () => {
  beforeEach(async () => {
    useCanonicalLedger.setState({ privacyMasked: false });
    await IndexedDBStorageService.clearAll();
    await useCanonicalLedger.getState().initialize();
  });

  // =========================================================================
  // DEF-07a: Dashboard Truthfulness
  // =========================================================================
  describe('DEF-07a — Dashboard figures and indicators reflect canonical financial data', () => {
    it('OverviewPage, MoneyPage, WealthPage, and EssentialsPage render zero fabricated MoM strings or fake insurance cover', async () => {
      await FinancialCommands.recordAssetWithMetadata({ name: 'Nifty 50 Index ETF', amount: 250000, type: 'Equity' });
      await FinancialCommands.saveProfile({
        id: 'default-profile',
        monthlyIncome: 120000,
        monthlyExpenses: 40000,
        savingsRate: 67,
        targetEmergencyMonths: 6,
        updatedAt: '2026-08-20T00:00:00.000Z'
      });
      FinancialCommands.recordIncome('August Salary', 120000, 'HDFC Bank', 'SALARY');
      FinancialCommands.recordExpense('August Rent', 30000, 'HDFC Bank', 'Rent');
      await useCanonicalLedger.getState().initialize();

      const ov = render(<OverviewPage navigateTo={vi.fn()} />);
      const ovText = ov.container.textContent || '';
      expect(ovText).not.toContain('+8.32% vs last month');
      expect(ovText).not.toContain('+18.74% vs last month');
      expect(ovText).not.toContain('+20 pts vs last month');
      ov.unmount();

      const mp = render(<MoneyPage openModal={vi.fn()} openSidebarTab={vi.fn()} />);
      const mpText = mp.container.textContent || '';
      expect(mpText).not.toContain('+8.45% vs last month');
      expect(mpText).not.toContain('-5.32% vs last month');
      expect(mpText).not.toContain('+19.22% vs last month');
      expect(mpText).not.toContain('+6.5pp vs last month');
      mp.unmount();

      const wp = render(<WealthPage />);
      const wpText = wp.container.textContent || '';
      expect(wpText).not.toContain('+12.45%');
      wp.unmount();

      // Profile is configured, but ZERO insurance policies exist -> must NOT claim fake '₹1.5 Cr'
      const ep = render(<EssentialsPage />);
      const epText = ep.container.textContent || '';
      expect(epText).not.toContain('₹1.5 Cr');
      expect(epText).not.toContain('+20 pts vs last month');
      ep.unmount();
    });

    it('OverviewPage Investments card computes real unrealized gain/loss % from imported Holdings and hides rolled-back transactions from Recent widget', async () => {
      await repository.holdings.add({
        id: 'hld-truth-1',
        broker: 'ZERODHA',
        account: 'AB1234',
        isin: 'INE002A01018',
        instrumentName: 'Reliance Industries',
        securityClassification: 'Equity',
        quantity: 10,
        averageCost: 1000,
        investedValue: 10000,
        currentPrice: 1150,
        currentValue: 11500,
        unrealisedPnL: 1500,
        status: 'active',
        sourceFile: 'holdings.csv',
        importedAt: '2026-08-20T10:00:00.000Z'
      });

      const parsed = FinancialCommands.importStatement(
        'Date,Title,Narration,Amount,Type,Account\n2026-08-12,Rolled Back Row,RB-NARRATION,4200,EXPENSE,HDFC Bank',
        'HDFC Bank',
        'rb.csv'
      );
      await useCanonicalLedger.getState().rollbackImportBatch(parsed.batchId);

      const { container } = render(<OverviewPage navigateTo={vi.fn()} />);
      // Real gain: (11500 - 10000) / 10000 = +15.00% vs invested
      expect(container.textContent).toContain('+15.00% vs invested');
      // Rolled-back row is NOT shown in Overview Recent Transactions
      expect(container.textContent).not.toContain('Rolled Back Row');
    });
  });

  // =========================================================================
  // DEF-13a: Local Privacy Hygiene
  // =========================================================================
  describe('DEF-13a — Local privacy hygiene (zero external font beacons, zero hardcoded PII, complete privacy masking)', () => {
    it('index.html has zero external Google Fonts / third-party CDN links and Header/tests contain zero hardcoded personal names', () => {
      const indexHtml = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
      expect(indexHtml).not.toMatch(/fonts\.googleapis\.com/i);
      expect(indexHtml).not.toMatch(/fonts\.gstatic\.com/i);
      expect(indexHtml).not.toMatch(/https?:\/\//i);

      const headerSrc = readFileSync(resolve(__dirname, '../components/Header.tsx'), 'utf8');
      expect(headerSrc).not.toMatch(/Ramakrishnan/i);

      const growwTestSrc = readFileSync(resolve(__dirname, './GrowwHoldingsAdapter.test.ts'), 'utf8');
      expect(growwTestSrc).not.toMatch(/Ramakrishnan/i);
      expect(growwTestSrc).not.toMatch(/DKOPR8056J/i);

      const hdr = render(<Header toggleDark={vi.fn()} isDark={true} />);
      expect(hdr.container.textContent).toContain('Local Vault');
      expect(hdr.container.textContent).not.toContain('Ramakrishnan');
    });

    it('masks raw ₹ figures across Overview, Money, Wealth, Essentials, and Calculators when privacyMasked is active', async () => {
      await FinancialCommands.recordAssetWithMetadata({ name: 'Savings Corpus', amount: 845678, type: 'Cash & Savings' });
      FinancialCommands.recordIncome('Consulting Fee', 175432, 'HDFC Bank', 'DIVIDEND');
      FinancialCommands.recordExpense('Office Lease', 64321, 'HDFC Bank', 'Rent');
      await FinancialCommands.recordPolicy({
        type: 'Term Life',
        provider: 'LIC',
        coverAmount: 12345678,
        premiumAmount: 18500,
        status: 'Active'
      });
      await FinancialCommands.saveProfile({
        id: 'default-profile',
        monthlyIncome: 175432,
        monthlyExpenses: 64321,
        savingsRate: 63,
        targetEmergencyMonths: 6,
        updatedAt: '2026-08-20T00:00:00.000Z'
      });
      await useCanonicalLedger.getState().captureSnapshot();
      await useCanonicalLedger.getState().initialize();

      // Enable privacy masking
      useCanonicalLedger.setState({ privacyMasked: true });

      const ov = render(<OverviewPage navigateTo={vi.fn()} />);
      expect(ov.container.textContent).not.toContain('8,45,678');
      expect(ov.container.textContent).not.toContain('1,75,432');
      expect(ov.container.textContent).not.toContain('64,321');
      ov.unmount();

      const mp = render(<MoneyPage openModal={vi.fn()} openSidebarTab={vi.fn()} />);
      expect(mp.container.textContent).not.toContain('1,75,432');
      expect(mp.container.textContent).not.toContain('64,321');
      expect(mp.container.textContent).not.toContain('1,11,111');
      mp.unmount();

      const wp = render(<WealthPage />);
      expect(wp.container.textContent).not.toContain('8,45,678');
      expect(wp.container.textContent).not.toContain('1,75,432');
      wp.unmount();

      const ep = render(<EssentialsPage />);
      expect(ep.container.textContent).not.toContain('8,45,678');
      expect(ep.container.textContent).not.toContain('1,23,45,678');
      ep.unmount();

      const cp = render(<CalculatorsPage />);
      // 6 * 64,321 = 3,85,926 emergency fund goal must also be masked
      expect(cp.container.textContent).not.toContain('3,85,926');
      expect(cp.container.textContent).not.toContain('385926');
      cp.unmount();
    });

    it('togglePrivacy persists safely even when localStorage throws', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      try {
        expect(() => useCanonicalLedger.getState().togglePrivacy()).not.toThrow();
        expect(useCanonicalLedger.getState().privacyMasked).toBe(true);
      } finally {
        setItemSpy.mockRestore();
      }
    });
  });
});
