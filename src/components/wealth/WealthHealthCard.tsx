import React from 'react';
import { Asset, Holding, Liability, NetWorthSnapshot } from '../../domain/types';
import { FinancialQueries } from '../../application/queries';
import { WealthIntelligenceService } from '../../services/WealthIntelligenceService';
import { CurrencyValue } from '../CurrencyValue';
import { Activity } from 'lucide-react';

interface Props {
  assets: Asset[];
  liabilities: Liability[];
  snapshots: NetWorthSnapshot[];
  // WP-FB-IMPORT-BROKER-01 D-04: imported Holdings contribute
  // currentValue to wealth; threaded through to the service layer
  // so the displayed net worth includes broker-imported positions.
  holdings?: Holding[];
}

export const WealthHealthCard: React.FC<Props> = ({ assets, liabilities, snapshots, holdings = [] }) => {
  // WP-FB-IMPORT-BROKER-01 D-04: thread holdings into the service
  // calls so the displayed Debt-to-Asset Ratio and related metrics
  // include the imported currentValue.
  const health = WealthIntelligenceService.getHealthSummary(assets, liabilities, snapshots, [], [], holdings);
  const liabDiag = WealthIntelligenceService.getLiabilityDiagnostics(assets, liabilities, holdings);
  // WP-FB-IMPORT-BROKER-01 D04-HWA-07: use the queries layer so the
  // authoritative Holdings-aware data-quality result is used. The
  // service-layer `getDataQuality(assets, liabilities, snapshots,
  // holdings)` correctly counts Holdings in `totalRecords`, but the
  // queries layer is the single entry point for the UI (consistent
  // with the other wealth cards) and already threads Holdings per
  // the D04-HWA-07 implementation. The completeness methodology
  // (canonical Asset/Liability type/geography/currency checks) is
  // unchanged; this is a wiring-only fix.
  const dataQuality = FinancialQueries.getDataQuality();

  if (health.status === 'NOT_CONFIGURED') {
    return (
      <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="text-[#8B949E]" size={16} />
            <h3 className="font-bold text-[#F0F6FC] text-xs uppercase tracking-wider">Wealth Health & Diagnostics</h3>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-[#21262D] text-[#8B949E] text-[10px] font-bold">
            Not Configured
          </span>
        </div>
        <p className="text-xs text-[#8B949E] mt-1.5">
          Add assets and liabilities to calculate debt solvency, liquidity cushion, and portfolio health diagnostics.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="text-[#23C55E]" size={16} />
          <div>
            <h3 className="font-bold text-[#F0F6FC] text-xs uppercase tracking-wider">Wealth Health & Solvency Diagnostics</h3>
            <p className="text-[11px] text-[#8B949E]">Canonical balance sheet ratios and structural resilience</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
            liabDiag.burdenLevel === 'LOW'
              ? 'bg-green-950/30 text-[#23C55E] border border-green-800/30'
              : liabDiag.burdenLevel === 'MODERATE'
              ? 'bg-amber-950/30 text-[#F59E0B] border border-amber-800/30'
              : 'bg-rose-950/30 text-rose-400 border border-rose-800/30'
          }`}>
            {liabDiag.burdenLevel === 'LOW' ? 'Low Leverage Solvency' : liabDiag.burdenLevel === 'MODERATE' ? 'Moderate Debt Burden' : 'Elevated Debt Ratio'}
          </span>

          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
            dataQuality.status === 'COMPLETE'
              ? 'bg-blue-950/30 text-[#4F8CFF] border border-blue-800/30'
              : dataQuality.status === 'PARTIAL'
              ? 'bg-[#21262D] text-[#8B949E]'
              : 'bg-amber-950/30 text-[#F59E0B] border border-amber-800/30'
          }`}>
            Metadata: {dataQuality.completenessScore}%
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Debt-to-Asset Ratio */}
        <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
              Debt-to-Asset Ratio
            </div>
            <div className="text-xl font-black text-[#F0F6FC] mt-0.5">
              {Math.round(health.debtToAssetRatio)}%
            </div>
          </div>
          <div className="mt-2">
            <div className="h-1.5 w-full bg-[#21262D] rounded-full overflow-hidden">
              <div
                style={{ width: `${Math.min(health.debtToAssetRatio, 100)}%` }}
                className={`h-full ${
                  health.debtToAssetRatio > 40
                    ? 'bg-rose-500'
                    : health.debtToAssetRatio > 20
                    ? 'bg-[#F59E0B]'
                    : 'bg-[#23C55E]'
                }`}
              />
            </div>
            <span className="text-[10px] text-[#8B949E] mt-1 block font-medium">
              Liabilities / Assets
            </span>
          </div>
        </div>

        {/* Liquid Cash Reserves */}
        <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
              Liquid Reserve Cushion
            </div>
            <div className="text-xl font-black text-[#23C55E] mt-0.5">
              <CurrencyValue value={health.liquidReserve} />
            </div>
          </div>
          <div className="mt-2">
            <span className="text-[10px] font-bold text-[#06B6D4] block">
              {Math.round(health.liquidRatio)}% of total asset base
            </span>
            <span className="text-[9px] text-[#6E7681] block">
              Cash & Savings classification
            </span>
          </div>
        </div>

        {/* Top Position Concentration */}
        <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
              Top Position Concentration
            </div>
            <div className="text-xl font-black text-[#F0F6FC] mt-0.5">
              {Math.round(health.topAssetConcentration)}%
            </div>
          </div>
          <div className="mt-2">
            <span className={`text-[10px] font-bold block ${
              health.topAssetConcentration > 40 ? 'text-[#F59E0B]' : 'text-[#23C55E]'
            }`}>
              {health.topAssetConcentration > 40 ? 'Concentrated single position' : 'Balanced distribution'}
            </span>
            <span className="text-[9px] text-[#6E7681] block">
              Largest position as % of total wealth
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
