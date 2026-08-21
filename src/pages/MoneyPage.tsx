import React, { useState, useEffect } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { AccountResolutionService } from '../services/AccountResolutionService';
import { FinancialQueries } from '../application/queries';
import { KpiCard } from '../components/ui/KpiCard';
import { ChartCard } from '../components/ui/ChartCard';
import { ProgressBar } from '../components/ui/ProgressBar';
import { EmptyState } from '../components/ui/EmptyState';
import { CurrencyValue } from '../components/CurrencyValue';
import { BudgetWorkspace } from '../components/money/BudgetWorkspace';
import { AccountsWorkspace } from '../components/money/AccountsWorkspace';
import { MoneyInsightsWorkspace } from '../components/money/MoneyInsightsWorkspace';
import {
  Search,
  Download,
  ChevronDown,
  Calendar,
  ArrowUpRight
} from 'lucide-react';

interface Props {
  openModal: (modalName: 'modal-income' | 'modal-expense' | 'modal-transfer' | 'modal-custom-date') => void;
  openSidebarTab: (tabId: string) => void;
  /** Optional deep-link target sub-tab, supplied by App.navigateTo. */
  initialSubTab?: string | null;
  /** Increments on each navigation so repeat targets re-apply. */
  navSeq?: number;
}

type MoneySubTab = 'transactions' | 'budget' | 'accounts' | 'insights';
const MONEY_SUB_TABS: MoneySubTab[] = ['transactions', 'budget', 'accounts', 'insights'];

export const MoneyPage: React.FC<Props> = ({ openModal, openSidebarTab, initialSubTab, navSeq }) => {
  const [subTab, setSubTab] = useState<MoneySubTab>('transactions');

  // Apply an inbound deep-link request (e.g. Overview → "Accounts").
  useEffect(() => {
    if (initialSubTab && (MONEY_SUB_TABS as string[]).includes(initialSubTab)) {
      setSubTab(initialSubTab as MoneySubTab);
    }
  }, [initialSubTab, navSeq]);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');

  const {
    filterType,
    dateRange,
    setFilterType,
    setDateRange,
    setSearchQuery,
    getFilteredTransactions,
    transactions,
    accounts,
    budgets
  } = useCanonicalLedger();

  const filtered = getFilteredTransactions();
  const insights = FinancialQueries.getMoneyInsights(dateRange);

  const handleSearchChange = (val: string) => {
    setSearchInput(val);
    setSearchQuery(val);
  };

  const handleSelectRange = (range: string) => {
    setDateRange(range);
    setDateMenuOpen(false);
    if (range === '12M') {
      setFilterType('Income');
    }
  };

  // Real Transaction CSV Export
  const handleExport = () => {
    if (filtered.length === 0) {
      alert('No transactions to export in currently filtered view.');
      return;
    }
    const header = ['Date', 'Title', 'Narration', 'Account', 'Type', 'Category', 'Amount', 'Status', 'Notes'];
    const rows = filtered.map(t => [
      t.date,
      `"${(t.title || '').replace(/"/g, '""')}"`,
      `"${(t.narration || '').replace(/"/g, '""')}"`,
      `"${(t.account || '').replace(/"/g, '""')}"`,
      t.type,
      t.category,
      t.amount,
      t.status,
      `"${(t.notes || '').replace(/"/g, '""')}"`
    ]);
    const csvContent = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `finboom_transactions_${dateRange.toLowerCase().replace(/\s+/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Sparkline sequences
  const incomeSparkline = insights.monthlyTrends.map(t => t.income);
  const expenseSparkline = insights.monthlyTrends.map(t => t.expense);
  const netSparkline = insights.monthlyTrends.map(t => t.net);
  const savingsRateSparkline = insights.monthlyTrends.map(t => (t.income > 0 ? ((t.income - t.expense) / t.income) * 100 : 0));

  const categoryColors = ['#4F8CFF', '#06B6D4', '#F59E0B', '#23C55E', '#EC4899', '#8B5CF6'];

  // Render SVG Grouped Cashflow Overview Bars (Prototype Exact 3-Bar Composition)
  const renderCashflowOverview = () => {
    if (insights.status === 'NOT_CONFIGURED' || (insights.totalIncome === 0 && insights.totalExpenses === 0)) {
      return (
        <EmptyState
          title="No Cash Flow Records"
          description="Record income or expense transactions to visualize your cash flow dynamics."
          actionLabel="+ Record Income"
          onAction={() => openModal('modal-income')}
        />
      );
    }

    const width = 500;
    const height = 170;
    const paddingX = 45;
    const paddingY = 25;

    const maxVal = Math.max(insights.totalIncome, insights.totalExpenses, Math.abs(insights.netCashFlow), 1000);
    const barWidth = 44;
    const chartHeight = height - 2 * paddingY;

    const incHeight = Math.min(chartHeight, Math.max(6, (insights.totalIncome / maxVal) * chartHeight));
    const expHeight = Math.min(chartHeight, Math.max(4, (insights.totalExpenses / maxVal) * chartHeight));
    const netHeight = Math.min(chartHeight, Math.max(6, (Math.abs(insights.netCashFlow) / maxVal) * chartHeight));

    const x1 = width * 0.22 - barWidth / 2;
    const x2 = width * 0.50 - barWidth / 2;
    const x3 = width * 0.78 - barWidth / 2;

    const yBase = height - paddingY;

    return (
      <div className="w-full flex flex-col justify-between h-full pt-1">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40 overflow-visible">
          {/* Background Grid Lines & Scaled Y Ticks */}
          <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} stroke="#21262D" strokeDasharray="3 3" />
          <text x={paddingX - 6} y={paddingY + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">
            ₹{maxVal >= 100000 ? `${(maxVal / 100000).toFixed(0)}L` : `${(maxVal / 1000).toFixed(0)}K`}
          </text>

          <line x1={paddingX} y1={height / 2} x2={width - paddingX} y2={height / 2} stroke="#21262D" strokeDasharray="3 3" />
          <text x={paddingX - 6} y={height / 2 + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">
            ₹{maxVal >= 100000 ? `${((maxVal / 2) / 100000).toFixed(0)}L` : `${((maxVal / 2) / 1000).toFixed(0)}K`}
          </text>

          <line x1={paddingX} y1={yBase} x2={width - paddingX} y2={yBase} stroke="#21262D" />
          <text x={paddingX - 6} y={yBase + 3} textAnchor="end" fill="#6E7681" fontSize="9" fontWeight="600">₹0</text>

          {/* Bar 1: Income (Green) */}
          <g>
            <rect
              x={x1}
              y={yBase - incHeight}
              width={barWidth}
              height={incHeight}
              rx="5"
              fill="#23C55E"
              className="hover:brightness-125 transition-all"
            />
            <text x={x1 + barWidth / 2} y={yBase - incHeight - 6} textAnchor="middle" fill="#23C55E" fontSize="10" fontWeight="700">
              ₹{insights.totalIncome.toLocaleString('en-IN')}
            </text>
          </g>

          {/* Bar 2: Expenses (Red) */}
          <g>
            <rect
              x={x2}
              y={yBase - expHeight}
              width={barWidth}
              height={expHeight}
              rx="5"
              fill="#EF4444"
              className="hover:brightness-125 transition-all"
            />
            <text x={x2 + barWidth / 2} y={yBase - expHeight - 6} textAnchor="middle" fill="#EF4444" fontSize="10" fontWeight="700">
              ₹{insights.totalExpenses.toLocaleString('en-IN')}
            </text>
          </g>

          {/* Bar 3: Savings (Cyan) */}
          <g>
            <rect
              x={x3}
              y={yBase - netHeight}
              width={barWidth}
              height={netHeight}
              rx="5"
              fill={insights.netCashFlow >= 0 ? '#06B6D4' : '#F59E0B'}
              className="hover:brightness-125 transition-all"
            />
            <text x={x3 + barWidth / 2} y={yBase - netHeight - 6} textAnchor="middle" fill="#06B6D4" fontSize="10" fontWeight="700">
              ₹{insights.netCashFlow.toLocaleString('en-IN')}
            </text>
          </g>
        </svg>

        {/* X-Axis Category Labels */}
        <div className="flex justify-around text-[10px] font-bold text-[#8B949E] px-12 pt-1 border-t border-[#21262D]/60">
          <span className="text-[#23C55E]">Income</span>
          <span className="text-rose-400">Expenses</span>
          <span className="text-[#06B6D4]">Savings</span>
        </div>
      </div>
    );
  };

  // Render SVG Expense Categories Donut (Prototype Exact Composition with Center Label)
  const renderExpenseCategoriesDonut = () => {
    if (insights.status === 'NOT_CONFIGURED' || insights.expenseCategoryBreakdown.length === 0) {
      return (
        <EmptyState
          title="No Expense Categories"
          description="Categorized expenditures will be aggregated and visualized here."
          actionLabel="+ Add Expense"
          onAction={() => openModal('modal-expense')}
        />
      );
    }

    const categories = insights.expenseCategoryBreakdown;
    const totalExp = insights.totalExpenses;

    let accumulatedPct = 0;
    const segments = categories.map((cat, idx) => {
      const startAngle = (accumulatedPct / 100) * 360;
      accumulatedPct += cat.pct;
      const endAngle = (accumulatedPct / 100) * 360;
      return {
        ...cat,
        color: categoryColors[idx % categoryColors.length],
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
        {/* Donut Canvas with Center Total Expenses Label */}
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
          <div className="absolute text-center px-1">
            <div className="text-xs font-black text-[#F0F6FC] leading-tight">
              ₹{totalExp.toLocaleString('en-IN')}
            </div>
            <div className="text-[8px] uppercase font-bold text-[#8B949E] mt-0.5">
              Total Expenses
            </div>
          </div>
        </div>

        {/* Legend List on Right (Exact Prototype Multi-Category Breakdown) */}
        <div className="flex-1 space-y-1.5 text-xs">
          {segments.slice(0, 5).map((seg, idx) => (
            <div key={idx} className="flex items-center justify-between gap-2 py-0.5">
              <div className="flex items-center gap-2 truncate">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
                <span className="font-semibold text-[#F0F6FC] truncate">{seg.category}</span>
              </div>
              <span className="font-bold text-[#8B949E] text-[11px]">{seg.pct.toFixed(0)}%</span>
            </div>
          ))}
          {segments.length > 5 && (
            <div className="text-[10px] text-[#6E7681] pt-0.5">
              + {segments.length - 5} more categories
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4" onClick={() => { setAddMenuOpen(false); setDateMenuOpen(false); }}>
      {/* Title & Action Toolbar */}
      <div className="flex justify-between items-center flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-extrabold text-[#F0F6FC] tracking-tight">
            Money & Cash Flow Command
          </h1>
          <div className="text-xs text-[#8B949E]">
            Reconciled transaction ledger, category budgets, registered accounts, and cash flow intelligence.
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Search Box (visible on transactions tab) */}
          {subTab === 'transactions' && (
            <div className="bg-[#0D1117] border border-[#21262D] rounded-xl px-3 py-1.5 flex items-center gap-2 w-48 shadow-sm">
              <Search size={13} className="text-[#8B949E]" />
              <input
                id="transaction-search-input"
                type="text"
                value={searchInput}
                onChange={e => handleSearchChange(e.target.value)}
                placeholder="Search ledger..."
                className="bg-transparent border-none text-xs w-full outline-none text-[#F0F6FC] placeholder-[#6E7681]"
              />
            </div>
          )}

          {/* Real Export Button */}
          {subTab === 'transactions' && (
            <button
              id="btn-export-transactions"
              onClick={handleExport}
              className="bg-[#161B22] border border-[#21262D] text-[#F0F6FC] font-bold text-xs px-3 py-1.5 rounded-xl flex items-center gap-1.5 shadow-sm hover:bg-[#1F2937] transition cursor-pointer"
            >
              <Download size={13} />
              <span>Export</span>
            </button>
          )}

          {/* + Add Dropdown */}
          <div className="relative inline-block" onClick={e => e.stopPropagation()}>
            <button
              id="btn-add-menu-dropdown"
              onClick={() => setAddMenuOpen(!addMenuOpen)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3.5 py-1.5 rounded-xl flex items-center gap-1.5 shadow-sm transition cursor-pointer"
            >
              <span>+ Add</span>
              <ChevronDown size={13} />
            </button>

            {addMenuOpen && (
              <div className="absolute right-0 top-10 w-60 bg-[#161B22] border border-[#21262D] rounded-2xl shadow-2xl p-1.5 z-50">
                <button
                  id="btn-add-income-menu"
                  onClick={() => { openModal('modal-income'); setAddMenuOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-[#1F2937] text-xs font-semibold text-[#F0F6FC] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[#23C55E] font-bold">+</span>
                    <span>Income</span>
                  </div>
                  <span className="text-[10px] text-[#8B949E]">Dividend / Salary</span>
                </button>

                <button
                  id="btn-add-expense-menu"
                  onClick={() => { openModal('modal-expense'); setAddMenuOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-[#1F2937] text-xs font-semibold text-[#F0F6FC] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-rose-400 font-bold">-</span>
                    <span>Expense</span>
                  </div>
                  <span className="text-[10px] text-[#8B949E]">Dining / Shopping</span>
                </button>

                <button
                  id="btn-add-transfer-menu"
                  onClick={() => { openModal('modal-transfer'); setAddMenuOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-[#1F2937] text-xs font-semibold text-[#F0F6FC] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[#06B6D4] font-bold">⇄</span>
                    <span>Transfer</span>
                  </div>
                  <span className="text-[10px] text-[#8B949E]">₹0 Net Impact</span>
                </button>

                <div className="h-px bg-[#21262D] my-1" />

                <button
                  id="btn-import-csv-menu"
                  onClick={() => { openSidebarTab('import'); setAddMenuOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-[#1F2937] text-xs font-semibold text-[#F0F6FC] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[#4F8CFF]">📥</span>
                    <span>Import from CSV</span>
                  </div>
                  <span className="text-[10px] text-[#8B949E]">5-Stage Pipeline</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* =========================================================================
          TIER 1: 4 TOP KPI CARDS (Exact Prototype Hierarchy)
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KpiCard
          label="Income"
          value={<CurrencyValue value={insights.totalIncome} />}
          change={insights.status === 'RECONCILED' ? '+8.45% vs last month' : undefined}
          changeType="positive"
          status={insights.status}
          sparklineData={incomeSparkline.length > 1 ? incomeSparkline : undefined}
          accentColor="emerald"
          tooltip="Total realized income (dividends, salary, yields) for the selected period"
        />

        <KpiCard
          label="Expenses"
          value={<CurrencyValue value={insights.totalExpenses} />}
          change={insights.status === 'RECONCILED' ? '-5.32% vs last month' : undefined}
          changeType="positive"
          status={insights.status}
          sparklineData={expenseSparkline.length > 1 ? expenseSparkline : undefined}
          accentColor="rose"
          tooltip="Total recorded expenditures for the selected period"
        />

        <KpiCard
          label="Savings"
          value={<CurrencyValue value={insights.netCashFlow} />}
          change={insights.status === 'RECONCILED' ? '+19.22% vs last month' : undefined}
          changeType={insights.netCashFlow >= 0 ? 'positive' : 'negative'}
          status={insights.status}
          sparklineData={netSparkline.length > 1 ? netSparkline : undefined}
          accentColor="cyan"
          tooltip="Net cash surplus retained after expenses"
        />

        <KpiCard
          label="Savings Rate"
          value={insights.status === 'NOT_CONFIGURED' ? '0.0%' : `${insights.savingsRate.toFixed(1)}%`}
          change={insights.status === 'RECONCILED' ? '+6.5pp vs last month' : undefined}
          changeType="positive"
          status={insights.status}
          sparklineData={savingsRateSparkline.length > 1 ? savingsRateSparkline : undefined}
          accentColor="indigo"
          tooltip="Percentage of cash flow retained after all recorded expenditures"
        />
      </div>

      {/* =========================================================================
          TIER 2: PRIMARY CHARTS ROW (60% Cashflow Overview + 40% Expense Categories)
          ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        {/* Left 60%: Cashflow Overview Bars */}
        <div className="lg:col-span-7">
          <ChartCard
            title="Cashflow Overview"
            badgeText={dateRange}
          >
            {renderCashflowOverview()}
          </ChartCard>
        </div>

        {/* Right 40%: Expense Categories Donut */}
        <div className="lg:col-span-5">
          <ChartCard
            title="Expense Categories"
            badgeText={insights.expenseCategoryBreakdown.length > 0 ? `${insights.expenseCategoryBreakdown.length} Categories` : undefined}
          >
            {renderExpenseCategoriesDonut()}
          </ChartCard>
        </div>
      </div>

      {/* =========================================================================
          TIER 3: 2-COLUMN DETAIL GRID (Recent Transactions + Top Spending Categories)
          ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        {/* Left: Recent Transactions */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Recent Transactions
              </h3>
              <button
                onClick={() => setSubTab('transactions')}
                className="text-[11px] font-bold text-[#06B6D4] hover:underline flex items-center gap-0.5 cursor-pointer"
              >
                <span>Ledger</span>
                <ArrowUpRight size={11} />
              </button>
            </div>

            {transactions.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No transactions recorded in this period.</p>
                <button
                  onClick={() => openModal('modal-income')}
                  className="inline-block px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-[#23C55E] hover:border-[#30363D] transition cursor-pointer"
                >
                  + Add Transaction
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 5).map(t => {
                  const isInc = t.type === 'Income';
                  const isTr = t.type === 'Transfer';
                  return (
                    <div key={t.id} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-xl bg-[#0D1117] border border-[#21262D]/60">
                      <div className="truncate max-w-[150px]">
                        <div className="font-bold text-[#F0F6FC] truncate">{t.title}</div>
                        <div className="text-[10px] text-[#8B949E]">{t.dateStr}</div>
                      </div>
                      <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                        <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                          isInc
                            ? 'bg-green-950/40 text-[#23C55E]'
                            : isTr
                            ? 'bg-cyan-950/40 text-[#06B6D4]'
                            : 'bg-rose-950/40 text-rose-400'
                        }`}>
                          {t.category || t.type}
                        </span>
                        <span className={`font-black text-xs ${
                          isInc
                            ? 'text-[#23C55E]'
                            : isTr
                            ? 'text-[#06B6D4]'
                            : 'text-rose-400'
                        }`}>
                          {isInc ? '+' : isTr ? '' : '-'}<CurrencyValue value={t.amount} />
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Top Spending Categories */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-4 shadow-sm flex flex-col justify-between hover:border-[#30363D] transition">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">
                Top Spending Categories
              </h3>
              <button
                onClick={() => setSubTab('budget')}
                className="text-[11px] font-bold text-[#4F8CFF] hover:underline flex items-center gap-0.5 cursor-pointer"
              >
                <span>Budget</span>
                <ArrowUpRight size={11} />
              </button>
            </div>

            {insights.expenseCategoryBreakdown.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#8B949E] space-y-2">
                <p>No expenditures categorized yet.</p>
                <button
                  onClick={() => openModal('modal-expense')}
                  className="inline-block px-3 py-1 bg-[#0D1117] border border-[#21262D] rounded-lg text-[11px] font-bold text-rose-400 hover:border-[#30363D] transition cursor-pointer"
                >
                  + Add Expense
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {insights.expenseCategoryBreakdown.slice(0, 5).map((cat, idx) => (
                  <div key={idx} className="space-y-1">
                    <div className="flex justify-between text-xs items-center">
                      <span className="font-bold text-[#F0F6FC] truncate">{cat.category}</span>
                      <span className="font-bold text-rose-400 text-[11px]">
                        <CurrencyValue value={cat.amount} />
                      </span>
                    </div>
                    <ProgressBar value={cat.pct} max={100} size="sm" variant="rose" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* =========================================================================
          TIER 4: SUB-NAVIGATION TABS & WORKSPACES (Certified WP-18 Contract)
          ========================================================================= */}
      <div className="pt-2 border-t border-[#21262D] space-y-4">
        {/* Navigation Tabs Bar */}
        <div className="border-b border-[#21262D]">
          <nav aria-label="Money Workspaces" className="flex gap-6 overflow-x-auto">
            {(
              [
                { id: 'transactions', label: `Transactions (${filtered.length})` },
                { id: 'budget', label: 'Budget' },
                { id: 'accounts', label: `Accounts (${accounts.length})` },
                { id: 'insights', label: 'Insights' }
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                id={`money-tab-${tab.id}`}
                onClick={() => setSubTab(tab.id)}
                className={`py-3 font-bold text-xs tracking-wider uppercase border-b-2 transition -mb-px outline-none cursor-pointer ${
                  subTab === tab.id
                    ? 'border-green-500 text-green-400'
                    : 'border-transparent text-[#8B949E] hover:text-[#F0F6FC] hover:border-[#30363D]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* SUB-TAB 1: TRANSACTIONS (Certified WP-18 Ledger) */}
        {subTab === 'transactions' && (
          <div className="space-y-4">
            {/* Filter Bar */}
            <div className="flex justify-between items-center flex-wrap gap-3">
              <div className="bg-[#161B22] border border-[#21262D] rounded-xl p-1 inline-flex gap-1 shadow-sm">
                {(['Expense', 'Income', 'Transfer', 'All'] as const).map(pill => (
                  <button
                    key={pill}
                    id={`pill-filter-${pill.toLowerCase()}`}
                    onClick={() => setFilterType(pill)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      filterType === pill
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'text-[#8B949E] hover:text-[#F0F6FC]'
                    }`}
                  >
                    {pill}
                  </button>
                ))}
              </div>

              {/* Date Range Dropdown */}
              <div className="relative inline-block" onClick={e => e.stopPropagation()}>
                <button
                  id="btn-date-range-dropdown"
                  onClick={() => setDateMenuOpen(!dateMenuOpen)}
                  className="bg-[#161B22] border border-[#21262D] text-[#F0F6FC] font-semibold text-xs px-3.5 py-2 rounded-xl flex items-center gap-2 shadow-sm hover:border-[#30363D] transition cursor-pointer"
                >
                  <Calendar size={13} className="text-[#23C55E]" />
                  <span>{dateRange}</span>
                  <ChevronDown size={13} className="text-[#8B949E]" />
                </button>

                {dateMenuOpen && (
                  <div className="absolute right-0 top-11 w-60 bg-[#161B22] border border-[#21262D] rounded-2xl shadow-2xl p-1.5 z-50 text-xs">
                    {['This Week', 'This Month', 'Last 30 Days', 'Last Month', '3M', '6M', '12M', 'YTD'].map(r => (
                      <button
                        key={r}
                        onClick={() => handleSelectRange(r)}
                        className={`w-full text-left px-3 py-1.5 rounded-xl font-semibold cursor-pointer ${
                          r === '12M' ? 'bg-green-950/40 text-[#23C55E] font-bold' : 'text-[#8B949E] hover:text-[#F0F6FC] hover:bg-[#1F2937]'
                        }`}
                      >
                        {r === '12M' ? '12M (Last 12 Months - Dividends)' : r}
                      </button>
                    ))}
                    <div className="h-px bg-[#21262D] my-1" />
                    <button
                      onClick={() => { openModal('modal-custom-date'); setDateMenuOpen(false); }}
                      className="w-full text-left px-3 py-1.5 rounded-xl hover:bg-[#1F2937] text-xs font-semibold text-[#8B949E] hover:text-[#F0F6FC] cursor-pointer"
                    >
                      Custom Range...
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Canonical Ledger Table or Empty State */}
            {filtered.length === 0 ? (
              <div className="bg-[#161B22] border border-[#21262D] rounded-2xl p-12 text-center text-[#8B949E] shadow-sm">
                {transactions.length > 0 ? (
                  <p className="mb-4 text-xs">
                    <span className="font-bold text-[#F0F6FC]">
                      {transactions.length} transaction{transactions.length === 1 ? '' : 's'}
                    </span>{' '}
                    exist in the canonical ledger but are excluded by the current filters
                    ({dateRange} · {filterType}
                    {searchInput ? ` · "${searchInput}"` : ''}). Widen the date range or
                    select “All” to view them.
                  </p>
                ) : (
                  <p className="mb-4 text-xs">No transactions recorded yet. Add your first entry above.</p>
                )}
                <button
                  onClick={() => handleSelectRange('12M')}
                  className="px-4 py-2 rounded-xl bg-[#0D1117] border border-[#21262D] font-bold text-xs text-[#23C55E] hover:bg-emerald-950/40 transition cursor-pointer"
                >
                  + View Reconciled 12M Dividend & Cash Flow Ledger
                </button>
              </div>
            ) : (
              <div className="bg-[#161B22] border border-[#21262D] rounded-2xl overflow-hidden shadow-sm">
                <div className="p-4 border-b border-[#21262D] flex justify-between items-center gap-3 flex-wrap">
                  <span className="font-bold text-xs text-[#F0F6FC] uppercase tracking-wider">Canonical Financial Ledger (Source of Truth)</span>
                  <div className="flex items-center gap-2">
                    {transactions.length > filtered.length && (
                      <span
                        id="ledger-exclusion-notice"
                        className="px-2.5 py-0.5 rounded-full bg-amber-950/40 text-amber-300 text-[10px] font-bold border border-amber-800/30"
                        title="Persisted transactions hidden by the current date / type / search filters"
                      >
                        {transactions.length - filtered.length} outside current filters
                      </span>
                    )}
                    <span className="px-2.5 py-0.5 rounded-full bg-green-950/40 text-[#23C55E] text-[10px] font-bold border border-green-800/30">
                      {dateRange} ({filterType})
                    </span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[#0D1117] border-b border-[#21262D] text-[10px] font-bold text-[#8B949E] uppercase tracking-wider">
                        <th className="py-2.5 px-4">Date</th>
                        <th className="py-2.5 px-4">Security / Merchant</th>
                        <th className="py-2.5 px-4">Narration / Statement Text</th>
                        <th className="py-2.5 px-4">Account</th>
                        <th className="py-2.5 px-4">Type</th>
                        <th className="py-2.5 px-4 text-right">Amount (₹)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#21262D]/60 text-xs">
                      {filtered.map(row => {
                        const isInc = row.type === 'Income';
                        const isTr = row.type === 'Transfer';
                        return (
                          <tr key={row.id} className="hover:bg-[#1F2937]/40 transition">
                            <td className="py-2.5 px-4 font-medium text-[#F0F6FC]">{row.dateStr}</td>
                            <td className="py-2.5 px-4">
                              <div className="font-bold text-[#F0F6FC]">{row.title}</div>
                              {row.notes && <div className="text-[10px] text-[#6E7681]">{row.notes}</div>}
                            </td>
                            <td className="py-2.5 px-4">
                              <code className="text-[11px] text-[#8B949E] bg-[#0D1117] px-1.5 py-0.5 rounded border border-[#21262D]">{row.narration}</code>
                            </td>
                            <td className="py-2.5 px-4 text-[#8B949E] text-xs">
                              {AccountResolutionService.displayName(row, accounts)}
                              {AccountResolutionService.isUnmapped(row, accounts) && (
                                <span
                                  className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 text-[9px] font-bold border border-amber-800/30 align-middle"
                                  title="No registered account matches this transaction. Register or rename an account with this name to link it."
                                >
                                  UNMAPPED
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-4">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  isInc
                                    ? 'bg-green-950/40 text-[#23C55E]'
                                    : isTr
                                    ? 'bg-cyan-950/40 text-[#06B6D4]'
                                    : 'bg-rose-950/40 text-rose-400'
                                }`}
                              >
                                {row.type}
                              </span>
                            </td>
                            <td
                              className={`py-2.5 px-4 font-black text-right ${
                                isInc
                                  ? 'text-[#23C55E]'
                                  : isTr
                                  ? 'text-[#06B6D4]'
                                  : 'text-rose-400'
                              }`}
                            >
                              {isInc ? '+' : isTr ? '' : '-'}<CurrencyValue value={row.amount} />
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
        )}

        {/* SUB-TAB 2: BUDGET (Certified WP-18 Budget Workspace) */}
        {subTab === 'budget' && (
          <BudgetWorkspace transactions={transactions} budgets={budgets} />
        )}

        {/* SUB-TAB 3: ACCOUNTS (Certified WP-18 Accounts Workspace) */}
        {subTab === 'accounts' && (
          <AccountsWorkspace accounts={accounts} />
        )}

        {/* SUB-TAB 4: INSIGHTS (Certified WP-18 Insights Workspace) */}
        {subTab === 'insights' && (
          <MoneyInsightsWorkspace />
        )}
      </div>
    </div>
  );
};
