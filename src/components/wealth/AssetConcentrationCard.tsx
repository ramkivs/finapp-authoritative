import React from 'react';
import { Asset, Holding } from '../../domain/types';
import { WealthIntelligenceService } from '../../services/WealthIntelligenceService';
import { CurrencyValue } from '../CurrencyValue';
import { PieChart, AlertTriangle } from 'lucide-react';

interface Props {
  assets: Asset[];
  // WP-FB-IMPORT-BROKER-01 D-04: imported Holdings contribute
  // currentValue to the concentration denominator.
  holdings?: Holding[];
}

export const AssetConcentrationCard: React.FC<Props> = ({ assets, holdings = [] }) => {
  // WP-FB-IMPORT-BROKER-01 D-04: thread holdings into the
  // service-layer call so the concentration percentages include
  // the broker-imported currentValue.
  const concentration = WealthIntelligenceService.getAssetConcentration(assets, holdings);
  // Total includes both Assets AND Imported Holdings (currentValue).
  const holdingsValue = holdings.reduce((s, h) => s + (Number(h.currentValue) || 0), 0);
  const total = assets.reduce((s, a) => s + a.amount, 0) + holdingsValue;

  if (total === 0) {
    return null;
  }

  const isUnclassified = concentration.byType[0]?.type === 'Unclassified';

  return (
    <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <PieChart className="text-[#06B6D4]" size={16} />
          <div>
            <h3 className="font-bold text-[#F0F6FC] text-xs uppercase tracking-wider">
              Portfolio Concentration & Exposure Analytics
            </h3>
            <p className="text-[11px] text-[#8B949E]">
              Deterministic asset distribution across single holdings, categories, and explicit geographies
            </p>
          </div>
        </div>

        {concentration.isConcentrated && (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-950/30 text-[#F59E0B] text-[10px] font-bold border border-amber-800/30">
            <AlertTriangle size={11} />
            <span>Concentration Alert</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Largest Single Asset */}
        <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
              Largest Asset Position
            </div>
            {concentration.topAsset ? (
              <>
                <div className="text-xs font-bold text-[#F0F6FC] mt-1 truncate">
                  {concentration.topAsset.name}
                </div>
                <div className="text-lg font-black text-[#23C55E] mt-0.5">
                  <CurrencyValue value={concentration.topAsset.amount} />
                </div>
              </>
            ) : (
              <div className="text-xs text-[#8B949E] mt-1">No assets</div>
            )}
          </div>
          <div className="mt-2">
            <span className={`text-[10px] font-bold block ${
              (concentration.topAsset?.pct || 0) > 40 ? 'text-[#F59E0B]' : 'text-[#23C55E]'
            }`}>
              {concentration.topAsset?.pct}% of total portfolio
            </span>
          </div>
        </div>

        {/* Top Asset Category */}
        <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
              Dominant Category
            </div>
            {concentration.byType[0] ? (
              <>
                <div className="text-xs font-bold text-[#F0F6FC] mt-1 flex items-center gap-1.5">
                  <span>{concentration.byType[0].type}</span>
                  {isUnclassified && (
                    <span className="text-[9px] px-1.5 py-0.2 bg-[#21262D] text-[#8B949E] rounded font-mono">
                      Metadata Pending
                    </span>
                  )}
                </div>
                <div className="text-lg font-black text-[#06B6D4] mt-0.5">
                  <CurrencyValue value={concentration.byType[0].amount} />
                </div>
              </>
            ) : (
              <div className="text-xs text-[#8B949E] mt-1">Unclassified</div>
            )}
          </div>
          <div className="mt-2">
            <span className="text-[10px] font-bold text-[#8B949E] block">
              {concentration.byType[0]?.pct}% of total asset valuation
            </span>
          </div>
        </div>

        {/* Geography Distribution */}
        <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
          <div>
            <div className="text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
              Explicit Geography Exposure
            </div>
            <div className="space-y-1 mt-1.5 text-xs">
              {concentration.byGeography.map(g => (
                <div key={g.geography} className="flex justify-between items-center text-[#F0F6FC] text-[11px]">
                  <span className="font-semibold text-[#8B949E]">{g.geography}</span>
                  <span className="font-bold">{g.pct}%</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 text-[9px] text-[#6E7681] italic">
            Explicit metadata only; no currency inference
          </div>
        </div>
      </div>
    </div>
  );
};
