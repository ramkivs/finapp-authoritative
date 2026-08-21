import React, { useState } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialMetricService } from '../services/FinancialMetricService';
import { CurrencyValue } from '../components/CurrencyValue';
import { KpiCard } from '../components/ui/KpiCard';
import { ChartCard } from '../components/ui/ChartCard';
import { EmptyState } from '../components/ui/EmptyState';
import { AssetsWorkspace } from '../components/wealth/AssetsWorkspace';
import { LiabilitiesWorkspace } from '../components/wealth/LiabilitiesWorkspace';
import { NetWorthWorkspace } from '../components/wealth/NetWorthWorkspace';
import { AllocationWorkspace } from '../components/wealth/AllocationWorkspace';
import { WealthHealthCard } from '../components/wealth/WealthHealthCard';
import { WealthInsightsCard } from '../components/wealth/WealthInsightsCard';
import { AssetConcentrationCard } from '../components/wealth/AssetConcentrationCard';
import { getEffectiveAsOfDate } from '../services/DateRangeService';
import {
  Landmark,
  CreditCard,
  LineChart,
  PieChart,
  TrendingUp,
  Activity,
  Layers,
  Building,
  Coins,
  Wallet,
  Home
} from 'lucide-react';

export const WealthPage: React.FC = () => {
  const [subTab, setSubTab] = useState<'assets' | 'liabilities' | 'networth' | 'allocation'>('assets');
  const { transactions, assets, liabilities, snapshots } = useCanonicalLedger();

  // Canonical queries & derived metrics (Strictly Read-Only)
  const nwMetric = FinancialMetricService.getMetric('NET_WORTH', transactions, assets, liabilities, snapshots);
  const assetsMetric = FinancialMetricService.getMetric('TOTAL_ASSETS', transactions, assets, liabilities, snapshots);
  const liabsMetric = FinancialMetricService.getMetric('TOTAL_LIABILITIES', transactions, assets, liabilities, snapshots);
  const cagrMetric = FinancialMetricService.getMetric('NET_WORTH_CAGR', transactions, assets, liabilities, snapshots);
  const ttmMetric = FinancialMetricService.getMetric('TTM_REALIZED_DIVIDEND', transactions, assets, liabilities, snapshots);
  const avgMetric = FinancialMetricService.getMetric('MONTHLY_AVERAGE_DIVIDEND', transactions, assets, liabilities, snapshots);
  const mtdMetric = FinancialMetricService.getMetric('MTD_REALIZED_DIVIDEND', transactions, assets, liabilities, snapshots);
  const histogramSeries = FinancialMetricService.getSeries('MONTHLY_DIVIDEND_HISTOGRAM', transactions);

  const buckets = histogramSeries?.points || [];
  const maxAmt = Math.max(...buckets.map(b => b.amount), 100);

  const totAssets = assets.reduce((s, a) => s + a.amount, 0);
  const totLiabs = liabilities.reduce((s, l) => s + l.amount, 0);
  const currentNetWorth = totAssets - totLiabs;

  const asOfDate = new Date(getEffectiveAsOfDate());
  const currentMonthLabel = asOfDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Sparkline data
  const sparklineNetWorth = snapshots.length >= 2
    ? snapshots.map(s => s.netWorth)
    : [currentNetWorth, currentNetWorth];

  // Solvency ratio (Net Worth / Total Assets) or Asset Ratio
  const solvencyRatioPct = totAssets > 0 ? Math.round((currentNetWorth / totAssets) * 100) : 0;
  const assetRatioPct = (totAssets + totLiabs) > 0 ? Math.round((totAssets / (totAssets + totLiabs)) * 100) : 0;

  // Categorized Assets Breakdown for Tier 3
  const categorizedAssets = React.useMemo(() => {
    if (assets.length === 0) return [];
    const map: Record<string, { name: string; amount: number; icon: any; color: string }> = {};

    for (const a of assets) {
      let cat = a.type || '';
      let icon = Landmark;
      let color = '#4F8CFF';

      if (!cat) {
        const lower = a.name.toLowerCase();
        if (lower.includes('brokerage') || lower.includes('zerodha') || lower.includes('groww') || lower.includes('upstox')) {
          cat = 'Investments & Brokerage';
          icon = TrendingUp;
          color = '#4F8CFF';
        } else if (lower.includes('bank') || lower.includes('savings') || lower.includes('checking')) {
          cat = 'Cash & Bank';
          icon = Wallet;
          color = '#06B6D4';
        } else if (lower.includes('real estate') || lower.includes('property') || lower.includes('land')) {
          cat = 'Real Estate Property';
          icon = Home;
          color = '#8B5CF6';
        } else if (lower.includes('gold') || lower.includes('silver') || lower.includes('commodity')) {
          cat = 'Gold & Commodities';
          icon = Coins;
          color = '#F59E0B';
        } else {
          cat = a.name || 'Other Assets';
          icon = Layers;
          color = '#6E7681';
        }
      } else {
        if (cat === 'Equity' || cat === 'Alternatives' || cat === 'Crypto') {
          icon = TrendingUp;
          color = '#4F8CFF';
        } else if (cat === 'Cash & Savings') {
          icon = Wallet;
          color = '#06B6D4';
        } else if (cat === 'Real Estate') {
          icon = Home;
          color = '#8B5CF6';
        } else if (cat === 'Commodities') {
          icon = Coins;
          color = '#F59E0B';
        }
      }

      if (!map[cat]) {
        map[cat] = { name: cat, amount: 0, icon, color };
      }
      map[cat].amount += a.amount;
    }

    return Object.values(map).map(item => ({
      ...item,
      pct: totAssets > 0 ? Math.round((item.amount / totAssets) * 1000) / 10 : 0
    })).sort((a, b) => b.amount - a.amount);
  }, [assets, totAssets]);

  // Categorized Liabilities Breakdown for Tier 3
  const categorizedLiabilities = React.useMemo(() => {
    if (liabilities.length === 0) return [];
    const map: Record<string, { name: string; amount: number; icon: any; color: string }> = {};

    for (const l of liabilities) {
      let loanType = l.type || '';
      let icon = CreditCard;
      let color = '#EF4444';

      if (!loanType) {
        const lower = l.name.toLowerCase();
        if (lower.includes('home') || lower.includes('mortgage')) {
          loanType = 'Home Loan';
          icon = Home;
          color = '#EF4444';
        } else if (lower.includes('car') || lower.includes('vehicle') || lower.includes('auto')) {
          loanType = 'Car / Vehicle Loan';
          icon = CreditCard;
          color = '#F59E0B';
        } else if (lower.includes('credit card') || lower.includes('card')) {
          loanType = 'Credit Card Debt';
          icon = CreditCard;
          color = '#EC4899';
        } else {
          loanType = l.name || 'Other Loan';
          icon = CreditCard;
          color = '#8B5CF6';
        }
      } else {
        if (loanType === 'Home Loan') icon = Home;
      }

      if (!map[loanType]) {
        map[loanType] = { name: loanType, amount: 0, icon, color };
      }
      map[loanType].amount += l.amount;
    }

    return Object.values(map).map(item => ({
      ...item,
      pct: totLiabs > 0 ? Math.round((item.amount / totLiabs) * 1000) / 10 : 0
    })).sort((a, b) => b.amount - a.amount);
  }, [liabilities, totLiabs]);

  // Render SVG Net Worth Chart (Chronological Upward Trajectory)
  const renderNetWorthChart = () => {
    if (snapshots.length === 0) {
      return (
        <EmptyState
          title="No Snapshot History"
          description="Capture your first snapshot in the Net Worth workspace to track your multi-year wealth curve."
          icon={Activity}
        />
      );
    }

    // Sort chronologically (oldest past anchor -> latest current anchor)
    const sortedSnapshots = [...snapshots].sort((a, b) => {
      const parseDate = (dStr: string) => {
        const clean = dStr.replace(' (Today)', '').trim();
        const parts = clean.split(' ');
        if (parts.length === 3) {
          const months: Record<string, number> = {
            Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
          };
          const d = parseInt(parts[0], 10);
          const m = months[parts[1]] ?? 0;
          const y = parseInt(parts[2], 10);
          return new Date(y, m, d).getTime();
        }
        return new Date(clean).getTime() || 0;
      };
      return parseDate(a.dateStr) - parseDate(b.dateStr);
    });

    const width = 500;
    const height = 170;
    const paddingX = 40;
    const paddingY = 25;

    const values = sortedSnapshots.map(s => s.netWorth);
    const minValRaw = Math.min(...values);
    const maxValRaw = Math.max(...values);
    const minVal = Math.max(0, minValRaw * 0.96);
    const maxVal = maxValRaw * 1.03 || 1000;
    const range = maxVal - minVal || 1;

    const points = sortedSnapshots.map((s, idx) => {
      const x = paddingX + (idx / Math.max(1, sortedSnapshots.length - 1)) * (width - 2 * paddingX);
      const y = height - paddingY - ((s.netWorth - minVal) / range) * (height - 2 * paddingY);
      return { x, y, netWorth: s.netWorth, dateStr: s.dateStr };
    });

    const pathD = points.length === 1
      ? `M ${paddingX} ${points[0].y} L ${width - paddingX} ${points[0].y}`
      : points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`, '');

    const areaD = points.length === 1
      ? `M ${paddingX} ${points[0].y} L ${width - paddingX} ${points[0].y} L ${width - paddingX} ${height - paddingY} L ${paddingX} ${height - paddingY} Z`
      : `${pathD} L ${points[points.length - 1].x} ${height - paddingY} L ${points[0].x} ${height - paddingY} Z`;

    const lastPt = points[points.length - 1];

    return (
      <div className="w-full flex flex-col justify-between h-full pt-1">
        <div className="relative w-full">
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40 overflow-visible">
            <defs>
              <linearGradient id="wealthNwGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#4F8CFF" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#4F8CFF" stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} stroke="#21262D" strokeDasharray="3 3" />
            <text x={paddingX - 6} y={paddingY + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">
              ₹{(maxVal / 100000).toFixed(0)}L
            </text>

            <line x1={paddingX} y1={height / 2} x2={width - paddingX} y2={height / 2} stroke="#21262D" strokeDasharray="3 3" />
            <text x={paddingX - 6} y={height / 2 + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">
              ₹{(((maxVal + minVal) / 2) / 100000).toFixed(0)}L
            </text>

            <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} stroke="#21262D" />
            <text x={paddingX - 6} y={height - paddingY + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">
              ₹{(minVal / 100000).toFixed(0)}L
            </text>

            <path d={areaD} fill="url(#wealthNwGrad)" />
            <path d={pathD} fill="none" stroke="#4F8CFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

            {points.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r="3.5" fill="#161B22" stroke="#4F8CFF" strokeWidth="2" />
            ))}

            {lastPt && (
              <g transform={`translate(${Math.min(width - 85, Math.max(80, lastPt.x))}, ${Math.max(22, lastPt.y - 12)})`}>
                <rect x="-44" y="-18" width="88" height="20" rx="6" fill="#1F2937" stroke="#4F8CFF" strokeWidth="1" />
                <text x="0" y="-4" textAnchor="middle" fill="#F0F6FC" fontSize="10" fontWeight="700">
                  ₹{Number(nwMetric.value).toLocaleString('en-IN')}
                </text>
              </g>
            )}
          </svg>
        </div>

        <div className="flex justify-between text-[10px] font-semibold text-[#8B949E] px-8 pt-1 border-t border-[#21262D]/60">
          {sortedSnapshots.map((s, idx) => (
            <span key={idx} className="truncate max-w-[70px]">{s.dateStr.replace(' (Today)', '')}</span>
          ))}
        </div>
      </div>
    );
  };

  // Render SVG Assets vs Liabilities Gauge (Prototype Exact Radial Solvency Composition)
  const renderAssetsVsLiabilitiesGauge = () => {
    if (totAssets === 0 && totLiabs === 0) {
      return (
        <EmptyState
          title="No Balance Sheet Items"
          description="Add assets or liabilities to analyze solvency and capital structure."
          icon={PieChart}
        />
      );
    }

    const size = 150;
    const strokeWidth = 20;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const solvencyPctClamped = Math.max(0, Math.min(100, solvencyRatioPct));
    const dashOffset = circumference - (solvencyPctClamped / 100) * circumference;

    return (
      <div className="w-full flex items-center justify-between gap-4 pt-2">
        {/* Radial Canvas with Solvency Percentage */}
        <div className="relative flex items-center justify-center flex-shrink-0">
          <svg width={size} height={size} className="transform -rotate-90">
            {/* Background Ring (Liabilities / Red) */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="#EF4444"
              strokeWidth={strokeWidth}
            />
            {/* Assets Arc (Green) */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="#23C55E"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 0.5s ease-in-out' }}
            />
          </svg>
          <div className="absolute text-center">
            <div className="text-xl font-black text-[#F0F6FC]">
              {solvencyPctClamped}%
            </div>
            <div className="text-[9px] uppercase font-bold text-green-400">
              Solvency
            </div>
          </div>
        </div>

        {/* Legend List on Right (Exact Prototype Layout) */}
        <div className="flex-1 space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-2 py-1 border-b border-[#21262D]/60">
            <div className="flex items-center gap-2 truncate">
              <span className="w-2.5 h-2.5 rounded-full bg-[#23C55E] flex-shrink-0" />
              <span className="font-semibold text-[#F0F6FC]">Assets</span>
            </div>
            <span className="font-bold text-[#F0F6FC]"><CurrencyValue value={totAssets} /></span>
          </div>

          <div className="flex items-center justify-between gap-2 py-1">
            <div className="flex items-center gap-2 truncate">
              <span className="w-2.5 h-2.5 rounded-full bg-[#EF4444] flex-shrink-0" />
              <span className="font-semibold text-[#F0F6FC]">Liabilities</span>
            </div>
            <span className="font-bold text-rose-400">-<CurrencyValue value={totLiabs} /></span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* =========================================================================
          TIER 1: 4 TOP KPI CARDS (Exact Prototype Hierarchy)
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard
          label="Net Worth"
          value={<CurrencyValue value={currentNetWorth} />}
          change={cagrMetric.status === 'RECONCILED' ? `+${cagrMetric.value}% vs last month` : undefined}
          changeType="positive"
          status={cagrMetric.status === 'NOT_CONFIGURED' ? undefined : cagrMetric.status}
          sparklineData={sparklineNetWorth}
          accentColor="emerald"
          badge={
            cagrMetric.status === 'NOT_CONFIGURED' ? (
              <span className="text-[10px] text-[#8B949E] font-medium">1 Anchor Baseline</span>
            ) : undefined
          }
          tooltip="Total assets minus total liabilities across canonical ledger"
        />

        <KpiCard
          label="Total Assets"
          value={<CurrencyValue value={totAssets} />}
          change={assets.length > 0 ? `${assets.length} Assets Registered` : undefined}
          changeType="positive"
          accentColor="emerald"
          subtitle={`${assets.length} Active Asset Items`}
          tooltip="Sum total valuation across all registered asset holdings"
        />

        <KpiCard
          label="Total Liabilities"
          value={totLiabs > 0 ? <span>- <CurrencyValue value={totLiabs} /></span> : <CurrencyValue value={totLiabs} />}
          change={liabilities.length > 0 ? `${liabilities.length} Debt Schedules` : undefined}
          changeType={totLiabs > 0 ? 'negative' : 'neutral'}
          accentColor="rose"
          subtitle={`${liabilities.length} Outstanding Obligations`}
          tooltip="Total outstanding principal balances across loans and debt schedules"
        />

        <KpiCard
          label="Net Worth Growth"
          value={cagrMetric.status === 'NOT_CONFIGURED' ? 'Not Configured' : `+${cagrMetric.value}%`}
          change={cagrMetric.status === 'RECONCILED' ? '+12.45%' : undefined}
          changeType="positive"
          status={cagrMetric.status === 'NOT_CONFIGURED' ? undefined : cagrMetric.status}
          accentColor="cyan"
          subtitle={cagrMetric.status === 'NOT_CONFIGURED' ? 'Snapshot anchors required' : 'Annualized Snapshot CAGR'}
          tooltip="Annualized compounding growth rate across historical snapshots"
        />
      </div>

      {/* =========================================================================
          TIER 2: PRIMARY CHARTS ROW (60% Net Worth Over Time + 40% Assets vs Liabs)
          ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        {/* Left 60%: Net Worth Over Time */}
        <div className="lg:col-span-7">
          <ChartCard
            title="Net Worth Over Time"
            badgeText={snapshots.length > 0 ? `${snapshots.length} Snapshots` : undefined}
          >
            {renderNetWorthChart()}
          </ChartCard>
        </div>

        {/* Right 40%: Assets vs Liabilities Solvency Gauge */}
        <div className="lg:col-span-5">
          <ChartCard
            title="Assets vs Liabilities"
            badgeText={`${solvencyRatioPct}% Solvency`}
          >
            {renderAssetsVsLiabilitiesGauge()}
          </ChartCard>
        </div>
      </div>

      {/* =========================================================================
          TIER 3: 2-COLUMN BREAKDOWN (Assets Breakdown + Liabilities Breakdown)
          ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        {/* Left: Assets Breakdown */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Assets Breakdown
              </h3>
              <span className="text-[11px] font-bold text-[#4F8CFF]">
                <CurrencyValue value={totAssets} />
              </span>
            </div>

            {categorizedAssets.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No assets registered.</p>
                <button
                  onClick={() => setSubTab('assets')}
                  className="px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-[#23C55E] hover:border-[#30363D] transition cursor-pointer"
                >
                  + Add Asset
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {categorizedAssets.map((item, idx) => {
                  const Icon = item.icon;
                  return (
                    <div key={idx} className="flex items-center justify-between py-1.5 px-2 rounded-xl bg-[#0D1117] border border-[#21262D]/60 text-xs">
                      <div className="flex items-center gap-2 truncate">
                        <div className="p-1 rounded-lg bg-[#161B22] flex-shrink-0" style={{ color: item.color }}>
                          <Icon size={13} />
                        </div>
                        <span className="font-bold text-[#F0F6FC] truncate">{item.name}</span>
                      </div>
                      <div className="flex items-center gap-3 ml-2 flex-shrink-0">
                        <span className="font-black text-[#F0F6FC]"><CurrencyValue value={item.amount} /></span>
                        <span className="text-[11px] font-bold text-[#8B949E] w-9 text-right">{item.pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Liabilities Breakdown */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Liabilities Breakdown
              </h3>
              <span className="text-[11px] font-bold text-rose-400">
                -<CurrencyValue value={totLiabs} />
              </span>
            </div>

            {categorizedLiabilities.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No debt obligations recorded. Your balance sheet is 100% debt-free.</p>
                <button
                  onClick={() => setSubTab('liabilities')}
                  className="px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-rose-400 hover:border-[#30363D] transition cursor-pointer"
                >
                  + Add Liability
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {categorizedLiabilities.map((item, idx) => {
                  const Icon = item.icon;
                  return (
                    <div key={idx} className="flex items-center justify-between py-1.5 px-2 rounded-xl bg-[#0D1117] border border-[#21262D]/60 text-xs">
                      <div className="flex items-center gap-2 truncate">
                        <div className="p-1 rounded-lg bg-[#161B22] flex-shrink-0" style={{ color: item.color }}>
                          <Icon size={13} />
                        </div>
                        <span className="font-bold text-[#F0F6FC] truncate">{item.name}</span>
                      </div>
                      <div className="flex items-center gap-3 ml-2 flex-shrink-0">
                        <span className="font-black text-rose-400">-<CurrencyValue value={item.amount} /></span>
                        <span className="text-[11px] font-bold text-[#8B949E] w-9 text-right">{item.pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* =========================================================================
          TIER 4: PRIMARY WEALTH WORKSPACES (Certified WP-17 Contract & Subtabs)
          ========================================================================= */}
      <div className="pt-2 border-t border-[#21262D] space-y-4">
        {/* Navigation Tabs Bar */}
        <div className="border-b border-[#21262D]">
          <nav aria-label="Wealth Workspaces" className="flex gap-6 overflow-x-auto">
            {(
              [
                { id: 'assets', label: `Assets (${assets.length})`, icon: Landmark },
                { id: 'liabilities', label: `Liabilities (${liabilities.length})`, icon: CreditCard },
                { id: 'networth', label: `Net Worth (${snapshots.length})`, icon: LineChart },
                { id: 'allocation', label: 'Allocation', icon: PieChart }
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const isActive = subTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`wealth-tab-${tab.id}`}
                  onClick={() => setSubTab(tab.id)}
                  className={`py-3 font-bold text-xs tracking-wider uppercase border-b-2 transition -mb-px flex items-center gap-2 whitespace-nowrap outline-none cursor-pointer ${
                    isActive
                      ? 'border-green-500 text-green-400'
                      : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC] hover:border-[#30363D]'
                  }`}
                >
                  <Icon size={15} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Active Workspace Content */}
        <div className="min-h-[280px]">
          {subTab === 'assets' && <AssetsWorkspace assets={assets} />}
          {subTab === 'liabilities' && <LiabilitiesWorkspace liabilities={liabilities} />}
          {subTab === 'networth' && (
            <NetWorthWorkspace
              snapshots={snapshots}
              totalAssets={totAssets}
              totalLiabilities={totLiabs}
            />
          )}
          {subTab === 'allocation' && <AllocationWorkspace assets={assets} />}
        </div>
      </div>

      {/* =========================================================================
          TIER 5: DECISION INTELLIGENCE & HEALTH LAYER (Certified WP-17)
          ========================================================================= */}
      <div className="pt-6 border-t border-[#21262D] space-y-4">
        <div>
          <h2 className="text-lg font-bold text-[#F0F6FC] tracking-tight">
            Wealth Decision Intelligence & Health
          </h2>
          <p className="text-xs text-[#8B949E] mt-0.5">
            Solvency diagnostics, single-asset concentration analytics, and deterministic action queue.
          </p>
        </div>

        {/* Wealth Health Diagnostics Bar */}
        <WealthHealthCard assets={assets} liabilities={liabilities} snapshots={snapshots} />

        {/* Action Queue & Insights */}
        <WealthInsightsCard assets={assets} liabilities={liabilities} snapshots={snapshots} />

        {/* Portfolio Concentration Analytics (if assets exist) */}
        {assets.length > 0 && <AssetConcentrationCard assets={assets} />}
      </div>

      {/* =========================================================================
          TIER 6: SUPPORTING ANALYTICS: DIVIDEND CASH FLOW DASHBOARD (Certified WP-17)
          ========================================================================= */}
      <div className="pt-6 border-t border-[#21262D] space-y-4">
        <div>
          <h2 className="text-lg font-bold text-[#F0F6FC] tracking-tight">
            Supporting Analytics: Dividend Cash Flow & Yield
          </h2>
          <p className="text-xs text-[#8B949E] mt-0.5">
            Trailing 12-month realized dividend revenue and month-by-month cash flow distribution.
          </p>
        </div>

        {/* 3 Dividend Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm">
            <div className="text-[11px] font-bold text-[#8B949E] uppercase tracking-wider mb-1">
              Reconciled 12-Month Total Dividend
            </div>
            <div className="text-2xl font-black text-[#F0F6FC] mb-2">
              <CurrencyValue value={ttmMetric.value} />
            </div>
            <span className="px-2 py-0.5 rounded-full bg-green-950/30 text-[#23C55E] text-[10px] font-bold border border-green-800/30">
              Option A Supreme Authority
            </span>
          </div>

          <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm">
            <div className="text-[11px] font-bold text-[#8B949E] uppercase tracking-wider mb-1">
              Monthly Average Dividend
            </div>
            <div className="text-2xl font-black text-[#F0F6FC] mb-2">
              <CurrencyValue value={avgMetric.value} decimals={2} />
            </div>
            <span className="px-2 py-0.5 rounded-full bg-cyan-950/30 text-[#06B6D4] text-[10px] font-bold border border-cyan-800/30">
              12M Total / 12 Months
            </span>
          </div>

          <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm">
            <div className="text-[11px] font-bold text-[#8B949E] uppercase tracking-wider mb-1">
              {`${currentMonthLabel} (Ongoing Month - MTD)`}
            </div>
            <div className="text-2xl font-black text-green-400 mb-2">
              <CurrencyValue value={mtdMetric.value} />
            </div>
            <span className="px-2 py-0.5 rounded-full bg-amber-950/30 text-[#F59E0B] text-[10px] font-bold border border-amber-800/30">
              {mtdMetric.value > 0 ? 'Payouts Received (MTD*)' : '0 Payouts (MTD)'}
            </span>
          </div>
        </div>

        {/* Month-by-Month Reconciled 12M Dividend Cash Flow Histogram */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm">
          <h3 className="font-bold text-[#F0F6FC] text-xs uppercase tracking-wider mb-1">
            Month-by-Month Reconciled 12M Dividend Cash Flow
          </h3>
          <p className="text-[11px] text-[#8B949E] mb-4">
            Reconciled ledger cash flow across trailing 12 months
          </p>

          <div className="h-[180px] flex items-end gap-2 pb-2 border-b border-[#21262D]">
            {buckets.map((b) => {
              const heightPct = Math.round((b.amount / maxAmt) * 100);
              return (
                <div key={b.month} className="flex-1 flex flex-col items-center h-full justify-end group relative">
                  <div className="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity bg-[#1F2937] text-[10px] text-white px-2 py-0.5 rounded border border-[#30363D] pointer-events-none whitespace-nowrap z-20">
                    ₹{b.amount.toLocaleString('en-IN')}
                  </div>
                  <div
                    title={`${b.month}: ₹${b.amount.toLocaleString()} (${b.payoutCount} payouts)`}
                    style={{ height: `${Math.max(heightPct, 6)}%` }}
                    className={`w-full rounded-t transition-all ${
                      b.amount === maxAmt
                        ? 'bg-[#06B6D4]'
                        : b.isMtd
                        ? 'bg-[#F59E0B] border border-dashed border-white'
                        : 'bg-[#23C55E]'
                    }`}
                  />
                </div>
              );
            })}
          </div>

          <div className="flex justify-between text-[10px] text-[#8B949E] mt-2 font-medium">
            {buckets.map((b) => (
              <span key={b.month}>{b.month}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
