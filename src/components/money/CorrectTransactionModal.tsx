import React, { useState, useEffect, useMemo } from 'react';
import { Transaction, Account, AmendmentRequestShape } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { TransactionAmendmentService } from '../../services/TransactionAmendmentService';
import { TransactionIdentityService } from '../../services/TransactionIdentityService';
import { AccountResolutionService } from '../../services/AccountResolutionService';
import { CurrencyValue } from '../CurrencyValue';
import { X, AlertTriangle, Lock } from 'lucide-react';

/* =============================================================================
 * CORRECT TRANSACTION (WP-FB-DATA-06c-2a)
 *
 * The UI for the amendment primitive shipped in WP-FB-DATA-06c-2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FORM ADDS NO AUTHORITY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It builds an `AmendmentRequestShape` and hands it to
 * `useCanonicalLedger.supersedeTransactions`, which is the only store seam to
 * `repository.transactions.supersede`. It does not write, does not persist, and
 * does not decide anything the services have not already decided:
 *
 *   eligibility -> TransactionAmendmentService.singleRowCorrectability()
 *   refusal     -> whatever the repository throws, rendered verbatim
 *
 * Re-implementing either would give the user a button whose enabled state
 * disagrees with what actually happens — the exact drift `ImportBatchRollback-
 * Service.listBatches` avoids by computing `rollbackEligible` from `plan()`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EXPOSED FIELD SET IS A PRODUCT DECISION, NOT A CONVENIENCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Decision Q-UI-1 = (c) — value + classification + attribution:
 *
 *     amount · date · notes · category · title · account
 *
 * The repository API permits five more (`narration`, `accountId` as a raw
 * string, `status`, `direction`, `type`). They are deliberately NOT rendered,
 * and the discovery gate measured why:
 *
 *   type      Income -> Expense moved a balance 15,000 -> 5,000. A 10,000 swing
 *             from one dropdown.
 *   direction DEBIT alone produced a row still labelled "Income" that SUBTRACTS
 *             money. `TransactionSignService` treats direction as authoritative,
 *             so the label and the arithmetic disagree.
 *   status    CLEARED -> PENDING silently removed the row from five dividend
 *             consumers that filter on status.
 *   narration on an imported row rewrites the bank's own statement text while
 *             the row still cites sourceFile and sourceRowNumber.
 *
 * `account` is bound to a PICKER over registered accounts plus one explicit
 * "not linked" option. It is never free text: the gate measured that an
 * arbitrary `accountId` string removed 5,000 from every balance, because the
 * row became unmapped and unmapped rows are excluded from balances under
 * Decision B -> Option A. A picker makes that unreachable by construction.
 * ========================================================================== */

/** Sentinel for the explicit "not linked to a registered account" choice. */
const UNMAPPED = '__UNMAPPED__';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The row being corrected. */
  transaction: Transaction | null;
  onSuccess?: (correctionId: string) => void;
}

interface FormState {
  amount: string;
  date: string;
  title: string;
  category: string;
  notes: string;
  accountId: string;
}

function toForm(tx: Transaction): FormState {
  return {
    amount: String(tx.amount ?? ''),
    date: tx.date ?? '',
    title: tx.title ?? '',
    category: tx.category ?? '',
    notes: tx.notes ?? '',
    accountId: tx.accountId == null ? UNMAPPED : tx.accountId
  };
}

export const CorrectTransactionModal: React.FC<Props> = ({
  isOpen, onClose, transaction, onSuccess
}) => {
  const accounts = useCanonicalLedger(s => s.accounts) as Account[];
  const transactions = useCanonicalLedger(s => s.transactions) as Transaction[];
  const supersedeTransactions = useCanonicalLedger(s => s.supersedeTransactions);

  const [form, setForm] = useState<FormState>({
    amount: '', date: '', title: '', category: '', notes: '', accountId: UNMAPPED
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (transaction) setForm(toForm(transaction));
    setError(null);
    setBusy(false);
  }, [transaction, isOpen]);

  // Asked of the SERVICE, never re-derived here.
  const eligibility = useMemo(
    () => transaction
      ? TransactionAmendmentService.singleRowCorrectability(transaction.id, transactions)
      : { correctable: false, reason: 'No transaction selected.' },
    [transaction, transactions]
  );

  if (!isOpen || !transaction) return null;

  const tx = transaction;
  const isImported = TransactionIdentityService.originOf(tx) === 'IMPORT';

  const nextAccountId = form.accountId === UNMAPPED ? null : form.accountId;
  const nextAccountName = nextAccountId
    ? (accounts.find(a => a.id === nextAccountId)?.name ?? tx.account)
    : tx.account;

  /** Only fields that actually changed are sent. */
  const changes: AmendmentRequestShape['changes'] = {};
  const parsedAmount = Number(form.amount);
  if (form.amount !== '' && !Number.isNaN(parsedAmount) && parsedAmount !== tx.amount) {
    changes.amount = parsedAmount;
  }
  if (form.date && form.date !== tx.date) changes.date = form.date;
  if (form.title !== (tx.title ?? '')) changes.title = form.title;
  if (form.category !== (tx.category ?? '')) changes.category = form.category;
  if (form.notes !== (tx.notes ?? '')) changes.notes = form.notes;
  if (nextAccountId !== (tx.accountId ?? null)) {
    changes.accountId = nextAccountId;
    changes.account = nextAccountName;
  }

  const changedKeys = Object.keys(changes).filter(k => k !== 'account');
  const hasChanges = changedKeys.length > 0;
  const amountInvalid = form.amount === '' || Number.isNaN(parsedAmount) || parsedAmount <= 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!eligibility.correctable) {
      setError(eligibility.reason || 'This transaction cannot be corrected.');
      return;
    }

    setBusy(true);
    try {
      const result = await supersedeTransactions([{ targetId: tx.id, changes }]);
      setBusy(false);
      onSuccess?.(result.outcomes[0].correctionId);
      onClose();
    } catch (err: any) {
      // WP-FB-DATA-06b / F-06b-2: the modal STAYS OPEN and the refusal is
      // rendered. A refusal the user cannot see is not a safeguard.
      setBusy(false);
      setError(err?.message || 'The correction could not be recorded.');
    }
  };

  const label = 'block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1';
  const input =
    'w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 ' +
    'bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white ' +
    'disabled:opacity-60 disabled:cursor-not-allowed';
  const readOnlyBox =
    'px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 ' +
    'bg-gray-100 dark:bg-gray-900/60 text-xs text-gray-500 dark:text-gray-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div
        id="correct-transaction-modal"
        data-correct-target={tx.id}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-2xl w-full shadow-2xl max-h-[92vh] flex flex-col"
      >
        {/* ── header ── */}
        <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-extrabold text-gray-900 dark:text-white">
              Correct transaction
            </h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              The original is kept exactly as recorded and stops counting. A new corrected
              version is recorded and counted instead. Nothing is deleted.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="p-6 space-y-4 overflow-y-auto">

            {/* ── source-row identification ── */}
            <div id="correct-source-row" className={readOnlyBox}>
              <div className="font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wider text-[10px] mb-1">
                Correcting this record
              </div>
              <div className="text-gray-700 dark:text-gray-300">
                <span className="font-semibold">{tx.dateStr}</span>
                {' · '}{tx.title}
                {' · '}{AccountResolutionService.displayName(tx, accounts)}
                {' · '}<CurrencyValue value={tx.amount} />
              </div>
              <div className="mt-1 font-mono text-[10px] text-gray-400 break-all" data-source-id={tx.id}>
                id {tx.id}
              </div>
            </div>

            {/* ── blocked: not correctable ── */}
            {!eligibility.correctable && (
              <div
                id="correct-blocked"
                data-correct-blocked={eligibility.code}
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40"
              >
                <p className="flex items-center gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-200">
                  <AlertTriangle size={13} /> This transaction cannot be corrected
                </p>
                <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">{eligibility.reason}</p>
              </div>
            )}

            {/* ── editable fields (Q-UI-1 = c) ── */}
            <fieldset disabled={!eligibility.correctable || busy} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={label} htmlFor="correct-amount">Amount (₹)</label>
                  <input
                    id="correct-amount" type="number" step="0.01" min="0"
                    value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    className={input}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="correct-date">Date</label>
                  <input
                    id="correct-date" type="date"
                    value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                    className={input}
                  />
                </div>
              </div>

              <div>
                <label className={label} htmlFor="correct-title">Title</label>
                <input
                  id="correct-title" type="text"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  className={input}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={label} htmlFor="correct-category">Category</label>
                  <input
                    id="correct-category" type="text"
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className={input}
                  />
                </div>
                <div>
                  {/* PICKER, never free text — see header comment. */}
                  <label className={label} htmlFor="correct-account">Account</label>
                  <select
                    id="correct-account"
                    value={form.accountId}
                    onChange={e => setForm(f => ({ ...f, accountId: e.target.value }))}
                    className={input}
                  >
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                    <option value={UNMAPPED}>Not linked to a registered account</option>
                  </select>
                </div>
              </div>

              <div>
                <label className={label} htmlFor="correct-notes">Notes</label>
                <textarea
                  id="correct-notes" rows={2}
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className={input}
                />
              </div>
            </fieldset>

            {/* ── immutable fields, shown WITH A REASON rather than hidden ── */}
            <div id="correct-immutable" className={readOnlyBox}>
              <div className="flex items-center gap-1.5 font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wider text-[10px] mb-1.5">
                <Lock size={11} /> Cannot be changed by a correction
              </div>
              <ul className="space-y-1">
                <li data-immutable="narration">
                  <span className="font-semibold">Statement text:</span>{' '}
                  <code className="text-[10px]">{tx.narration}</code>
                  {' — '}
                  {isImported
                    ? 'this is what the bank statement says; a correction records your figures without rewriting the source.'
                    : 'kept as originally recorded.'}
                </li>
                <li data-immutable="type">
                  <span className="font-semibold">Type / direction:</span> {tx.type}
                  {tx.direction ? ` (${tx.direction})` : ''} — changing these flips whether money
                  is added or subtracted, so they are not editable here.
                </li>
                <li data-immutable="identity">
                  <span className="font-semibold">Identity &amp; provenance:</span> the correction keeps
                  this record&apos;s origin{isImported && tx.sourceFile ? ` (${tx.sourceFile})` : ''} and is
                  marked <em>Edited after recording</em>.
                </li>
              </ul>
            </div>

            {/* ── before -> after confirmation ── */}
            {eligibility.correctable && hasChanges && (
              <div
                id="correct-diff"
                className="rounded-lg border border-blue-300 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/30"
              >
                <p className="text-[10px] font-bold uppercase tracking-wider text-blue-800 dark:text-blue-200">
                  You are about to record
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {changedKeys.map(k => (
                    <li key={k} data-diff-field={k} className="text-xs text-blue-900 dark:text-blue-200">
                      <span className="font-semibold capitalize">{k}</span>:{' '}
                      <span className="line-through opacity-70">
                        {k === 'accountId'
                          ? AccountResolutionService.displayName(tx, accounts)
                          : String((tx as any)[k] ?? '—')}
                      </span>
                      {' → '}
                      <span className="font-bold">
                        {k === 'accountId'
                          ? (nextAccountId ? nextAccountName : 'Not linked')
                          : String((changes as any)[k])}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── refusal ── */}
            {error && (
              <div
                id="correct-error"
                className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950/40"
              >
                <p className="text-xs font-bold text-red-800 dark:text-red-200">
                  Correction refused
                </p>
                <p className="mt-0.5 text-xs text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}
          </div>

          {/* ── actions ── */}
          <div className="p-5 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-2">
            <button
              type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              id="correct-submit" type="submit"
              disabled={!eligibility.correctable || !hasChanges || amountInvalid || busy}
              title={
                !eligibility.correctable ? eligibility.reason
                  : amountInvalid ? 'Enter an amount greater than zero'
                    : !hasChanges ? 'Change at least one field to record a correction'
                      : 'Record the corrected version'
              }
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Recording…' : 'Record correction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
