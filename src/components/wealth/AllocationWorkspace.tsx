import React, { useState } from 'react';
import { Asset, Holding } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { queries } from '../../application';
import { WealthIntelligenceService, REFERENCE_ALLOCATION_BENCHMARK } from '../../services/WealthIntelligenceService';
import { PieChart, Globe, Repeat, AlertTriangle, Compass } from 'lucide-react';

interface Props {
  assets: Asset[];
  // WP-FB-IMPORT-BROKER-01 D-04: imported Holdings contribute
  // currentValue to allocation totals. Threaded through to the
  // service layer so the displayed allocation percentages
  // include broker-imported positions in the denominator.
  holdings?: Holding[];
}

export const AllocationWorkspace: React.FC<Props> = ({ assets, holdings = [] }) => {
  const [allocTab, setAllocTab] = useState<'class' | 'geography' | 'sip' | 'diagnostics'>('class');

  // WP-FB-IMPORT-BROKER-01 D-04: include holdings' currentValue in the
  // total-assets sum so allocation percentages reflect the
  // complete portfolio (Assets + Imported Holdings).
  const holdingsValue = holdings.reduce((sum, h) => sum + (Number(h.currentValue) || 0), 0);
  const totAssets = assets.reduce((sum, a) => sum + a.amount, 0) + holdingsValue;
  const sipMetric = queries.getMetric('SIP_COMMITMENT_MONTHLY');
  // Thread holdings into the service-layer diagnostics and
  // concentration calls so the percentages include the broker-
  // imported currentValue.
  const diagnostics = WealthIntelligenceService.getAllocationDiagnostics(assets, holdings);
  const concentration = WealthIntelligenceService.getAssetConcentration(assets, holdings);

  // Authoritative class allocation from intelligence service
  const classBreakdown = concentration.byType;

  // Authoritative geography exposure from intelligence service (no local inference)
  const geoBreakdown = concentration.byGeography;

  return (
    <div className="space-y-6">
      {/* Subtabs for Allocation */}
      <div className="flex border-b border-gray-200 dark:border-gray-800 gap-8 overflow-x-auto">
        {(['class', 'geography', 'sip', 'diagnostics'] as const).map((tab) => (
          <button
            key={tab}
            id={`alloc-subtab-${tab}`}
            onClick={() => setAllocTab(tab)}
            className={`py-3 font-semibold text-xs tracking-wider uppercase border-b-2 transition -mb-px flex items-center gap-2 whitespace-nowrap outline-none ${
              allocTab === tab
                ? 'border-green-600 dark:border-green-400 text-green-700 dark:text-green-400 font-bold'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            }`}
          >
            {tab === 'class' && (
              <>
                <PieChart size={15} />
                <span>Asset Allocation</span>
              </>
            )}
            {tab === 'geography' && (
              <>
                <Globe size={15} />
                <span>Geography</span>
              </>
            )}
            {tab === 'sip' && (
              <>
                <Repeat size={15} />
                <span>Monthly SIP Plan</span>
              </>
            )}
            {tab === 'diagnostics' && (
              <>
                <Compass size={15} />
                <span>Allocation Drift & Diagnostics</span>
              </>
            )}
          </button>
        ))}
      </div>

      {assets.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">No assets recorded</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-sm mx-auto">
            Add assets to inspect asset allocation and geography exposure.
          </div>
        </div>
      ) : allocTab === 'class' ? (
        <div className="space-y-6">
          {/* Reference Allocation Benchmark (Single Source of Truth) */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 rounded-2xl shadow-sm">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <h4 className="text-sm font-extrabold text-gray-900 dark:text-white">
                  Reference Allocation Benchmark (Analytical Reference; Not Personalized Advice)
                </h4>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Broad market multi-asset analytical benchmark for structural comparison
                </p>
              </div>
              <span className="px-2.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 text-[10px] font-bold">
                Analytical Benchmark
              </span>
            </div>

            {/* Benchmark Bar derived dynamically from single source of truth */}
            <div className="h-4 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden flex border border-gray-200 dark:border-gray-700">
              {REFERENCE_ALLOCATION_BENCHMARK.map((b) => (
                <div
                  key={b.category}
                  style={{ width: `${b.targetPct}%` }}
                  className={`${b.color} h-full`}
                  title={`${b.category}: ${b.targetPct}%`}
                />
              ))}
            </div>

            {/* Benchmark Legend derived dynamically from single source of truth */}
            <div className="flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-400 mt-3 font-semibold">
              {REFERENCE_ALLOCATION_BENCHMARK.map((b) => (
                <span key={b.category} className="flex items-center gap-1.5">
                  <span className={`w-2.5 h-2.5 rounded-full ${b.color}`} />
                  {b.category} {b.targetPct}%
                </span>
              ))}
            </div>
          </div>

          {/* Actual Portfolio Allocation */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 rounded-2xl shadow-sm">
            <h4 className="text-sm font-extrabold text-gray-900 dark:text-white mb-4">Actual Canonical Portfolio Allocation</h4>
            <div className="space-y-3">
              {classBreakdown.map((item) => (
                <div key={item.type} className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-4 rounded-xl flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-900 dark:text-white">{item.type}</span>
                  <div className="flex items-center gap-4">
                    <span className="text-xs font-bold text-gray-500 dark:text-gray-400">{item.pct}%</span>
                    <span className="text-sm font-extrabold text-green-700 dark:text-green-400">
                      <CurrencyValue value={item.amount} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : allocTab === 'geography' ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 rounded-2xl shadow-sm">
          <h4 className="text-sm font-extrabold text-gray-900 dark:text-white mb-2">Explicit Geography Exposure</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Derived strictly from explicit geography metadata on canonical assets (no currency inference)</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {geoBreakdown.map((geo) => (
              <div key={geo.geography} className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-5 rounded-xl flex flex-col justify-between">
                <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase">{geo.geography}</span>
                <div className="mt-4">
                  <div className="text-2xl font-extrabold text-gray-900 dark:text-white">
                    <CurrencyValue value={geo.amount} />
                  </div>
                  <span className="text-xs font-bold text-cyan-600 dark:text-cyan-400 mt-1 block">{geo.pct}% of total valuation</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : allocTab === 'sip' ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 rounded-2xl shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="text-sm font-extrabold text-gray-900 dark:text-white">Monthly SIP Commitment Plan</h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Systematic monthly investment contributions from canonical registry</p>
            </div>
            <span className="px-2.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 text-xs font-bold">
              {sipMetric.status}
            </span>
          </div>

          <div className="bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-6 rounded-xl flex items-center justify-between">
            <span className="text-sm font-bold text-gray-900 dark:text-white">Total Monthly SIP Commitment</span>
            <span className="text-2xl font-extrabold text-green-700 dark:text-green-400">
              {sipMetric.status === 'NOT_CONFIGURED' ? 'Not configured' : <CurrencyValue value={sipMetric.value} />}
            </span>
          </div>
        </div>
      ) : (
        /* Workstream C3: Allocation Drift & Diagnostics Tab */
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 rounded-2xl shadow-sm space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h4 className="text-sm font-extrabold text-gray-900 dark:text-white">
                Allocation Drift & Exposure Diagnostics
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Deterministic comparison between actual canonical portfolio weights and target benchmarks
              </p>
            </div>
            {diagnostics.hasConcentrationWarning && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-400 text-xs font-bold">
                <AlertTriangle size={13} />
                <span>Heavy Category Concentration</span>
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-800 text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  <th className="py-3 px-4">Asset Class</th>
                  <th className="py-3 px-4 text-center">Target Benchmark</th>
                  <th className="py-3 px-4 text-center">Actual Portfolio</th>
                  <th className="py-3 px-4 text-right">Drift (Actual − Target)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-xs">
                {diagnostics.targetDrift.map(d => {
                  const isPositive = d.driftPct > 0;
                  const isNeutral = d.driftPct === 0;
                  return (
                    <tr key={d.category} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
                      <td className="py-3 px-4 font-bold text-gray-900 dark:text-white">{d.category}</td>
                      <td className="py-3 px-4 text-center text-gray-600 dark:text-gray-400 font-semibold">{d.targetPct}%</td>
                      <td className="py-3 px-4 text-center font-bold text-gray-900 dark:text-white">{d.actualPct}%</td>
                      <td className={`py-3 px-4 text-right font-extrabold ${
                        isNeutral ? 'text-gray-400' : isPositive ? 'text-cyan-600 dark:text-cyan-400' : 'text-amber-600 dark:text-amber-400'
                      }`}>
                        {isPositive ? `+${d.driftPct}%` : `${d.driftPct}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
