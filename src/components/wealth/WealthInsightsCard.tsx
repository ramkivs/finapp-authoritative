import React from 'react';
import { Asset, Holding, Liability, NetWorthSnapshot } from '../../domain/types';
import { WealthIntelligenceService } from '../../services/WealthIntelligenceService';
import { Lightbulb, Info, AlertTriangle } from 'lucide-react';

interface Props {
  assets: Asset[];
  liabilities: Liability[];
  snapshots: NetWorthSnapshot[];
  holdings?: Holding[];
}

export const WealthInsightsCard: React.FC<Props> = ({ assets, liabilities, snapshots, holdings = [] }) => {
  const insights = WealthIntelligenceService.generateInsights(assets, liabilities, snapshots, holdings);

  if (insights.length === 0) {
    return null;
  }

  const getBadgeStyle = (severity: string) => {
    switch (severity) {
      case 'ACTION':
        return 'bg-rose-950/30 text-rose-400 border border-rose-800/30';
      case 'WATCH':
        return 'bg-amber-950/30 text-[#F59E0B] border border-amber-800/30';
      case 'INFO':
      default:
        return 'bg-blue-950/30 text-[#4F8CFF] border border-blue-800/30';
    }
  };

  const getIcon = (severity: string) => {
    switch (severity) {
      case 'ACTION':
        return <AlertTriangle className="text-rose-400 flex-shrink-0 mt-0.5" size={15} />;
      case 'WATCH':
        return <AlertTriangle className="text-[#F59E0B] flex-shrink-0 mt-0.5" size={15} />;
      case 'INFO':
      default:
        return <Info className="text-[#4F8CFF] flex-shrink-0 mt-0.5" size={15} />;
    }
  };

  return (
    <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="text-[#F59E0B]" size={16} />
          <div>
            <h3 className="font-bold text-[#F0F6FC] text-xs uppercase tracking-wider">
              Wealth Intelligence & Action Queue
            </h3>
            <p className="text-[11px] text-[#8B949E]">
              Deterministic diagnostic insights derived strictly from canonical balance sheet state
            </p>
          </div>
        </div>
        <span className="text-[10px] font-bold text-[#8B949E] px-2 py-0.5 rounded-full bg-[#0D1117] border border-[#21262D]">
          {insights.length} Insights
        </span>
      </div>

      <div className="space-y-2">
        {insights.map((insight) => (
          <div
            key={insight.id}
            className="p-3 rounded-xl bg-[#0D1117] border border-[#21262D]/60 flex items-start justify-between gap-3 text-xs"
          >
            <div className="flex items-start gap-2.5">
              {getIcon(insight.severity)}
              <div>
                <div className="font-bold text-[#F0F6FC] text-xs flex items-center gap-2">
                  <span>{insight.title}</span>
                </div>
                <p className="text-[11px] text-[#8B949E] mt-0.5 leading-relaxed">{insight.explanation}</p>
                <div className="text-[10px] text-[#6E7681] mt-1 font-mono">
                  Source: {insight.sourceMetric}
                  {insight.deterministicReason && ` • ${insight.deterministicReason}`}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${getBadgeStyle(insight.severity)}`}>
                {insight.severity}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
