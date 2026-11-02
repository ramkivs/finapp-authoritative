import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { DateNormalizer } from '../services/import/normalization/DateNormalizer';
import { AmountNormalizer } from '../services/import/normalization/AmountNormalizer';
import { ImportPipelineService } from '../services/ImportPipelineService';
import {
  TransactionIdentityService,
  FINGERPRINT_VERSION,
  FINGERPRINT_FIELDS
} from '../services/TransactionIdentityService';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { LiquidReservesService } from '../services/LiquidReservesService';
import { FinancialCommands } from '../application/commands';
import { FinancialQueries } from '../application/queries';
import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { BudgetWorkspace } from '../components/money/BudgetWorkspace';
import { ImportPage } from '../pages/ImportPage';

describe('FINAPP Batch 4 — Step 7: Bank Transaction Integrity (DEF-14, DEF-15, DEF-16, DEF-17)', () => {
  beforeEach(async () => {
    await IndexedDBStorageService.clearAll();
    await useCanonicalLedger.getState().initialize();
  });

  // =========================================================================
  // DEF-14: Bank Transaction Deduplication
  // =========================================================================
  describe('DEF-14 — Bank transaction deduplication', () => {
    it('preserves FINGERPRINT_VERSION = 1 and FINGERPRINT_FIELDS invariant while disambiguating distinct same-day referenceNumbers', () => {
      expect(FINGERPRINT_VERSION).toBe(1);
      expect([...FINGERPRINT_FIELDS]).toEqual(['account', 'date', 'amount', 'narration']);

      const hdfcSameDayDistinctRefs = [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '18/08/2026,UPI-STARBUCKS COFFEE,000011112222,18/08/2026,450.00,,49550.00',
        '18/08/2026,UPI-STARBUCKS COFFEE,000011113333,18/08/2026,450.00,,49100.00'
      ].join('\n');

      const firstRun = ImportPipelineService.processCSV(
        hdfcSameDayDistinctRefs,
        [],
        'HDFC Bank',
        'HDFC_Aug2026.csv'
      );
      expect(firstRun.validRows).toHaveLength(2);
      expect(firstRun.duplicateCount).toBe(0);
      expect(firstRun.validRows[0].referenceNumber).toBe('11112222');
      expect(firstRun.validRows[1].referenceNumber).toBe('11113333');
      expect(firstRun.validRows[0].closingBalance).toBe(49550);
      expect(firstRun.validRows[1].closingBalance).toBe(49100);

      // Commit both rows to the canonical ledger
      const commitRes = useCanonicalLedger.getState().commitImportedRows(firstRun.validRows);
      expect(commitRes.appended).toBe(2);
      expect(commitRes.duplicates).toBe(0);

      // Re-importing the exact same statement skips both rows as duplicates
      const ledgerRows = useCanonicalLedger.getState().transactions;
      const secondRun = ImportPipelineService.processCSV(
        hdfcSameDayDistinctRefs,
        ledgerRows,
        'HDFC Bank',
        'HDFC_Aug2026_Reimport.csv'
      );
      expect(secondRun.validRows).toHaveLength(0);
      expect(secondRun.duplicateCount).toBe(2);
    });

    it('uses 1-to-1 multiset pool consumption on overlapping statement imports with a 3rd same-day repeat', () => {
      const day1Csv = [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '18/08/2026,UPI-METRO RECHARGE,-,18/08/2026,200.00,,9800.00',
        '18/08/2026,UPI-METRO RECHARGE,-,18/08/2026,200.00,,9600.00'
      ].join('\n');

      const r1 = ImportPipelineService.processCSV(day1Csv, [], 'HDFC Bank', 'day1.csv');
      expect(r1.validRows).toHaveLength(2);
      useCanonicalLedger.getState().commitImportedRows(r1.validRows);

      // Overlapping export has those 2 existing rows plus a 3rd genuine metro recharge
      const overlappingCsv = [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '18/08/2026,UPI-METRO RECHARGE,-,18/08/2026,200.00,,9800.00',
        '18/08/2026,UPI-METRO RECHARGE,-,18/08/2026,200.00,,9600.00',
        '18/08/2026,UPI-METRO RECHARGE,-,18/08/2026,200.00,,9400.00'
      ].join('\n');

      const r2 = ImportPipelineService.processCSV(
        overlappingCsv,
        useCanonicalLedger.getState().transactions,
        'HDFC Bank',
        'overlapping.csv'
      );
      expect(r2.duplicateCount).toBe(2);
      expect(r2.validRows).toHaveLength(1);
      expect(r2.validRows[0].closingBalance).toBe(9400);
    });

    it('preserves cross-format deduplication when a native bank row with ref is re-imported via Generic CSV without ref', () => {
      const hdfcCsv = [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '19/08/2026,ACH/C/INFOSYS DIVIDEND,99887766,19/08/2026,,1800.00,61800.00'
      ].join('\n');
      const r1 = ImportPipelineService.processCSV(hdfcCsv, [], 'HDFC Bank', 'hdfc.csv');
      expect(r1.validRows).toHaveLength(1);

      const genericCsv = [
        'Date,Narration,Amount,Type,Account',
        '2026-08-19,ACH/C/INFOSYS DIVIDEND,1800,INCOME,HDFC Bank'
      ].join('\n');
      const r2 = ImportPipelineService.processCSV(genericCsv, r1.validRows, 'HDFC Bank', 'generic.csv');
      expect(r2.validRows).toHaveLength(0);
      expect(r2.duplicateCount).toBe(1);
    });

    it('normalizes placeholder reference values to null so placeholders never defeat deduplication', () => {
      for (const placeholder of ['', '-', '--', 'N/A', 'NA', 'NIL', 'NULL', '0', '00000000']) {
        expect(TransactionIdentityService.normalizeReferenceNumber(placeholder)).toBeNull();
      }
      expect(TransactionIdentityService.normalizeReferenceNumber('0000123456')).toBe('123456');
      expect(TransactionIdentityService.normalizeReferenceNumber(' utr-98765a ')).toBe('UTR-98765A');
    });
  });

  // =========================================================================
  // DEF-15: Transaction Exclusions
  // =========================================================================
  describe('DEF-15 — Transaction exclusions across re-import, reconciliation, budgets, and pre-commit review', () => {
    it('allows clean re-import after batch rollback and excludes rolled-back/superseded rows from reconciliation & budgets', async () => {
      const csv = [
        'Date,Title,Narration,Amount,Type,Category,Account',
        '2026-07-15,Grocery Store,UPI/GROCERY/JULY,6000,EXPENSE,Groceries,Unregistered Bank',
        '2026-08-10,Supermarket,UPI/GROCERY/AUG,3000,EXPENSE,Groceries,Unregistered Bank'
      ].join('\n');

      const parsed = ImportPipelineService.processCSV(csv, [], 'HDFC Bank', 'groceries.csv');
      expect(parsed.validRows).toHaveLength(2);

      const commit1 = useCanonicalLedger.getState().commitImportedRows(parsed.validRows);
      if (commit1.persisted) await commit1.persisted;
      expect(commit1.appended).toBe(2);

      // Before rollback: unmapped reconciliation and auto-suggest budget include the imported rows
      const reconBefore = AccountBalanceService.reconciliation(
        useCanonicalLedger.getState().accounts,
        useCanonicalLedger.getState().transactions,
        '2026-08-31'
      );
      expect(reconBefore.unmappedCount).toBe(2);
      expect(FinancialCommands.autoSuggestBudget('2026-08').totalBudget).toBe(2000); // 6000 / 3

      // Roll back the batch
      await useCanonicalLedger.getState().rollbackImportBatch(parsed.batchId);

      // After rollback: reconciliation and budget derivations MUST exclude the rolled-back rows
      const reconAfter = AccountBalanceService.reconciliation(
        useCanonicalLedger.getState().accounts,
        useCanonicalLedger.getState().transactions,
        '2026-08-31'
      );
      expect(reconAfter.unmappedCount).toBe(0);
      expect(reconAfter.unmappedGross).toBe(0);
      expect(FinancialCommands.autoSuggestBudget('2026-08').totalBudget).toBe(0);

      // BudgetWorkspace actual spending also excludes rolled-back rows
      const { container } = render(
        <BudgetWorkspace
          transactions={useCanonicalLedger.getState().transactions}
          budgets={[]}
        />
      );
      expect(container.textContent).not.toContain('3,000');

      // Re-importing the exact same CSV after rollback MUST NOT be blocked as duplicates
      const reimportParsed = ImportPipelineService.processCSV(
        csv,
        useCanonicalLedger.getState().transactions,
        'HDFC Bank',
        'groceries_reimport.csv'
      );
      expect(reimportParsed.duplicateCount).toBe(0);
      expect(reimportParsed.validRows).toHaveLength(2);

      const commit2 = useCanonicalLedger.getState().commitImportedRows(reimportParsed.validRows);
      if (commit2.persisted) await commit2.persisted;
      expect(commit2.appended).toBe(2);
    });

    it('supports pre-commit per-row exclusion on ImportPage without dropping non-excluded rows', async () => {
      render(<ImportPage />);
      fireEvent.click(screen.getByTestId('import-subtab-bank'));
      fireEvent.click(screen.getByText('Simulate Upload'));

      // Sample CSV has 5 valid rows initially
      const commitBtn = document.getElementById('btn-commit-import')!;
      expect(commitBtn.textContent).toContain('5 Valid Rows');

      const excludeBoxes = document.querySelectorAll('input[data-exclude-row]');
      expect(excludeBoxes.length).toBe(5);

      // Exclude row 5 (the hostile payload demo row)
      fireEvent.click(excludeBoxes[4]);
      expect(commitBtn.textContent).toContain('4 Valid Rows');

      fireEvent.click(commitBtn);
      await waitFor(() => {
        expect(screen.getByText(/Import committed\./i)).toBeTruthy();
      });
      expect(screen.getByText(/Appended 4 new rows/i)).toBeTruthy();
      expect(screen.getByText(/Skipped 1 user-excluded row\./i)).toBeTruthy();
      expect(useCanonicalLedger.getState().transactions).toHaveLength(4);
    });
  });

  // =========================================================================
  // DEF-16: Transaction Dates
  // =========================================================================
  describe('DEF-16 — Strict calendar validation & bank statement date formats', () => {
    it('rejects impossible calendar and non-leap-year dates while accepting valid leap days', () => {
      expect(DateNormalizer.normalize('31/02/2026')).toBeNull();
      expect(DateNormalizer.normalize('29/02/2026')).toBeNull(); // 2026 is not a leap year
      expect(DateNormalizer.normalize('29/02/2024')).toBe('2024-02-29'); // 2024 is a leap year
      expect(DateNormalizer.normalize('31/04/2026')).toBeNull();
      expect(DateNormalizer.normalize('2026-02-30')).toBeNull();
      expect(DateNormalizer.normalize('15/13/2026')).toBeNull();
      expect(DateNormalizer.normalize('00/08/2026')).toBeNull();
    });

    it('normalizes textual Indian bank months, dot separators, and timestamp suffixes', () => {
      expect(DateNormalizer.normalize('18-Aug-2026')).toBe('2026-08-18');
      expect(DateNormalizer.normalize('5 Sep 2026')).toBe('2026-09-05');
      expect(DateNormalizer.normalize('09-Jan-26')).toBe('2026-01-09');
      expect(DateNormalizer.normalize('Aug 18, 2026')).toBe('2026-08-18');
      expect(DateNormalizer.normalize('18.08.2026')).toBe('2026-08-18');
      expect(DateNormalizer.normalize('18/08/2026 14:35:22')).toBe('2026-08-18');
      expect(DateNormalizer.normalize('2026-08-18T09:15:00.000Z')).toBe('2026-08-18');
    });

    it('parses binary workbooks with >20 preamble metadata rows without losing transactions', () => {
      const preamble: string[][] = Array.from({ length: 22 }, (_, i) => [
        `Metadata Field ${i + 1}`,
        i === 0 ? 'State Bank of India' : `Value ${i + 1}`
      ]);
      const headers = ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'];
      const dataRows = [
        ['18-Aug-2026', '18-Aug-2026', 'OPENING BALANCE', '', '', '', '50,000.00'],
        ['19-Aug-2026', '19-Aug-2026', 'ACH/C/TCS DIVIDEND', 'UTR889900', '', '2,400.00', '52,400.00']
      ];

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([...preamble, headers, ...dataRows]);
      XLSX.utils.book_append_sheet(wb, ws, 'Statement');
      const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

      const res = ImportPipelineService.processBinaryFile(bytes, [], 'SBI Bank', 'SBI_LongPreamble.xlsx');
      expect(res.unsupportedFormat).toBeFalsy();
      expect(res.invalidCount).toBe(0); // OPENING BALANCE skipped cleanly
      expect(res.validRows).toHaveLength(1);
      expect(res.validRows[0].date).toBe('2026-08-19');
      expect(res.validRows[0].amount).toBe(2400);
    });
  });

  // =========================================================================
  // DEF-17: Transaction Amounts and PPF Handling
  // =========================================================================
  describe('DEF-17 — Strict amount parsing, Cr/Dr indicators, and PPF handling', () => {
    it('parses Indian commas, currency prefixes, parentheses, and Cr/Dr tokens while flagging malformed amounts as INVALID_AMOUNT', () => {
      expect(AmountNormalizer.parseStrict('₹ 1,50,000.50 Cr')).toEqual({
        valid: true,
        empty: false,
        value: 150000.5,
        indicator: 'CR'
      });
      expect(AmountNormalizer.parseStrict('Rs. (2,500.00)')).toEqual({
        valid: true,
        empty: false,
        value: -2500,
        indicator: null
      });
      expect(AmountNormalizer.parseStrict('12abc').valid).toBe(false);
      expect(AmountNormalizer.parseStrict('1,200.50.25').valid).toBe(false);

      const badCsv = [
        'Date,Title,Narration,Amount,Type,Account',
        '2026-08-15,Broken Row,CORRUPT-AMT,12abc,EXPENSE,HDFC Bank',
        '2026-08-16,Valid Row,VALID-AMT,"₹ 1,25,000.00",INCOME,HDFC Bank'
      ].join('\n');

      const res = ImportPipelineService.processCSV(badCsv, [], 'HDFC Bank', 'amounts.csv');
      expect(res.invalidCount).toBe(1);
      expect(res.invalidRows[0].code).toBe('INVALID_AMOUNT');
      expect(res.validRows).toHaveLength(1);
      expect(res.validRows[0].amount).toBe(125000);
    });

    it('classifies savings bank PPF debits as INVESTMENT and PPF statement deposits vs interest without inflating earned income or liquid reserves', async () => {
      // 1. Regular HDFC savings bank statement transferring ₹1,50,000 to PPF
      const savingsCsv = [
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '05/08/2026,NEFT DR-SBIN0000300-PUBLIC PROVIDENT FUND,HDFCPPF2026,05/08/2026,"1,50,000.00",,"3,50,000.00"'
      ].join('\n');

      const bankRes = ImportPipelineService.processCSV(savingsCsv, [], 'HDFC Bank', 'HDFC_Savings.csv');
      expect(bankRes.validRows).toHaveLength(1);
      expect(bankRes.validRows[0].type).toBe('Expense');
      expect(bankRes.validRows[0].category).toBe('INVESTMENT');
      expect(bankRes.validRows[0].amount).toBe(150000);

      // 2. SBI PPF passbook workbook (no cheque column, single Amount + Dr/Cr or Credit column)
      const ppfRows = [
        ['State Bank of India - PPF Account Statement', '', '', '', ''],
        ['Account Type', 'PPF Account', '', '', ''],
        ['Date', 'Details', 'Debit', 'Credit', 'Balance'],
        ['01-Apr-2026', 'OPENING BALANCE', '', '', '5,00,000.00'],
        ['05-Aug-2026', 'BY TRANSFER - PPF SUBSCRIPTION DEPOSIT', '', '1,50,000.00', '6,50,000.00'],
        ['15-Aug-2026', 'BY INTEREST PAID FOR FY', '', '46,150.00', '6,96,150.00']
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ppfRows), 'PPF');
      const ppfBytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

      const ppfRes = ImportPipelineService.processBinaryFile(ppfBytes, [], 'SBI Bank', 'SBI_PPF_Passbook.xlsx');
      expect(ppfRes.unsupportedFormat).toBeFalsy();
      expect(ppfRes.invalidCount).toBe(0);
      expect(ppfRes.validRows).toHaveLength(2);

      const [depositTx, interestTx] = ppfRes.validRows;
      expect(depositTx.account).toBe('SBI PPF');
      expect(depositTx.type).toBe('Income');
      expect(depositTx.category).toBe('PPF_CONTRIBUTION');
      expect(depositTx.amount).toBe(150000);

      expect(interestTx.account).toBe('SBI PPF');
      expect(interestTx.type).toBe('Income');
      expect(interestTx.category).toBe('INTEREST');
      expect(interestTx.amount).toBe(46150);

      // Register SBI PPF account & HDFC Bank account and commit both imports
      const hdfcAcc = await FinancialCommands.recordAccount({
        name: 'HDFC Bank',
        type: 'Bank',
        openingBalance: 500000,
        asOfDate: '2026-07-01'
      });
      const ppfAcc = await FinancialCommands.recordAccount({
        name: 'SBI PPF',
        type: 'Other',
        institution: 'SBI PPF',
        openingBalance: 500000,
        asOfDate: '2026-07-01'
      });
      await useCanonicalLedger.getState().initialize();

      const c1 = useCanonicalLedger.getState().commitImportedRows([...bankRes.validRows, ...ppfRes.validRows]);
      if (c1.persisted) await c1.persisted;

      // Verify PPF account balance includes both principal deposit and interest
      const ppfBal = AccountBalanceService.balance(
        ppfAcc.id,
        useCanonicalLedger.getState().accounts,
        useCanonicalLedger.getState().transactions,
        '2026-08-31'
      );
      expect(ppfBal?.balance).toBe(696150);

      // Verify earned totalIncome counts ONLY PPF interest (46,150), NOT principal PPF_CONTRIBUTION (1,50,000),
      // while totalInvested reflects the 1,50,000 investment outflow
      const insights = FinancialQueries.getMoneyInsights('Custom', '2026-08-01', '2026-08-31');
      expect(insights.totalIncome).toBe(46150);
      expect(insights.totalInvested).toBe(150000);

      // Even if a user registers a PPF account as 'Bank', LiquidReservesService excludes locked PPF accounts
      const ppfMislabelledBank = await FinancialCommands.recordAccount({
        name: 'ICICI PPF Account',
        type: 'Bank',
        openingBalance: 800000,
        asOfDate: '2026-07-01'
      });
      const liquid = LiquidReservesService.compute(
        [],
        [hdfcAcc, ppfAcc, ppfMislabelledBank],
        useCanonicalLedger.getState().transactions,
        '2026-08-31'
      );
      // Only HDFC Bank (5,00,000 - 1,50,000 = 3,50,000) is liquid
      expect(liquid.accountsTotal).toBe(350000);
    });
  });
});
