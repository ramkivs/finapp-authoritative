/**
 * WP-FB-DATA-06c-2a — Amendment UI affordance.
 *
 * Decisions implemented: Q-UI-1 = (c), Q-UI-2 = (a), Q-UI-3 accepted.
 *
 * WHAT THIS FILE IS FOR
 *
 * The 06c-2 package proved the amendment PRIMITIVE is safe. This one proves the
 * UI cannot get around it. Every test therefore asserts BEHAVIOUR through the
 * rendered control — not that a component exists, but that clicking it produces
 * the write the services sanction, and that a blocked control cannot be made to
 * produce one.
 *
 * The OverviewPage lesson (WP-21) applies directly: Layer 1 (the control
 * renders) passed for six inert anchors while Layer 2 (it does something) did
 * not. These tests are Layer 2.
 *
 *   §1  eligibility parity — the control agrees with the authority
 *   §2  the exposed field set is exactly Q-UI-1 = (c)
 *   §3  immutable fields are shown, with a reason
 *   §4  the write goes through supersede, atomically, once
 *   §5  refusals are rendered and the modal stays open
 *   §6  transfers (Q-UI-2 = a)
 *   §7  ledger disclosure — reason badges, linkage, provenance
 *   §8  Import History correctionCount (Q-UI-3 iii)
 *   §9  scope boundary — no restore, no new authority
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { CorrectTransactionModal } from '../components/money/CorrectTransactionModal';
import { MoneyPage } from '../pages/MoneyPage';
import { ImportPage } from '../pages/ImportPage';
import {
  TransactionAmendmentService,
  AMENDABLE_FIELDS
} from '../services/TransactionAmendmentService';
import { LedgerExclusionService, KNOWN_EXCLUSION_REASONS } from '../services/LedgerExclusionService';
import { ImportBatchRollbackService } from '../services/ImportBatchRollbackService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { setAsOfDateOverride, resetAsOfDateOverride } from '../services/DateRangeService';
import { Transaction } from '../domain/types';

const ASOF = '2026-08-31';
const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const rows = (): Transaction[] => repo.transactionsData;
const byId = (id: string) => rows().find(t => t.id === id) as Transaction;
const bal = (a: any) =>
  AccountBalanceService.balance(a.id, S().accounts, S().transactions, ASOF).balance;
const force = (n: Transaction[]) => { repo.transactionsData = n; repo.syncStore(); };

function reset() {
  repo.transactionsData = []; repo.accountsData = []; repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], accounts: [], filterType: 'All', dateRange: 'YTD', searchQuery: ''
  } as any);
}
function acct(n: string, o = 0) {
  S().addAccount({ name: n, type: 'Bank', openingBalance: o, asOfDate: '2026-08-01' });
  return S().accounts.find((a: any) => a.name === n);
}
async function income(A: any, amount: number, title = 'Salary') {
  const tx = TransactionFactory.createIncome({
    title, amount, account: A.name, accountId: A.id, category: 'Income'
  });
  await repository.transactions.append(tx);
  return tx;
}
async function transferPair(A: any, B: any, amount = 2000) {
  const [d, c] = TransactionFactory.createTransferPair({
    source: A.name, destination: B.name, amount,
    sourceAccountId: A.id, destinationAccountId: B.id
  });
  await repository.transactions.appendMany([d, c]);
  return [d, c];
}

/** Renders the modal against the live store for `tx`. */
function openModal(tx: Transaction, onSuccess?: (id: string) => void) {
  const onClose = vi.fn();
  const utils = render(
    <CorrectTransactionModal
      isOpen
      transaction={tx}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
  return { ...utils, onClose };
}

const submitBtn = () => document.getElementById('correct-submit') as HTMLButtonElement;
const setInput = (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  fireEvent.change(el, { target: { value } });
};

describe('WP-FB-DATA-06c-2a — amendment UI affordance', () => {
  beforeEach(() => { reset(); setAsOfDateOverride('2026-08-21'); });
  afterEach(() => {
    cleanup();
    resetAsOfDateOverride();
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    reset();
  });

  /* ═════════════════ §1 eligibility parity ═══════════════════════════════ */
  describe('§1 the control agrees with the authority', () => {
    it('a live single row is correctable and the submit control can be enabled', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      expect(document.getElementById('correct-blocked')).toBeNull();
      setInput('correct-amount', '5500');
      expect(submitBtn().disabled).toBe(false);
    });

    it('eligibility is READ FROM the service, not re-derived', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const spy = vi.spyOn(TransactionAmendmentService, 'singleRowCorrectability');
      openModal(byId(v1.id));
      expect(spy).toHaveBeenCalledWith(v1.id, expect.anything());
    });

    it('an ALREADY-SUPERSEDED row is blocked with the reason the service gives', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      openModal(byId(v1.id));
      const blocked = document.getElementById('correct-blocked')!;
      expect(blocked).toBeTruthy();
      expect(blocked.getAttribute('data-correct-blocked')).toBe('TARGET_ALREADY_EXCLUDED');
      expect(blocked.textContent).toContain('amend the current version');
      expect(submitBtn().disabled).toBe(true);
    });

    it('an IMPORT-ROLLED-BACK row is blocked with a DIFFERENT reason', async () => {
      const A = acct('A', 10000);
      const tx: any = { ...(await income(A, 1000, 'Imported')), importBatchId: 'bx', origin: 'IMPORT' };
      force(rows().map(t => t.id === tx.id ? tx : t));
      await repository.transactions.rollbackBatch('bx');
      openModal(byId(tx.id));
      const blocked = document.getElementById('correct-blocked')!;
      expect(blocked.getAttribute('data-correct-blocked')).toBe('TARGET_ALREADY_EXCLUDED');
      expect(blocked.textContent).toContain('rolled back with its import batch');
      expect(blocked.textContent).toContain('put its money back');
    });

    it('submit stays disabled when NOTHING changed (no no-op corrections)', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      expect(submitBtn().disabled).toBe(true);
      expect(document.getElementById('correct-diff')).toBeNull();
    });

    it('submit stays disabled for a zero or negative amount', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      setInput('correct-amount', '0');
      expect(submitBtn().disabled).toBe(true);
      setInput('correct-amount', '-5');
      expect(submitBtn().disabled).toBe(true);
    });

    it('the source row is identified unambiguously BY ID', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      const src = document.getElementById('correct-source-row')!;
      expect(src.querySelector(`[data-source-id="${v1.id}"]`)).toBeTruthy();
      expect(document.getElementById('correct-transaction-modal')!
        .getAttribute('data-correct-target')).toBe(v1.id);
    });
  });

  /* ═════════════════ §2 the exposed field set (Q-UI-1 = c) ═══════════════ */
  describe('§2 exposed field set is exactly Q-UI-1 = (c)', () => {
    it('renders exactly the six approved editable controls', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      for (const id of ['correct-amount', 'correct-date', 'correct-title',
                        'correct-category', 'correct-notes', 'correct-account']) {
        expect(document.getElementById(id)).toBeTruthy();
      }
    });

    it('does NOT render controls for type, direction, status or narration', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      for (const id of ['correct-type', 'correct-direction', 'correct-status', 'correct-narration']) {
        expect(document.getElementById(id)).toBeNull();
      }
    });

    /* The measured hazard behind the decision: `type` alone swung a balance
       15,000 -> 5,000 and `direction` alone produced a row labelled "Income"
       that subtracts. Neither may reach the payload from this form. */
    it('the submitted payload can never contain type, direction, status or narration', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const spy = vi.spyOn(S(), 'supersedeTransactions');
      const { onClose } = openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      setInput('correct-title', 'Corrected title');
      setInput('correct-category', 'Bonus');
      setInput('correct-notes', 'why');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(onClose).toHaveBeenCalled());

      const payload = spy.mock.calls[0][0][0];
      expect(Object.keys(payload.changes).sort())
        .toEqual(['amount', 'category', 'notes', 'title']);
      for (const forbidden of ['type', 'direction', 'status', 'narration',
                               'id', 'fingerprint', 'supersedes', 'excludedAt',
                               'importBatchId', 'origin', 'recordedAt', 'dateStr']) {
        expect(payload.changes).not.toHaveProperty(forbidden);
      }
    });

    it('account is a PICKER over registered accounts, never free text', async () => {
      const A = acct('A', 10000); const B = acct('B', 1000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      const select = document.getElementById('correct-account') as HTMLSelectElement;
      expect(select.tagName).toBe('SELECT');
      const values = [...select.options].map(o => o.value);
      expect(values).toContain(A.id);
      expect(values).toContain(B.id);
      expect(values).toContain('__UNMAPPED__');
      // exactly the registered accounts plus the one explicit unmapped option
      expect(values).toHaveLength(S().accounts.length + 1);
    });

    /* The gate measured a free-text accountId removing 5,000 from every
       balance, because the row became unmapped. A picker makes the dangling
       reference unreachable: every selectable value is a registered id. */
    it('every selectable account value resolves to a registered account', async () => {
      const A = acct('A', 10000); acct('B', 1000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      const select = document.getElementById('correct-account') as HTMLSelectElement;
      const ids = S().accounts.map((a: any) => a.id);
      for (const o of [...select.options]) {
        if (o.value === '__UNMAPPED__') continue;
        expect(ids).toContain(o.value);
      }
    });

    it('choosing the unmapped option sends accountId null, not a bogus string', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const spy = vi.spyOn(S(), 'supersedeTransactions');
      openModal(byId(v1.id));
      fireEvent.change(document.getElementById('correct-account')!, { target: { value: '__UNMAPPED__' } });
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      expect(spy.mock.calls[0][0][0].changes.accountId).toBeNull();
    });

    it('the API still permits more than the UI exposes — the UI is the narrower gate', () => {
      expect(AMENDABLE_FIELDS.length).toBe(11);
      const uiExposed = ['amount', 'date', 'title', 'category', 'notes', 'accountId', 'account'];
      for (const f of uiExposed) expect(AMENDABLE_FIELDS as readonly string[]).toContain(f);
      for (const f of ['type', 'direction', 'status', 'narration']) {
        expect(AMENDABLE_FIELDS as readonly string[]).toContain(f);   // API allows
      }
    });
  });

  /* ═════════════════ §3 immutable fields shown with a reason ═════════════ */
  describe('§3 immutable fields are disclosed, not hidden', () => {
    it('lists statement text, type/direction and provenance as unchangeable', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      const box = document.getElementById('correct-immutable')!;
      expect(box.querySelector('[data-immutable="narration"]')).toBeTruthy();
      expect(box.querySelector('[data-immutable="type"]')).toBeTruthy();
      expect(box.querySelector('[data-immutable="identity"]')).toBeTruthy();
      expect(box.textContent).toContain('flips whether money');
    });

    it('an IMPORTED row explains that the statement text is the source', async () => {
      const A = acct('A', 10000);
      const imp: any = {
        ...(await income(A, 1000, 'ATM')),
        origin: 'IMPORT', importBatchId: 'bx', sourceProvider: 'SBI', sourceFile: 'SBI.xlsx'
      };
      force(rows().map(t => t.id === imp.id ? imp : t));
      openModal(byId(imp.id));
      const box = document.getElementById('correct-immutable')!;
      expect(box.textContent).toContain('what the bank statement says');
      expect(box.textContent).toContain('SBI.xlsx');
    });

    it('a MANUAL row does not claim to have a bank statement', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      const box = document.getElementById('correct-immutable')!;
      expect(box.textContent).not.toContain('what the bank statement says');
      expect(box.textContent).toContain('kept as originally recorded');
    });

    it('the correction is announced as "Edited after recording" (Q-UI-3 ii)', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      expect(document.getElementById('correct-immutable')!.textContent)
        .toContain('Edited after recording');
    });
  });

  /* ═════════════════ §4 the write path ═══════════════════════════════════ */
  describe('§4 the write goes through supersede, once', () => {
    it('a correction submitted from the form changes the balance', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      expect(bal(A)).toBe(15000);
      const { onClose } = openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bal(A)).toBe(15500);
      expect(rows()).toHaveLength(2);
    });

    it('the UI calls supersede — never append/appendMany directly', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const sup = vi.spyOn(repository.transactions, 'supersede');
      const app = vi.spyOn(repository.transactions, 'append');
      const many = vi.spyOn(repository.transactions, 'appendMany');
      const { onClose } = openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(sup).toHaveBeenCalledTimes(1);
      expect(app).not.toHaveBeenCalled();
      expect(many).not.toHaveBeenCalled();
    });

    it('exactly ONE saveAll, and no persisted snapshot double-counts', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const seen: number[] = [];
      const save = vi.spyOn(IndexedDBStorageService, 'saveAll')
        .mockImplementation(async (st: any) => {
          seen.push(LedgerExclusionService.forDerivation(st.transactions).length);
        });
      const { onClose } = openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(save).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([1]);
    });

    it('shows a before -> after diff of exactly the changed fields', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      setInput('correct-category', 'Bonus');
      const diff = document.getElementById('correct-diff')!;
      expect(diff.querySelector('[data-diff-field="amount"]')).toBeTruthy();
      expect(diff.querySelector('[data-diff-field="category"]')).toBeTruthy();
      expect(diff.querySelector('[data-diff-field="title"]')).toBeNull();
      expect(diff.textContent).toContain('5000');
      expect(diff.textContent).toContain('5500');
    });

    it('the modal CLOSES and reports success on a successful correction', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const onSuccess = vi.fn();
      const { onClose } = openModal(byId(v1.id), onSuccess);
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(onSuccess).toHaveBeenCalledTimes(1);
      const correctionId = onSuccess.mock.calls[0][0];
      expect(byId(correctionId).supersedes).toBe(v1.id);
      expect(byId(correctionId).provenanceDiverged).toBe(true);
    });
  });

  /* ═════════════════ §5 refusals ═════════════════════════════════════════ */
  describe('§5 refusals are rendered; the modal stays open', () => {
    it('a persistence failure is shown inline and the modal does NOT close', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      IndexedDBStorageService.simulateFailureOnce = true;
      const { onClose } = openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(document.getElementById('correct-error')).toBeTruthy());
      expect(onClose).not.toHaveBeenCalled();
      expect(bal(A)).toBe(15000);
      expect(rows()).toHaveLength(1);
    });

    it('a READFAIL refusal reaches the user verbatim', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      vi.spyOn(IndexedDBStorageService, 'saveAll').mockRejectedValueOnce(
        new Error('Refusing to persist: the last IndexedDB load failed, so the in-memory ledger may be empty or partial and writing it would destroy stored data.')
      );
      const { onClose } = openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(document.getElementById('correct-error')).toBeTruthy());
      expect(document.getElementById('correct-error')!.textContent).toContain('Refusing to persist');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('the refusal MESSAGE is rendered, not merely a code', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      IndexedDBStorageService.simulateFailureOnce = true;
      openModal(byId(v1.id));
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(document.getElementById('correct-error')).toBeTruthy());
      const text = document.getElementById('correct-error')!.textContent || '';
      expect(text.length).toBeGreaterThan(30);
    });

    it('a blocked row cannot be submitted even if the form is forced', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      const before = JSON.parse(JSON.stringify(rows()));
      const sup = vi.spyOn(repository.transactions, 'supersede');
      const { onClose } = openModal(byId(v1.id));
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(document.getElementById('correct-error')).toBeTruthy());
      expect(sup).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
    });
  });

  /* ═════════════════ §6 transfers (Q-UI-2 = a) ═══════════════════════════ */
  describe('§6 transfers are blocked with an explanation', () => {
    it('a transfer leg is not correctable and says why', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = await transferPair(A, B, 2000);
      openModal(byId(d.id));
      const blocked = document.getElementById('correct-blocked')!;
      expect(blocked.getAttribute('data-correct-blocked')).toBe('PARTIAL_TRANSFER_AMENDMENT');
      expect(blocked.textContent).toContain('one leg of a transfer');
      expect(blocked.textContent).toContain('as a whole');
      expect(submitBtn().disabled).toBe(true);
    });

    /* NOTE ON THE ASSERTION. The controls are disabled by an ancestor
       `<fieldset disabled>`, and `element.disabled` reflects only the element's
       OWN attribute — it stays false. The effective state is what `:disabled`
       matches, which is also what decides focusability and form submission.
       Asserting `.disabled` here would silently pass on a broken form. */
    it('every editable control is effectively disabled for a transfer leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = await transferPair(A, B, 2000);
      openModal(byId(d.id));
      for (const id of ['correct-amount', 'correct-date', 'correct-title',
                        'correct-category', 'correct-notes', 'correct-account']) {
        const el = document.getElementById(id)!;
        expect(el.matches(':disabled')).toBe(true);
        expect(el.closest('fieldset[disabled]')).toBeTruthy();
      }
    });

    it('the UI can never submit a single transfer leg', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = await transferPair(A, B, 2000);
      const sup = vi.spyOn(repository.transactions, 'supersede');
      openModal(byId(d.id));
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(() => expect(document.getElementById('correct-error')).toBeTruthy());
      expect(sup).not.toHaveBeenCalled();
      expect(bal(A) + bal(B)).toBe(15000);
    });

    it('the service agrees: a transfer leg is never singly correctable', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = await transferPair(A, B, 2000);
      for (const leg of [d, c]) {
        const e = TransactionAmendmentService.singleRowCorrectability(leg.id, rows());
        expect(e.correctable).toBe(false);
        expect(e.code).toBe('PARTIAL_TRANSFER_AMENDMENT');
      }
    });

    it('the API-level whole-transfer amendment is still available (not regressed)', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d, c] = await transferPair(A, B, 2000);
      const res = await repository.transactions.supersede([
        { targetId: d.id, changes: { amount: 2500 } },
        { targetId: c.id, changes: { amount: 2500 } }
      ]);
      expect(res.correctionCount).toBe(2);
      expect(bal(A) + bal(B)).toBe(15000);
    });
  });

  /* ═════════════════ §7 ledger disclosure ════════════════════════════════ */
  describe('§7 ledger disclosure primitives (Q-UI-3 i & ii)', () => {
    it('the exclusion REASON is derivable per row for the badge', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const imp: any = { ...(await income(A, 1000, 'Imp')), importBatchId: 'bx', origin: 'IMPORT' };
      force(rows().map(t => t.id === imp.id ? imp : t));
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      await repository.transactions.rollbackBatch('bx');

      expect(LedgerExclusionService.reasonOf(byId(v1.id))).toBe('SUPERSEDED');
      expect(LedgerExclusionService.reasonOf(byId(imp.id))).toBe('IMPORT_ROLLBACK');
      // two excluded rows, two DIFFERENT reasons — the badge can distinguish them
      expect(new Set(LedgerExclusionService.excluded(rows())
        .map(t => LedgerExclusionService.reasonOf(t))).size).toBe(2);
    });

    it('original -> correction is resolvable for the ledger link', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const res = await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      const index = new Map(
        rows().filter(t => TransactionAmendmentService.isCorrection(t))
              .map(t => [t.supersedes as string, t])
      );
      expect(index.get(v1.id)!.id).toBe(res.outcomes[0].correctionId);
    });

    it('provenanceDiverged is present on the correction for the "Edited after recording" tag', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const res = await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      expect(byId(res.outcomes[0].correctionId).provenanceDiverged).toBe(true);
      expect(byId(v1.id).provenanceDiverged).toBeUndefined();
    });

    it('both rows remain in the DISPLAY projection (excluded is not hidden)', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      expect(S().getFilteredTransactions()).toHaveLength(2);
      expect(LedgerExclusionService.forDerivation(rows())).toHaveLength(1);
    });
  });

  /* ═════════════════ §8 Import History (Q-UI-3 iii) ══════════════════════ */
  describe('§8 Import History discloses retained corrections', () => {
    it('correctionCount is non-zero and the batch is not "fully rolled back"', async () => {
      const A = acct('A', 0);
      const mk = (id: string, amount: number, title: string): any => ({
        id, date: '2026-08-10', dateStr: '10 Aug 2026', title, narration: title,
        account: A.name, accountId: A.id, direction: 'CREDIT', type: 'Income',
        category: 'Income', amount, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bx', sourceProvider: 'SBI', sourceFile: 'SBI.xlsx',
        recordedAt: new Date().toISOString()
      });
      await repository.transactions.appendMany([mk('i1', 1000, 'R1'), mk('i2', 2000, 'R2')]);
      await repository.transactions.supersede([{ targetId: 'i1', changes: { amount: 1500 } }]);
      await repository.transactions.rollbackBatch('bx');

      const [s] = ImportBatchRollbackService.listBatches(rows());
      expect(s.correctionCount).toBe(1);
      expect(s.status).toBe('PARTIALLY_EXCLUDED');
      expect(bal(A)).toBe(1500);
    });

    it('a batch with no corrections reports zero', async () => {
      const A = acct('A', 0);
      const tx: any = {
        id: 'i1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'R', narration: 'R',
        account: A.name, accountId: A.id, direction: 'CREDIT', type: 'Income',
        category: 'Income', amount: 100, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bx', recordedAt: new Date().toISOString()
      };
      await repository.transactions.append(tx);
      expect(ImportBatchRollbackService.listBatches(rows())[0].correctionCount).toBe(0);
    });
  });

  /* ═════════════════ §10 the RENDERED ledger and import history ═════════ */
  /* §7 and §8 prove the DATA supports each disclosure. That is Layer 1. These
     render the real pages and assert the disclosure is actually on screen —
     the WP-21 lesson, where six controls rendered and none of them worked. */
  describe('§10 rendered disclosure (Layer 2)', () => {
    const renderMoney = () =>
      render(<MoneyPage openModal={vi.fn()} openSidebarTab={vi.fn()} />);

    it('every ledger row carries a Correct control', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      renderMoney();
      const btn = document.querySelector(`[data-correct-transaction="${v1.id}"]`) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(false);
      expect(document.querySelector('thead')!.textContent).toContain('Correct');
    });

    it('a transfer leg renders a DISABLED Correct control with the reason in its title', async () => {
      const A = acct('A', 10000); const B = acct('B', 5000);
      const [d] = await transferPair(A, B, 2000);
      renderMoney();
      const btn = document.querySelector(`[data-correct-transaction="${d.id}"]`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('data-correct-blocked-code')).toBe('PARTIAL_TRANSFER_AMENDMENT');
      expect(btn.getAttribute('title')).toContain('as a whole');
    });

    it('an excluded row renders a DISABLED Correct control', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      renderMoney();
      const btn = document.querySelector(`[data-correct-transaction="${v1.id}"]`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('data-correct-blocked-code')).toBe('TARGET_ALREADY_EXCLUDED');
    });

    it('SUPERSEDED and IMPORT_ROLLBACK render DIFFERENT badges (Q-UI-3 i)', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const imp: any = { ...(await income(A, 1000, 'Imp')), importBatchId: 'bx', origin: 'IMPORT' };
      force(rows().map(t => t.id === imp.id ? imp : t));
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      await repository.transactions.rollbackBatch('bx');
      renderMoney();

      const sup = document.querySelector('[data-exclusion-reason="SUPERSEDED"]')!;
      const rb = document.querySelector('[data-exclusion-reason="IMPORT_ROLLBACK"]')!;
      expect(sup).toBeTruthy();
      expect(rb).toBeTruthy();
      expect(sup.textContent!.trim()).toBe('SUPERSEDED');
      expect(rb.textContent!.trim()).toBe('ROLLED BACK');
      expect(sup.textContent).not.toBe(rb.textContent);
    });

    it('the original links FORWARD to its correction and the correction BACK (Q-UI-3)', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      const res = await repository.transactions
        .supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      const corrId = res.outcomes[0].correctionId;
      renderMoney();
      expect(document.querySelector(`[data-superseded-by="${corrId}"]`)).toBeTruthy();
      expect(document.querySelector(`[data-supersedes="${v1.id}"]`)).toBeTruthy();
    });

    it('the correction renders "Edited after recording" (Q-UI-3 ii)', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      await repository.transactions.supersede([{ targetId: v1.id, changes: { amount: 5500 } }]);
      renderMoney();
      const tag = document.querySelector('[data-provenance-diverged="true"]')!;
      expect(tag).toBeTruthy();
      expect(tag.textContent).toContain('Edited after recording');
      // exactly one — the ORIGINAL must not claim to have been edited
      expect(document.querySelectorAll('[data-provenance-diverged="true"]')).toHaveLength(1);
    });

    it('clicking Correct opens the modal for that exact row', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      renderMoney();
      fireEvent.click(document.querySelector(`[data-correct-transaction="${v1.id}"]`)!);
      await waitFor(() => expect(document.getElementById('correct-transaction-modal')).toBeTruthy());
      expect(document.getElementById('correct-transaction-modal')!
        .getAttribute('data-correct-target')).toBe(v1.id);
    });

    it('a correction driven entirely through the page updates the ledger and notifies', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      renderMoney();
      fireEvent.click(document.querySelector(`[data-correct-transaction="${v1.id}"]`)!);
      await waitFor(() => expect(document.getElementById('correct-amount')).toBeTruthy());
      setInput('correct-amount', '5500');
      fireEvent.submit(document.querySelector('#correct-transaction-modal form')!);
      await waitFor(() => expect(document.getElementById('correction-notice')).toBeTruthy());
      expect(document.getElementById('correction-notice')!
        .getAttribute('data-correction-kind')).toBe('success');
      expect(bal(A)).toBe(15500);
      expect(document.getElementById('correct-transaction-modal')).toBeNull();
    });

    it('Import History renders the retained-correction count (Q-UI-3 iii)', async () => {
      const A = acct('A', 0);
      const mk = (id: string, amount: number): any => ({
        id, date: '2026-08-10', dateStr: '10 Aug 2026', title: id, narration: id,
        account: A.name, accountId: A.id, direction: 'CREDIT', type: 'Income',
        category: 'Income', amount, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bx', sourceProvider: 'SBI', sourceFile: 'SBI.xlsx',
        recordedAt: new Date().toISOString()
      });
      await repository.transactions.appendMany([mk('i1', 1000), mk('i2', 2000)]);
      await repository.transactions.supersede([{ targetId: 'i1', changes: { amount: 1500 } }]);
      render(<ImportPage />);
      const el = document.querySelector('[data-batch-corrections]')!;
      expect(el).toBeTruthy();
      expect(el.getAttribute('data-batch-corrections')).toBe('1');
      expect(el.textContent).toContain('will not undo');
    });

    it('Import History shows NO correction line for a clean batch', async () => {
      const A = acct('A', 0);
      await repository.transactions.append({
        id: 'i1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 'R', narration: 'R',
        account: A.name, accountId: A.id, direction: 'CREDIT', type: 'Income',
        category: 'Income', amount: 100, status: 'CLEARED', origin: 'IMPORT',
        importBatchId: 'bx', recordedAt: new Date().toISOString()
      } as any);
      render(<ImportPage />);
      expect(document.querySelector('[data-batch-corrections]')).toBeNull();
    });
  });

  /* ═════════════════ §9 scope boundary ═══════════════════════════════════ */
  describe('§9 the UI adds no authority and no restore', () => {
    it('the write surface is STILL exactly four primitives', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'rollbackBatch', 'supersede']);
    });

    it('no restore/undo affordance is rendered anywhere in the modal', async () => {
      const A = acct('A', 10000);
      const v1 = await income(A, 5000);
      openModal(byId(v1.id));
      const text = (document.getElementById('correct-transaction-modal')!.textContent || '').toLowerCase();
      for (const w of ['restore', 'undo', 'un-supersede', 'unsupersede', 'revert']) {
        expect(text).not.toContain(w);
      }
      // ...and there is no control offering any of them
      const controls = [...document.querySelectorAll('#correct-transaction-modal button')]
        .map(b => (b.textContent || '').trim().toLowerCase());
      expect(controls.filter(c => /restore|undo|revert|delete/.test(c))).toHaveLength(0);
      // the modal DOES say "nothing is deleted" — that is the 13-b promise,
      // not a delete affordance, and it must stay.
      expect(text).toContain('nothing is deleted');
    });

    it('the store still exposes no restore action', () => {
      const s = S();
      for (const k of ['undo', 'restoreTransaction', 'restoreImportBatch', 'unsupersedeTransaction']) {
        expect(typeof s[k]).toBe('undefined');
      }
      expect(typeof s.supersedeTransactions).toBe('function');
    });

    it('the UI introduced no new exclusion reason', () => {
      expect([...KNOWN_EXCLUSION_REASONS].sort()).toEqual(['IMPORT_ROLLBACK', 'SUPERSEDED']);
      expect(KNOWN_EXCLUSION_REASONS).not.toContain('DELETED' as any);
    });
  });
});
