import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { OverviewPage } from './pages/OverviewPage';
import { WealthPage } from './pages/WealthPage';
import { MoneyPage } from './pages/MoneyPage';
import { EssentialsPage } from './pages/EssentialsPage';
import { ImportPage } from './pages/ImportPage';
import { CalculatorsPage } from './pages/CalculatorsPage';
import { IncomeModal, ExpenseModal, TransferModal } from './components/Modals';
import { CustomDateModal } from './components/CustomDateModal';
import { ShieldCheck } from 'lucide-react';

export function App() {
  const [activeTab, setActiveTab] = useState<string>('money');

  /**
   * Canonical cross-page navigation.
   *
   * FinBoom has no router: page selection is React state (`activeTab`) and each
   * page owns its own sub-tab state. `navigateTo` is the single authoritative
   * entry point for navigating between pages, optionally deep-linking to a
   * sub-tab within the destination page.
   *
   * `navSeq` increments on every call so a destination page re-applies the
   * requested sub-tab even when the same target is selected twice in a row.
   */
  const [pendingSubTab, setPendingSubTab] = useState<string | null>(null);
  const [navSeq, setNavSeq] = useState<number>(0);

  const navigateTo = React.useCallback((tabId: string, subTab?: string) => {
    setActiveTab(tabId);
    setPendingSubTab(subTab ?? null);
    setNavSeq(prev => prev + 1);
  }, []);
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('finapp.theme');
      if (stored === 'light') return false;
      return true; // Institutional dark is the authoritative default
    }
    return true;
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState<boolean>(false);

  const [activeModal, setActiveModal] = useState<
    null | 'modal-income' | 'modal-expense' | 'modal-transfer' | 'modal-custom-date'
  >(null);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('finapp.theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('finapp.theme', 'light');
    }
  }, [isDark]);

  const toggleDark = () => {
    setIsDark(prev => !prev);
  };

  return (
    <div className={`flex min-h-screen w-full font-sans antialiased ${isDark ? 'dark bg-[#0D1117] text-[#F0F6FC]' : 'bg-[#faf9f5] text-gray-900'}`}>
      {/* Responsive Sidebar with Collapse & Mobile Off-Canvas Drawer */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={(tab: string) => navigateTo(tab)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(prev => !prev)}
        isMobileOpen={isMobileDrawerOpen}
        onCloseMobile={() => setIsMobileDrawerOpen(false)}
      />

      {/* Main Workspace Canvas */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        <Header
          toggleDark={toggleDark}
          isDark={isDark}
          onOpenMobile={() => setIsMobileDrawerOpen(true)}
        />

        <main className="p-4 md:p-6 lg:p-8 max-w-[1440px] w-full mx-auto flex-1">
          {activeTab === 'overview' && <OverviewPage navigateTo={navigateTo} />}
          {activeTab === 'wealth' && <WealthPage />}
          {activeTab === 'money' && (
            <MoneyPage
              openModal={(m) => setActiveModal(m)}
              openSidebarTab={setActiveTab}
              initialSubTab={pendingSubTab}
              navSeq={navSeq}
            />
          )}
          {activeTab === 'essentials' && (
            <EssentialsPage initialSubTab={pendingSubTab} navSeq={navSeq} />
          )}
          {activeTab === 'import' && <ImportPage />}
          {activeTab === 'calculators' && <CalculatorsPage />}
        </main>

        {/* Global Institutional Footer */}
        <footer className="mt-auto border-t border-[#21262D] bg-[#161B22] px-6 py-4 text-xs text-[#8B949E]">
          <div className="max-w-[1440px] mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-center md:text-left">
            <div className="font-semibold text-[#F0F6FC] flex items-center gap-1.5 justify-center">
              <span>FinBoom</span>
              <span className="text-[#8B949E]">— Your Financial Command Center</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] justify-center">
              <span className="inline-flex items-center gap-1 text-[#23C55E]">
                <ShieldCheck size={14} />
                <span>All data is encrypted and stored locally</span>
              </span>
              <span>•</span>
              <span>You own your data</span>
            </div>
            <div className="text-[11px] font-bold tracking-wider text-[#6E7681] uppercase">
              Build. Grow. Prosper.
            </div>
          </div>
        </footer>
      </div>

      {/* Reusable Modals (Preserving All Certified Contracts) */}
      <IncomeModal isOpen={activeModal === 'modal-income'} onClose={() => setActiveModal(null)} />
      <ExpenseModal isOpen={activeModal === 'modal-expense'} onClose={() => setActiveModal(null)} />
      <TransferModal isOpen={activeModal === 'modal-transfer'} onClose={() => setActiveModal(null)} />
      <CustomDateModal isOpen={activeModal === 'modal-custom-date'} onClose={() => setActiveModal(null)} />
    </div>
  );
}

export default App;
