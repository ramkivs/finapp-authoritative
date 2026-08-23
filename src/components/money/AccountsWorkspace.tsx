import React, { useState } from 'react';
import { Account } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { AddAccountModal } from './AddAccountModal';
import { LinkAssetModal } from './LinkAssetModal';
import { AccountAssetLinkService } from '../../services/AccountAssetLinkService';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { AccountBalanceService } from '../../services/AccountBalanceService';
import { getEffectiveAsOfDate } from '../../services/DateRangeService';
import { Landmark, CreditCard, Wallet, Building2, HelpCircle, Plus, Trash2, AlertTriangle, Link2 } from 'lucide-react';

interface Props {
  accounts: Account[];
}

export const AccountsWorkspace: React.FC<Props> = ({ accounts }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<Account | null>(null);
  /** WP-FB-DATA-08A: which account's removal is in flight. */
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  /**
   * WP-FB-DATA-08A: the row whose removal is pending, kept VISIBLE until
   * persistence settles.
   *
   * Repository writes are optimistic, so memory drops the row the instant
   * remove() is called. Without this the row vanished immediately and
   * reappeared on failure - the UI announcing a completed deletion before
   * storage had agreed to it. Same pattern as the liability and asset
   * workspaces.
   */
  const [pendingDelete, setPendingDelete] = useState<{ row: any; index: number } | null>(null);
  const [notice, setNotice] = useState<
    { kind: 'success' | 'error'; headline: string; message: string } | null
  >(null);
  const { removeAccount, transactions, assets, linkAccountToAsset, unlinkAccountFromAsset, dismissAssetCandidate } = useCanonicalLedger();

  // WP-FB-DATA-05a: derived from the canonical transaction collection.
  // AccountBalanceService is the sole authority - no balance arithmetic here.
  const asOf = getEffectiveAsOfDate();
  const derived = AccountBalanceService.balances(accounts, transactions, asOf);
  const balanceOf = (id: string) => derived.find(b => b.accountId === id)?.balance ?? 0;
  const reconciliation = AccountBalanceService.reconciliation(accounts, transactions, asOf);

  const bankTotal = AccountBalanceService.totalForTypes(['Bank', 'Cash', 'Wallet'], accounts, transactions, asOf);
  const brokerTotal = AccountBalanceService.totalForTypes(['Broker'], accounts, transactions, asOf);
  const creditTotal = AccountBalanceService.totalForTypes(['Credit Card'], accounts, transactions, asOf);

  /**
   * WP-FB-DATA-08A — a destructive deletion that reports its outcome.
   *
   * Measured at the 08 gate: the user confirmed this deletion, the write
   * failed, the row stayed on screen and NOTHING was said. The rejection left
   * the app as an unhandled page error. The confirmation copy and the
   * unmapping consequence below are unchanged; only the outcome is now told.
   */
  const handleDelete = async (id: string, name: string) => {
    if (deleteBusy) {
      setNotice({
        kind: 'error',
        headline: 'One removal at a time.',
        message: 'Another account is still being removed. Wait for that to finish, then try again.'
      });
      return;
    }
    // WP-FB-DATA-04: deletion never silently orphans financial records. State
    // the exact consequence before the user commits to it.
    const linked = transactions.filter(t => t.accountId === id).length;
    const message =
      linked > 0
        ? `Remove account "${name}"?\n\n${linked} transaction${linked === 1 ? '' : 's'} currently reference this account. ` +
          `${linked === 1 ? 'It' : 'They'} will NOT be deleted — ${linked === 1 ? 'it' : 'they'} will remain in the ` +
          `Canonical Ledger marked UNMAPPED, and can be re-linked by registering an account with a matching name.`
        : `Are you sure you want to remove account "${name}"?`;

    if (!window.confirm(message)) return;

    setNotice(null);
    setDeleteBusy(id);
    setPendingDelete({
      row: accounts.find((x: any) => x.id === id),
      index: Math.max(0, accounts.findIndex((x: any) => x.id === id))
    });
    try {
      await removeAccount(id);
      setNotice({
        kind: 'success',
        headline: 'Account removed.',
        message: linked > 0
          ? `"${name}" is gone. ${linked} transaction${linked === 1 ? '' : 's'} ${linked === 1 ? 'is' : 'are'} now UNMAPPED and still in the ledger.`
          : `"${name}" is gone.`
      });
    } catch (err: any) {
      setNotice({
        kind: 'error',
        headline: 'Removal refused.',
        message: err?.message || 'The account could not be removed.'
      });
    } finally {
      setDeleteBusy(null);
      setPendingDelete(null);
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

  /* The pending row stays on screen, in place, so the list never claims an
     outcome persistence has not given. */
  const visibleAccounts = React.useMemo(() => {
    if (!pendingDelete || !pendingDelete.row) return accounts;
    if (accounts.some((x: any) => x.id === pendingDelete.row.id)) return accounts;
    const merged = [...accounts];
    merged.splice(Math.min(pendingDelete.index, merged.length), 0, pendingDelete.row);
    return merged;
  }, [accounts, pendingDelete]);

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

      {/* WP-FB-DATA-05a: reconciliation notice (Decision B).
          Unmapped activity is excluded from every registered account balance,
          is NOT folded into a pseudo-account, and is NOT lost. */}
      {notice && (
        <div
          id="account-notice"
          data-account-kind={notice.kind}
          role="status"
          className={
            notice.kind === 'error'
              ? 'rounded-2xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-5 py-3.5 text-xs font-semibold text-rose-800 dark:text-rose-300'
              : 'rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-5 py-3.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300'
          }
        >
          <strong>{notice.headline}</strong>{' '}
          {notice.message}
        </div>
      )}

      {reconciliation.unmappedCount > 0 && (
        <div
          id="balance-reconciliation-notice"
          className="rounded-2xl border border-amber-300 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/30 px-5 py-3.5 flex items-start gap-3"
        >
          <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-900 dark:text-amber-200">
            <span className="font-bold">
              {reconciliation.unmappedCount} transaction{reconciliation.unmappedCount === 1 ? '' : 's'} require
              {reconciliation.unmappedCount === 1 ? 's' : ''} reconciliation
            </span>
            <span className="opacity-90">
              {' '}(<CurrencyValue value={reconciliation.unmappedGross} /> of activity).
              These are not linked to a registered account, so they are excluded from the balances above.
              They remain in the Canonical Ledger marked UNMAPPED — register or rename an account with a
              matching name to include them.
            </span>
          </div>
        </div>
      )}

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
          {visibleAccounts.map(acc => {
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

                    <div className="flex items-center gap-1">
                      <button
                        data-link-account={acc.id}
                        onClick={() => setLinkTarget(acc)}
                        className={`p-1 transition ${
                          AccountAssetLinkService.statusOf(acc, assets).state === 'LINKED'
                            ? 'text-green-600 dark:text-green-400'
                            : AccountAssetLinkService.statusOf(acc, assets).state === 'BROKEN'
                            ? 'text-amber-500'
                            : 'text-gray-400 hover:text-green-600'
                        }`}
                        title={
                          AccountAssetLinkService.statusOf(acc, assets).state === 'LINKED'
                            ? `Linked to asset: ${AccountAssetLinkService.statusOf(acc, assets).asset?.name}`
                            : AccountAssetLinkService.statusOf(acc, assets).state === 'BROKEN'
                            ? 'Linked asset no longer exists'
                            : 'Link an asset'
                        }
                      >
                        <Link2 size={14} />
                      </button>
                      <button
                        data-account-delete={acc.id}
                        data-account-delete-busy={deleteBusy === acc.id ? 'true' : 'false'}
                        disabled={deleteBusy === acc.id}
                        onClick={() => handleDelete(acc.id, acc.name)}
                        className="p-1 text-gray-400 hover:text-rose-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        title={deleteBusy === acc.id ? `Removing ${acc.name}…` : 'Delete account'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 space-y-1">
                    <div className="flex justify-between items-baseline">
                      <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">
                        Opening Balance{acc.asOfDate ? ` (as of ${acc.asOfDate})` : ''}:
                      </span>
                      <span className="text-xs font-bold text-gray-600 dark:text-gray-400">
                        <CurrencyValue value={acc.openingBalance} />
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-xs text-gray-700 dark:text-gray-300 font-bold">Current Balance:</span>
                      <span
                        id={`account-balance-${acc.id}`}
                        className={`text-base font-black ${
                          isCredit
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-green-700 dark:text-green-400'
                        }`}
                      >
                        <CurrencyValue value={balanceOf(acc.id)} />
                      </span>
                    </div>
                    {(() => {
                      const st = AccountAssetLinkService.statusOf(acc, assets);
                      if (st.state === 'LINKED') {
                        return (
                          <div data-linked-asset={acc.id} className="text-[10px] text-green-700 dark:text-green-400 font-semibold pt-0.5 truncate">
                            Linked asset: {st.asset!.name}
                          </div>
                        );
                      }
                      if (st.state === 'BROKEN') {
                        return (
                          <div data-linked-asset-broken={acc.id} className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold pt-0.5">
                            Linked asset missing — re-link or unlink.
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {!acc.asOfDate && (
                      <div className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold pt-0.5">
                        No opening-balance date set — all transactions are being applied.
                      </div>
                    )}
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
      <LinkAssetModal
        isOpen={!!linkTarget}
        account={linkTarget}
        accounts={accounts}
        assets={assets}
        onClose={() => setLinkTarget(null)}
        onLink={linkAccountToAsset}
        onUnlink={unlinkAccountFromAsset}
        onDismissCandidate={dismissAssetCandidate}
      />
    </div>
  );
};
