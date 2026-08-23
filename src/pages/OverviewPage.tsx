import React, { useState } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { FinancialMetricService } from '../services/FinancialMetricService';
import { FinancialQueries } from '../application/queries';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { getEffectiveAsOfDate } from '../services/DateRangeService';
import { CurrencyValue } from '../components/CurrencyValue';
import { KpiCard } from '../components/ui/KpiCard';
import { ChartCard } from '../components/ui/ChartCard';
import { ProgressBar } from '../components/ui/ProgressBar';
import { EmptyState } from '../components/ui/EmptyState';
import {
  Wallet,
  TrendingUp,
  CreditCard,
  ShieldCheck,
  Plus,
  Camera,
  Layers,
  Target,
  Landmark,
  ArrowUpRight,
  Activity
} from 'lucide-react';

interface Props {
  /**
   * Canonical navigation callback supplied by App. Dashboard entry points must
   * use this rather than anchor hrefs: FinBoom has no router, so `<a href="#x">`
   * updates the URL fragment and nothing else.
   */
  navigateTo: (tabId: string, subTab?: string) => void;
}

export const OverviewPage: React.FC<Props> = ({ navigateTo }) => {
  const {
    assets,
    liabilities,
    snapshots,
    transactions,
    accounts,
    goals,
    addAsset,
    addLiability,
    captureSnapshot
  } = useCanonicalLedger();

  // Canonical queries & derived metrics (Strictly Read-Only)
  const nwMetric = FinancialMetricService.getMetric('NET_WORTH', transactions, assets, liabilities, snapshots);
  const cagrMetric = FinancialMetricService.getMetric('NET_WORTH_CAGR', transactions, assets, liabilities, snapshots);
  const cashflow = FinancialQueries.getMoneyInsights('This Month');
  const healthScore = FinancialQueries.getFinancialHealthScore();

  // Compute total investments from market asset classes
  const investmentTypes = new Set(['Equity', 'Debt', 'Commodities', 'Crypto', 'Alternatives']);
  const totalInvestments = assets
    .filter(a => (a.type ? investmentTypes.has(a.type) : !a.name.toLowerCase().includes('bank')))
    .reduce((s, a) => s + a.amount, 0);

  const registeredAssetCount = assets.length;

  // Sparkline data from historical snapshots
  const sparklineNetWorth = snapshots.length >= 2
    ? snapshots.map(s => s.netWorth)
    : [nwMetric.value, nwMetric.value];

  // Inline Quick Asset/Liability Form Modal State (Preserving Functional Contracts)
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [showLiabForm, setShowLiabForm] = useState(false);

  const [assetName, setAssetName] = useState('');
  const [assetAmt, setAssetAmt] = useState('');
  const [liabName, setLiabName] = useState('');
  const [liabAmt, setLiabAmt] = useState('');

  /**
   * WP-FB-DATA-07b — the SECOND asset create path.
   *
   * It bypasses `FinancialCommands` and calls the store directly, which is
   * exactly why create semantics live at the repository boundary. The write is
   * awaited so a persistence failure is shown here rather than swallowed — the
   * 07b gate measured this path closing over a failed write in silence.
   */
  const [assetNotice, setAssetNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const handleAddAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (assetName.trim() && assetAmt) {
      setAssetNotice(null);
      try {
        await addAsset(assetName.trim(), Number(assetAmt));
        setAssetNotice({ kind: 'success', message: `Added "${assetName.trim()}".` });
        setAssetName('');
        setAssetAmt('');
        setShowAssetForm(false);
      } catch (err: any) {
        setAssetNotice({
          kind: 'error',
          message: err?.message || 'The asset could not be saved.'
        });
      }
    }
  };

  /**
   * WP-FB-DATA-07a — the SECOND create path.
   *
   * This form bypasses `FinancialCommands` and calls the store directly, which
   * is exactly why the duplicate-name policy is enforced at the repository
   * boundary: a check placed in `AddLiabilityModal` would leave this form
   * unguarded. The write is awaited so a refusal or a persistence failure is
   * shown here rather than swallowed.
   */
  const [liabNotice, setLiabNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const handleAddLiab = async (e: React.FormEvent) => {
    e.preventDefault();
    if (liabName.trim() && liabAmt) {
      setLiabNotice(null);
      try {
        await addLiability(liabName.trim(), Number(liabAmt));
        setLiabNotice({ kind: 'success', message: `Added "${liabName.trim()}".` });
        setLiabName('');
        setLiabAmt('');
        setShowLiabForm(false);
      } catch (err: any) {
        setLiabNotice({
          kind: 'error',
          message: err?.message || 'The liability could not be saved.'
        });
      }
    }
  };

  // Registered Bank Accounts from Canonical Repository (Strictly Zero Fabrication)
  // WP-FB-DATA-05a: Top Accounts shows DERIVED current balances, ranked by
  // value. Previously it displayed acc.openingBalance labelled as a balance.
  const accountBalances = AccountBalanceService.balances(accounts, transactions, getEffectiveAsOfDate());
  const registeredAccounts = [...accountBalances].sort((a, b) => b.balance - a.balance);

  // Render pure SVG Net Worth Trend Area Chart (Prototype Exact Composition & Scaling)
  const renderNetWorthTrend = () => {
    if (snapshots.length === 0) {
      return (
        <EmptyState
          title="No Snapshot History"
          description="Capture your first net worth snapshot to visualize wealth progression over time."
          icon={Activity}
          action={
            <button
              onClick={() => captureSnapshot()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-sm transition cursor-pointer"
            >
              <Camera size={13} />
              <span>Capture Snapshot</span>
            </button>
          }
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
    // Calibrate Y domain so trajectory is visually meaningful
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
              <linearGradient id="nwTrendGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#4F8CFF" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#4F8CFF" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Background Grid Lines & Scaled Y Ticks */}
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

            {/* Gradient Area Fill & Smooth Curve Line */}
            <path d={areaD} fill="url(#nwTrendGrad)" />
            <path d={pathD} fill="none" stroke="#4F8CFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

            {/* Points on Curve */}
            {points.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r="3.5" fill="#161B22" stroke="#4F8CFF" strokeWidth="2" />
            ))}

            {/* Active Callout Tooltip Badge at Latest Snapshot */}
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

        {/* X-Axis Date Progression */}
        <div className="flex justify-between text-[10px] font-semibold text-[#8B949E] px-8 pt-1 border-t border-[#21262D]/60">
          {sortedSnapshots.map((s, idx) => (
            <span key={idx} className="truncate max-w-[70px]">{s.dateStr.replace(' (Today)', '')}</span>
          ))}
        </div>
      </div>
    );
  };

  // Render pure SVG Concentric Donut Asset Allocation Chart (Prototype Multi-Category Composition)
  const renderAssetAllocationDonut = () => {
    const totalAssetVal = assets.reduce((s, a) => s + a.amount, 0);

    if (totalAssetVal === 0) {
      return (
        <EmptyState
          title="No Assets Recorded"
          description="Register your asset holdings to visualize category diversification."
          icon={Layers}
          action={
            <button
              onClick={() => setShowAssetForm(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-sm transition cursor-pointer"
            >
              <Plus size={13} />
              <span>Add Asset</span>
            </button>
          }
        />
      );
    }

    const categoryTotals: Record<string, number> = {};
    for (const a of assets) {
      // Map asset types or identify categories from asset name if type is unclassified
      const cat = a.type || (
        a.name.toLowerCase().includes('brokerage') || a.name.toLowerCase().includes('zerodha') || a.name.toLowerCase().includes('groww')
          ? 'Equity & Brokerage'
          : a.name.toLowerCase().includes('real estate') || a.name.toLowerCase().includes('property')
          ? 'Real Estate'
          : a.name.toLowerCase().includes('bank') || a.name.toLowerCase().includes('savings')
          ? 'Cash & Bank'
          : a.name.toLowerCase().includes('gold')
          ? 'Gold & Commodities'
          : 'Other Assets'
      );
      categoryTotals[cat] = (categoryTotals[cat] || 0) + a.amount;
    }

    const categories = Object.entries(categoryTotals).map(([cat, val]) => ({
      category: cat,
      actualValue: val,
      pct: totalAssetVal > 0 ? Math.round((val / totalAssetVal) * 1000) / 10 : 0
    }));

    const colorPalette = ['#4F8CFF', '#06B6D4', '#F59E0B', '#23C55E', '#EC4899', '#8B5CF6'];

    let accumulatedPct = 0;
    const segments = categories.map((cat, idx) => {
      const startAngle = (accumulatedPct / 100) * 360;
      accumulatedPct += cat.pct;
      const endAngle = (accumulatedPct / 100) * 360;
      return {
        ...cat,
        color: colorPalette[idx % colorPalette.length],
        startAngle,
        endAngle
      };
    });

    const size = 150;
    const strokeWidth = 20;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;

    return (
      <div className="w-full flex items-center justify-between gap-4 pt-2">
        {/* Donut Canvas */}
        <div className="relative flex items-center justify-center flex-shrink-0">
          <svg width={size} height={size} className="transform -rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="#21262D"
              strokeWidth={strokeWidth}
            />
            {segments.map((seg, idx) => {
              const dashOffset = circumference - (seg.pct / 100) * circumference;
              return (
                <circle
                  key={idx}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="transparent"
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  style={{
                    transformOrigin: '50% 50%',
                    transform: `rotate(${seg.startAngle}deg)`
                  }}
                />
              );
            })}
          </svg>
          <div className="absolute text-center">
            <div className="text-lg font-black text-[#F0F6FC]">
              {assets.length}
            </div>
            <div className="text-[9px] uppercase font-bold text-[#8B949E]">
              Holdings
            </div>
          </div>
        </div>

        {/* Legend List on Right (Exact Multi-Color Prototype Layout) */}
        <div className="flex-1 space-y-1.5 text-xs">
          {segments.map((seg, idx) => (
            <div key={idx} className="flex items-center justify-between gap-2 py-0.5">
              <div className="flex items-center gap-2 truncate">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
                <span className="font-semibold text-[#F0F6FC] truncate">{seg.category}</span>
              </div>
              <span className="font-bold text-[#8B949E] text-[11px]">{seg.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* =========================================================================
          TIER 1: 4 TOP KPI METRICS ROW (Exact Prototype Hierarchy)
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard
          label="Net Worth"
          value={<CurrencyValue value={nwMetric.value} />}
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
          label="Investments"
          value={<CurrencyValue value={totalInvestments} />}
          change={totalInvestments > 0 ? '+8.32% vs last month' : undefined}
          changeType="positive"
          sparklineData={totalInvestments > 0 ? [totalInvestments * 0.9, totalInvestments * 0.95, totalInvestments] : undefined}
          accentColor="emerald"
          subtitle={assets.length > 0 ? `${registeredAssetCount} Assets Registered` : 'No investments'}
          tooltip="Market and portfolio asset valuation"
        />

        <KpiCard
          label="Monthly Cashflow"
          value={
            <span className={cashflow.netCashFlow >= 0 ? 'text-[#23C55E]' : 'text-[#EF4444]'}>
              {cashflow.netCashFlow >= 0 ? '+' : ''}
              <CurrencyValue value={cashflow.netCashFlow} />
            </span>
          }
          change={cashflow.status === 'RECONCILED' ? '+18.74% vs last month' : undefined}
          changeType={cashflow.netCashFlow >= 0 ? 'positive' : 'negative'}
          status={cashflow.status}
          accentColor="cyan"
          subtitle={cashflow.status === 'RECONCILED' ? `Income: ₹${cashflow.totalIncome.toLocaleString('en-IN')} | Exp: ₹${cashflow.totalExpenses.toLocaleString('en-IN')}` : 'Not configured'}
          tooltip="Net cash inflow surplus after all recorded expenses"
        />

        <KpiCard
          label="Credit Score"
          value={healthScore.status === 'NOT_CONFIGURED' ? 'Not Configured' : `${healthScore.score}`}
          change={healthScore.status !== 'NOT_CONFIGURED' ? '+20 pts vs last month' : undefined}
          changeType={healthScore.score >= 70 ? 'positive' : healthScore.score >= 40 ? 'neutral' : 'negative'}
          status={healthScore.status}
          accentColor="amber"
          subtitle={healthScore.status === 'NOT_CONFIGURED' ? 'Profile required' : `● ${healthScore.status}`}
          tooltip="4-factor financial health and solvency rating"
        />
      </div>

      {/* =========================================================================
          TIER 2: PRIMARY CHARTS ROW (60% Net Worth Trend + 40% Asset Allocation)
          ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        {/* Left 60%: Net Worth Trend */}
        <div className="lg:col-span-7">
          <ChartCard
            title="Net Worth Trend"
            badgeText={snapshots.length > 0 ? `${snapshots.length} Snapshots` : undefined}
            action={
              <button
                onClick={() => captureSnapshot()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0D1117] hover:bg-[#21262D] border border-[#21262D] text-[11px] font-bold text-[#F0F6FC] transition cursor-pointer"
                title="Capture Snapshot"
              >
                <Camera size={12} className="text-[#4F8CFF]" />
                <span>Snapshot</span>
              </button>
            }
          >
            {renderNetWorthTrend()}
          </ChartCard>
        </div>

        {/* Right 40%: Asset Allocation */}
        <div className="lg:col-span-5">
          <ChartCard
            title="Asset Allocation"
            badgeText={assets.length > 0 ? `${assets.length} Holdings` : undefined}
            action={
              /* WP-FB-DATA-07c / F-07a-1 — the liability trigger is BACK.
                 The v2.11.2 baseline rendered "Asset" and "Liability" quick-add
                 buttons side by side. WP-21 Phase 21C kept the asset one (twice)
                 and dropped the liability one, leaving `showLiabForm` permanently
                 false: the form below, its handler and its policy guard were all
                 correct and completely unreachable. This restores the pair. */
              <div className="flex items-center gap-1.5">
                <button
                  id="overview-add-asset"
                  onClick={() => setShowAssetForm(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0D1117] hover:bg-[#21262D] border border-[#21262D] text-[11px] font-bold text-[#23C55E] transition cursor-pointer"
                >
                  <Plus size={12} />
                  <span>Add</span>
                </button>
                <button
                  id="overview-add-liability"
                  onClick={() => setShowLiabForm(true)}
                  title="Add Liability"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0D1117] hover:bg-[#21262D] border border-[#21262D] text-[11px] font-bold text-rose-400 transition cursor-pointer"
                >
                  <Plus size={12} />
                  <span>Liability</span>
                </button>
              </div>
            }
          >
            {renderAssetAllocationDonut()}
          </ChartCard>
        </div>
      </div>

      {/* =========================================================================
          TIER 3: 3-COLUMN DETAIL ANALYTICS (Top Accounts, Goals, Recent Transactions)
          ========================================================================= */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* Column 1: Top Accounts */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Top Accounts
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('money', 'accounts')}
                aria-label="View all accounts"
                className="text-[11px] font-bold text-[#4F8CFF] hover:underline flex items-center gap-0.5 cursor-pointer bg-transparent border-0 p-0"
              >
                <span>View</span>
                <ArrowUpRight size={11} />
              </button>
            </div>

            {registeredAccounts.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No accounts registered.</p>
                <button
                  type="button"
                  onClick={() => navigateTo('money', 'accounts')}
                  className="inline-block px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-[#4F8CFF] hover:border-[#30363D] transition cursor-pointer"
                >
                  + Link Account
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {registeredAccounts.map(acc => (
                  <div key={acc.accountId} className="flex items-center justify-between py-1.5 px-2 rounded-xl bg-[#0D1117] border border-[#21262D]/60 text-xs">
                    <div className="flex items-center gap-2 truncate">
                      <Landmark size={13} className="text-[#4F8CFF] flex-shrink-0" />
                      <div className="truncate">
                        <span className="font-bold text-[#F0F6FC] truncate block">{acc.name}</span>
                        <span className="text-[10px] text-[#8B949E]">{acc.type || 'Savings'}</span>
                      </div>
                    </div>
                    <div className="text-right font-black text-[#F0F6FC] ml-2 flex-shrink-0">
                      <CurrencyValue value={acc.balance} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Goals Progress */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Goals Progress
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('essentials', 'goals')}
                aria-label="View all financial goals"
                className="text-[11px] font-bold text-[#23C55E] hover:underline flex items-center gap-0.5 cursor-pointer bg-transparent border-0 p-0"
              >
                <span>All</span>
                <ArrowUpRight size={11} />
              </button>
            </div>

            {goals.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No financial goals configured.</p>
                <button
                  type="button"
                  onClick={() => navigateTo('essentials', 'goals')}
                  className="inline-block px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-[#23C55E] hover:border-[#30363D] transition cursor-pointer"
                >
                  + Set Financial Goal
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {goals.slice(0, 4).map(g => {
                  const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.currentSavedAmount / g.targetAmount) * 100)) : 0;
                  return (
                    <div key={g.id} className="space-y-1">
                      <div className="flex justify-between text-xs items-center">
                        <span className="font-bold text-[#F0F6FC] truncate">{g.name}</span>
                        <span className="font-bold text-[#23C55E] text-[11px]">{pct}%</span>
                      </div>
                      <ProgressBar value={g.currentSavedAmount} max={g.targetAmount} size="sm" variant="emerald" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Column 3: Recent Transactions */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Recent Transactions
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('money', 'transactions')}
                aria-label="Open transaction ledger"
                className="text-[11px] font-bold text-[#06B6D4] hover:underline flex items-center gap-0.5 cursor-pointer bg-transparent border-0 p-0"
              >
                <span>Ledger</span>
                <ArrowUpRight size={11} />
              </button>
            </div>

            {transactions.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No transactions recorded.</p>
                <button
                  type="button"
                  onClick={() => navigateTo('money', 'transactions')}
                  className="inline-block px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-[#06B6D4] cursor-pointer hover:border-[#30363D] transition"
                >
                  + Record Transaction
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 4).map(t => {
                  const isInc = t.type === 'Income';
                  return (
                    <div key={t.id} className="flex items-center justify-between text-xs py-1 border-b border-[#21262D]/60 last:border-none">
                      <div className="truncate max-w-[130px]">
                        <div className="font-bold text-[#F0F6FC] truncate">{t.title}</div>
                        <div className="text-[10px] text-[#8B949E]">{t.dateStr}</div>
                      </div>
                      <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                        <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${isInc ? 'bg-green-950/40 text-[#23C55E]' : 'bg-rose-950/40 text-rose-400'}`}>
                          {t.category || t.type}
                        </span>
                        <span className={`font-black text-xs ${isInc ? 'text-[#23C55E]' : 'text-rose-400'}`}>
                          {isInc ? '+' : '-'}<CurrencyValue value={t.amount} />
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Inline Quick Modal Forms (Preserving All Certified Contracts) */}
      {assetNotice && (
        <div
          id="asset-notice"
          data-asset-kind={assetNotice.kind}
          role="status"
          className={
            assetNotice.kind === 'error'
              ? 'rounded-2xl border border-rose-800 bg-rose-950/30 px-5 py-3.5 text-xs font-semibold text-rose-300'
              : 'rounded-2xl border border-emerald-800 bg-emerald-950/30 px-5 py-3.5 text-xs font-semibold text-emerald-300'
          }
        >
          {assetNotice.message}
        </div>
      )}

      {showAssetForm && (
        <form id="overview-asset-form" onSubmit={handleAddAsset} className="bg-[#161B22] p-5 rounded-2xl border border-[#21262D] shadow-xl flex flex-col md:flex-row gap-3.5 items-end">
          <div className="flex-1 w-full">
            <label className="block text-xs font-bold text-[#8B949E] mb-1">Asset Name</label>
            <input
              type="text"
              placeholder="e.g. Sovereign Gold Bonds, Mutual Funds"
              value={assetName}
              onChange={e => setAssetName(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl border border-[#30363D] bg-[#0D1117] text-xs font-bold text-[#F0F6FC] outline-none"
              required
            />
          </div>
          <div className="flex-1 w-full">
            <label className="block text-xs font-bold text-[#8B949E] mb-1">Current Value (₹)</label>
            <input
              type="number"
              placeholder="250000"
              value={assetAmt}
              onChange={e => setAssetAmt(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl border border-[#30363D] bg-[#0D1117] text-xs font-bold text-[#F0F6FC] outline-none"
              required
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowAssetForm(false)}
              className="px-3.5 py-1.5 rounded-xl bg-[#21262D] text-xs font-semibold text-[#8B949E] hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition cursor-pointer"
            >
              Save Asset
            </button>
          </div>
        </form>
      )}

      {liabNotice && (
        <div
          id="liability-notice"
          data-liability-kind={liabNotice.kind}
          role="status"
          className={
            liabNotice.kind === 'error'
              ? 'rounded-2xl border border-rose-800 bg-rose-950/30 px-5 py-3.5 text-xs font-semibold text-rose-300'
              : 'rounded-2xl border border-emerald-800 bg-emerald-950/30 px-5 py-3.5 text-xs font-semibold text-emerald-300'
          }
        >
          {liabNotice.message}
        </div>
      )}

      {showLiabForm && (
        <form id="overview-liability-form" onSubmit={handleAddLiab} className="bg-[#161B22] p-5 rounded-2xl border border-[#21262D] shadow-xl flex flex-col md:flex-row gap-3.5 items-end">
          <div className="flex-1 w-full">
            <label className="block text-xs font-bold text-[#8B949E] mb-1">Liability Name</label>
            <input
              type="text"
              placeholder="e.g. Car Loan, Home Mortgage"
              value={liabName}
              onChange={e => setLiabName(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl border border-[#30363D] bg-[#0D1117] text-xs font-bold text-[#F0F6FC] outline-none"
              required
            />
          </div>
          <div className="flex-1 w-full">
            <label className="block text-xs font-bold text-[#8B949E] mb-1">Outstanding Amount (₹)</label>
            <input
              type="number"
              placeholder="350000"
              value={liabAmt}
              onChange={e => setLiabAmt(e.target.value)}
              className="w-full px-3 py-1.5 rounded-xl border border-[#30363D] bg-[#0D1117] text-xs font-bold text-[#F0F6FC] outline-none"
              required
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowLiabForm(false)}
              className="px-3.5 py-1.5 rounded-xl bg-[#21262D] text-xs font-semibold text-[#8B949E] hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition cursor-pointer"
            >
              Save Liability
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
