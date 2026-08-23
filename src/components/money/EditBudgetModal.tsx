import React, { useState, useEffect } from 'react';
import { BUDGET_CATEGORY_FAMILIES } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { CurrencyValue } from '../CurrencyValue';
import { X, Check } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  monthStr: string; // "YYYY-MM"
  initialAllocations: Record<string, number>;
}

export const EditBudgetModal: React.FC<Props> = ({ isOpen, onClose, monthStr, initialAllocations }) => {
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const { saveMonthlyBudget } = useCanonicalLedger();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAllocations({ ...initialAllocations });
  }, [initialAllocations, isOpen]);

  if (!isOpen) return null;

  const handleAmountChange = (category: string, value: string) => {
    const num = Number(value);
    setAllocations(prev => ({
      ...prev,
      [category]: isNaN(num) || num < 0 ? 0 : num
    }));
  };

  const totalBudget = Object.values(allocations).reduce((sum, val) => sum + (Number(val) || 0), 0);

  /**
   * WP-FB-DATA-08B: the write is AWAITED and the modal closes only on success.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await saveMonthlyBudget(monthStr, allocations);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'The budget could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <div>
            <h3 className="text-lg font-extrabold text-gray-900 dark:text-white">
              Edit Monthly Budget — {monthStr}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Allocate target spending amounts across the 21 standard category families
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {BUDGET_CATEGORY_FAMILIES.map(cat => (
                <div key={cat} className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-3 rounded-xl flex items-center justify-between gap-3">
                  <label className="text-xs font-bold text-gray-700 dark:text-gray-300 flex-1 truncate">
                    {cat}
                  </label>
                  <div className="w-32 flex items-center gap-1.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-2.5 py-1.5 focus-within:border-green-600">
                    <span className="text-xs text-gray-400 font-semibold">₹</span>
                    <input
                      type="number"
                      placeholder="0"
                      value={allocations[cat] || ''}
                      onChange={e => handleAmountChange(cat, e.target.value)}
                      className="bg-transparent border-none outline-none text-xs font-bold text-gray-900 dark:text-white w-full text-right"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 mt-4 border-t border-gray-200 dark:border-gray-800 flex-shrink-0">
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400 font-medium block">Total Monthly Budget:</span>
              <span className="text-lg font-black text-green-700 dark:text-green-400">
                <CurrencyValue value={totalBudget} />
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold transition"
              >
                Cancel
              </button>
              {error && (
                <div
                  id="edit-budget-error"
                  data-write-kind="error"
                  role="alert"
                  className="mb-3 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs font-semibold text-rose-800 dark:text-rose-300"
                >
                  {error}
                </div>
              )}
              <button
                type="submit"
              id="edit-budget-submit"
              data-write-busy={busy ? 'true' : 'false'}
              disabled={busy}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-green-700 hover:bg-green-800 text-white font-extrabold text-xs transition shadow-sm"
              >
                <Check size={14} />
                <span>Save Budget</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
