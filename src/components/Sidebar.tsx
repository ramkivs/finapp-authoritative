import React from 'react';
import {
  LayoutDashboard,
  TrendingUp,
  Wallet,
  ShieldCheck,
  Calculator,
  Upload,
  FileText,
  Target,
  Sparkles,
  Settings,
  Database,
  Trash2,
  ChevronLeft,
  ChevronRight,
  X
} from 'lucide-react';
import { FinancialCommands } from '../application/commands';
import { useCanonicalLedger } from '../store/useCanonicalLedger';

/**
 * WP-FB-DATA-09 / Decision Q-D09-1 = (c).
 *
 * "Clear Dev Data" is developer tooling with no user-facing purpose and is
 * gated out of production builds. Vite statically replaces `import.meta.env.DEV`,
 * so the control and its handler are removed by dead-code elimination rather
 * than merely hidden.
 *
 * "Load Demo Data" stays available in production as a genuine first-run
 * capability, but is only safe because it REFUSES to run against a populated
 * ledger. That refusal — not the confirmation — is what removes the
 * destructive case.
 */
const DEV_TOOLS_ENABLED = import.meta.env.DEV;

interface Props {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<Props> = ({
  activeTab,
  setActiveTab,
  isCollapsed = false,
  onToggleCollapse,
  isMobileOpen = false,
  onCloseMobile
}) => {
  const {
    transactions, assets, liabilities, snapshots,
    accounts, budgets, policies, goals, profile
  } = useCanonicalLedger();

  const [notice, setNotice] = React.useState<
    { kind: 'success' | 'error'; headline: string; message: string } | null
  >(null);
  const [busy, setBusy] = React.useState<null | 'demo' | 'clear'>(null);

  /**
   * WP-FB-DATA-09 — every collection counts.
   *
   * Emptiness is judged across all nine, not just transactions: a user who has
   * registered accounts and policies but recorded no transaction yet still has
   * real data that demo content must never overwrite.
   */
  const populatedCollections = (): string[] => {
    const present: string[] = [];
    if (transactions.length) present.push('transactions');
    if (assets.length) present.push('assets');
    if (liabilities.length) present.push('liabilities');
    if (snapshots.length) present.push('snapshots');
    if (accounts.length) present.push('accounts');
    if (budgets.length) present.push('budgets');
    if (policies.length) present.push('policies');
    if (goals.length) present.push('goals');
    if (profile) present.push('financial profile');
    return present;
  };

  const primaryNavItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'wealth', label: 'Wealth', icon: TrendingUp },
    { id: 'money', label: 'Money', icon: Wallet },
    { id: 'essentials', label: 'Essentials', icon: ShieldCheck },
    { id: 'calculators', label: 'Calculators', icon: Calculator },
    { id: 'import', label: 'Import', icon: Upload },
    { id: 'reports', label: 'Reports', icon: FileText },
    { id: 'goals', label: 'Goals', icon: Target },
    { id: 'insights', label: 'Insights', icon: Sparkles },
    { id: 'settings', label: 'Settings', icon: Settings }
  ];

  const handleLoadDemo = async () => {
    if (busy) return;
    setNotice(null);

    /* Q-D09-1(c) — REFUSE outright on a populated ledger. Checked BEFORE the
     * confirmation, so a user with real data is never even offered the choice
     * of destroying it. */
    const populated = populatedCollections();
    if (populated.length > 0) {
      setNotice({
        kind: 'error',
        headline: 'Demo data was not loaded.',
        message:
          `This ledger already contains real data (${populated.join(', ')}). ` +
          `Loading the demo dataset would replace all of it, and that cannot be undone, ` +
          `so the operation was refused. Nothing was changed. Clear your data deliberately ` +
          `first if you genuinely want the demo dataset.`
      });
      return;
    }

    if (!window.confirm(
      'Load the demo dataset?\n\n' +
      'This fills the empty ledger with sample transactions, assets, liabilities and ' +
      'snapshots so you can explore FinBoom. It is sample data, not your own.'
    )) {
      return;
    }

    setBusy('demo');
    try {
      // WP-FB-DATA-09: awaited. No success claim before storage agrees.
      await FinancialCommands.loadDemoData();
      setNotice({
        kind: 'success',
        headline: 'Demo dataset loaded.',
        message: 'Sample transactions, assets, liabilities and snapshots are now in the ledger and saved.'
      });
    } catch (e) {
      setNotice({
        kind: 'error',
        headline: 'Demo data could not be saved.',
        message:
          `${e instanceof Error ? e.message : String(e)} ` +
          `Your ledger was left exactly as it was.`
      });
    } finally {
      setBusy(null);
    }
  };

  const handleClearData = async () => {
    if (busy) return;
    setNotice(null);

    /* The confirmation names ALL NINE collections. The previous wording listed
     * five and destroyed nine, which understated its own scope. */
    if (!window.confirm(
      'Clear all local financial data?\n\n' +
      'This permanently deletes every one of the following:\n' +
      '  1. transactions\n' +
      '  2. assets\n' +
      '  3. liabilities\n' +
      '  4. net-worth snapshots\n' +
      '  5. accounts\n' +
      '  6. budgets\n' +
      '  7. insurance policies\n' +
      '  8. goals\n' +
      '  9. your financial profile\n\n' +
      'This cannot be undone.'
    )) {
      return;
    }

    setBusy('clear');
    try {
      await FinancialCommands.clearLocalDevelopmentData();
      setNotice({
        kind: 'success',
        headline: 'All local financial data cleared.',
        message: 'All nine collections are empty and the empty state has been saved.'
      });
    } catch (e) {
      setNotice({
        kind: 'error',
        headline: 'Data was not cleared.',
        message:
          `${e instanceof Error ? e.message : String(e)} ` +
          `Your ledger was left exactly as it was.`
      });
    } finally {
      setBusy(null);
    }
  };

  const handleNavClick = (id: string) => {
    if (id === 'goals') {
      setActiveTab('essentials');
    } else if (id === 'reports') {
      setActiveTab('money');
    } else if (id === 'insights') {
      setActiveTab('wealth');
    } else if (id === 'settings') {
      alert('Settings: FinBoom v3.0 Institutional Theme active. Local persistence verified.');
    } else {
      setActiveTab(id);
    }
    if (onCloseMobile) {
      onCloseMobile();
    }
  };

  const isTabActive = (id: string) => {
    if (activeTab === id) return true;
    if (id === 'goals' && activeTab === 'goals') return true;
    return false;
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#161B22] border-r border-[#21262D] text-[#F0F6FC]">
      {/* Brand Header */}
      <div className={`p-4 flex items-center justify-between border-b border-[#21262D] ${isCollapsed ? 'justify-center' : ''}`}>
        {!isCollapsed ? (
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#23C55E] to-[#4F8CFF] flex items-center justify-center font-black text-white text-sm shadow-md flex-shrink-0">
              ☑
            </div>
            <div>
              <div className="font-extrabold text-sm tracking-tight text-white flex items-center gap-1.5">
                <span>FINBOOM</span>
                <span className="text-[9px] px-1.5 py-0.2 bg-[#21262D] text-[#8B949E] rounded-md font-mono">v3.0</span>
              </div>
              <p className="text-[10px] text-[#8B949E] tracking-tight">Financial Command Center</p>
            </div>
          </div>
        ) : (
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-[#23C55E] to-[#4F8CFF] flex items-center justify-center font-black text-white text-sm shadow-md">
            ☑
          </div>
        )}

        {/* Mobile close button */}
        {onCloseMobile && (
          <button
            onClick={onCloseMobile}
            className="md:hidden p-1.5 text-[#8B949E] hover:text-white rounded-lg hover:bg-[#21262D] transition cursor-pointer"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Primary Navigation List (Exact Prototype Hierarchy + Import) */}
      <nav className="p-2.5 flex-1 overflow-y-auto space-y-1">
        {primaryNavItems.map(item => {
          const Icon = item.icon;
          const active = isTabActive(item.id);
          return (
            <button
              key={item.id}
              id={`sidebar-nav-${item.id}`}
              onClick={() => handleNavClick(item.id)}
              title={isCollapsed ? item.label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer ${
                active
                  ? 'bg-[#1F2937] text-[#4F8CFF] font-bold border border-[#30363D] shadow-sm'
                  : 'text-[#8B949E] hover:bg-[#1F2937]/50 hover:text-[#F0F6FC]'
              } ${isCollapsed ? 'justify-center px-0' : ''}`}
            >
              <Icon size={17} className={active ? 'text-[#4F8CFF]' : 'text-[#8B949E]'} />
              {!isCollapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Data & Diagnostics Controls (Exact Prototype Dev Data section) */}
      <div className="p-2.5 border-t border-[#21262D] space-y-1">
        {!isCollapsed && (
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-[#6E7681] px-3 pt-1 pb-1">
            DEV DATA & TOOLS
          </div>
        )}

        <button
          id="btn-load-demo-data"
          onClick={handleLoadDemo}
          disabled={busy !== null}
          aria-busy={busy === 'demo'}
          title={isCollapsed ? 'Load Demo Data' : undefined}
          className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-green-400 hover:bg-[#1F2937] border border-transparent hover:border-[#30363D] transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isCollapsed ? 'justify-center px-0' : ''}`}
        >
          <Database size={15} className="text-green-400 flex-shrink-0" />
          {!isCollapsed && <span>{busy === 'demo' ? 'Loading demo data…' : 'Load Demo Data'}</span>}
        </button>

        {/* Q-D09-1(c): developer-only, removed from production builds. */}
        {DEV_TOOLS_ENABLED && (
          <button
            id="btn-clear-dev-data"
            onClick={handleClearData}
            disabled={busy !== null}
            aria-busy={busy === 'clear'}
            title={isCollapsed ? 'Clear Dev Data' : undefined}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-rose-400 hover:bg-[#1F2937] border border-transparent hover:border-[#30363D] transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isCollapsed ? 'justify-center px-0' : ''}`}
          >
            <Trash2 size={15} className="text-rose-400 flex-shrink-0" />
            {!isCollapsed && <span>{busy === 'clear' ? 'Clearing…' : 'Clear Dev Data'}</span>}
          </button>
        )}

        {/* WP-FB-DATA-09 — 08A/08B disclosure convention. Never an alert(). */}
        {notice && !isCollapsed && (
          <div
            id="devtools-notice"
            data-devtools-kind={notice.kind}
            role="status"
            className={
              notice.kind === 'error'
                ? 'mt-1 rounded-xl border border-rose-800 bg-rose-950/40 px-2.5 py-2 text-[10px] font-semibold text-rose-300 leading-snug'
                : 'mt-1 rounded-xl border border-emerald-800 bg-emerald-950/40 px-2.5 py-2 text-[10px] font-semibold text-emerald-300 leading-snug'
            }
          >
            <strong>{notice.headline}</strong>{' '}
            {notice.message}
          </div>
        )}

        {onToggleCollapse && (
          <button
            id="btn-collapse-sidebar"
            onClick={onToggleCollapse}
            className="hidden md:flex w-full items-center justify-center py-1.5 mt-1 rounded-xl text-xs font-bold text-[#8B949E] hover:bg-[#1F2937] hover:text-white transition cursor-pointer"
            title={isCollapsed ? 'Expand Sidebar (240px)' : 'Collapse Sidebar (72px)'}
          >
            {isCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside
        className={`hidden md:block h-screen sticky top-0 flex-shrink-0 z-40 transition-all duration-300 ease-in-out ${
          isCollapsed ? 'w-[72px]' : 'w-[240px]'
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Mobile Off-Canvas Drawer Overlay */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity cursor-pointer"
            onClick={onCloseMobile}
          />
          <div className="relative w-[260px] max-w-[80vw] h-full shadow-2xl z-50">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
};
