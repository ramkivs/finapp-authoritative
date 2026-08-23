import React, { useState, useEffect } from 'react';
import { FinancialProfile } from '../../domain/types';
import { FinancialQueries } from '../../application/queries';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { CurrencyValue } from '../CurrencyValue';
import { UserCheck, Activity, ShieldCheck, TrendingUp, Save, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props {
  profile: FinancialProfile | null;
}

export const FinancialProfileWorkspace: React.FC<Props> = ({ profile }) => {
  const [age, setAge] = useState<string>(profile?.age !== undefined ? String(profile.age) : '');
  const [monthlyIncome, setMonthlyIncome] = useState<string>(profile?.monthlyIncome ? String(profile.monthlyIncome) : '');
  const [monthlyExpenses, setMonthlyExpenses] = useState<string>(profile?.monthlyExpenses ? String(profile.monthlyExpenses) : '');
  const [dependents, setDependents] = useState<string>(profile?.dependents !== undefined ? String(profile.dependents) : '');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [error, setError] = useState('');
  /** WP-FB-DATA-08B: in-flight while persistence is unresolved. */
  const [busy, setBusy] = useState(false);

  const { saveProfile } = useCanonicalLedger();

  useEffect(() => {
    if (profile) {
      setAge(profile.age !== undefined ? String(profile.age) : '');
      setMonthlyIncome(profile.monthlyIncome ? String(profile.monthlyIncome) : '');
      setMonthlyExpenses(profile.monthlyExpenses ? String(profile.monthlyExpenses) : '');
      setDependents(profile.dependents !== undefined ? String(profile.dependents) : '');
    } else {
      setAge('');
      setMonthlyIncome('');
      setMonthlyExpenses('');
      setDependents('');
    }
  }, [profile]);

  const incNum = Number(monthlyIncome) || 0;
  const expNum = Number(monthlyExpenses) || 0;
  const computedSavings = Math.max(0, incNum - expNum);
  const computedSavingsRate = incNum > 0 ? Math.round((computedSavings / incNum) * 100) : 0;

  /**
   * WP-FB-DATA-08B: the write is AWAITED, and the success indicator follows
   * storage rather than the call.
   *
   * Measured at the 08B gate: this called and reported success, so a
   * persistence failure left the profile unsaved with no disclosure and an
   * unhandled page error. The synchronous validation catch is unchanged - it
   * still surfaces "Monthly income cannot be negative." and friends.
   */
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await saveProfile({
        id: 'default-profile',
        age: age ? Number(age) : undefined,
        monthlyIncome: incNum,
        monthlyExpenses: expNum,
        savingsRate: computedSavingsRate,
        dependents: dependents ? Number(dependents) : undefined,
        updatedAt: new Date().toISOString()
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Error saving financial profile.');
    } finally {
      setBusy(false);
    }
  };

  const healthScore = FinancialQueries.getFinancialHealthScore();
  const netWorth = useCanonicalLedger.getState().getNetWorth();
  const annualExpenses = expNum > 0 ? expNum * 12 : 0;
  const financialIndependenceYears = annualExpenses > 0 && netWorth > 0
    ? Math.round((netWorth / annualExpenses) * 10) / 10
    : 0;

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {savedSuccess && (
        <div className="bg-green-50 dark:bg-green-950/40 border border-green-300 dark:border-green-800 p-3 rounded-xl text-green-800 dark:text-green-300 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 size={16} className="text-green-600 dark:text-green-400 flex-shrink-0" />
          <span>Financial profile parameters saved to canonical store successfully.</span>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 p-3 rounded-xl text-rose-800 dark:text-rose-300 text-xs font-semibold flex items-center gap-2">
          <AlertCircle size={16} className="text-rose-600 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Grid: Profile Editor & Financial Health Diagnostic */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile Editor Form */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2.5">
            <UserCheck size={18} className="text-green-700 dark:text-green-400" />
            <div>
              <h3 className="text-base font-bold text-gray-900 dark:text-white">
                Financial Profile & Cash Flow Baseline
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                User parameters powering emergency fund runway and health scoring
              </p>
            </div>
          </div>

          <form onSubmit={handleSave} className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Age (Years)
                </label>
                <input
                  id="input-profile-age"
                  type="number"
                  placeholder="32"
                  value={age}
                  onChange={e => setAge(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Dependents Count
                </label>
                <input
                  id="input-profile-dependents"
                  type="number"
                  placeholder="2"
                  value={dependents}
                  onChange={e => setDependents(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Monthly Inflow / Income (₹)
                </label>
                <input
                  id="input-profile-income"
                  type="number"
                  placeholder="e.g. 150000"
                  value={monthlyIncome}
                  onChange={e => setMonthlyIncome(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Monthly Expenses (₹)
                </label>
                <input
                  id="input-profile-expenses"
                  type="number"
                  placeholder="e.g. 75000"
                  value={monthlyExpenses}
                  onChange={e => setMonthlyExpenses(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>
            </div>

            {/* Computed Savings Rate */}
            <div className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-3.5 rounded-xl flex items-center justify-between">
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 font-medium block">Computed Monthly Savings:</span>
                <span className="text-sm font-extrabold text-green-700 dark:text-green-400 mt-0.5 block">
                  <CurrencyValue value={computedSavings} />
                </span>
              </div>

              <div className="text-right">
                <span className="text-xs text-gray-500 dark:text-gray-400 font-medium block">Savings Rate:</span>
                <span className="text-base font-black text-cyan-600 dark:text-cyan-400 mt-0.5 block">
                  {computedSavingsRate}%
                </span>
              </div>
            </div>

            <button
              id="btn-save-profile"
              type="submit"
              data-write-busy={busy ? 'true' : 'false'}
              disabled={busy}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-extrabold text-xs transition shadow-sm"
            >
              <Save size={14} />
              <span>{busy ? 'Saving…' : 'Save Financial Profile'}</span>
            </button>
          </form>
        </div>

        {/* Overall Financial Health Score & Runway */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm space-y-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Activity size={18} className="text-cyan-600 dark:text-cyan-400" />
                <div>
                  <h3 className="text-base font-bold text-gray-900 dark:text-white">
                    Overall Financial Health Score
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Transparent 4-factor diagnostic score evaluating balance sheet resilience
                  </p>
                </div>
              </div>

              <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                healthScore.status === 'HEALTHY'
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                  : healthScore.status === 'MODERATE'
                  ? 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
              }`}>
                {healthScore.status === 'NOT_CONFIGURED' ? 'Not Configured' : `${healthScore.score} / 100 (${healthScore.status})`}
              </span>
            </div>

            {/* Score Factor Breakdown */}
            <div className="space-y-2.5 mt-4">
              {healthScore.explanations.map((exp, idx) => (
                <div key={idx} className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-2.5 rounded-xl text-xs text-gray-700 dark:text-gray-300 flex items-center gap-2">
                  <ShieldCheck size={14} className="text-green-600 flex-shrink-0" />
                  <span>{exp}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Financial Independence Diagnostic */}
          <div className="pt-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-baseline">
            <div>
              <span className="text-xs font-bold text-gray-700 dark:text-gray-300 block">
                Financial Independence Runway
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                Net Worth / Annual Expenses
              </span>
            </div>

            <div className="text-right">
              <span className="text-base font-black text-green-700 dark:text-green-400">
                {financialIndependenceYears > 0 ? `${financialIndependenceYears} Years` : 'Not configured'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
