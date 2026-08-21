import React, { useState } from 'react';
import { Account } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { AddAccountModal } from './AddAccountModal';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { Landmark, CreditCard, Wallet, Building2, HelpCircle, Plus, Trash2 } from 'lucide-react';

interface Props {
  accounts: Account[];
}

export const AccountsWorkspace: React.FC<Props> = ({ accounts }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const { removeAccount, transactions } = useCanonicalLedger();

  const bankTotal = accounts
    .filter(a => a.type === 'Bank' || a.type === 'Cash' || a.type === 'Wallet')
    .reduce((s, a) => s + a.openingBalance, 0);

  const brokerTotal = accounts
    .filter(a => a.type === 'Broker')
    .reduce((s, a) => s + a.openingBalance, 0);

  const creditTotal = accounts
    .filter(a => a.type === 'Credit Card')
    .reduce((s, a) => s + a.openingBalance, 0);

  const handleDelete = (id: string, name: string) => {
    // WP-FB-DATA-04: deletion never silently orphans financial records. State
    // the exact consequence before the user commits to it.
    const linked = transactions.filter(t => t.accountId === id).length;
    const message =
      linked > 0
        ? `Remove account "${name}"?\n\n${linked} transaction${linked === 1 ? '' : 's'} currently reference this account. ` +
          `${linked === 1 ? 'It' : 'They'} will NOT be deleted — ${linked === 1 ? 'it' : 'they'} will remain in the ` +
          `Canonical Ledger marked UNMAPPED, and can be re-linked by registering an account with a matching name.`
        : `Are you sure you want to remove account "${name}"?`;

    if (window.confirm(message)) {
      removeAccount(id);
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'Bank': return Landmark;
      case 'Credit Card': return CreditCard;
      case 'Cash': return Wallet;
      case 'Wallet': return Wallet;
      case 'Broker': return Building2;
      default: return HelpCircle;
    }
  };

  return (
    <div className="space-y-6">
      {/* Controls / Summary Header */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">
            Registered Financial Accounts ({accounts.length})
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Canonical account registry across 6 controlled classifications
          </p>
        </div>

        <button
          id="btn-add-account"
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white font-bold text-xs transition shadow-sm"
        >
          <Plus size={15} />
          <span>+ Add Account</span>
        </button>
      </div>

      {/* KPI Summary Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Liquid & Bank Balances
          </span>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            <CurrencyValue value={bankTotal} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {accounts.filter(a => a.type === 'Bank' || a.type === 'Cash' || a.type === 'Wallet').length} Liquid Accounts
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Invested Brokerage Balances
          </span>
          <div className="text-2xl font-black text-cyan-600 dark:text-cyan-400 mt-1">
            <CurrencyValue value={brokerTotal} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {accounts.filter(a => a.type === 'Broker').length} Brokerage Registrations
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Credit & Revolving Debt
          </span>
          <div className="text-2xl font-black text-rose-600 dark:text-rose-400 mt-1">
            {creditTotal > 0 ? (
              <span className="flex items-center">
                -&nbsp;<CurrencyValue value={creditTotal} />
              </span>
            ) : (
              <CurrencyValue value={creditTotal} />
            )}
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {accounts.filter(a => a.type === 'Credit Card').length} Credit Cards
          </span>
        </div>
      </div>

      {/* Accounts List / Grid */}
      {accounts.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">
            No financial accounts configured
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-md mx-auto">
            Register bank accounts, credit cards, investment brokerages, and cash wallets to track balances and auto-populate transaction accounts.
          </p>
          <button
            id="btn-add-account-empty"
            onClick={() => setModalOpen(true)}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-xs font-bold transition shadow-sm"
          >
            <Plus size={14} />
            <span>+ Add Account</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map(acc => {
            const Icon = getTypeIcon(acc.type);
            const isCredit = acc.type === 'Credit Card';
            return (
              <div
                key={acc.id}
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm flex flex-col justify-between hover:border-gray-300 dark:hover:border-gray-700 transition"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                        <Icon size={18} />
                      </div>
                      <div>
                        <h4 className="font-extrabold text-sm text-gray-900 dark:text-white leading-tight">
                          {acc.name}
                        </h4>
                        <span className="text-[11px] text-gray-500 dark:text-gray-400">
                          {acc.institution ? `${acc.institution} ` : ''}{acc.lastFourDigits ? `(•••• ${acc.lastFourDigits})` : ''}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(acc.id, acc.name)}
                      className="p-1 text-gray-400 hover:text-rose-600 transition"
                      title="Delete account"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-baseline">
                    <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">Opening Balance:</span>
                    <span className={`text-base font-black ${
                      isCredit
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-green-700 dark:text-green-400'
                    }`}>
                      <CurrencyValue value={acc.openingBalance} />
                    </span>
                  </div>
                </div>

                <div className="mt-3 pt-2 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center text-[11px] text-gray-500 dark:text-gray-400">
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-[10px] font-bold">
                    {acc.type}
                  </span>
                  <span>Currency: {acc.currency || 'Not Specified'}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddAccountModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
};
