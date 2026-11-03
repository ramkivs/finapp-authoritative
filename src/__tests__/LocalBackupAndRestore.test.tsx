import 'fake-indexeddb/auto';
import React from 'react';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { repository } from '../repositories';
import { MemoryRepository } from '../repositories/MemoryRepository';
import { useCanonicalLedger, runStartupInitialization } from '../store/useCanonicalLedger';
import { FinancialCommands } from '../application/commands';
import { HoldingWealthBridge } from '../services/HoldingWealthBridge';
import { LedgerExclusionService } from '../services/LedgerExclusionService';
import { JcsSerializationService } from '../services/mathematics/JcsSerializationService';
import {
  BACKUP_CANONICALIZATION,
  BACKUP_DB_VERSION,
  BACKUP_FORMAT_ID,
  BACKUP_HASH_ALGORITHM,
  BACKUP_SCHEMA_VERSION,
  BackupValidationError,
  LocalBackupData,
  LocalBackupService,
  computeIntegrityDigestHex,
  computeRfc6234DigestHex,
} from '../services/LocalBackupService';
import { SettingsPage } from '../pages/SettingsPage';
import { Sidebar } from '../components/Sidebar';
import App from '../App';
import type {
  Account,
  Asset,
  FinancialGoal,
  FinancialProfile,
  Holding,
  HoldingDeletionLogEntry,
  InsurancePolicy,
  Liability,
  MonthlyBudget,
  NetWorthSnapshot,
  Transaction,
} from '../domain/types';

function buildCompleteCanonicalDataset(): LocalBackupData {
  const accounts: Account[] = [
    {
      id: 'acc-hdfc-savings',
      name: 'HDFC Savings',
      type: 'Bank',
      institution: 'HDFC Bank',
      lastFourDigits: '4921',
      openingBalance: 125_000,
      currency: 'INR',
      asOfDate: '2026-04-01',
      linkedAssetId: 'ast-hdfc-cash',
      dismissedAssetCandidateIds: ['ast-emergency-fd'],
      notes: 'Primary salary account',
    },
    {
      id: 'acc-sbi-savings',
      name: 'SBI Savings',
      type: 'Bank',
      institution: 'State Bank of India',
      lastFourDigits: '8820',
      openingBalance: 60_000,
      currency: 'INR',
      asOfDate: '2026-04-01',
      linkedAssetId: null,
    },
  ];

  const assets: Asset[] = [
    {
      id: 'ast-hdfc-cash',
      name: 'HDFC Savings',
      amount: 125_000,
      type: 'Cash & Savings',
      currency: 'INR',
      geography: 'India',
      tag: 'Liquid',
    },
    {
      id: 'ast-emergency-fd',
      name: 'Emergency Sweep FD',
      amount: 500_000,
      type: 'Debt',
      currency: 'INR',
      geography: 'India',
    },
  ];

  const liabilities: Liability[] = [
    {
      id: 'lia-home-loan-1',
      name: 'Primary Residence Home Loan',
      amount: 1_850_000,
      type: 'Home Loan',
      currency: 'INR',
    },
  ];

  const holdings: Holding[] = [
    {
      id: 'hld-zerodha-infy',
      broker: 'Zerodha',
      account: 'ZR1042',
      instrumentName: 'Infosys Limited',
      ticker: 'INFY',
      isin: 'INE009A01021',
      productScope: 'EQUITY',
      quantity: 120,
      averageCost: 1500,
      investedValue: 180_000,
      currentPrice: 1850,
      currentValue: 222_000,
      unrealisedPnL: 42_000,
      unrealisedPnLPercent: 23.3333,
      securityClassification: 'Large Cap',
      status: 'active',
      sourceFile: 'zerodha_holdings_2026_10.xlsx',
      importedAt: '2026-10-15T09:30:00.000Z',
    },
    {
      id: 'hld-groww-mf-closed',
      broker: 'Groww',
      // Intentionally undefined account to test D-02 undefined-account identity preservation
      instrumentName: 'Parag Parikh Flexi Cap Fund Direct Growth',
      productScope: 'MUTUAL_FUND',
      quantity: 350.425,
      averageCost: 62.5,
      investedValue: 21_901.56,
      currentPrice: 84.2,
      currentValue: 29_505.79,
      unrealisedPnL: 7_604.23,
      xirrPercent: 18.65,
      securityClassification: 'Equity - Flexi Cap Fund',
      status: 'closed_absent',
      sourceFile: 'groww_mf_2026_09.xlsx',
      importedAt: '2026-09-30T11:00:00.000Z',
    },
  ];

  const holdingDeletionLog: HoldingDeletionLogEntry[] = [
    {
      id: 'hdl-single-001',
      holdingId: 'hld-old-itc',
      broker: 'Zerodha',
      account: 'ZR1042',
      instrumentName: 'ITC Limited',
      ticker: 'ITC',
      isin: 'INE154A01025',
      currentValueAtDeletion: 48_500,
      sourceFile: 'zerodha_holdings_2026_06.xlsx',
      importedAt: '2026-06-01T08:00:00.000Z',
      deletedAt: '2026-07-10T14:22:00.000Z',
    },
    {
      id: 'hdl-batch-002',
      holdingId: 'hld-old-dhan-1',
      broker: 'Dhan',
      instrumentName: 'Nippon India Liquid Fund',
      currentValueAtDeletion: 100_000,
      sourceFile: 'dhan_mf_2026_07.csv',
      importedAt: '2026-07-05T10:00:00.000Z',
      deletedAt: '2026-08-01T16:45:00.000Z',
      batchId: 'hdlb-cleanup-01',
      batchScope: 'BROKER_WIDE',
    },
  ];

  const transactions: Transaction[] = [
    // 1. Live imported bank statement credit with referenceNumber & closingBalance
    {
      id: 'tx-bank-salary-1',
      date: '2026-10-01',
      dateStr: '01 Oct 2026',
      title: 'Monthly Salary Credit',
      narration: 'NEFT/CR/ACME CORP INDIA/SALARY OCT',
      account: 'HDFC Savings',
      accountId: 'acc-hdfc-savings',
      direction: 'CREDIT',
      type: 'Income',
      category: 'SALARY',
      amount: 185_000,
      status: 'CLEARED',
      origin: 'IMPORT',
      recordedAt: '2026-10-02T07:00:00.000Z',
      importBatchId: 'batch-hdfc-oct',
      sourceProvider: 'HDFC Bank',
      sourceFile: 'HDFC_Oct_2026.txt',
      sourceRowNumber: 4,
      referenceNumber: 'UTR2026100199881',
      closingBalance: 310_000,
      fingerprint: 'fp-bank-salary-1',
    },
    // 2. Rolled-back imported expense (excluded via IMPORT_ROLLBACK + prior restoredAt history)
    {
      id: 'tx-rolled-back-1',
      date: '2026-10-03',
      dateStr: '03 Oct 2026',
      title: 'Duplicate Statement Row',
      narration: 'UPI/DR/MERCHANT/991122',
      account: 'HDFC Savings',
      accountId: 'acc-hdfc-savings',
      direction: 'DEBIT',
      type: 'Expense',
      category: 'SHOPPING',
      amount: 4_250,
      status: 'CLEARED',
      origin: 'IMPORT',
      recordedAt: '2026-10-04T07:00:00.000Z',
      importBatchId: 'batch-rolled-back',
      excludedAt: '2026-10-06T09:15:00.000Z',
      excludedReason: 'IMPORT_ROLLBACK',
      restoredAt: '2026-10-05T12:00:00.000Z',
      fingerprint: 'fp-rolled-back-1',
    },
    // 3. Superseded original + amendment correction chain
    {
      id: 'tx-orig-grocery-1',
      date: '2026-10-07',
      dateStr: '07 Oct 2026',
      title: 'Supermarket Grocery',
      narration: 'POS/GROCERY MART CHENNAI',
      account: 'HDFC Savings',
      accountId: 'acc-hdfc-savings',
      direction: 'DEBIT',
      type: 'Expense',
      category: 'GROCERIES',
      amount: 3_100,
      status: 'CLEARED',
      origin: 'MANUAL',
      recordedAt: '2026-10-07T18:00:00.000Z',
      excludedAt: '2026-10-08T08:30:00.000Z',
      excludedReason: 'SUPERSEDED',
      fingerprint: 'fp-orig-grocery-1',
    },
    {
      id: 'tx-corr-grocery-2',
      date: '2026-10-07',
      dateStr: '07 Oct 2026',
      title: 'Supermarket Grocery (Amended)',
      narration: 'POS/GROCERY MART CHENNAI',
      account: 'HDFC Savings',
      accountId: 'acc-hdfc-savings',
      direction: 'DEBIT',
      type: 'Expense',
      category: 'GROCERIES',
      amount: 3_450,
      status: 'CLEARED',
      origin: 'MANUAL',
      recordedAt: '2026-10-08T08:30:00.000Z',
      supersedes: 'tx-orig-grocery-1',
      provenanceDiverged: true,
      fingerprint: 'fp-corr-grocery-2',
    },
    // 4. Complete paired transfer (DEBIT + CREDIT legs)
    {
      id: 'tr-oct-01-debit',
      date: '2026-10-10',
      dateStr: '10 Oct 2026',
      title: 'Transfer to SBI Savings',
      narration: 'TRANSFER-DEBIT/HDFC Savings -> SBI Savings',
      account: 'HDFC Savings',
      accountId: 'acc-hdfc-savings',
      direction: 'DEBIT',
      type: 'Transfer',
      category: 'TRANSFER',
      amount: 25_000,
      status: 'CLEARED',
      transferId: 'tr-oct-01',
      origin: 'MANUAL',
      recordedAt: '2026-10-10T10:00:00.000Z',
    },
    {
      id: 'tr-oct-01-credit',
      date: '2026-10-10',
      dateStr: '10 Oct 2026',
      title: 'Transfer from HDFC Savings',
      narration: 'TRANSFER-CREDIT/HDFC Savings -> SBI Savings',
      account: 'SBI Savings',
      accountId: 'acc-sbi-savings',
      direction: 'CREDIT',
      type: 'Transfer',
      category: 'TRANSFER',
      amount: 25_000,
      status: 'CLEARED',
      transferId: 'tr-oct-01',
      origin: 'MANUAL',
      recordedAt: '2026-10-10T10:00:00.000Z',
    },
  ];

  const snapshots: NetWorthSnapshot[] = [
    {
      id: 'snap-2026-10-15',
      dateStr: '15 Oct 2026',
      totalAssets: 847_000,
      totalLiabilities: 1_850_000,
      netWorth: -1_003_000,
      status: 'Anchored Permanent',
      label: 'Mid-Oct Check',
    },
  ];

  const budgets: MonthlyBudget[] = [
    {
      id: 'bgt-2026-10',
      monthStr: '2026-10',
      allocations: {
        Groceries: 12_000,
        Housing: 35_000,
        Utilities: 6_500,
      },
      totalBudget: 53_500,
      updatedAt: '2026-10-01T06:00:00.000Z',
    },
  ];

  const policies: InsurancePolicy[] = [
    {
      id: 'pol-term-1',
      type: 'Term Life',
      provider: 'HDFC Life',
      policyNumber: 'TERM-88412',
      coverAmount: 20_000_000,
      premiumAmount: 24_500,
      renewalDate: '2027-03-15',
      status: 'Active',
      currency: 'INR',
      notes: 'Pure term cover',
    },
  ];

  const goals: FinancialGoal[] = [
    {
      id: 'goal-retire-1',
      name: 'Retirement Corpus',
      template: 'Retirement',
      targetAmount: 50_000_000,
      targetDate: '2045-12-31',
      currentSavedAmount: 4_200_000,
      monthlyContribution: 65_000,
      status: 'In Progress',
      currency: 'INR',
    },
  ];

  const profile: FinancialProfile = {
    id: 'default-profile',
    age: 34,
    monthlyIncome: 185_000,
    monthlyExpenses: 75_000,
    savingsRate: 59,
    dependents: 2,
    targetEmergencyMonths: 9,
    updatedAt: '2026-10-01T06:00:00.000Z',
  };

  return {
    transactions,
    assets,
    liabilities,
    holdings,
    holdingDeletionLog,
    snapshots,
    accounts,
    budgets,
    policies,
    goals,
    profile,
  };
}

async function resetEnvironment(): Promise<void> {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
  }
  (IndexedDBStorageService as any).simulateFailureOnce = false;
  (IndexedDBStorageService as any).simulateQueueFailureOnce = false;
  (IndexedDBStorageService as any).simulateReadFailureOnce = false;
  await IndexedDBStorageService.clearAll();
  await useCanonicalLedger.getState().initialize();
}

async function seedDatasetIntoPersistence(dataset: LocalBackupData): Promise<void> {
  await IndexedDBStorageService.saveAll(dataset);
  await useCanonicalLedger.getState().initialize();
}

describe('Step 9 (DEF-21a backup component): Local JSON Backup and SHA-256 Verified Restore', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetEnvironment();
  });

  describe('1. Genuine FIPS 180-4 SHA-256 generation, retention, and verification', () => {
    it('computes genuine NIST FIPS 180-4 SHA-256 digests in both Web Crypto and pure RFC 6234 fallback', async () => {
      const vectors: Array<[string, string]> = [
        ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        [
          'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
          '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
        ],
      ];

      for (const [input, expected] of vectors) {
        const viaSubtle = await computeIntegrityDigestHex(input);
        const viaFallback = computeRfc6234DigestHex(new TextEncoder().encode(input));
        const viaNodeCrypto = createHash('sha256').update(input, 'utf8').digest('hex');

        expect(viaSubtle).toBe(expected);
        expect(viaFallback).toBe(expected);
        expect(viaSubtle).toBe(viaNodeCrypto);
      }
    });

    it('generates, embeds, and retains a verifiable SHA-256 digest over canonical JCS backup payload', async () => {
      const dataset = buildCompleteCanonicalDataset();
      await seedDatasetIntoPersistence(dataset);

      const exported = await FinancialCommands.exportLocalBackup({
        createdAt: '2026-11-03T10:30:00.000Z',
      });

      expect(exported.envelope.manifest.format).toBe(BACKUP_FORMAT_ID);
      expect(exported.envelope.manifest.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
      expect(exported.envelope.manifest.dbVersion).toBe(BACKUP_DB_VERSION);
      expect(exported.envelope.integrity.algorithm).toBe(BACKUP_HASH_ALGORITHM);
      expect(exported.envelope.integrity.canonicalization).toBe(BACKUP_CANONICALIZATION);
      expect(exported.envelope.integrity.digest).toMatch(/^[0-9a-f]{64}$/);

      const expectedCanonical = JcsSerializationService.canonicalize({
        manifest: exported.envelope.manifest,
        data: exported.envelope.data,
      });
      const expectedNodeSha256 = createHash('sha256')
        .update(expectedCanonical, 'utf8')
        .digest('hex');

      expect(exported.envelope.integrity.digest).toBe(expectedNodeSha256);

      // Retained receipt in localStorage matches exported envelope without storing financial PII
      const retained = LocalBackupService.getLastBackupReceipt();
      expect(retained).not.toBeNull();
      expect(retained!.digest).toBe(expectedNodeSha256);
      expect(retained!.createdAt).toBe('2026-11-03T10:30:00.000Z');
      expect(retained!.fileName).toBe('arthavault-backup-2026-11-03T10-30-00-000Z.json');

      // Re-formatting whitespace / key order in JSON transport remains valid under RFC 8785 JCS
      const compactJson = JSON.stringify({
        data: exported.envelope.data,
        integrity: {
          ...exported.envelope.integrity,
          digest: exported.envelope.integrity.digest.toUpperCase(),
        },
        manifest: exported.envelope.manifest,
      });
      const verified = await LocalBackupService.verifyAndParseBackup(compactJson);
      expect(verified.integrity.digest).toBe(expectedNodeSha256);
    });
  });

  describe('2. Complete canonical export & round-trip restoration across all 11 collections', () => {
    it('exports all 11 canonical collections and restores holdings, deletion logs, bank transactions, exclusions, transfers, and essentials losslessly', async () => {
      const dataset = buildCompleteCanonicalDataset();
      await seedDatasetIntoPersistence(dataset);

      const exported = await useCanonicalLedger.getState().exportLocalBackup({
        createdAt: '2026-11-03T11:00:00.000Z',
      });

      // Clear everything and confirm local vault is completely empty
      await useCanonicalLedger.getState().clearLocalData();
      expect(useCanonicalLedger.getState().transactions).toHaveLength(0);
      expect(useCanonicalLedger.getState().holdings).toHaveLength(0);
      expect(useCanonicalLedger.getState().holdingDeletionLog).toHaveLength(0);
      expect(useCanonicalLedger.getState().assets).toHaveLength(0);
      expect(useCanonicalLedger.getState().liabilities).toHaveLength(0);
      expect(useCanonicalLedger.getState().accounts).toHaveLength(0);
      expect(useCanonicalLedger.getState().snapshots).toHaveLength(0);
      expect(useCanonicalLedger.getState().budgets).toHaveLength(0);
      expect(useCanonicalLedger.getState().policies).toHaveLength(0);
      expect(useCanonicalLedger.getState().goals).toHaveLength(0);
      expect(useCanonicalLedger.getState().profile).toBeNull();

      // Restore from the exported JSON string
      const restoreOutcome = await useCanonicalLedger
        .getState()
        .restoreLocalBackup(exported.json);

      expect(restoreOutcome.digest).toBe(exported.envelope.integrity.digest);
      expect(restoreOutcome.recordCounts).toEqual({
        transactions: 6,
        assets: 2,
        liabilities: 1,
        holdings: 2,
        holdingDeletionLog: 2,
        snapshots: 1,
        accounts: 2,
        budgets: 1,
        policies: 1,
        goals: 1,
        hasProfile: true,
      });

      // Verify in-memory repository, Zustand store, and raw IndexedDB agree across all 11 collections
      const state = useCanonicalLedger.getState();
      const rawIdb = await IndexedDBStorageService.loadAll();

      expect(state.transactions).toHaveLength(6);
      expect(rawIdb.transactions).toHaveLength(6);

      // Verify bank provenance, exclusions, rollback-restore history, and supersession pointers
      const salaryTx = state.transactions.find((t) => t.id === 'tx-bank-salary-1')!;
      expect(salaryTx.referenceNumber).toBe('UTR2026100199881');
      expect(salaryTx.closingBalance).toBe(310_000);
      expect(salaryTx.fingerprint).toBe('fp-bank-salary-1');

      const rolledBackTx = state.transactions.find((t) => t.id === 'tx-rolled-back-1')!;
      expect(rolledBackTx.excludedReason).toBe('IMPORT_ROLLBACK');
      expect(rolledBackTx.excludedAt).toBe('2026-10-06T09:15:00.000Z');
      expect(rolledBackTx.restoredAt).toBe('2026-10-05T12:00:00.000Z');
      expect(LedgerExclusionService.isExcluded(rolledBackTx)).toBe(true);

      const supersededOrig = state.transactions.find((t) => t.id === 'tx-orig-grocery-1')!;
      const correctionRow = state.transactions.find((t) => t.id === 'tx-corr-grocery-2')!;
      expect(supersededOrig.excludedReason).toBe('SUPERSEDED');
      expect(correctionRow.supersedes).toBe('tx-orig-grocery-1');
      expect(correctionRow.provenanceDiverged).toBe(true);

      // Verify holdings (active + closed_absent, explicit account + undefined account)
      expect(state.holdings).toHaveLength(2);
      expect(rawIdb.holdings).toHaveLength(2);
      const growwClosed = state.holdings.find((h) => h.id === 'hld-groww-mf-closed')!;
      expect(growwClosed.status).toBe('closed_absent');
      expect(growwClosed.account).toBeUndefined();
      expect(growwClosed.xirrPercent).toBe(18.65);

      // Verify holdingDeletionLog (single + batch scope)
      expect(state.holdingDeletionLog).toHaveLength(2);
      expect(rawIdb.holdingDeletionLog).toHaveLength(2);
      expect(
        state.holdingDeletionLog.find((d) => d.id === 'hdl-batch-002')?.batchScope
      ).toBe('BROKER_WIDE');

      // Verify assets, liabilities, snapshots, accounts, budgets, policies, goals, profile
      const sortById = <T extends { id?: string }>(arr: T[]) =>
        [...arr].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      expect(sortById(state.assets)).toEqual(sortById(dataset.assets));
      expect(sortById(state.liabilities)).toEqual(sortById(dataset.liabilities));
      expect(sortById(state.snapshots)).toEqual(sortById(dataset.snapshots));
      expect(sortById(state.accounts)).toEqual(sortById(dataset.accounts));
      expect(sortById(state.budgets)).toEqual(sortById(dataset.budgets));
      expect(sortById(state.policies)).toEqual(sortById(dataset.policies));
      expect(sortById(state.goals)).toEqual(sortById(dataset.goals));
      expect(state.profile).toEqual(dataset.profile);

      // Re-exporting with the same timestamp produces the exact same canonical data & SHA-256 digest
      const reExported = await useCanonicalLedger.getState().exportLocalBackup({
        createdAt: '2026-11-03T11:00:00.000Z',
      });
      expect(reExported.envelope.integrity.digest).toBe(exported.envelope.integrity.digest);
    });
  });

  describe('3. Detection and rejection of modified or corrupted backup contents', () => {
    it('rejects modified transaction amounts, un-excluded rows, altered holdings, altered deletion logs, and corrupted hashes', async () => {
      const dataset = buildCompleteCanonicalDataset();
      await seedDatasetIntoPersistence(dataset);
      const exported = await repository.exportBackup({
        createdAt: '2026-11-03T12:00:00.000Z',
      });

      // Case A: Modified transaction amount (+1 rupee)
      const tamperedAmount = JSON.parse(exported.json);
      tamperedAmount.data.transactions[0].amount += 1;
      await expect(
        repository.restoreFromBackup(JSON.stringify(tamperedAmount))
      ).rejects.toMatchObject({
        name: 'BackupValidationError',
        code: 'INTEGRITY_MISMATCH',
      });

      // Case B: Stripped exclusion stamp on rolled-back transaction
      const tamperedExclusion = JSON.parse(exported.json);
      const rolledBackTarget = tamperedExclusion.data.transactions.find(
        (t: Transaction) => t.id === 'tx-rolled-back-1'
      );
      expect(rolledBackTarget).toBeDefined();
      delete rolledBackTarget.excludedAt;
      delete rolledBackTarget.excludedReason;
      await expect(
        repository.restoreFromBackup(JSON.stringify(tamperedExclusion))
      ).rejects.toMatchObject({
        code: 'INTEGRITY_MISMATCH',
      });

      // Case C: Altered holding currentValue
      const tamperedHolding = JSON.parse(exported.json);
      tamperedHolding.data.holdings[0].currentValue = 999_999;
      await expect(
        repository.restoreFromBackup(JSON.stringify(tamperedHolding))
      ).rejects.toMatchObject({
        code: 'INTEGRITY_MISMATCH',
      });

      // Case D: Deleted holdingDeletionLog audit entry without updating manifest/hash
      const tamperedAudit = JSON.parse(exported.json);
      tamperedAudit.data.holdingDeletionLog.pop();
      await expect(
        repository.restoreFromBackup(JSON.stringify(tamperedAudit))
      ).rejects.toMatchObject({
        code: 'INTEGRITY_MISMATCH',
      });

      // Case E: Single flipped hex nibble in integrity.digest
      const tamperedDigest = JSON.parse(exported.json);
      const origDigest: string = tamperedDigest.integrity.digest;
      const flippedFirst = origDigest[0] === 'a' ? 'b' : 'a';
      tamperedDigest.integrity.digest = flippedFirst + origDigest.slice(1);
      await expect(
        repository.restoreFromBackup(JSON.stringify(tamperedDigest))
      ).rejects.toMatchObject({
        code: 'INTEGRITY_MISMATCH',
      });

      // Case F: Truncated / syntactically corrupted JSON file
      await expect(
        repository.restoreFromBackup(exported.json.slice(0, 180))
      ).rejects.toMatchObject({
        code: 'INVALID_JSON',
      });

      // Case G: Empty input
      await expect(repository.restoreFromBackup('   ')).rejects.toMatchObject({
        code: 'EMPTY_INPUT',
      });
    });
  });

  describe('4. Rejection of invalid, incomplete, or incompatible backup structures', () => {
    async function signArbitraryEnvelope(manifest: any, data: any) {
      const canonical = LocalBackupService.canonicalizeForHashing(manifest, data);
      const digest = await computeIntegrityDigestHex(canonical);
      return JSON.stringify({
        manifest,
        integrity: {
          algorithm: BACKUP_HASH_ALGORITHM,
          canonicalization: BACKUP_CANONICALIZATION,
          digest,
        },
        data,
      });
    }

    it('rejects wrong format identifiers, unsupported schema/db versions, missing collections, duplicate IDs, and malformed records even when re-hashed', async () => {
      const dataset = buildCompleteCanonicalDataset();
      const baseExport = await LocalBackupService.createBackup(dataset, {
        createdAt: '2026-11-03T12:30:00.000Z',
      });

      // Wrong format identifier
      const wrongFormat = JSON.parse(baseExport.json);
      wrongFormat.manifest.format = 'foreign.app.export';
      await expect(
        repository.restoreFromBackup(JSON.stringify(wrongFormat))
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_BACKUP_FORMAT',
      });

      // Future incompatible schemaVersion
      const futureSchema = JSON.parse(baseExport.json);
      futureSchema.manifest.schemaVersion = 2;
      await expect(
        repository.restoreFromBackup(JSON.stringify(futureSchema))
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_SCHEMA_VERSION',
      });

      // Incompatible future dbVersion
      const futureDb = JSON.parse(baseExport.json);
      futureDb.manifest.dbVersion = 99;
      await expect(
        repository.restoreFromBackup(JSON.stringify(futureDb))
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_SCHEMA_VERSION',
      });

      // Missing canonical holdings collection
      const missingHoldings = JSON.parse(baseExport.json);
      delete missingHoldings.data.holdings;
      await expect(
        repository.restoreFromBackup(JSON.stringify(missingHoldings))
      ).rejects.toMatchObject({
        code: 'INCOMPLETE_BACKUP_DATA',
      });

      // Missing profile key
      const missingProfile = JSON.parse(baseExport.json);
      delete missingProfile.data.profile;
      await expect(
        repository.restoreFromBackup(JSON.stringify(missingProfile))
      ).rejects.toMatchObject({
        code: 'INCOMPLETE_BACKUP_DATA',
      });

      // Re-hashed payload with duplicate primary key in transactions
      const dupTxData = JSON.parse(JSON.stringify(baseExport.envelope.data));
      dupTxData.transactions.push({ ...dupTxData.transactions[0] });
      const dupManifest = {
        ...baseExport.envelope.manifest,
        recordCounts: {
          ...baseExport.envelope.manifest.recordCounts,
          transactions: dupTxData.transactions.length,
        },
      };
      const signedDupJson = await signArbitraryEnvelope(dupManifest, dupTxData);
      await expect(repository.restoreFromBackup(signedDupJson)).rejects.toMatchObject({
        code: 'DUPLICATE_RECORD_ID',
      });

      // Re-hashed payload with missing primary key (`id: ""`) in assets
      const missingKeyData = JSON.parse(JSON.stringify(baseExport.envelope.data));
      missingKeyData.assets[0].id = '';
      const signedMissingKeyJson = await signArbitraryEnvelope(
        baseExport.envelope.manifest,
        missingKeyData
      );
      await expect(repository.restoreFromBackup(signedMissingKeyJson)).rejects.toMatchObject({
        code: 'INVALID_RECORD_SCHEMA',
      });

      // Re-hashed payload with wrong manifest recordCounts
      const countMismatchManifest = {
        ...baseExport.envelope.manifest,
        recordCounts: {
          ...baseExport.envelope.manifest.recordCounts,
          holdings: 99,
        },
      };
      const signedCountMismatchJson = await signArbitraryEnvelope(
        countMismatchManifest,
        baseExport.envelope.data
      );
      await expect(
        repository.restoreFromBackup(signedCountMismatchJson)
      ).rejects.toMatchObject({
        code: 'RECORD_COUNT_MISMATCH',
      });

      // Prototype pollution key in raw JSON
      const pollutedJson =
        '{"__proto__":{"polluted":true},"manifest":{},"integrity":{},"data":{}}';
      await expect(repository.restoreFromBackup(pollutedJson)).rejects.toMatchObject({
        code: 'PROTOTYPE_POLLUTION_DETECTED',
      });
    });
  });

  describe('5. Atomic failure safety leaving existing financial data unchanged', () => {
    it('leaves memory, Zustand store, and IndexedDB completely unchanged when validation fails OR when IndexedDB aborts mid-restore', async () => {
      // Prepare a valid backup of Dataset A
      const backupSourceDataset = buildCompleteCanonicalDataset();
      const validBackup = await LocalBackupService.createBackup(backupSourceDataset, {
        createdAt: '2026-11-03T13:00:00.000Z',
      });

      // Seed a DISTINCT live baseline Dataset B into local storage
      const existingBaseline: LocalBackupData = {
        transactions: [
          {
            id: 'tx-live-baseline-only',
            date: '2026-11-01',
            dateStr: '01 Nov 2026',
            title: 'Existing Live Dividend',
            narration: 'ACH/DIVIDEND/TCS',
            account: 'Existing Bank',
            direction: 'CREDIT',
            type: 'Income',
            category: 'DIVIDEND',
            amount: 9_999,
            status: 'CLEARED',
          },
        ],
        assets: [{ id: 'ast-live-only', name: 'Existing Gold', amount: 333_000, type: 'Commodities' }],
        liabilities: [{ id: 'lia-live-only', name: 'Existing Car Loan', amount: 111_000, type: 'Vehicle Loan' }],
        holdings: [
          {
            id: 'hld-live-only',
            broker: 'Dhan',
            account: 'DH99',
            instrumentName: 'TCS Limited',
            ticker: 'TCS',
            quantity: 10,
            averageCost: 3500,
            investedValue: 35_000,
            currentPrice: 4100,
            currentValue: 41_000,
            unrealisedPnL: 6_000,
            status: 'active',
            sourceFile: 'dhan_live.csv',
            importedAt: '2026-11-01T10:00:00.000Z',
          },
        ],
        holdingDeletionLog: [
          {
            id: 'hdl-live-only',
            holdingId: 'hld-deleted-earlier',
            broker: 'Dhan',
            instrumentName: 'Old Fund',
            currentValueAtDeletion: 12_000,
            sourceFile: 'dhan_old.csv',
            importedAt: '2026-05-01T00:00:00.000Z',
            deletedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        snapshots: [],
        accounts: [{ id: 'acc-live-only', name: 'Existing Bank', type: 'Bank', openingBalance: 50_000, linkedAssetId: null }],
        budgets: [],
        policies: [],
        goals: [],
        profile: {
          id: 'default-profile',
          monthlyIncome: 120_000,
          monthlyExpenses: 45_000,
          savingsRate: 63,
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      };
      await seedDatasetIntoPersistence(existingBaseline);

      const assertBaselineIntactEverywhere = async () => {
        const memTx = repository.transactions.findAllSync();
        const memHoldings = repository.holdings.findAllSync();
        const memAudit = repository.holdingDeletionLog.findAllSync();
        const store = useCanonicalLedger.getState();
        const idb = await IndexedDBStorageService.loadAll();

        expect(memTx.map((t) => t.id)).toEqual(['tx-live-baseline-only']);
        expect(store.transactions.map((t) => t.id)).toEqual(['tx-live-baseline-only']);
        expect(idb.transactions.map((t) => t.id)).toEqual(['tx-live-baseline-only']);

        expect(memHoldings.map((h) => h.id)).toEqual(['hld-live-only']);
        expect(store.holdings.map((h) => h.id)).toEqual(['hld-live-only']);
        expect(idb.holdings.map((h) => h.id)).toEqual(['hld-live-only']);

        expect(memAudit.map((d) => d.id)).toEqual(['hdl-live-only']);
        expect(store.holdingDeletionLog.map((d) => d.id)).toEqual(['hdl-live-only']);
        expect(idb.holdingDeletionLog.map((d) => d.id)).toEqual(['hdl-live-only']);

        expect(store.assets.map((a) => a.id)).toEqual(['ast-live-only']);
        expect(idb.assets.map((a) => a.id)).toEqual(['ast-live-only']);
        expect(store.liabilities.map((l) => l.id)).toEqual(['lia-live-only']);
        expect(idb.liabilities.map((l) => l.id)).toEqual(['lia-live-only']);
        expect(store.profile?.monthlyIncome).toBe(120_000);
        expect(idb.profile?.monthlyIncome).toBe(120_000);
      };

      // 1) Corrupted / tampered backup is rejected pre-mutation; baseline untouched
      const tampered = JSON.parse(validBackup.json);
      tampered.data.assets[0].amount = 999_999_999;
      await expect(
        repository.restoreFromBackup(JSON.stringify(tampered))
      ).rejects.toBeInstanceOf(BackupValidationError);
      await assertBaselineIntactEverywhere();

      // 2) Simulated IndexedDB transaction abort during restore rolls back memory & store atomically
      (IndexedDBStorageService as any).simulateFailureOnce = true;
      await expect(repository.restoreFromBackup(validBackup.json)).rejects.toThrow();
      await assertBaselineIntactEverywhere();

      // 3) Simulated mid-queue IndexedDB request failure also rolls back atomically
      (IndexedDBStorageService as any).simulateQueueFailureOnce = true;
      await expect(repository.restoreFromBackup(validBackup.json)).rejects.toThrow();
      await assertBaselineIntactEverywhere();
    });

    it('refuses both export and restore when IndexedDB is in a failed-load (READFAIL) state', async () => {
      const dataset = buildCompleteCanonicalDataset();
      const validBackup = await LocalBackupService.createBackup(dataset);

      (IndexedDBStorageService as any).simulateReadFailureOnce = true;
      await expect(useCanonicalLedger.getState().initialize()).rejects.toThrow();
      expect(IndexedDBStorageService.loadFailed).toBe(true);

      await expect(repository.exportBackup()).rejects.toMatchObject({
        code: 'STORAGE_UNREADABLE',
      });
      await expect(repository.restoreFromBackup(validBackup.json)).rejects.toMatchObject({
        code: 'STORAGE_UNREADABLE',
      });

      // Recover storage so subsequent tests start cleanly
      const rec = await useCanonicalLedger.getState().recoverStorage();
      expect(rec.recovered).toBe(true);
    });
  });

  describe('6. Post-restore cold app startup, derived financial access, and Settings UI workflow', () => {
    it('supports clean cold-start initialization and accurate derived ledger & wealth queries after restore', async () => {
      const dataset = buildCompleteCanonicalDataset();
      const backup = await LocalBackupService.createBackup(dataset, {
        createdAt: '2026-11-03T14:00:00.000Z',
      });

      await repository.restoreFromBackup(backup.json);

      // Simulate cold browser restart with a brand-new MemoryRepository reading from IndexedDB
      const coldStartRepo = new MemoryRepository();
      await coldStartRepo.initialize();

      expect(coldStartRepo.transactions.findAllSync()).toHaveLength(6);
      // Derived financial queries exclude IMPORT_ROLLBACK and SUPERSEDED rows automatically
      const liveIncludedTxs = coldStartRepo.transactions.findManySync({
        includeExcluded: false,
        dateRange: '12M',
      });
      const allLedgerTxs = coldStartRepo.transactions.findManySync({
        includeExcluded: true,
        dateRange: '12M',
      });
      expect(allLedgerTxs).toHaveLength(6);
      expect(liveIncludedTxs.map((t) => t.id).sort()).toEqual(
        [
          'tr-oct-01-credit',
          'tr-oct-01-debit',
          'tx-bank-salary-1',
          'tx-corr-grocery-2',
        ].sort()
      );

      // Derived wealth aggregates canonical assets + retained holdings (DEF-10 unified bridge)
      const totalWealthAssets = HoldingWealthBridge.aggregateAssetsAndHoldings(
        coldStartRepo.assets.findAllSync(),
        coldStartRepo.holdings.findAllSync()
      );
      expect(totalWealthAssets).toBeCloseTo(125_000 + 500_000 + 222_000 + 29_505.79, 2);
      expect(coldStartRepo.holdingDeletionLog.findAllSync()).toHaveLength(2);
      expect(coldStartRepo.profile.getSync()?.monthlyIncome).toBe(185_000);
    });

    it('navigates to Settings without alert() and completes export, tamper rejection, and verified restore through the UI', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      const setActiveTab = vi.fn();

      const sidebar = render(<Sidebar activeTab="overview" setActiveTab={setActiveTab} />);
      fireEvent.click(sidebar.container.querySelector('#sidebar-nav-settings')!);
      expect(setActiveTab).toHaveBeenCalledWith('settings');
      expect(alertSpy).not.toHaveBeenCalled();
      sidebar.unmount();

      // Seed dataset, export via SettingsPage UI, clear vault, reject tampered upload, then restore valid upload
      const dataset = buildCompleteCanonicalDataset();
      await seedDatasetIntoPersistence(dataset);

      render(<SettingsPage />);

      fireEvent.click(screen.getByTestId('btn-export-local-backup'));
      await waitFor(() => {
        expect(screen.getByTestId('backup-export-receipt')).toBeTruthy();
      });
      const displayedDigest = screen.getByTestId('backup-receipt-digest').textContent!;
      expect(displayedDigest).toMatch(/^[0-9a-f]{64}$/);

      const exported = await repository.exportBackup({
        createdAt: '2026-11-03T15:00:00.000Z',
      });
      await act(async () => {
        await useCanonicalLedger.getState().clearLocalData();
      });
      expect(useCanonicalLedger.getState().holdings).toHaveLength(0);

      const fileInput = screen.getByTestId('input-restore-backup-file') as HTMLInputElement;

      // 1) Upload tampered file -> UI shows INTEGRITY_MISMATCH error and never renders Confirm button
      const tamperedObj = JSON.parse(exported.json);
      tamperedObj.data.holdings[0].quantity = 9999;
      const badFile = new File([JSON.stringify(tamperedObj)], 'tampered-backup.json', {
        type: 'application/json',
      });
      fireEvent.change(fileInput, { target: { files: [badFile] } });

      await waitFor(() => {
        expect(screen.getByTestId('backup-restore-error').textContent).toMatch(
          /INTEGRITY_MISMATCH/
        );
      });
      expect(screen.queryByTestId('btn-confirm-restore-backup')).toBeNull();
      expect(useCanonicalLedger.getState().holdings).toHaveLength(0);

      // 2) Upload valid file -> UI shows verified preview -> click Confirm & Restore -> vault restored
      const goodFile = new File([exported.json], exported.fileName, {
        type: 'application/json',
      });
      fireEvent.change(fileInput, { target: { files: [goodFile] } });

      await waitFor(() => {
        expect(screen.getByTestId('backup-verify-preview')).toBeTruthy();
      });
      fireEvent.click(screen.getByTestId('btn-confirm-restore-backup'));

      await waitFor(() => {
        expect(screen.getByTestId('backup-restore-success')).toBeTruthy();
      });
      expect(useCanonicalLedger.getState().transactions).toHaveLength(6);
      expect(useCanonicalLedger.getState().holdings).toHaveLength(2);
      expect(useCanonicalLedger.getState().holdingDeletionLog).toHaveLength(2);
      expect(useCanonicalLedger.getState().profile?.monthlyIncome).toBe(185_000);
    });

    it('mounts the full App after restoration, completes startup initialization, and renders restored financial data across pages', async () => {
      const dataset = buildCompleteCanonicalDataset();
      const backup = await LocalBackupService.createBackup(dataset, {
        createdAt: '2026-11-03T16:00:00.000Z',
      });
      await repository.restoreFromBackup(backup.json);

      // Simulate cold browser launch: wipe in-memory Zustand state before mounting <App />
      useCanonicalLedger.setState({
        transactions: [],
        assets: [],
        liabilities: [],
        holdings: [],
        holdingDeletionLog: [],
        snapshots: [],
        accounts: [],
        budgets: [],
        policies: [],
        goals: [],
        profile: null,
        initStatus: 'loading',
        initError: null,
      } as any);

      const appView = render(<App />);
      await act(async () => {
        await runStartupInitialization();
      });

      await waitFor(() => {
        expect(useCanonicalLedger.getState().initStatus).toBe('ready');
      });
      expect(useCanonicalLedger.getState().transactions).toHaveLength(6);
      expect(useCanonicalLedger.getState().holdings).toHaveLength(2);
      expect(useCanonicalLedger.getState().holdingDeletionLog).toHaveLength(2);

      // Navigate into Settings inside full App and confirm live vault inventory matches restored records
      fireEvent.click(appView.container.querySelector('#sidebar-nav-settings')!);
      await waitFor(() => {
        expect(screen.getByTestId('settings-page')).toBeTruthy();
      });
      const inventoryText = screen.getByTestId('backup-live-inventory').textContent!;
      expect(inventoryText).toContain('Transactions6');
      expect(inventoryText).toContain('Holdings2');
      expect(inventoryText).toContain('Deletion Audit2');
    });

    it('falls back seamlessly to RFC 6234 SHA-256 when Web Crypto crypto.subtle is unavailable', async () => {
      const dataset = buildCompleteCanonicalDataset();
      const withSubtle = await LocalBackupService.createBackup(dataset, {
        createdAt: '2026-11-03T16:30:00.000Z',
      });

      const origCrypto = globalThis.crypto;
      vi.stubGlobal('crypto', {} as Crypto);
      try {
        const withoutSubtle = await LocalBackupService.createBackup(dataset, {
          createdAt: '2026-11-03T16:30:00.000Z',
        });
        expect(withoutSubtle.envelope.integrity.digest).toBe(
          withSubtle.envelope.integrity.digest
        );
        const verified = await LocalBackupService.verifyAndParseBackup(withoutSubtle.json);
        expect(verified.integrity.digest).toBe(withSubtle.envelope.integrity.digest);
      } finally {
        vi.stubGlobal('crypto', origCrypto);
      }
    });
  });
});
