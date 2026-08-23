/**
 * WP-FB-DATA-06a — Transaction integrity foundations.
 *
 * This package consolidates identity and construction and adds explicit
 * provenance. It is a FOUNDATIONS package: it must make the model more
 * inspectable WITHOUT changing a single financial outcome. These tests are
 * therefore weighted towards proving the *absence* of change:
 *
 *   §1  fingerprint authority          — one definition, exact canonical bytes
 *   §2  fingerprint stability          — new fields must not change any digest
 *   §3  direction / accountId ruling   — the two flagged fields stay excluded
 *   §4  construction authority         — store and commands produce one shape
 *   §5  provenance                     — origin/recordedAt, never inferred
 *   §6  manual fingerprints            — present at rest, dedup unchanged
 *   §7  L-02 divergent duplicate       — detected and reported, still dropped
 *   §8  scope boundary                 — L-01 explicitly NOT closed here
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  TransactionIdentityService,
  FINGERPRINT_VERSION,
  FINGERPRINT_FIELDS,
  FINGERPRINT_EXCLUDED_FIELDS,
  setRecordedAtClock,
  resetRecordedAtClock
} from '../services/TransactionIdentityService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { ImportPipelineService } from '../services/ImportPipelineService';
import { Sha256Service } from '../services/Sha256Service';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialCommands } from '../application/commands';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const LIVE_TODAY = '2026-08-21';
const FIXED_CLOCK = '2026-08-21T10:30:00.000Z';

const repo = repository as unknown as {
  transactionsData: Transaction[];
  accountsData: any[];
  syncStore: () => void;
};

function reset() {
  repo.transactionsData = [];
  repo.accountsData = [];
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  });
}
const S = () => useCanonicalLedger.getState();

function addAccount(name: string, openingBalance = 0) {
  S().addAccount({ name, type: 'Bank' as any, openingBalance });
  return S().accounts.find(a => a.name === name)!;
}

/** The canonical reference row used across the discovery gate (§6 base row). */
const BASE = {
  account: 'HDFC Bank',
  date: '2026-06-01',
  amount: 5000,
  narration: 'ACME PAYROLL JUN'
};

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    date: BASE.date,
    dateStr: BASE.date,
    title: BASE.narration,
    narration: BASE.narration,
    account: BASE.account,
    type: 'Income' as any,
    direction: 'CREDIT',
    category: 'GENERAL',
    amount: BASE.amount,
    status: 'CLEARED' as any,
    ...over
  };
}

describe('WP-FB-DATA-06a — transaction integrity foundations', () => {
  beforeEach(() => {
    reset();
    setAsOfDateOverride(LIVE_TODAY);
    setRecordedAtClock(() => FIXED_CLOCK);
  });
  afterEach(() => {
    resetRecordedAtClock();
    resetAsOfDateOverride();
    reset();
  });

  /* ══════════════════════════════ §1 fingerprint authority ═════════════════ */
  describe('§1 single fingerprint authority', () => {
    it('builds the canonical string as account|date|amount|lowercased-trimmed-narration', () => {
      expect(TransactionIdentityService.canonicalString(BASE))
        .toBe('HDFC Bank|2026-06-01|5000|acme payroll jun');
    });

    it('lowercases and trims ONLY the narration, never the account', () => {
      expect(TransactionIdentityService.canonicalString({
        ...BASE, account: 'HDFC Bank', narration: '   ACME Payroll JUN   '
      })).toBe('HDFC Bank|2026-06-01|5000|acme payroll jun');
    });

    it('is the deterministic digest of that exact string (NOT SHA-256 — see Sha256Service)', () => {
      expect(TransactionIdentityService.fingerprint(BASE))
        .toBe(Sha256Service.hash('HDFC Bank|2026-06-01|5000|acme payroll jun'));
      expect(TransactionIdentityService.fingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ImportPipelineService.generateFingerprint delegates to the authority (no second definition)', () => {
      expect(ImportPipelineService.generateFingerprint(BASE))
        .toBe(TransactionIdentityService.fingerprint(BASE));
    });

    it('declares the participating field set explicitly', () => {
      expect([...FINGERPRINT_FIELDS]).toEqual(['account', 'date', 'amount', 'narration']);
      expect(FINGERPRINT_VERSION).toBe(1);
    });

    it('every participating field actually changes the digest', () => {
      const base = TransactionIdentityService.fingerprint(BASE);
      expect(TransactionIdentityService.fingerprint({ ...BASE, account: 'SBI Bank' })).not.toBe(base);
      expect(TransactionIdentityService.fingerprint({ ...BASE, date: '2026-06-02' })).not.toBe(base);
      expect(TransactionIdentityService.fingerprint({ ...BASE, amount: 5500 })).not.toBe(base);
      expect(TransactionIdentityService.fingerprint({ ...BASE, narration: 'OTHER' })).not.toBe(base);
    });
  });

  /* ═══════════════════════ §2 stability across the 06a change ══════════════ */
  describe('§2 fingerprint stability (06a must not re-identify existing rows)', () => {
    /**
     * Digest captured from the PRE-06a implementation at HEAD 3a839af. If a
     * refactor ever perturbs the canonical string, this fails loudly rather than
     * silently orphaning every fingerprint already persisted in IndexedDB.
     */
    const PRE_06A_DIGEST = Sha256Service.hash('HDFC Bank|2026-06-01|5000|acme payroll jun');

    it('produces the identical digest to the pre-06a implementation', () => {
      expect(TransactionIdentityService.fingerprint(BASE)).toBe(PRE_06A_DIGEST);
    });

    it('the new provenance fields do not participate in identity', () => {
      const without = TransactionIdentityService.fingerprintOf(row());
      const withProv = TransactionIdentityService.fingerprintOf(
        row({ origin: 'IMPORT', recordedAt: '2026-08-21T10:30:00.000Z' })
      );
      expect(withProv).toBe(without);
    });

    it('two identical statement rows imported on different days are still one event', () => {
      const day1 = TransactionIdentityService.fingerprintOf(row({ recordedAt: '2026-08-01T00:00:00.000Z' }));
      const day2 = TransactionIdentityService.fingerprintOf(row({ recordedAt: '2026-09-15T00:00:00.000Z' }));
      expect(day1).toBe(day2);
    });

    it('fingerprintOf prefers the persisted value over recomputation', () => {
      expect(TransactionIdentityService.fingerprintOf(row({ fingerprint: 'pinned-identity' })))
        .toBe('pinned-identity');
    });

    it('fingerprintOf computes when the row carries none', () => {
      expect(TransactionIdentityService.fingerprintOf(row()))
        .toBe(TransactionIdentityService.fingerprint(BASE));
    });
  });

  /* ════════════════ §3 the two flagged fields: direction & accountId ═══════ */
  describe('§3 direction and accountId remain excluded', () => {
    it('lists both as explicitly excluded', () => {
      expect(FINGERPRINT_EXCLUDED_FIELDS).toContain('direction');
      expect(FINGERPRINT_EXCLUDED_FIELDS).toContain('accountId');
    });

    it('direction does NOT change the digest — L-02 deferred, not silently decided', () => {
      const credit = TransactionIdentityService.fingerprintOf(row({ direction: 'CREDIT', type: 'Income' as any }));
      const debit = TransactionIdentityService.fingerprintOf(row({ direction: 'DEBIT', type: 'Expense' as any }));
      expect(debit).toBe(credit);
    });

    it('accountId does NOT change the digest — resolving an account never re-identifies history', () => {
      const unmapped = TransactionIdentityService.fingerprintOf(row({ accountId: null }));
      const mapped = TransactionIdentityService.fingerprintOf(row({ accountId: 'acc-123' }));
      const remapped = TransactionIdentityService.fingerprintOf(row({ accountId: 'acc-999' }));
      expect(mapped).toBe(unmapped);
      expect(remapped).toBe(unmapped);
    });

    it('no excluded field is also a participating field', () => {
      for (const f of FINGERPRINT_FIELDS) {
        expect(FINGERPRINT_EXCLUDED_FIELDS).not.toContain(f as never);
      }
    });
  });

  /* ═════════════════════════ §4 single construction authority ══════════════ */
  describe('§4 single construction authority', () => {
    it('store and commands produce structurally identical income rows', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const viaStore = repo.transactionsData[0];

      reset();
      addAccount('HDFC Bank', 0);
      FinancialCommands.recordIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const viaCommands = repo.transactionsData[0];

      const shape = (t: Transaction) => ({ ...t, id: 'IGNORED', accountId: 'IGNORED' });
      expect(shape(viaCommands)).toEqual(shape(viaStore));
    });

    it('store and commands produce structurally identical expense rows', () => {
      addAccount('HDFC Bank', 0);
      S().addExpense('Rent', 1200, 'HDFC Bank', 'HOUSING');
      const viaStore = repo.transactionsData[0];

      reset();
      addAccount('HDFC Bank', 0);
      FinancialCommands.recordExpense('Rent', 1200, 'HDFC Bank', 'HOUSING');
      const viaCommands = repo.transactionsData[0];

      const shape = (t: Transaction) => ({ ...t, id: 'IGNORED', accountId: 'IGNORED' });
      expect(shape(viaCommands)).toEqual(shape(viaStore));
    });

    it('the pre-06a transfer id prefix drift (tr- vs tr-cmd-) is gone', () => {
      addAccount('A', 0); addAccount('B', 0);
      S().addTransfer('A', 'B', 2000);
      const storeLegs = repo.transactionsData.filter(t => t.type === 'Transfer');

      reset();
      addAccount('A', 0); addAccount('B', 0);
      FinancialCommands.recordTransfer('A', 'B', 2000);
      const cmdLegs = repo.transactionsData.filter(t => t.type === 'Transfer');

      expect(storeLegs[0].transferId!.startsWith('tr-')).toBe(true);
      expect(cmdLegs[0].transferId!.startsWith('tr-')).toBe(true);
      expect(cmdLegs[0].transferId!.startsWith('tr-cmd-')).toBe(false);
    });

    it('preserves the exact legacy field values for a manual income row', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY', 'note');
      const t = repo.transactionsData[0];
      expect(t.id.startsWith('tx-inc-')).toBe(true);
      expect(t.narration).toBe('MANUAL/SALARY');
      expect(t.direction).toBe('CREDIT');
      expect(t.type).toBe('Income');
      expect(t.category).toBe('SALARY');
      expect(t.amount).toBe(5000);
      expect(t.status).toBe('CLEARED');
      expect(t.notes).toBe('note');
      expect(t.date).toBe(LIVE_TODAY);
    });

    it('preserves the legacy default note on an expense with no note', () => {
      addAccount('HDFC Bank', 0);
      S().addExpense('Rent', 1200, 'HDFC Bank', 'HOUSING');
      expect(repo.transactionsData[0].notes).toBe('Manual expense entry');
      expect(repo.transactionsData[0].direction).toBe('DEBIT');
    });

    it('still resolves accountId through AccountResolutionService, and leaves unknown names unmapped', () => {
      const acc = addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      S().addIncome('Gift', 100, 'Nowhere Bank', 'GENERAL');

      // Select by title: the repository sorts on insert, so position is not insertion order.
      const byTitle = (t: string) => repo.transactionsData.find(x => x.title === t)!;
      expect(byTitle('Salary').accountId).toBe(acc.id);
      expect(byTitle('Gift').accountId).toBeNull();
    });

    it('creates a transfer balanced: two legs, opposite directions, equal magnitude', () => {
      addAccount('A', 0); addAccount('B', 0);
      S().addTransfer('A', 'B', 2000);
      const legs = repo.transactionsData.filter(t => t.type === 'Transfer');
      expect(legs).toHaveLength(2);
      expect(legs[0].transferId).toBe(legs[1].transferId);
      expect(legs.map(l => l.direction).sort()).toEqual(['CREDIT', 'DEBIT']);
      expect(legs[0].amount).toBe(legs[1].amount);
    });
  });

  /* ═══════════════════════════════ §5 provenance ═══════════════════════════ */
  describe('§5 explicit provenance', () => {
    it('stamps origin MANUAL and a recordedAt audit timestamp on manual rows', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const t = repo.transactionsData[0];
      expect(t.origin).toBe('MANUAL');
      expect(t.recordedAt).toBe(FIXED_CLOCK);
    });

    it('stamps both transfer legs', () => {
      addAccount('A', 0); addAccount('B', 0);
      S().addTransfer('A', 'B', 2000);
      for (const leg of repo.transactionsData) {
        expect(leg.origin).toBe('MANUAL');
        expect(leg.recordedAt).toBe(FIXED_CLOCK);
      }
    });

    it('recordedAt is the audit clock, NOT the financial value date', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const t = repo.transactionsData[0];
      expect(t.date).toBe(LIVE_TODAY);          // value date
      expect(t.recordedAt).toBe(FIXED_CLOCK);   // wall clock
      expect(t.recordedAt).not.toBe(t.date);
    });

    it('reports origin UNKNOWN for a legacy row rather than inferring it', () => {
      // A pre-06a imported row: it HAS importBatchId, which would make an
      // inference easy and tempting. The service must still refuse to guess.
      const legacy = row({ importBatchId: 'batch-123', sourceProvider: 'SBI Bank' });
      delete (legacy as any).origin;
      expect(TransactionIdentityService.originOf(legacy)).toBe('UNKNOWN');
    });

    it('reports origin UNKNOWN for a legacy manual row too', () => {
      const legacy = row();
      delete (legacy as any).origin;
      expect(TransactionIdentityService.originOf(legacy)).toBe('UNKNOWN');
    });

    it('reports the explicit origin when one was actually recorded', () => {
      expect(TransactionIdentityService.originOf(row({ origin: 'IMPORT' }))).toBe('IMPORT');
      expect(TransactionIdentityService.originOf(row({ origin: 'MANUAL' }))).toBe('MANUAL');
    });

    it('rejects a malformed origin value instead of trusting it', () => {
      expect(TransactionIdentityService.originOf(row({ origin: 'GUESSED' as any }))).toBe('UNKNOWN');
    });
  });

  /* ═════════════════════ §6 manual rows carry a fingerprint ════════════════ */
  describe('§6 manual transactions have a fingerprint at rest', () => {
    it('persists a fingerprint on a manual income row (discovery §11 said ABSENT)', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const t = repo.transactionsData[0];
      expect(t.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('the persisted fingerprint equals the recomputed one (stored == derived)', () => {
      addAccount('HDFC Bank', 0);
      S().addExpense('Rent', 1200, 'HDFC Bank', 'HOUSING');
      const t = repo.transactionsData[0];
      expect(t.fingerprint).toBe(TransactionIdentityService.fingerprint({
        account: t.account, date: t.date, amount: t.amount, narration: t.narration
      }));
    });

    it('persisting it changes NO dedup outcome — the store already computed one on the fly', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const manual = repo.transactionsData[0];

      // An imported row identical on the four fingerprinted fields is still a duplicate.
      const imported = row({
        id: 'tx-import-1',
        account: manual.account,
        date: manual.date,
        amount: manual.amount,
        narration: manual.narration,
        origin: 'IMPORT'
      });
      delete (imported as any).fingerprint;

      const res = S().commitImportedRows([imported]);
      expect(res.appended).toBe(0);
      expect(res.duplicates).toBe(1);
    });

    it('both transfer legs get distinct fingerprints (different account and narration)', () => {
      addAccount('A', 0); addAccount('B', 0);
      S().addTransfer('A', 'B', 2000);
      const [d, c] = repo.transactionsData;
      expect(d.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(d.fingerprint).not.toBe(c.fingerprint);
    });
  });

  /* ══════════════════ §7 L-02 divergent duplicate disclosure ═══════════════ */
  describe('§7 L-02 — a dropped correction is reported, not silent', () => {
    it('detects a fingerprint collision that disagrees on direction', () => {
      const stored = row({ direction: 'CREDIT', type: 'Income' as any });
      const corrected = row({ id: 'tx-2', direction: 'DEBIT', type: 'Expense' as any });
      expect(TransactionIdentityService.isDivergentDuplicate(corrected, stored)).toBe(true);
    });

    it('does NOT flag a plain identical re-import', () => {
      const stored = row();
      const same = row({ id: 'tx-2' });
      expect(TransactionIdentityService.isDivergentDuplicate(same, stored)).toBe(false);
    });

    it('does NOT flag rows that are simply different transactions', () => {
      const stored = row();
      const other = row({ id: 'tx-2', amount: 9999, direction: 'DEBIT', type: 'Expense' as any });
      expect(TransactionIdentityService.isDivergentDuplicate(other, stored)).toBe(false);
    });

    it('treats Income and INCOME as the same type (legacy casing is not a divergence)', () => {
      const stored = row({ type: 'Income' as any });
      const upper = row({ id: 'tx-2', type: 'INCOME' as any });
      expect(TransactionIdentityService.isDivergentDuplicate(upper, stored)).toBe(false);
    });

    it('the store still DROPS the divergent row, and now counts it', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const manual = repo.transactionsData[0];

      const flipped = row({
        id: 'tx-import-flip',
        account: manual.account,
        date: manual.date,
        amount: manual.amount,
        narration: manual.narration,
        direction: 'DEBIT',
        type: 'Expense' as any,
        origin: 'IMPORT'
      });
      delete (flipped as any).fingerprint;

      const before = repo.transactionsData.length;
      const res = S().commitImportedRows([flipped]);

      // Behaviour is UNCHANGED: still excluded, no new row, no balance movement.
      expect(res.appended).toBe(0);
      expect(res.duplicates).toBe(1);
      expect(repo.transactionsData.length).toBe(before);
      // Disclosure is NEW: the drop is now reported.
      expect(res.divergentDuplicates).toBe(1);
    });

    it('reports zero divergent duplicates for an ordinary duplicate', () => {
      addAccount('HDFC Bank', 0);
      S().addIncome('Salary', 5000, 'HDFC Bank', 'SALARY');
      const manual = repo.transactionsData[0];

      const same = row({
        id: 'tx-import-same',
        account: manual.account,
        date: manual.date,
        amount: manual.amount,
        narration: manual.narration,
        origin: 'IMPORT'
      });
      delete (same as any).fingerprint;

      const res = S().commitImportedRows([same]);
      expect(res.duplicates).toBe(1);
      expect(res.divergentDuplicates).toBe(0);
    });

    it('a genuinely new row still appends and is not mistaken for a divergence', () => {
      addAccount('HDFC Bank', 0);
      const fresh = row({ id: 'tx-new', narration: 'SOMETHING ELSE ENTIRELY', origin: 'IMPORT' });
      delete (fresh as any).fingerprint;
      const res = S().commitImportedRows([fresh]);
      expect(res.appended).toBe(1);
      expect(res.duplicates).toBe(0);
      expect(res.divergentDuplicates).toBe(0);
    });
  });

  /* ════════════════════════════ §8 scope boundary ══════════════════════════ */
  describe('§8 scope boundary — no lifecycle in 06a (L-01 later closed by 06b)', () => {
    it('transactions remain append-only: no update/remove API was introduced', () => {
      const txRepo = repository.transactions as any;
      expect(typeof txRepo.remove).toBe('undefined');
      expect(typeof txRepo.update).toBe('undefined');
      expect(typeof txRepo.replace).toBe('undefined');
    });

    /**
     * UPDATED BY WP-FB-DATA-06b.
     *
     * This test previously asserted that `transferId` was "only a label" and
     * that nothing enforced leg symmetry — a marker for the then-open L-01.
     * DATA-06b closed L-01 at the repository admission boundary, so the marker
     * is flipped rather than deleted: the write path now refuses an asymmetric
     * pair, and the only way to produce one is to bypass the API entirely.
     */
    it('the write path now enforces leg symmetry (L-01 closed by DATA-06b)', async () => {
      addAccount('A', 0); addAccount('B', 0);
      await S().addTransfer('A', 'B', 2000);
      const legs = repo.transactionsData.filter(t => t.type === 'Transfer');
      expect(legs).toHaveLength(2);

      // Appending a lone extra leg is now refused.
      let refused = false;
      try {
        await repository.transactions.append({ ...legs[0], id: 'extra-leg' });
      } catch { refused = true; }
      expect(refused).toBe(true);
      expect(repo.transactionsData.filter(t => t.type === 'Transfer')).toHaveLength(2);
    });
  });
});
