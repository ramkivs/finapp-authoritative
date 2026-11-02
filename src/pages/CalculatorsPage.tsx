import React, { useState, useRef } from 'react';
import { queries } from '../application';
import { CurrencyValue } from '../components/CurrencyValue';
import { KpiCard } from '../components/ui/KpiCard';
import { SipCalculator } from '../components/calculators/SipCalculator';
import { LumpsumCalculator } from '../components/calculators/LumpsumCalculator';
import { XirrCalculator } from '../components/calculators/XirrCalculator';
import { CagrCalculator } from '../components/calculators/CagrCalculator';
import { LoanEmiCalculator } from '../components/calculators/LoanEmiCalculator';
import { RecurringDepositModal } from '../components/calculators/RecurringDepositModal';
import { PpfCalculatorModal } from '../components/calculators/PpfCalculatorModal';
import { SwpCalculatorModal } from '../components/calculators/SwpCalculatorModal';
import { GoalReverseSipModal } from '../components/calculators/GoalReverseSipModal';
import { RetirementFireModal } from '../components/calculators/RetirementFireModal';
import { InflationCalculatorModal } from '../components/essentials/InflationCalculatorModal';
import {
  TrendingUp,
  Landmark,
  Calculator,
  Percent,
  CreditCard,
  Activity,
  Clock,
  Layers,
  ChevronRight,
  ShieldCheck,
  Flame,
  Target,
  Coins,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';

export const CalculatorsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'sip' | 'lumpsum' | 'xirr' | 'cagr' | 'loan'>('sip');
  const [isInflationOpen, setIsInflationOpen] = useState(false);
  const [isRdOpen, setIsRdOpen] = useState(false);
  const [isPpfOpen, setIsPpfOpen] = useState(false);
  const [isSwpOpen, setIsSwpOpen] = useState(false);
  const [isGoalOpen, setIsGoalOpen] = useState(false);
  const [isRetirementOpen, setIsRetirementOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const roadmapRef = useRef<HTMLDivElement>(null);

  const yieldMetric = queries.getMetric('DIVIDEND_YIELD_TTM');
  const cagrMetric = queries.getMetric('NET_WORTH_CAGR');
  const goalMetric = queries.getMetric('EMERGENCY_FUND_GOAL');

  const scrollToWorkspace = (tab: 'sip' | 'lumpsum' | 'xirr' | 'cagr' | 'loan') => {
    setActiveTab(tab);
    if (workspaceRef.current) {
      workspaceRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const popularCalculators = [
    {
      id: 'pop-sip',
      name: 'SIP Calculator',
      subtitle: 'Calculate SIP returns',
      icon: TrendingUp,
      color: '#4F8CFF',
      bgColor: 'bg-blue-950/40',
      borderColor: 'border-blue-800/30',
      action: () => scrollToWorkspace('sip'),
      badge: 'Live'
    },
    {
      id: 'pop-emi',
      name: 'EMI Calculator',
      subtitle: 'Calculate loan EMI',
      icon: CreditCard,
      color: '#A855F7',
      bgColor: 'bg-purple-950/40',
      borderColor: 'border-purple-800/30',
      action: () => scrollToWorkspace('loan'),
      badge: 'Live'
    },
    {
      id: 'pop-rd',
      name: 'RD Calculator',
      subtitle: 'Calculate RD maturity',
      icon: Coins,
      color: '#F59E0B',
      bgColor: 'bg-amber-950/40',
      borderColor: 'border-amber-800/30',
      action: () => setIsRdOpen(true),
      badge: 'Live'
    },
    {
      id: 'pop-ppf',
      name: 'PPF Calculator',
      subtitle: 'Calculate PPF returns',
      icon: ShieldCheck,
      color: '#23C55E',
      bgColor: 'bg-green-950/40',
      borderColor: 'border-green-800/30',
      action: () => setIsPpfOpen(true),
      badge: 'Live'
    },
    {
      id: 'pop-retire',
      name: 'Retirement Calculator',
      subtitle: 'Plan your retirement',
      icon: Flame,
      color: '#EF4444',
      bgColor: 'bg-rose-950/40',
      borderColor: 'border-rose-800/30',
      action: () => setIsRetirementOpen(true),
      badge: 'Live'
    },
    {
      id: 'pop-goal',
      name: 'Goal Calculator',
      subtitle: 'Plan your goals',
      icon: Target,
      color: '#06B6D4',
      bgColor: 'bg-cyan-950/40',
      borderColor: 'border-cyan-800/30',
      action: () => setIsGoalOpen(true),
      badge: 'Live'
    }
  ];

  const allCalculatorsList = [
    {
      id: 'all-sip',
      name: 'SIP Calculator',
      desc: 'Systematic Investment Plan with annual step-up compounding',
      action: () => scrollToWorkspace('sip'),
      type: 'Live Engine'
    },
    {
      id: 'all-lump',
      name: 'Lumpsum Calculator',
      desc: 'One-time wealth compounding with inflation purchasing power adjustment',
      action: () => scrollToWorkspace('lumpsum'),
      type: 'Live Engine'
    },
    {
      id: 'all-swp',
      name: 'SWP Calculator',
      desc: 'Systematic Withdrawal Plan for passive annuity cash flows',
      action: () => setIsSwpOpen(true),
      type: 'Live Engine'
    },
    {
      id: 'all-emi',
      name: 'EMI Calculator',
      desc: 'Monthly loan EMI amortization schedule & interest breakdown',
      action: () => scrollToWorkspace('loan'),
      type: 'Live Engine'
    },
    {
      id: 'all-rd',
      name: 'RD Calculator',
      desc: 'Recurring Deposit quarterly compounding calculator',
      action: () => setIsRdOpen(true),
      type: 'Live Engine'
    },
    {
      id: 'all-ppf',
      name: 'PPF Calculator',
      desc: 'Public Provident Fund 15-year statutory interest & tax exemption',
      action: () => setIsPpfOpen(true),
      type: 'Live Engine'
    },
    {
      id: 'all-inflation',
      name: 'Inflation Calculator',
      desc: 'Future value standard of living calculator under inflation',
      action: () => setIsInflationOpen(true),
      type: 'Interactive Tool'
    },
    {
      id: 'all-retirement',
      name: 'Retirement Calculator',
      desc: 'Corpus requirement and FIRE target runway estimator',
      action: () => setIsRetirementOpen(true),
      type: 'Live Engine'
    },
    {
      id: 'all-goal',
      name: 'Goal & Reverse SIP Calculator',
      desc: 'Exact target milestone solver with step-up and existing portfolio growth',
      action: () => setIsGoalOpen(true),
      type: 'Live Engine'
    }
  ];

  return (
    <div className="space-y-6">
      {/* =========================================================================
          TIER 1: POPULAR CALCULATORS (Exact Prototype Hierarchy: 6 Quick-Access Cards)
          ========================================================================= */}
      <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
            Popular Calculators
          </h3>
          <span className="text-[10px] text-[#8B949E]">Institutional Compounding Models</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {popularCalculators.map(calc => {
            const Icon = calc.icon;
            return (
              <button
                key={calc.id}
                onClick={calc.action}
                className="bg-[#0D1117] hover:bg-[#161B22] border border-[#21262D]/60 hover:border-[#30363D] rounded-xl p-3.5 flex items-center justify-between transition group text-left cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center border ${calc.bgColor} ${calc.borderColor}`}
                    style={{ color: calc.color }}
                  >
                    <Icon size={20} />
                  </div>
                  <div>
                    <div className="font-bold text-xs text-[#F0F6FC] group-hover:text-[#4F8CFF] transition">
                      {calc.name}
                    </div>
                    <div className="text-[10px] text-[#8B949E]">{calc.subtitle}</div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-[9px] font-black uppercase px-2 py-0.5 rounded ${
                      calc.badge === 'Live'
                        ? 'bg-emerald-950/40 text-[#23C55E] border border-emerald-800/30'
                        : 'bg-[#21262D] text-[#8B949E]'
                    }`}
                  >
                    {calc.badge}
                  </span>
                  <ArrowUpRight size={14} className="text-[#8B949E] group-hover:text-[#F0F6FC] transition" />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* =========================================================================
          TIER 2: ALL CALCULATORS DIRECTORY (Exact Prototype Hierarchy: Structured List)
          ========================================================================= */}
      <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-5 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
            All Calculators
          </h3>
          <span className="text-[10px] text-[#8B949E]">8 Comprehensive Mathematical Tools</span>
        </div>

        <div className="divide-y divide-[#21262D]/60 rounded-xl border border-[#21262D]/60 bg-[#0D1117] overflow-hidden">
          {allCalculatorsList.map(item => (
            <button
              key={item.id}
              onClick={item.action}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#161B22] transition group text-left cursor-pointer"
            >
              <div className="pr-4">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs text-[#F0F6FC] group-hover:text-[#4F8CFF] transition">
                    {item.name}
                  </span>
                  <span
                    className={`text-[9px] font-bold px-1.5 py-0.2 rounded ${
                      item.type === 'Live Engine'
                        ? 'text-[#23C55E] bg-green-950/30'
                        : item.type === 'Interactive Tool'
                        ? 'text-[#06B6D4] bg-cyan-950/30'
                        : 'text-[#8B949E] bg-[#21262D]'
                    }`}
                  >
                    {item.type}
                  </span>
                </div>
                <div className="text-[11px] text-[#8B949E] line-clamp-1 mt-0.5">{item.desc}</div>
              </div>

              <ChevronRight
                size={16}
                className="text-[#6E7681] group-hover:text-[#F0F6FC] group-hover:translate-x-0.5 transition shrink-0"
              />
            </button>
          ))}
        </div>
      </div>

      {/* =========================================================================
          TIER 3: ACTIVE MATHEMATICAL WORKSPACE CONTAINER & SUBTABS (Certified WP-20)
          ========================================================================= */}
      <div ref={workspaceRef} className="pt-2 border-t border-[#21262D] space-y-4">
        {/* Workspace Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base md:text-lg font-extrabold text-[#F0F6FC] tracking-tight">
              Interactive Mathematical Workspace
            </h2>
            <p className="text-xs text-[#8B949E] mt-0.5">
              Certified numerical solvers for compounding, internal rate of return, and amortization.
            </p>
          </div>
        </div>

        {/* Subtab Navigation Bar */}
        <div className="border-b border-[#21262D]">
          <nav aria-label="Calculators Workspace Navigation" className="flex gap-2 overflow-x-auto">
            <button
              id="calc-tab-sip"
              onClick={() => setActiveTab('sip')}
              className={`flex items-center gap-2 px-4 py-2.5 font-bold text-xs border-b-2 transition whitespace-nowrap cursor-pointer ${
                activeTab === 'sip'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC]'
              }`}
            >
              <TrendingUp size={15} />
              <span>SIP & Step-Up</span>
            </button>

            <button
              id="calc-tab-lumpsum"
              onClick={() => setActiveTab('lumpsum')}
              className={`flex items-center gap-2 px-4 py-2.5 font-bold text-xs border-b-2 transition whitespace-nowrap cursor-pointer ${
                activeTab === 'lumpsum'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC]'
              }`}
            >
              <Landmark size={15} />
              <span>Lumpsum Growth</span>
            </button>

            <button
              id="calc-tab-xirr"
              onClick={() => setActiveTab('xirr')}
              className={`flex items-center gap-2 px-4 py-2.5 font-bold text-xs border-b-2 transition whitespace-nowrap cursor-pointer ${
                activeTab === 'xirr'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC]'
              }`}
            >
              <Calculator size={15} />
              <span>XIRR Solver</span>
            </button>

            <button
              id="calc-tab-cagr"
              onClick={() => setActiveTab('cagr')}
              className={`flex items-center gap-2 px-4 py-2.5 font-bold text-xs border-b-2 transition whitespace-nowrap cursor-pointer ${
                activeTab === 'cagr'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC]'
              }`}
            >
              <Percent size={15} />
              <span>CAGR Engine</span>
            </button>

            <button
              id="calc-tab-loan"
              onClick={() => setActiveTab('loan')}
              className={`flex items-center gap-2 px-4 py-2.5 font-bold text-xs border-b-2 transition whitespace-nowrap cursor-pointer ${
                activeTab === 'loan'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC]'
              }`}
            >
              <CreditCard size={15} />
              <span>Loan EMI & Schedule</span>
            </button>
          </nav>
        </div>

        {/* Active Calculator Workspace Component */}
        <div className="min-h-[400px]">
          {activeTab === 'sip' && <SipCalculator />}
          {activeTab === 'lumpsum' && <LumpsumCalculator />}
          {activeTab === 'xirr' && <XirrCalculator />}
          {activeTab === 'cagr' && <CagrCalculator />}
          {activeTab === 'loan' && <LoanEmiCalculator />}
        </div>
      </div>

      {/* Certified Mathematical Intelligence Engines Grid (Live Interactive) */}
      <div
        ref={roadmapRef}
        className="bg-[#161B22] border border-[#21262D] rounded-2xl p-5 space-y-3 shadow-sm"
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-emerald-500" />
            <h3 className="text-xs font-bold text-[#F0F6FC] uppercase tracking-wider">
              Certified Mathematical Intelligence Engines
            </h3>
          </div>
          <span className="text-[11px] text-[#8B949E] font-semibold flex items-center gap-1">
            <ShieldCheck size={12} className="text-[#23C55E]" /> RFC 8785 Canonical Engines
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { id: 'btn-open-rd-engine', name: 'Recurring Deposit (RD)', tag: 'Live Engine', desc: 'Quarterly compounding annuity', action: () => setIsRdOpen(true), color: '#F59E0B' },
            { id: 'btn-open-ppf-engine', name: 'Public Provident Fund', tag: 'Live Engine', desc: 'PPF Scheme 2019 statutory model', action: () => setIsPpfOpen(true), color: '#A855F7' },
            { id: 'btn-open-swp-engine', name: 'Systematic Withdrawal', tag: 'Live Engine', desc: 'Cash flow depletion solver', action: () => setIsSwpOpen(true), color: '#06B6D4' },
            { id: 'btn-open-fire-engine', name: 'Retirement & FIRE', tag: 'Live Engine', desc: 'Corpus & annuity-due solver', action: () => setIsRetirementOpen(true), color: '#F97316' },
            { id: 'btn-open-goal-engine', name: 'Goal Planner / Reverse SIP', tag: 'Live Engine', desc: 'Target corpus root-finder', action: () => setIsGoalOpen(true), color: '#EC4899' }
          ].map((calc) => (
            <button
              key={calc.id}
              id={calc.id}
              onClick={calc.action}
              className="p-3 bg-[#0D1117] hover:bg-[#161B22] border border-[#21262D]/60 hover:border-[#30363D] rounded-xl space-y-1.5 text-left transition group cursor-pointer"
            >
              <div className="flex justify-between items-start gap-1">
                <span className="text-xs font-bold text-[#F0F6FC] group-hover:text-[#4F8CFF] transition line-clamp-1">
                  {calc.name}
                </span>
                <ArrowUpRight size={12} className="text-[#8B949E] group-hover:text-[#F0F6FC] transition shrink-0" />
              </div>
              <p className="text-[10px] text-[#8B949E] leading-tight">{calc.desc}</p>
              <span className="inline-block px-2 py-0.5 rounded bg-emerald-950/40 border border-emerald-800/30 text-[#23C55E] text-[9px] font-bold">
                {calc.tag}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* =========================================================================
          TIER 4: CANONICAL LIVE LEDGER DERIVED METRICS (Live Queries)
          ========================================================================= */}
      <div className="pt-4 border-t border-[#21262D] space-y-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-emerald-500" />
          <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
            Canonical Derived Metrics (Live Ledger Synchronization)
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          <KpiCard
            label="Dividend Yield (TTM)"
            value={yieldMetric.status === 'NOT_CONFIGURED' ? 'Not configured' : `${yieldMetric.value}%`}
            change={yieldMetric.status === 'RECONCILED' ? 'TTM Yield on Capital' : undefined}
            changeType="neutral"
            status={yieldMetric.status}
            accentColor="emerald"
            tooltip="Trailing 12-month dividend yield calculated from canonical income ledger"
          />

          <KpiCard
            label="Net Worth CAGR"
            value={
              cagrMetric.status === 'NOT_CONFIGURED'
                ? 'Not configured'
                : `${Number(cagrMetric.value) >= 0 ? '+' : ''}${cagrMetric.value}%`
            }
            change={cagrMetric.status === 'RECONCILED' ? 'Compound Annual Growth' : undefined}
            changeType={Number(cagrMetric.value) >= 0 ? 'positive' : 'negative'}
            status={cagrMetric.status}
            accentColor="cyan"
            tooltip="Annualized compound growth rate across persistent net worth snapshots"
          />

          <KpiCard
            label="Emergency Fund Goal"
            value={goalMetric.status === 'NOT_CONFIGURED' ? 'Not configured' : <CurrencyValue value={Number(goalMetric.value)} />}
            change={goalMetric.status === 'RECONCILED' ? '6 Months Essential EMIs' : undefined}
            changeType="neutral"
            status={goalMetric.status}
            accentColor="amber"
            tooltip="Baseline 6-month essential living and debt commitment reserves"
          />
        </div>
      </div>

      {/* Interactive Modals */}
      <RecurringDepositModal
        isOpen={isRdOpen}
        onClose={() => setIsRdOpen(false)}
      />
      <PpfCalculatorModal
        isOpen={isPpfOpen}
        onClose={() => setIsPpfOpen(false)}
      />
      <SwpCalculatorModal
        isOpen={isSwpOpen}
        onClose={() => setIsSwpOpen(false)}
      />
      <GoalReverseSipModal
        isOpen={isGoalOpen}
        onClose={() => setIsGoalOpen(false)}
      />
      <RetirementFireModal
        isOpen={isRetirementOpen}
        onClose={() => setIsRetirementOpen(false)}
      />
      <InflationCalculatorModal
        isOpen={isInflationOpen}
        onClose={() => setIsInflationOpen(false)}
      />
    </div>
  );
};
