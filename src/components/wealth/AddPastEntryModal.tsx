import React, { useState } from 'react';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { CurrencyValue } from '../CurrencyValue';
import { X, Calendar } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const AddPastEntryModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [dateStr, setDateStr] = useState('09-08-2025');
  const [assetsAmt, setAssetsAmt] = useState('');
  const [liabsAmt, setLiabsAmt] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  /** WP-FB-DATA-08B: in-flight while persistence is unresolved. */
  const [busy, setBusy] = useState(false);

  const { addPastSnapshot } = useCanonicalLedger();

  if (!isOpen) return null;

  const totAssets = Number(assetsAmt) || 0;
  const totLiabs = Number(liabsAmt) || 0;
  const computedNetWorth = totAssets - totLiabs;

  const handleSubmit = async (e: React.FormEvent) => {
    if (busy) return;
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await addPastSnapshot({
        dateStr,
        totalAssets: totAssets,
        totalLiabilities: totLiabs,
        label: label || undefined
      });
      setDateStr('09-08-2025');
      setAssetsAmt('');
      setLiabsAmt('');
      setLabel('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error recording historical snapshot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Calendar size={18} className="text-green-700 dark:text-green-400" />
            <h3 className="text-base font-extrabold text-gray-900 dark:text-white">Add past entry</h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">
          Record what you were worth on a date that has already passed. Use this for months you tracked somewhere else before moving here.
        </p>

        {error && (
          <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 rounded-xl text-rose-700 dark:text-rose-400 text-xs font-semibold mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Date (dd-mm-yyyy or readable date) *</label>
            <input
              type="text"
              placeholder="dd-mm-yyyy e.g. 09-08-2025"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              required
              className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Total assets *</label>
              <input
                type="number"
                placeholder="0"
                value={assetsAmt}
                onChange={(e) => setAssetsAmt(e.target.value)}
                required
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Total liabilities (optional)</label>
              <input
                type="number"
                placeholder="0"
                value={liabsAmt}
                onChange={(e) => setLiabsAmt(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Label (optional)</label>
            <input
              type="text"
              placeholder="e.g. From my old spreadsheet"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
            />
          </div>

          <div className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-4 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-600 dark:text-gray-400">Net worth</span>
              <span className="text-sm font-extrabold text-green-700 dark:text-green-400">
                <CurrencyValue value={computedNetWorth} />
              </span>
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
              Totals only. This entry plots on the chart and compares historical net worth totals deterministically.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold transition"
            >
              Cancel
            </button>
            <button
              type="submit"
                  id="add-past-entry-submit"
                  data-write-busy={busy ? 'true' : 'false'}
                  disabled={busy}
              className="px-5 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white font-extrabold text-xs transition shadow-sm"
            >
              Add entry
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
