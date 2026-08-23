import React, { useEffect, useState } from 'react';
import { Liability, LiabilityType } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { X } from 'lucide-react';

/**
 * WP-FB-DATA-07a — EDIT (Q-D07a-1 = (c): the complete record except `id`).
 *
 * Two properties this form must have, both measured at the 07a gate:
 *
 *  1. It submits by `id`, taken from the row it was opened with and never from
 *     a user-editable control. Editing by NAME with two rows called "Home Loan"
 *     hit index 0 — a coin flip over ₹16,00,000.
 *
 *  2. It submits the COMPLETE record. `update` is a full-row replace, so a
 *     partial form would silently blank `type` or `currency`.
 *
 * A refusal or a persistence failure keeps the modal OPEN and renders
 * `e.message`. Closing over a failed write is how a UI ends up disagreeing with
 * storage.
 */

const LOAN_TYPES: LiabilityType[] = [
  'Home Loan',
  'Vehicle Loan',
  'Personal Loan',
  'Education Loan',
  'Credit Card',
  'Gold Loan',
  'Business Loan',
  'Friends / Family',
  'Other'
];

interface Props {
  liability: Liability | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export const EditLiabilityModal: React.FC<Props> = ({ liability, onClose, onSaved }) => {
  const { updateLiability } = useCanonicalLedger();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<LiabilityType | ''>('');
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!liability) return;
    setName(liability.name ?? '');
    setAmount(String(liability.amount ?? ''));
    setType((liability.type as LiabilityType) ?? '');
    setCurrency(liability.currency ?? '');
    setError(null);
    setBusy(false);
  }, [liability]);

  if (!liability) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await updateLiability({
        // Identity comes from the record this modal was opened with.
        id: liability.id as string,
        name: name.trim(),
        amount: Number(amount),
        type: type === '' ? undefined : type,
        currency: currency.trim() === '' ? undefined : currency.trim()
      });
      onSaved(`Saved "${name.trim()}".`);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-rose-600 dark:focus:border-rose-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div
        id="edit-liability-modal"
        data-liability-edit-target={liability.id}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 className="text-lg font-extrabold text-gray-900 dark:text-white">Edit Liability</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              The whole record is replaced. Nothing else is affected.
            </p>
          </div>
          <button
            type="button"
            id="edit-liability-close"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Identity is shown, never edited. */}
          <div
            id="edit-liability-identity"
            className="rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3.5 py-2.5"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Identity (permanent)
            </div>
            <div className="mt-1 font-mono text-[10px] text-gray-500 dark:text-gray-400 break-all">
              {liability.id}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Liability Name *</label>
            <input id="edit-liability-name" type="text" value={name} required
              onChange={(e) => setName(e.target.value)} className={field} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Outstanding Balance *</label>
              <input id="edit-liability-amount" type="number" step="0.01" value={amount} required
                onChange={(e) => setAmount(e.target.value)} className={field} />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Currency</label>
              <input id="edit-liability-currency" type="text" value={currency}
                onChange={(e) => setCurrency(e.target.value)} className={field} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Loan Type</label>
            <select id="edit-liability-type" value={type}
              onChange={(e) => setType(e.target.value as LiabilityType | '')} className={field}>
              <option value="">Unclassified</option>
              {LOAN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {error && (
            <div
              id="edit-liability-error"
              data-liability-kind="error"
              role="alert"
              className="rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2.5 text-xs font-semibold text-rose-800 dark:text-rose-300"
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200 dark:border-gray-800 mt-6">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold transition">
              Cancel
            </button>
            <button id="edit-liability-submit" type="submit" disabled={busy}
              className="px-5 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-800 disabled:opacity-50 text-white font-bold text-xs transition shadow-sm">
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
