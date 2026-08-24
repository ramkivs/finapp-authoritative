import React, { useState } from 'react';
import { Holding, NetWorthSnapshot } from '../../domain/types';
import { TakeSnapshotModal } from './TakeSnapshotModal';
import { AddPastEntryModal } from './AddPastEntryModal';
import { CurrencyValue } from '../CurrencyValue';
import { WealthIntelligenceService, parseDateToTime } from '../../services/WealthIntelligenceService';
import { Camera, Calendar, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface Props {
  snapshots: NetWorthSnapshot[];
  totalAssets: number;
  totalLiabilities: number;
  // WP-FB-IMPORT-BROKER-01 D-04: imported Holdings are already
  // included in the `totalAssets` prop (the page-level calc adds
  // holdings' currentValue to assets). The component itself does
  // not need to thread holdings into trend/CAGR (which are
  // snapshot-based metrics, not net-worth-sum metrics).
  holdings?: Holding[];
}

export const NetWorthWorkspace: React.FC<Props> = ({ snapshots, totalAssets, totalLiabilities }) => {
  const [takeModalOpen, setTakeModalOpen] = useState(false);
  const [pastModalOpen, setPastModalOpen] = useState(false);

  const trend = WealthIntelligenceService.getTrendIntelligence(snapshots);
  const cagrMetric = WealthIntelligenceService.calculateNetWorthCAGR(snapshots);

  const sortedSnaps = [...snapshots]
    .map(s => ({ ...s, timestamp: parseDateToTime(s.dateStr) }))
    .filter(s => !isNaN(s.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Net Worth Historical Snapshots ({snapshots.length})</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Reconciled temporal checkpoints anchoring multi-point net worth trajectory</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setPastModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 font-bold text-xs transition border border-gray-200 dark:border-gray-700"
          >
            <Calendar size={15} />
            <span>Add Past Entry</span>
          </button>

          <button
            onClick={() => setTakeModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white font-bold text-xs transition shadow-sm"
          >
            <Camera size={15} />
            <span>Take New Snapshot</span>
          </button>
        </div>
      </div>

      {/* Workstream C5: Trend Intelligence Banner when snapshots exist */}
      {snapshots.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
          <div>
            <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Latest Anchor Valuation
            </span>
            <div className="text-xl font-black text-gray-900 dark:text-white mt-1">
              <CurrencyValue value={trend.latestNetWorth} />
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 block">
              As of {sortedSnaps[sortedSnaps.length - 1]?.dateStr}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Change Since Previous Snapshot
            </span>
            <div className="text-xl font-black text-gray-900 dark:text-white mt-1">
              {trend.absoluteChange !== undefined ? (
                <span className={trend.absoluteChange >= 0 ? 'text-green-700 dark:text-green-400' : 'text-rose-600 dark:text-rose-400'}>
                  {trend.absoluteChange >= 0 ? '+' : ''}<CurrencyValue value={trend.absoluteChange} />
                </span>
              ) : (
                <span className="text-gray-400 text-sm font-semibold">1st Anchor Baseline</span>
              )}
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 block">
              {trend.percentageChange !== undefined
                ? `${trend.percentageChange >= 0 ? '+' : ''}${trend.percentageChange.toFixed(1)}% vs previous anchor`
                : 'Subsequent snapshots enable trend comparison'}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
              Historical Trajectory
            </span>
            <div className="mt-1 flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                trend.status === 'COMPOUNDING_ACTIVE'
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                  : trend.status === 'TREND_ACTIVE'
                  ? 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400'
                  : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
              }`}>
                {trend.direction === 'UP' && <TrendingUp size={14} />}
                {trend.direction === 'DOWN' && <TrendingDown size={14} />}
                {trend.direction === 'FLAT' && <Minus size={14} />}
                <span>
                  {trend.status === 'COMPOUNDING_ACTIVE'
                    ? (cagrMetric.status === 'RECONCILED' ? `${cagrMetric.value > 0 ? '+' : ''}${cagrMetric.value}% Annualized CAGR` : `Multi-Point Trajectory (${snapshots.length} Anchors)`)
                    : trend.status === 'TREND_ACTIVE'
                    ? '2-Point Trend Active'
                    : 'Baseline Set (1 Anchor)'}
                </span>
              </span>
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
              {snapshots.length} temporal data points recorded
            </span>
          </div>
        </div>
      )}

      {snapshots.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">No historical snapshots anchored</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-sm mx-auto">
            Anchor today's net worth or record historical milestones to start tracking your net worth growth curve.
          </div>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setPastModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-xs font-bold transition border border-gray-200 dark:border-gray-700"
            >
              <Calendar size={14} />
              <span>Add Past Entry</span>
            </button>
            <button
              type="button"
              onClick={() => setTakeModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-xs font-bold transition shadow-sm"
            >
              <Camera size={14} />
              <span>Take Snapshot</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-800 text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  <th className="py-3.5 px-6">Snapshot Date</th>
                  <th className="py-3.5 px-6">Label / Milestone</th>
                  <th className="py-3.5 px-6">Total Assets</th>
                  <th className="py-3.5 px-6">Total Liabilities</th>
                  <th className="py-3.5 px-6">Net Worth</th>
                  <th className="py-3.5 px-6">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-sm">
                {sortedSnaps.map((s, i) => (
                  <tr key={s.id || s.dateStr} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
                    <td className={`py-3.5 px-6 ${i === sortedSnaps.length - 1 ? 'font-bold' : ''}`}>
                      {s.dateStr}
                    </td>
                    <td className="py-3.5 px-6 text-xs text-gray-500 dark:text-gray-400">
                      {s.label ? (
                        <span className="px-2 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-medium">
                          {s.label}
                        </span>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500 italic">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-6"><CurrencyValue value={s.totalAssets} /></td>
                    <td className="py-3.5 px-6 text-rose-600 dark:text-rose-400">
                      {s.totalLiabilities > 0 ? (
                        <span className="flex items-center">
                          -&nbsp;<CurrencyValue value={s.totalLiabilities} />
                        </span>
                      ) : (
                        <CurrencyValue value={s.totalLiabilities} />
                      )}
                    </td>
                    <td className="py-3.5 px-6 font-bold text-green-700 dark:text-green-400">
                      <CurrencyValue value={s.netWorth} />
                    </td>
                    <td className="py-3.5 px-6">
                      <span className="px-2.5 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-bold">
                        {s.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TakeSnapshotModal isOpen={takeModalOpen} onClose={() => setTakeModalOpen(false)} />
      <AddPastEntryModal isOpen={pastModalOpen} onClose={() => setPastModalOpen(false)} />
    </div>
  );
};
