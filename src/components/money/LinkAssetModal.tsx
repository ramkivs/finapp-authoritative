import React, { useState } from 'react';
import { Account, Asset } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { AccountAssetLinkService } from '../../services/AccountAssetLinkService';
import { Link2, X, AlertTriangle } from 'lucide-react';

interface Props {
  isOpen: boolean;
  account: Account | null;
  accounts: Account[];
  assets: Asset[];
  onClose: () => void;
  onLink: (accountId: string, assetId: string) => { ok: boolean; message?: string };
  onUnlink: (accountId: string) => { ok: boolean; message?: string };
  /** WP-FB-DATA-05b G3: record that a same-name pair is NOT the same money. */
  onDismissCandidate?: (accountId: string, assetId: string) => { ok: boolean; message?: string };
}

/**
 * WP-FB-DATA-04c-2 — explicit Account↔Asset link selector.
 *
 * The Account surface owns the relationship, matching `Account.linkedAssetId`.
 *
 * The user always chooses: no asset is created, no link is inferred from a
 * matching name or type, and an asset already claimed by another account is
 * shown as unavailable with the claiming account named — never silently
 * reassigned. Changing to a different asset requires an explicit unlink first.
 *
 * Assets are identified by name plus type / amount / currency so duplicates are
 * distinguishable; the id is only a technical fallback label, never the primary
 * identifier shown.
 */
export const LinkAssetModal: React.FC<Props> = ({
  isOpen, account, accounts, assets, onClose, onLink, onUnlink, onDismissCandidate
}) => {
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !account) return null;

  const status = AccountAssetLinkService.statusOf(account, assets);
  const linkedAssets = assets.filter(a => !!a.id);

  const claimerOf = (assetId: string) => {
    const c = AccountAssetLinkService.accountClaiming(assetId, accounts);
    return c && c.id !== account.id ? c : null;
  };

  const handleLink = (assetId: string) => {
    setError(null);
    const res = onLink(account.id, assetId);
    if (!res.ok) setError(res.message || 'Unable to link this asset.');
    else onClose();
  };

  const handleUnlink = () => {
    setError(null);
    const res = onUnlink(account.id);
    if (!res.ok) setError(res.message || 'Unable to unlink.');
    else onClose();
  };

  const normalize = (n?: string) => (n || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const dismissed = account.dismissedAssetCandidateIds || [];
  const isHeldCandidate = (asset: Asset) =>
    !!asset.id &&
    status.state === 'UNLINKED' &&
    !dismissed.includes(asset.id) &&
    asset.type === 'Cash & Savings' &&
    normalize(asset.name) === normalize(account.name);

  const handleDismiss = (assetId: string) => {
    setError(null);
    if (!onDismissCandidate) return;
    const res = onDismissCandidate(account.id, assetId);
    if (!res.ok) setError(res.message || 'Unable to record that.');
    else onClose();
  };

  /** Distinguishing detail so two same-named assets are never ambiguous. */
  const describe = (a: Asset) =>
    [a.type, a.currency, a.geography].filter(Boolean).join(' · ');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        id="link-asset-modal"
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white text-base flex items-center gap-2">
              <Link2 size={16} className="text-green-600" />
              Link an asset to “{account.name}”
            </h3>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
              Link this account to the Wealth asset that represents the same money.
              The relationship is explicit — it is never guessed from matching names.
              An account can hold one asset, and an asset can belong to one account.
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {error && (
          <div
            id="link-asset-error"
            className="mx-5 mt-4 rounded-xl border border-rose-300 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2.5 flex items-start gap-2"
          >
            <AlertTriangle size={14} className="text-rose-600 dark:text-rose-400 mt-0.5 flex-shrink-0" />
            <span className="text-xs text-rose-800 dark:text-rose-200">{error}</span>
          </div>
        )}

        {status.state === 'BROKEN' && (
          <div className="mx-5 mt-4 rounded-xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-900 dark:text-amber-200">
            This account references an asset that no longer exists
            (<code className="text-[10px]">{status.assetId}</code>). Unlink it, or link a different asset.
          </div>
        )}

        <div className="p-5 overflow-y-auto space-y-2">
          {status.state === 'LINKED' && status.asset && (
            <div
              id="link-asset-current"
              className="rounded-xl border border-green-300 dark:border-green-800/60 bg-green-50 dark:bg-green-950/30 px-3.5 py-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-green-900 dark:text-green-200 truncate">
                  Linked: {status.asset.name}
                </div>
                <div className="text-[10px] text-green-800/80 dark:text-green-300/80">
                  {describe(status.asset)} · <CurrencyValue value={status.asset.amount} />
                </div>
              </div>
              <button
                id="btn-unlink-asset"
                onClick={handleUnlink}
                className="px-3 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:border-rose-400 transition flex-shrink-0"
              >
                Unlink
              </button>
            </div>
          )}

          {linkedAssets.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 py-6 text-center">
              No assets registered yet. Add an asset in Wealth first — assets are never created automatically.
            </p>
          )}

          {linkedAssets.map(asset => {
            const claimer = claimerOf(asset.id!);
            const isCurrent = status.assetId === asset.id;
            if (isCurrent) return null;
            return (
              <div
                key={asset.id}
                data-asset-id={asset.id}
                className={`rounded-xl border px-3.5 py-3 flex items-center justify-between gap-3 ${
                  claimer
                    ? 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40 opacity-70'
                    : 'border-gray-200 dark:border-gray-800 hover:border-green-500 transition'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-bold text-gray-900 dark:text-white truncate">{asset.name || '(unnamed asset)'}</div>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                    {describe(asset)} · <CurrencyValue value={asset.amount} />
                  </div>
                  {claimer && (
                    <div className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold mt-0.5">
                      Already linked to “{claimer.name}”
                    </div>
                  )}
                  {!claimer && isHeldCandidate(asset) && (
                    <div className="text-[10px] text-blue-600 dark:text-blue-400 font-semibold mt-0.5">
                      Same name as this account — held out of liquid reserves until you decide.
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                {!claimer && isHeldCandidate(asset) && onDismissCandidate && (
                  <button
                    data-dismiss-candidate={asset.id}
                    onClick={() => handleDismiss(asset.id!)}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-[11px] font-bold text-gray-700 dark:text-gray-300 hover:border-gray-400 transition"
                    title="These are different money — count both"
                  >
                    Not the same
                  </button>
                )}
                <button
                  data-link-asset={asset.id}
                  disabled={!!claimer || status.state === 'LINKED'}
                  onClick={() => handleLink(asset.id!)}
                  className="px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-800 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-[11px] font-bold transition flex-shrink-0"
                  title={
                    claimer
                      ? `Claimed by ${claimer.name}. Unlink it there first.`
                      : status.state === 'LINKED'
                      ? 'Unlink the current asset first.'
                      : 'Link this asset'
                  }
                >
                  Link
                </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
