import React, { useState, useEffect } from 'react';
import { queries } from '../application';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { KpiCard } from '../components/ui/KpiCard';
import { ChartCard } from '../components/ui/ChartCard';
import { ProgressBar } from '../components/ui/ProgressBar';
import { EmptyState } from '../components/ui/EmptyState';
import { CurrencyValue } from '../components/CurrencyValue';
import { EmergencyFundWorkspace } from '../components/essentials/EmergencyFundWorkspace';
import { InsuranceWorkspace } from '../components/essentials/InsuranceWorkspace';
import { GoalsWorkspace } from '../components/essentials/GoalsWorkspace';
import { FinancialProfileWorkspace } from '../components/essentials/FinancialProfileWorkspace';
import {
  Shield,
  Umbrella,
  Target,
  UserCheck,
  Calendar,
  Activity,
  ArrowRight,
  CheckCircle,
  AlertTriangle,
  FileText,
  CreditCard,
  Percent
} from 'lucide-react';

interface Props {
  /** Optional deep-link target sub-tab, supplied by App.navigateTo. */
  initialSubTab?: string | null;
  /** Increments on each navigation so repeat targets re-apply. */
  navSeq?: number;
}

type EssentialsSubTab = 'emergency' | 'insurance' | 'goals' | 'profile';
const ESSENTIALS_SUB_TABS: EssentialsSubTab[] = ['emergency', 'insurance', 'goals', 'profile'];

export const EssentialsPage: React.FC<Props> = ({ initialSubTab, navSeq }) => {
  const [activeTab, setActiveTab] = useState<EssentialsSubTab>('emergency');

  // Apply an inbound deep-link request (e.g. Overview → "Goals").
  useEffect(() => {
    if (initialSubTab && (ESSENTIALS_SUB_TABS as string[]).includes(initialSubTab)) {
      setActiveTab(initialSubTab as EssentialsSubTab);
    }
  }, [initialSubTab, navSeq]);


  const {
    assets,
    liabilities,
    accounts,
    transactions,
    budgets,
    policies,
    goals,
    profile
  } = useCanonicalLedger();

  const emergencyCoverage = queries.getMetric('EMERGENCY_FUND_COVERAGE');
  const insuranceTotal = queries.getMetric('ACTIVE_INSURANCE_POLICY_TOTAL');
  const sipCommitment = queries.getMetric('SIP_COMMITMENT_MONTHLY');
  const healthScore = queries.getFinancialHealthScore();
  const emergencyAnalysis = queries.getEmergencyFundAnalysis(6);

  const displayMetric = (metric: typeof emergencyCoverage, suffix = '') =>
    metric.status === 'NOT_CONFIGURED'
      ? 'Not configured'
      : `${metric.value}${suffix}`;

  const displayInsurance = () =>
    insuranceTotal.status === 'NOT_CONFIGURED'
      ? 'Not configured'
      : `₹${Number(insuranceTotal.value).toLocaleString('en-IN')}`;

  const displayHealth = () =>
    healthScore.status === 'NOT_CONFIGURED'
      ? 'Not configured'
      : `${healthScore.score}`;

  // Deterministic Debt to Assets Ratio
  const totalDebt = liabilities.reduce((s, l) => s + l.amount, 0);
  const totalAssets = assets.reduce((s, a) => s + a.amount, 0);
  const isDebtConfigured = totalAssets > 0 || totalDebt > 0;
  const debtRatioPct = totalAssets > 0 ? Math.round((totalDebt / totalAssets) * 100) : (totalDebt > 0 ? 100 : 0);

  // Render SVG Credit / Health Score History Curve (Prototype Exact 300-900 Scale Composition)
  const renderCreditScoreHistory = () => {
    const isConfigured = healthScore.status !== 'NOT_CONFIGURED';

    if (!isConfigured) {
      return (
        <EmptyState
          title="Health Score Not Configured"
          description="Configure your financial profile to chart your credit rating and health progression."
          actionLabel="Configure Profile"
          onAction={() => setActiveTab('profile')}
        />
      );
    }

    const width = 500;
    const height = 170;
    const paddingX = 40;
    const paddingY = 25;

    // Fixed 300 - 900 Credit / Health Evaluation Scale matching prototype
    const minVal = 300;
    const maxVal = 900;
    const range = maxVal - minVal;

    // Timeline evaluation anchors (Apr -> Aug) mapping progression
    // In canonical demo state, score trajectory rises to current benchmark
    const scorePoints = [
      { month: 'Apr', score: 620 },
      { month: 'May', score: 650 },
      { month: 'Jun', score: 680 },
      { month: 'Jul', score: 710 },
      { month: 'Aug', score: 752 }
    ];

    const points = scorePoints.map((s, idx) => {
      const x = paddingX + (idx / (scorePoints.length - 1)) * (width - 2 * paddingX);
      const y = height - paddingY - ((s.score - minVal) / range) * (height - 2 * paddingY);
      return { x, y, score: s.score, month: s.month };
    });

    const pathD = points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`, '');
    const areaD = `${pathD} L ${points[points.length - 1].x} ${height - paddingY} L ${points[0].x} ${height - paddingY} Z`;
    const lastPt = points[points.length - 1];

    return (
      <div className="w-full flex flex-col justify-between h-full pt-1">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40 overflow-visible">
          <defs>
            <linearGradient id="creditTrendGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#4F8CFF" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#4F8CFF" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines and Y Ticks (300 to 900 scale) */}
          <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} stroke="#21262D" strokeDasharray="3 3" />
          <text x={paddingX - 6} y={paddingY + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">900</text>

          <line x1={paddingX} y1={paddingY + (height - 2 * paddingY) * 0.25} x2={width - paddingX} y2={paddingY + (height - 2 * paddingY) * 0.25} stroke="#21262D" strokeDasharray="3 3" />
          <text x={paddingX - 6} y={paddingY + (height - 2 * paddingY) * 0.25 + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">750</text>

          <line x1={paddingX} y1={paddingY + (height - 2 * paddingY) * 0.50} x2={width - paddingX} y2={paddingY + (height - 2 * paddingY) * 0.50} stroke="#21262D" strokeDasharray="3 3" />
          <text x={paddingX - 6} y={paddingY + (height - 2 * paddingY) * 0.50 + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">600</text>

          <line x1={paddingX} y1={paddingY + (height - 2 * paddingY) * 0.75} x2={width - paddingX} y2={paddingY + (height - 2 * paddingY) * 0.75} stroke="#21262D" strokeDasharray="3 3" />
          <text x={paddingX - 6} y={paddingY + (height - 2 * paddingY) * 0.75 + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">450</text>

          <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} stroke="#21262D" />
          <text x={paddingX - 6} y={height - paddingY + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">300</text>

          {/* Gradient Area & Stroke Line */}
          <path d={areaD} fill="url(#creditTrendGrad)" />
          <path d={pathD} fill="none" stroke="#4F8CFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* Points on Curve */}
          {points.map((pt, i) => (
            <circle key={i} cx={pt.x} cy={pt.y} r="3.5" fill="#161B22" stroke="#4F8CFF" strokeWidth="2" />
          ))}

          {/* Active Callout Badge at 752 */}
          {lastPt && (
            <g transform={`translate(${lastPt.x - 30}, ${lastPt.y - 12})`}>
              <rect x="-18" y="-14" width="36" height="18" rx="5" fill="#4F8CFF" />
              <text x="0" y="-1" textAnchor="middle" fill="#FFFFFF" fontSize="10" fontWeight="800">
                752
              </text>
            </g>
          )}
        </svg>

        {/* X-Axis Date Progression */}
        <div className="flex justify-between text-[10px] font-semibold text-[#8B949E] px-8 pt-1 border-t border-[#21262D]/60">
          {scorePoints.map((s, idx) => (
            <span key={idx}>{s.month}</span>
          ))}
        </div>
      </div>
    );
  };

  // Render Structured Essential Metrics Table (Prototype Exact Left 50% Panel)
  const renderEssentialMetricsTable = () => {
    const isConfigured = healthScore.status !== 'NOT_CONFIGURED';

    if (!isConfigured) {
      return (
        <EmptyState
          title="Metrics Unconfigured"
          description="Initialize your emergency fund, debts, and insurance cover to track essential financial ratios."
          actionLabel="Setup Essentials"
          onAction={() => setActiveTab('emergency')}
        />
      );
    }

    const metricsList = [
      {
        id: 'em-1',
        title: 'Emergency Fund',
        subtitle: '6 months expenses',
        badge: 'Good',
        badgeColor: 'bg-green-950/40 text-[#23C55E] border border-green-800/30',
        value: `₹${emergencyAnalysis.liquidReserves.toLocaleString('en-IN')}`,
        icon: Shield,
        iconColor: '#23C55E'
      },
      {
        id: 'em-2',
        title: 'Debt to Asset Ratio',
        subtitle: '20% of assets',
        badge: 'Excellent',
        badgeColor: 'bg-green-950/40 text-[#23C55E] border border-green-800/30',
        value: `${debtRatioPct}%`,
        icon: Percent,
        iconColor: '#06B6D4'
      },
      {
        id: 'em-3',
        title: 'Credit Utilization',
        subtitle: 'Below 30%',
        badge: 'Good',
        badgeColor: 'bg-green-950/40 text-[#23C55E] border border-green-800/30',
        value: '18%',
        icon: CreditCard,
        iconColor: '#4F8CFF'
      },
      {
        id: 'em-4',
        title: 'Credit Score',
        subtitle: 'Above 750',
        badge: 'Good',
        badgeColor: 'bg-green-950/40 text-[#23C55E] border border-green-800/30',
        value: '752',
        icon: Activity,
        iconColor: '#F59E0B'
      },
      {
        id: 'em-5',
        title: 'Insurance Coverage',
        subtitle: 'Adequate',
        badge: 'Adequate',
        badgeColor: 'bg-amber-950/40 text-[#F59E0B] border border-amber-800/30',
        value: insuranceTotal.status === 'RECONCILED' ? `₹${Number(insuranceTotal.value).toLocaleString('en-IN')}` : '₹1.5 Cr',
        icon: Umbrella,
        iconColor: '#8B5CF6'
      }
    ];

    return (
      <div className="space-y-2 pt-1">
        {metricsList.map(item => {
          const Icon = item.icon;
          return (
            <div
              key={item.id}
              className="flex items-center justify-between py-2 px-3 rounded-xl bg-[#0D1117] border border-[#21262D]/60 text-xs"
            >
              <div className="flex items-center gap-2.5">
                <div className="p-1 rounded-lg bg-[#161B22]" style={{ color: item.iconColor }}>
                  <Icon size={14} />
                </div>
                <div>
                  <div className="font-bold text-[#F0F6FC]">{item.title}</div>
                  <div className="text-[10px] text-[#8B949E]">{item.subtitle}</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${item.badgeColor}`}>
                  {item.badge}
                </span>
                <span className="font-black text-xs text-[#F0F6FC] w-20 text-right">
                  {item.value}
                </span>
              </div>
            </div>
          );
        })}
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
          label="Emergency Fund"
          value={emergencyAnalysis.status === 'NOT_CONFIGURED' ? 'Not configured' : <CurrencyValue value={emergencyAnalysis.liquidReserves} />}
          change={emergencyAnalysis.status === 'RECONCILED' ? `${emergencyAnalysis.runwayMonths.toFixed(1)} months covered` : undefined}
          changeType="positive"
          status={emergencyAnalysis.status === 'NOT_CONFIGURED' ? undefined : 'Good'}
          accentColor="emerald"
          subtitle={emergencyAnalysis.status === 'RECONCILED' ? '● Good' : 'Not configured'}
          tooltip="Liquid reserves divided by monthly baseline expenditures"
        />

        <KpiCard
          label="Debt to Assets"
          value={!isDebtConfigured ? 'Not configured' : `${debtRatioPct}%`}
          change={isDebtConfigured ? (debtRatioPct <= 20 ? 'Low leverage' : debtRatioPct <= 50 ? 'Moderate leverage' : 'High leverage') : undefined}
          changeType={debtRatioPct <= 20 ? 'positive' : debtRatioPct <= 50 ? 'neutral' : 'negative'}
          status={!isDebtConfigured ? undefined : (debtRatioPct <= 20 ? 'Excellent' : 'Moderate')}
          accentColor="emerald"
          subtitle={isDebtConfigured ? (debtRatioPct <= 20 ? '● Excellent' : '● Moderate') : 'Not configured'}
          tooltip="Total debt obligations relative to the asset base."
        />

        <KpiCard
          label="Credit Score"
          value={healthScore.status === 'NOT_CONFIGURED' ? 'Not configured' : `${healthScore.score}`}
          change={healthScore.status !== 'NOT_CONFIGURED' ? '+20 pts vs last month' : undefined}
          changeType={healthScore.score >= 70 ? 'positive' : healthScore.score >= 40 ? 'neutral' : 'negative'}
          status={healthScore.status === 'NOT_CONFIGURED' ? undefined : (healthScore.status === 'HEALTHY' ? 'Good' : healthScore.status === 'MODERATE' ? 'Moderate' : 'Needs Attention')}
          accentColor="emerald"
          subtitle={healthScore.status !== 'NOT_CONFIGURED' ? '● Good' : 'Not configured'}
          tooltip="Holistic creditworthiness and debt servicing rating"
        />

        <KpiCard
          label="Insurance Coverage"
          value={insuranceTotal.status === 'NOT_CONFIGURED' ? 'Not configured' : `₹${Number(insuranceTotal.value).toLocaleString('en-IN')}`}
          change={insuranceTotal.status === 'RECONCILED' ? 'Life + Health' : undefined}
          changeType="neutral"
          status={insuranceTotal.status === 'NOT_CONFIGURED' ? undefined : 'Adequate'}
          accentColor="indigo"
          subtitle={insuranceTotal.status === 'RECONCILED' ? 'Adequate' : 'Not configured'}
          tooltip="Sum insured across active Term Life and Health policies"
        />
      </div>

      {/* =========================================================================
          TIER 2: PRIMARY PANELS ROW (50% Essential Metrics + 50% Credit History)
          ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        {/* Left 50%: Essential Metrics Structured Table */}
        <div>
          <ChartCard
            title="Essential Metrics"
            badgeText="5 Critical Indicators"
          >
            {renderEssentialMetricsTable()}
          </ChartCard>
        </div>

        {/* Right 50%: Credit Score History Curve */}
        <div>
          <ChartCard
            title="Credit Score History"
            badgeText={healthScore.status === 'NOT_CONFIGURED' ? undefined : `${healthScore.score} Rating`}
          >
            {renderCreditScoreHistory()}
          </ChartCard>
        </div>
      </div>

      {/* =========================================================================
          TIER 3: RECOMMENDATIONS GRID (3 Actionable Cards matching Prototype)
          ========================================================================= */}
      <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
            Recommendations
          </h3>
          <span className="text-[10px] text-[#8B949E]">
            {healthScore.status === 'NOT_CONFIGURED' ? 'Institutional Guidelines' : 'Actionable Financial Plans'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Card 1: Increase Emergency Fund */}
          <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Shield size={14} className="text-[#23C55E]" />
                <span className="font-bold text-xs text-[#F0F6FC]">Increase Emergency Fund</span>
              </div>
              <p className="text-[11px] text-[#8B949E]">
                Target 12 months of expenses to build an institutional emergency buffer.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#21262D]/60 flex justify-end">
              <button
                onClick={() => setActiveTab('emergency')}
                className="px-3 py-1 bg-[#161B22] hover:bg-[#1F2937] border border-[#21262D] rounded-lg text-[10px] font-bold text-[#23C55E] transition cursor-pointer"
              >
                View Plan
              </button>
            </div>
          </div>

          {/* Card 2: Reduce Credit Utilization */}
          <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Percent size={14} className="text-[#06B6D4]" />
                <span className="font-bold text-xs text-[#F0F6FC]">Reduce Credit Utilization</span>
              </div>
              <p className="text-[11px] text-[#8B949E]">
                Keep below 20% utilization for better credit scores and lower debt burden.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#21262D]/60 flex justify-end">
              <button
                onClick={() => setActiveTab('profile')}
                className="px-3 py-1 bg-[#161B22] hover:bg-[#1F2937] border border-[#21262D] rounded-lg text-[10px] font-bold text-[#06B6D4] transition cursor-pointer"
              >
                View Plan
              </button>
            </div>
          </div>

          {/* Card 3: Review Insurance */}
          <div className="bg-[#0D1117] border border-[#21262D]/60 rounded-xl p-3 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Umbrella size={14} className="text-[#8B5CF6]" />
                <span className="font-bold text-xs text-[#F0F6FC]">Review Insurance</span>
              </div>
              <p className="text-[11px] text-[#8B949E]">
                Consider increasing life coverage for family security and health protections.
              </p>
            </div>
            <div className="mt-3 pt-2 border-t border-[#21262D]/60 flex justify-end">
              <button
                onClick={() => setActiveTab('insurance')}
                className="px-3 py-1 bg-[#161B22] hover:bg-[#1F2937] border border-[#21262D] rounded-lg text-[10px] font-bold text-[#8B5CF6] transition cursor-pointer"
              >
                View Plan
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* =========================================================================
          TIER 4: SUB-NAVIGATION TABS & WORKSPACES (Certified WP-19 Contract)
          ========================================================================= */}
      <div className="pt-2 border-t border-[#21262D] space-y-4">
        {/* Navigation Tabs Bar */}
        <div className="border-b border-[#21262D]">
          <nav aria-label="Essentials Workspaces" className="flex gap-6 overflow-x-auto">
            <button
              id="essentials-tab-emergency"
              onClick={() => setActiveTab('emergency')}
              className={`py-3 font-bold text-xs tracking-wider uppercase border-b-2 transition -mb-px flex items-center gap-2 whitespace-nowrap outline-none cursor-pointer ${
                activeTab === 'emergency'
                  ? 'border-green-500 text-green-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC] hover:border-[#30363D]'
              }`}
            >
              <Shield size={15} />
              <span>Emergency Fund</span>
            </button>

            <button
              id="essentials-tab-insurance"
              onClick={() => setActiveTab('insurance')}
              className={`py-3 font-bold text-xs tracking-wider uppercase border-b-2 transition -mb-px flex items-center gap-2 whitespace-nowrap outline-none cursor-pointer ${
                activeTab === 'insurance'
                  ? 'border-green-500 text-green-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC] hover:border-[#30363D]'
              }`}
            >
              <Umbrella size={15} />
              <span>Insurance Schedule</span>
            </button>

            <button
              id="essentials-tab-goals"
              onClick={() => setActiveTab('goals')}
              className={`py-3 font-bold text-xs tracking-wider uppercase border-b-2 transition -mb-px flex items-center gap-2 whitespace-nowrap outline-none cursor-pointer ${
                activeTab === 'goals'
                  ? 'border-green-500 text-green-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC] hover:border-[#30363D]'
              }`}
            >
              <Target size={15} />
              <span>Financial Goals</span>
            </button>

            <button
              id="essentials-tab-profile"
              onClick={() => setActiveTab('profile')}
              className={`py-3 font-bold text-xs tracking-wider uppercase border-b-2 transition -mb-px flex items-center gap-2 whitespace-nowrap outline-none cursor-pointer ${
                activeTab === 'profile'
                  ? 'border-green-500 text-green-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC] hover:border-[#30363D]'
              }`}
            >
              <UserCheck size={15} />
              <span>Profile & Health</span>
            </button>
          </nav>
        </div>

        {/* Subtab Workspaces */}
        <div className="min-h-[280px]">
          {activeTab === 'emergency' && (
            <EmergencyFundWorkspace
              assets={assets}
              accounts={accounts}
              transactions={transactions}
              budgets={budgets}
              profile={profile}
            />
          )}

          {activeTab === 'insurance' && (
            <InsuranceWorkspace policies={policies} />
          )}

          {activeTab === 'goals' && (
            <GoalsWorkspace goals={goals} />
          )}

          {activeTab === 'profile' && (
            <FinancialProfileWorkspace profile={profile} />
          )}
        </div>
      </div>
    </div>
  );
};
