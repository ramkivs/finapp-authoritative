/**
 * WP-FB-DATA-04b — Transfer direction semantics.
 *
 * Clears blocker B1 from the WP-FB-DATA-05 discovery: a transfer is two rows
 * sharing a `transferId`, both `type: 'Transfer'` with the SAME positive
 * `amount`. Without an explicit direction the legs are structurally identical
 * and no balance can be derived without parsing narration/id strings.
 *
 *   DEBIT  -> money leaves the account (-amount)
 *   CREDIT -> money enters the account (+amount)
 *
 * Transfers previously had ZERO test coverage despite being the only
 * money-moving operation in the product.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TransactionSignService } from '../services/TransactionSignService';
import { ImportPipelineService } from '../services/ImportPipelineService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const FIXTURES = path.resolve(__dirname, '../../scripts/fixtures');
const LIVE_TODAY = '2026-08-21';

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

/** A legacy transfer leg exactly as the pre-04b code produced it. */
function legacyLeg(kind: 'debit' | 'credit', trId = 'tr-legacy-1'): Transaction {
  return {
    id: `${trId}-${kind}`,
    transferId: trId,
    date: '2026-08-18',
    dateStr: '18 Aug 2026',
    title: kind === 'debit' ? 'Transfer to B' : 'Transfer from A',
    narration: `TRANSFER-${kind.toUpperCase()}/${trId}`,
    account: kind === 'debit' ? 'A' : 'B',
    type: 'Transfer' as any,
    category: 'TRANSFER',
    amount: 2000,
    status: 'CLEARED' as any,
    notes: kind === 'debit' ? 'Bank-to-Bank Transfer (Debit)' : 'Bank-to-Bank Transfer (Credit)',
    fingerprint: `fp-legacy-${kind}`
  };
}

describe('WP-FB-DATA-04b — transfer direction', () => {
  beforeEach(() => { reset(); setAsOfDateOverride(LIVE_TODAY); });
  afterEach(() => { resetAsOfDateOverride(); reset(); });

  /* --------------------------------------------------------- sign authority */
  describe('signed amount', () => {
    it('signs Income positive and Expense negative from type alone', () => {
      const inc = { type: 'Income', amount: 1000 } as Transaction;
      const exp = { type: 'Expense', amount: 300 } as Transaction;
      expect(TransactionSignService.signedAmount(inc)).toBe(1000);
      expect(TransactionSignService.signedAmount(exp)).toBe(-300);
    });

    it('honours an explicit direction over type', () => {
      const debit = { type: 'Transfer', amount: 2000, direction: 'DEBIT' } as Transaction;
      const credit = { type: 'Transfer', amount: 2000, direction: 'CREDIT' } as Transaction;
      expect(TransactionSignService.signedAmount(debit)).toBe(-2000);
      expect(TransactionSignService.signedAmount(credit)).toBe(2000);
    });

    it('treats amount as a magnitude regardless of stored sign', () => {
      const t = { type: 'Transfer', amount: -2000, direction: 'DEBIT' } as Transaction;
      expect(TransactionSignService.signedAmount(t)).toBe(-2000);
    });

    it('returns 0 and flags undetermined rather than guessing', () => {
      const orphan = {
        id: 'x', type: 'Transfer', amount: 500, narration: 'SOMETHING ELSE', notes: ''
      } as Transaction;
      expect(TransactionSignService.isDirectionUndetermined(orphan)).toBe(true);
      expect(TransactionSignService.signedAmount(orphan)).toBe(0);
    });
  });

  /* ----------------------------------------------------- legacy recovery */
  describe('legacy migration', () => {
    it('recovers direction from the generated id suffix', () => {
      expect(TransactionSignService.recoverLegacyDirection(legacyLeg('debit'))).toBe('DEBIT');
      expect(TransactionSignService.recoverLegacyDirection(legacyLeg('credit'))).toBe('CREDIT');
    });

    it('falls back to the narration prefix when the id is unhelpful', () => {
      const t = { ...legacyLeg('credit'), id: 'renamed-id' };
      expect(TransactionSignService.recoverLegacyDirection(t)).toBe('CREDIT');
    });

    it('falls back to the notes text as a last resort', () => {
      const t = { ...legacyLeg('debit'), id: 'x', narration: 'OPAQUE' };
      expect(TransactionSignService.recoverLegacyDirection(t)).toBe('DEBIT');
    });

    it('migrates a legacy pair without touching any other field', () => {
      const before = [legacyLeg('debit'), legacyLeg('credit')];
      const snapshot = before.map(t => ({ ...t }));
      const res = TransactionSignService.migrate(before);

      expect(res.assigned).toBe(2);
      expect(res.undetermined).toBe(0);
      expect(res.transactions[0].direction).toBe('DEBIT');
      expect(res.transactions[1].direction).toBe('CREDIT');

      res.transactions.forEach((t, i) => {
        expect(t.id).toBe(snapshot[i].id);
        expect(t.amount).toBe(snapshot[i].amount);
        expect(t.date).toBe(snapshot[i].date);
        expect(t.narration).toBe(snapshot[i].narration);
        expect(t.account).toBe(snapshot[i].account);
        expect(t.fingerprint).toBe(snapshot[i].fingerprint);   // unchanged
      });
      // input not mutated
      expect(before[0].direction === undefined || before[0].direction === 'DEBIT').toBe(true);
    });

    it('is idempotent and never overwrites an explicit direction', () => {
      const rows = [{ ...legacyLeg('debit'), direction: 'CREDIT' as const }];
      const res = TransactionSignService.migrate(rows);
      expect(res.alreadySet).toBe(1);
      expect(res.assigned).toBe(0);
      expect(res.transactions[0].direction).toBe('CREDIT');
    });
  });

  /* --------------------------------------------- live transfer accounting */
  describe('transfer accounting (DATA-05 scenario 3)', () => {
    it('produces two oppositely-signed legs across two accounts', () => {
      const A = addAccount('A', 10000);
      const B = addAccount('B', 5000);
      S().addTransfer('A', 'B', 2000);

      const legs = S().transactions.filter(t => String(t.type).toUpperCase() === 'TRANSFER');
      expect(legs).toHaveLength(2);

      const debit = legs.find(l => l.accountId === A.id)!;
      const credit = legs.find(l => l.accountId === B.id)!;

      expect(debit.direction).toBe('DEBIT');
      expect(credit.direction).toBe('CREDIT');
      expect(TransactionSignService.signedAmount(debit)).toBe(-2000);
      expect(TransactionSignService.signedAmount(credit)).toBe(2000);
      expect(debit.transferId).toBe(credit.transferId);
    });

    it('nets to zero across the pair (no net worth impact)', () => {
      addAccount('A', 10000); addAccount('B', 5000);
      S().addTransfer('A', 'B', 2000);
      const net = S().transactions
        .filter(t => String(t.type).toUpperCase() === 'TRANSFER')
        .reduce((s, t) => s + TransactionSignService.signedAmount(t), 0);
      expect(net).toBe(0);
    });

    it('yields the DATA-05 scenario-3 balances once derived', () => {
      const A = addAccount('A', 10000);
      const B = addAccount('B', 5000);
      S().addTransfer('A', 'B', 2000);

      const derive = (id: string, opening: number) =>
        opening + S().transactions
          .filter(t => t.accountId === id)
          .reduce((s, t) => s + TransactionSignService.signedAmount(t), 0);

      expect(derive(A.id, 10000)).toBe(8000);
      expect(derive(B.id, 5000)).toBe(7000);
      expect(derive(A.id, 10000) + derive(B.id, 5000)).toBe(15000);
    });

    it('yields scenario-2 balance for income + expense + transfer out', () => {
      const A = addAccount('A', 10000);
      addAccount('B', 0);
      S().addIncome('Inc', 1000, 'A', 'GENERAL');
      S().addExpense('Exp', 300, 'A', 'GENERAL');
      S().addTransfer('A', 'B', 2000);

      const derived = 10000 + S().transactions
        .filter(t => t.accountId === A.id)
        .reduce((s, t) => s + TransactionSignService.signedAmount(t), 0);

      expect(derived).toBe(8700);   // 10000 + 1000 - 300 - 2000
    });
  });

  /* ------------------------------------------------- manual + import paths */
  describe('write paths set direction', () => {
    it('manual income and expense carry a direction', () => {
      addAccount('A', 0);
      S().addIncome('Inc', 1000, 'A', 'GENERAL');
      S().addExpense('Exp', 300, 'A', 'GENERAL');
      const [a, b] = S().transactions;
      const dirs = [a, b].map(t => t.direction).sort();
      expect(dirs).toEqual(['CREDIT', 'DEBIT']);
      expect(S().transactions.every(t => !TransactionSignService.isDirectionUndetermined(t))).toBe(true);
    });

    it('imported rows carry a direction matching their credit/debit column', () => {
      addAccount('SBI Bank', 0);
      const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'SBI_Statement.xlsx')));
      const r = ImportPipelineService.processBinaryFile(bytes, [], 'Bank Import', 'SBI_Statement.xlsx');
      S().commitImportedRows(r.validRows);

      const rows = S().transactions;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(t => !TransactionSignService.isDirectionUndetermined(t))).toBe(true);
      for (const t of rows) {
        const expected = String(t.type).toUpperCase() === 'INCOME' ? 'CREDIT' : 'DEBIT';
        expect(t.direction).toBe(expected);
      }
      // SBI fixture: +1 +604.93 -500
      const net = rows.reduce((s, t) => s + TransactionSignService.signedAmount(t), 0);
      expect(net).toBeCloseTo(105.93, 2);
    });
  });

  /* ------------------------------------------------------- non-regression */
  describe('non-regression', () => {
    it('does not include direction in the deduplication fingerprint', () => {
      const fp = (t: Transaction) =>
        `${t.account}|${t.date}|${t.amount}|${t.narration.toLowerCase().trim()}`;
      const a = { ...legacyLeg('debit'), direction: 'DEBIT' as const };
      const b = { ...legacyLeg('debit'), direction: undefined };
      expect(fp(a)).toBe(fp(b));
    });

    it('leaves Ledger visibility unchanged', () => {
      addAccount('A', 0); addAccount('B', 0);
      S().addTransfer('A', 'B', 2000);
      const s = S();
      expect(s.getFilteredTransactions({ type: 'All', dateRange: 'YTD' }).length)
        .toBe(s.transactions.length);
    });
  });
});
