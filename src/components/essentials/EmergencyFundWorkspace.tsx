import React, { useState } from 'react';
import { Asset, Account, Transaction, MonthlyBudget, FinancialProfile } from '../../domain/types';
import { EssentialsService } from '../../services/EssentialsService';
import { CurrencyValue } from '../CurrencyValue';
import { ShieldCheck, AlertCircle, TrendingUp, Info, Link2, AlertTriangle } from 'lucide-react';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';

interface Props {
  openSidebarTab?: (tabId: string) => void;
  assets: Asset[];
  accounts: Account[];
  transactions: Transaction[];
  budgets: MonthlyBudget[];
  profile: FinancialProfile | null;
}

export const EmergencyFundWorkspace: React.FC<Props> = ({
  openSidebarTab,
  assets,
  accounts,
  transactions,
  budgets,
  profile
}) => {
  const [targetMonths, setTargetMonths] = useState<number>(profile?.targetEmergencyMonths || 6);

  const analysis = EssentialsService.calculateEmergencyFundAnalysis(
    assets,
    accounts,
    transactions,
    budgets,
    targetMonths,
    profile
  );

  const fundedPercentage = analysis.targetAmount > 0
    ? Math.min(100, Math.round((analysis.liquidReserves / analysis.targetAmount) * 100))
    : 0;

  const isAdequate = analysis.runwayMonths >= targetMonths;

  return (
    <div className="space-y-6">
      {/* Target Selector Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <ShieldCheck className="text-green-700 dark:text-green-400" size={20} />
          <div>
            <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Emergency Runway Target
            </span>
            <div className="text-sm font-extrabold text-gray-900 dark:text-white">
              {targetMonths} Months Essential Living Expenses
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-semibold">Configurable Runway:</span>
          <div className="bg-gray-100 dark:bg-gray-800 p-1 rounded-xl flex gap-1 border border-gray-200 dark:border-gray-700">
            {[3, 6, 9, 12].map(m => (
              <button
                key={m}
                id={`btn-target-months-${m}`}
                onClick={() => setTargetMonths(m)}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                  targetMonths === m
                    ? 'bg-green-700 text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                {m}M
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {/* WP-FB-DATA-05b Decision G3 — detected here, resolved on the Accounts
          surface. Until the user answers, the asset is held back so the
          previously-deduplicated figure is preserved and no guidance changes
          silently. Confirming writes a real link; dismissing records that they
          are different money. A matching name is only a CANDIDATE - it never
          establishes a relationship on its own. */}
      {(analysis.linkCandidates || []).length > 0 && (
        <div
          id="liquid-link-candidates"
          className="mb-6 rounded-2xl border border-blue-300 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-950/30 px-5 py-4"
        >
          <div className="flex items-start gap-3">
            <Link2 size={16} className="text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-blue-900 dark:text-blue-200 space-y-2 w-full">
              <p className="font-bold">
                {(analysis.linkCandidates || []).length} possible duplicate
                {(analysis.linkCandidates || []).length === 1 ? '' : 's'} in your liquid reserves
              </p>
              <p className="opacity-90 leading-relaxed">
                These accounts and assets share a name, so they may be the same money. Until you
                confirm, the asset is <span className="font-semibold">not</span> being added on top —
                your reserves are unchanged. Resolve each pair on{' '}
                <span className="font-semibold">Money → Accounts</span> using the link control.
              </p>
              <ul className="space-y-1.5 pt-1">
                {(analysis.linkCandidates || []).map(c => (
                  <li
                    key={`${c.accountId}:${c.assetId}`}
                    data-link-candidate={`${c.accountId}:${c.assetId}`}
                    className="rounded-lg bg-white/70 dark:bg-blue-900/20 px-3 py-2 flex items-center justify-between gap-3"
                  >
                    <span className="truncate">
                      Account <span className="font-semibold">{c.accountName}</span>{' '}
                      (<CurrencyValue value={c.accountBalance} />) · Asset{' '}
                      <span className="font-semibold">{c.assetName}</span>{' '}
                      (<CurrencyValue value={c.assetAmount} />)
                    </span>
                    <button
                      data-resolve-candidate={c.accountId}
                      onClick={() => openSidebarTab && openSidebarTab('money')}
                      className="px-2.5 py-1 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-[10px] font-bold flex-shrink-0"
                    >
                      Resolve
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* H(c) — a link pointing at a deleted asset. The account keeps counting;
          money is never silently removed from liquidity. */}
      {(analysis.brokenLinks || []).length > 0 && (
        <div
          id="liquid-broken-links"
          className="mb-6 rounded-2xl border border-amber-300 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/30 px-5 py-3.5 flex items-start gap-3"
        >
          <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-900 dark:text-amber-200">
            <span className="font-bold">
              {(analysis.brokenLinks || []).length} account
              {(analysis.brokenLinks || []).length === 1 ? '' : 's'} reference a deleted asset
            </span>{' '}
            <span className="opacity-90">
              ({(analysis.brokenLinks || []).map(b => b.accountName).join(', ')}). The account balance is
              still counted — re-link or unlink it on Money → Accounts.
            </span>
          </div>
        </div>
      )}

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Liquid Reserves
          </span>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            <CurrencyValue value={analysis.liquidReserves} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            Cash, Savings & Bank Balances
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Monthly Essential Outflow
          </span>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            <CurrencyValue value={analysis.monthlyEssentialExpenses} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            Housing, Groceries, Utilities, EMIs
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Current Runway
          </span>
          <div className={`text-2xl font-black mt-1 ${isAdequate ? 'text-green-700 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {analysis.status === 'NOT_CONFIGURED' ? 'Not configured' : `${analysis.runwayMonths} Months`}
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            Target: {targetMonths} Months
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Funding Gap / Deficit
          </span>
          <div className={`text-2xl font-black mt-1 ${analysis.fundingGap > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-green-700 dark:text-green-400'}`}>
            <CurrencyValue value={analysis.fundingGap} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {analysis.fundingGap > 0 ? 'Additional buffer needed' : 'Fully Funded'}
          </span>
        </div>
      </div>

      {/* Target Buffer Progress Bar */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-extrabold text-gray-900 dark:text-white">
              Target Emergency Cushion Status
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Required Target Corpus: <CurrencyValue value={analysis.targetAmount} /> ({targetMonths} Months buffer)
            </p>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
            fundedPercentage >= 100
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
              : 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-400'
          }`}>
            {fundedPercentage}% Funded
          </span>
        </div>

        <div className="h-3 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden border border-gray-200 dark:border-gray-700">
          <div
            style={{ width: `${fundedPercentage}%` }}
            className={`h-full transition-all duration-300 ${fundedPercentage >= 100 ? 'bg-green-600' : 'bg-amber-500'}`}
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-100 dark:border-gray-800">
          <Info size={14} className="text-gray-400 flex-shrink-0" />
          <span>
            {isAdequate
              ? `You currently hold ${analysis.runwayMonths} months of liquid reserves, meeting your ${targetMonths}-month target buffer.`
              : `To reach your ${targetMonths}-month safety buffer, build an additional `}
            {!isAdequate && <strong className="text-gray-700 dark:text-gray-300 font-bold"><CurrencyValue value={analysis.fundingGap} /></strong>}
            {!isAdequate && ' in dedicated liquid savings.'}
          </span>
        </div>
      </div>
    </div>
  );
};
