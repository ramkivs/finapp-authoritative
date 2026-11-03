import React, { useState } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { AccountBalanceService } from '../services/AccountBalanceService';
import { Moon, Sun, Eye, EyeOff, Bell, Menu, ChevronDown, Calendar, Wallet } from 'lucide-react';

interface Props {
  toggleDark: () => void;
  isDark: boolean;
  onOpenMobile?: () => void;
}

export const Header: React.FC<Props> = ({ toggleDark, isDark, onOpenMobile }) => {
  const { privacyMasked = false, togglePrivacy, dateRange, setDateRange, accounts = [], transactions = [] } = useCanonicalLedger();
  const [showDateMenu, setShowDateMenu] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);

  const ranges = ['This Month', 'Last Month', '3M', '6M', '12M', 'YTD'];
  const reconciliation = AccountBalanceService.reconciliation(accounts, transactions);
  const notificationCount = reconciliation.unmappedCount > 0 ? 1 : 0;

  return (
    <header className="h-16 bg-[#161B22] border-b border-[#21262D] flex items-center justify-between px-4 md:px-8 sticky top-0 z-30 transition-colors duration-150">
      {/* Left Area: Mobile Hamburger Menu & Active Scope Indicators */}
      <div className="flex items-center gap-3">
        {onOpenMobile && (
          <button
            id="btn-mobile-menu-toggle"
            onClick={onOpenMobile}
            className="md:hidden p-2 rounded-xl text-[#8B949E] hover:bg-[#21262D] hover:text-white transition cursor-pointer"
            title="Open Menu"
          >
            <Menu size={20} />
          </button>
        )}

        <span className="md:hidden font-extrabold text-sm tracking-tight text-[#F0F6FC]">
          ArthaVault
        </span>

        {/* Account Context Pill */}
        <div className="relative hidden sm:inline-block">
          <button
            id="btn-account-context-dropdown"
            onClick={() => { setShowAccountMenu(!showAccountMenu); setShowDateMenu(false); }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#0D1117] border border-[#21262D] text-xs font-bold text-[#F0F6FC] hover:border-[#30363D] transition cursor-pointer"
          >
            <Wallet size={13} className="text-[#4F8CFF]" />
            <span>All Accounts</span>
            <span className="text-[10px] text-[#8B949E] font-mono">({accounts.length})</span>
            <ChevronDown size={12} className="text-[#8B949E]" />
          </button>

          {showAccountMenu && (
            <div className="absolute left-0 top-10 w-52 bg-[#161B22] border border-[#21262D] rounded-2xl shadow-2xl p-1.5 z-50 text-xs">
              <button
                onClick={() => setShowAccountMenu(false)}
                className="w-full text-left px-3 py-2 rounded-xl bg-green-900/30 text-[#23C55E] font-bold cursor-pointer"
              >
                All Accounts ({accounts.length})
              </button>
              {accounts.map(a => (
                <button
                  key={a.id}
                  onClick={() => setShowAccountMenu(false)}
                  className="w-full text-left px-3 py-2 rounded-xl hover:bg-[#21262D] text-[#8B949E] hover:text-[#F0F6FC] font-medium truncate cursor-pointer"
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Global Date Range Context */}
        <div className="relative hidden sm:inline-block">
          <button
            id="btn-global-date-range-dropdown"
            onClick={() => { setShowDateMenu(!showDateMenu); setShowAccountMenu(false); }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#0D1117] border border-[#21262D] text-xs font-bold text-[#F0F6FC] hover:border-[#30363D] transition cursor-pointer"
          >
            <Calendar size={13} className="text-[#23C55E]" />
            <span>{dateRange}</span>
            <ChevronDown size={12} className="text-[#8B949E]" />
          </button>

          {showDateMenu && (
            <div className="absolute left-0 top-10 w-44 bg-[#161B22] border border-[#21262D] rounded-2xl shadow-2xl p-1.5 z-50 text-xs">
              {ranges.map(r => (
                <button
                  key={r}
                  onClick={() => { setDateRange(r); setShowDateMenu(false); }}
                  className={`w-full text-left px-3 py-1.5 rounded-xl font-bold transition cursor-pointer ${
                    dateRange === r
                      ? 'bg-green-900/30 text-[#23C55E]'
                      : 'hover:bg-[#21262D] text-[#8B949E] hover:text-[#F0F6FC]'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Area: Utility Toggles & Local Vault Badge */}
      <div className="flex items-center gap-2.5">
        {/* Dark/Light Mode */}
        <button
          id="btn-theme-toggle"
          onClick={toggleDark}
          className="w-9 h-9 rounded-xl hover:bg-[#21262D] border border-transparent hover:border-[#21262D] flex items-center justify-center text-[#8B949E] hover:text-white transition cursor-pointer"
          title="Toggle Light / Dark Theme"
        >
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        {/* Privacy Balance Masking */}
        <button
          id="btn-privacy-toggle"
          aria-pressed={privacyMasked}
          onClick={togglePrivacy}
          className="w-9 h-9 rounded-xl hover:bg-[#21262D] border border-transparent hover:border-[#21262D] flex items-center justify-center text-[#8B949E] hover:text-white transition cursor-pointer"
          title="Mask / Unmask Financial Figures (Persistent)"
        >
          {privacyMasked ? <EyeOff size={17} className="text-[#F59E0B]" /> : <Eye size={17} />}
        </button>

        {/* Notification Bell */}
        <button
          id="btn-notifications"
          onClick={() =>
            alert(
              reconciliation.unmappedCount > 0
                ? `${reconciliation.unmappedCount} transaction(s) are not yet mapped to a registered account.`
                : 'No pending ledger notifications.'
            )
          }
          className="w-9 h-9 rounded-xl hover:bg-[#21262D] border border-transparent hover:border-[#21262D] flex items-center justify-center text-[#8B949E] hover:text-white transition relative cursor-pointer"
          title="Notifications"
        >
          <Bell size={17} />
          {notificationCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-3.5 h-3.5 rounded-full bg-[#EF4444] text-white text-[9px] font-bold flex items-center justify-center">
              {notificationCount}
            </span>
          )}
        </button>

        {/* ArthaVault Local Vault Badge (No Personal PII) */}
        <div
          id="btn-user-profile"
          title="ArthaVault • Local Vault"
          onClick={() => alert('ArthaVault • Local Vault — Single-owner personal finance workspace (client-only IndexedDB)')}
          className="flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full bg-[#0D1117] border border-[#21262D] cursor-pointer hover:border-[#30363D] transition"
        >
          <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-[#23C55E] to-[#4F8CFF] text-white font-bold text-[10px] flex items-center justify-center shadow-sm">
            AV
          </div>
          <span className="text-xs font-bold text-[#F0F6FC] hidden md:inline">
            ArthaVault • Local Vault
          </span>
        </div>
      </div>
    </header>
  );
};
