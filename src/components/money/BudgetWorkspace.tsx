import React, { useState } from 'react';
import {
  Transaction,
  MonthlyBudget,
  BUDGET_CATEGORY_FAMILIES,
  mapTransactionCategoryToBudget
} from '../../domain/types';
import { FinancialCommands } from '../../application/commands';
import { CurrencyValue } from '../CurrencyValue';
import { EditBudgetModal } from './EditBudgetModal';
import { Calendar, Zap, Copy, Edit3, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props {
  transactions: Transaction[];
  budgets: MonthlyBudget[];
}

export const BudgetWorkspace: React.FC<Props> = ({ transactions, budgets }) => {
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-08');
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  /**
   * WP-FB-DATA-08B: a failure notice, and an in-flight flag.
   *
   * These two actions write through FinancialCommands directly, bypassing the
   * store. The 08B gate measured copy-previous returning a truthy budget while
   * persistence had FAILED, which fired the success toast
   * "Copied budget allocations from previous month (Total: ₹900)" for a month
   * that was never stored. The toast must now follow storage, not the return
   * value.
   */
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetBusy, setBudgetBusy] = useState<null | 'suggest' | 'copy'>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const activeBudget = budgets.find(b => b.monthStr === selectedMonth);
  const allocations = activeBudget?.allocations || {};
  const totalBudget = activeBudget?.totalBudget || 0;

  // Calculate actual spending in selected month aggregated by standard budget categories
  const actualExpensesByCategory: Record<string, number> = {};
  let totalActualSpent = 0;

  for (const t of transactions) {
    if (t.type !== 'Expense') continue;
    if (t.date.startsWith(selectedMonth)) {
      const bCat = mapTransactionCategoryToBudget(t.category);
      actualExpensesByCategory[bCat] = (actualExpensesByCategory[bCat] || 0) + t.amount;
      totalActualSpent += t.amount;
    }
  }

  const remainingVariance = totalBudget - totalActualSpent;

  const handleAutoSuggest = async () => {
    if (budgetBusy) return;
    setBudgetError(null);
    const suggested = FinancialCommands.autoSuggestBudget(selectedMonth);
    setBudgetBusy('suggest');
    try {
      await FinancialCommands.saveMonthlyBudget(selectedMonth, suggested.allocations);
      showToast(`Auto-suggest populated ₹${suggested.totalBudget.toLocaleString()} based on trailing 3-month expense averages.`);
    } catch (e: any) {
      setBudgetError(e?.message || 'The budget could not be saved.');
    } finally {
      setBudgetBusy(null);
    }
  };

  const handleCopyPrevious = async () => {
    if (budgetBusy) return;
    setBudgetError(null);
    setBudgetBusy('copy');
    try {
      const copied = await FinancialCommands.copyBudgetFromPreviousMonth(selectedMonth);
      if (copied) {
        showToast(`Copied budget allocations from previous month (Total: ₹${copied.totalBudget.toLocaleString()}).`);
      } else {
        showToast('No budget found in the immediately previous month to copy.');
      }
    } catch (e: any) {
      setBudgetError(e?.message || 'The budget could not be copied.');
    } finally {
      setBudgetBusy(null);
    }
  };

  // Generate recent 12 months for selector
  const availableMonths = [
    '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03',
    '2026-02', '2026-01', '2025-12', '2025-11', '2025-10', '2025-09'
  ];

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="bg-green-50 dark:bg-green-950/40 border border-green-300 dark:border-green-800 p-3 rounded-xl text-green-800 dark:text-green-300 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 size={16} className="text-green-600 dark:text-green-400 flex-shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {budgetError && (
        <div
          id="budget-error"
          data-budget-kind="error"
          role="alert"
          className="bg-rose-50 dark:bg-rose-950/30 border border-rose-300 dark:border-rose-800 p-3 rounded-xl text-rose-800 dark:text-rose-300 text-xs font-semibold"
        >
          <strong>Budget not saved.</strong>{' '}{budgetError}
        </div>
      )}

      {/* Toolbar / Month Selector & Action Buttons */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <Calendar className="text-green-700 dark:text-green-400" size={18} />
          <div>
            <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Budget Period
            </span>
            <select
              id="budget-month-selector"
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3 py-1.5 text-xs font-extrabold text-gray-900 dark:text-white outline-none focus:border-green-600 mt-0.5"
            >
              {availableMonths.map(m => (
                <option key={m} value={m}>
                  {m} ({new Date(`${m}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            id="btn-auto-suggest-budget"
            data-budget-busy={budgetBusy === 'suggest' ? 'true' : 'false'}
            disabled={budgetBusy !== null}
            onClick={handleAutoSuggest}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-800 dark:text-gray-200 font-bold text-xs transition border border-gray-200 dark:border-gray-700"
          >
            <Zap size={14} className="text-amber-500" />
            <span>{budgetBusy === 'suggest' ? 'Saving…' : 'Auto-Suggest'}</span>
          </button>

          <button
            id="btn-copy-previous-budget"
            data-budget-busy={budgetBusy === 'copy' ? 'true' : 'false'}
            disabled={budgetBusy !== null}
            onClick={handleCopyPrevious}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-800 dark:text-gray-200 font-bold text-xs transition border border-gray-200 dark:border-gray-700"
          >
            <Copy size={14} className="text-cyan-600 dark:text-cyan-400" />
            <span>Copy Previous Month</span>
          </button>

          <button
            id="btn-edit-budget"
            onClick={() => setEditModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-green-700 hover:bg-green-800 text-white font-extrabold text-xs transition shadow-sm"
          >
            <Edit3 size={14} />
            <span>Edit Budget</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Total Monthly Budget
          </span>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            <CurrencyValue value={totalBudget} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {activeBudget ? `${Object.keys(allocations).length} active allocations` : 'No budget set'}
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Actual Spent ({selectedMonth})
          </span>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            <CurrencyValue value={totalActualSpent} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            Canonical ledger expense total
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Budget Variance
          </span>
          <div className={`text-2xl font-black mt-1 ${
            totalBudget === 0
              ? 'text-gray-400'
              : remainingVariance >= 0
              ? 'text-green-700 dark:text-green-400'
              : 'text-rose-600 dark:text-rose-400'
          }`}>
            {totalBudget > 0 ? (
              <span className="flex items-center">
                {remainingVariance >= 0 ? '+' : ''}
                <CurrencyValue value={remainingVariance} />
              </span>
            ) : (
              <span>Not Configured</span>
            )}
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {totalBudget > 0
              ? (remainingVariance >= 0 ? 'Within monthly budget' : 'Budget overrun detected')
              : 'Configure budget to measure variance'}
          </span>
        </div>
      </div>

      {/* 21 Standard Category Families Breakdown */}
      {!activeBudget || totalBudget === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">
            No budget configured for {selectedMonth}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-md mx-auto">
            Set target allocations across the 21 standard category families, or use Auto-Suggest to calculate baseline recommendations from your trailing 3-month expenses.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3 flex-wrap">
            <button
              data-budget-busy={budgetBusy === 'suggest' ? 'true' : 'false'}
              disabled={budgetBusy !== null}
              onClick={handleAutoSuggest}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed text-gray-800 dark:text-gray-200 text-xs font-bold transition border border-gray-200 dark:border-gray-700"
            >
              <Zap size={14} className="text-amber-500" />
              <span>{budgetBusy === 'suggest' ? 'Saving…' : 'Auto-Suggest'}</span>
            </button>
            <button
              onClick={() => setEditModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-xs font-bold transition shadow-sm"
            >
              <Edit3 size={14} />
              <span>+ Create Budget</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden shadow-sm">
          <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center flex-wrap gap-2">
            <div>
              <h4 className="font-bold text-gray-900 dark:text-white text-sm">
                Budget Allocations by Category Family (21)
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Deterministic category variance between budgeted targets and reconciled expenses
              </p>
            </div>
            <span className="px-2.5 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-bold">
              {Object.keys(allocations).length} Categories Allocated
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-800 text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  <th className="py-3 px-5">Category Family</th>
                  <th className="py-3 px-5 text-right">Budgeted</th>
                  <th className="py-3 px-5 text-right">Actual Spent</th>
                  <th className="py-3 px-5 w-40">Utilization</th>
                  <th className="py-3 px-5 text-right">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-xs">
                {BUDGET_CATEGORY_FAMILIES.map(cat => {
                  const budgeted = allocations[cat] || 0;
                  const actual = actualExpensesByCategory[cat] || 0;
                  const variance = budgeted - actual;
                  const pct = budgeted > 0 ? Math.round((actual / budgeted) * 100) : (actual > 0 ? 100 : 0);
                  const isOver = budgeted > 0 && actual > budgeted;

                  return (
                    <tr key={cat} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
                      <td className="py-3 px-5 font-bold text-gray-900 dark:text-white">
                        {cat}
                      </td>
                      <td className="py-3 px-5 text-right text-gray-700 dark:text-gray-300 font-semibold">
                        {budgeted > 0 ? <CurrencyValue value={budgeted} /> : <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="py-3 px-5 text-right text-gray-900 dark:text-white font-bold">
                        {actual > 0 ? <CurrencyValue value={actual} /> : <span className="text-gray-400 italic">₹0</span>}
                      </td>
                      <td className="py-3 px-5">
                        {budgeted > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div
                                style={{ width: `${Math.min(pct, 100)}%` }}
                                className={`h-full ${isOver ? 'bg-rose-600' : pct > 80 ? 'bg-amber-500' : 'bg-green-600'}`}
                              />
                            </div>
                            <span className={`text-[10px] font-bold ${isOver ? 'text-rose-600' : 'text-gray-500'}`}>
                              {pct}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-400 italic">Not set</span>
                        )}
                      </td>
                      <td className={`py-3 px-5 text-right font-extrabold ${
                        budgeted === 0
                          ? 'text-gray-400'
                          : variance >= 0
                          ? 'text-green-700 dark:text-green-400'
                          : 'text-rose-600 dark:text-rose-400'
                      }`}>
                        {budgeted > 0 ? (
                          <span>
                            {variance >= 0 ? '+' : ''}
                            <CurrencyValue value={variance} />
                          </span>
                        ) : (
                          <span className="text-gray-400 italic">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <EditBudgetModal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        monthStr={selectedMonth}
        initialAllocations={allocations}
      />
    </div>
  );
};
