import React, { useEffect, useState } from 'react';
import { Asset, AssetType, GeographyType } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { AssetLifecycleService } from '../../services/AssetLifecycleService';
import { X } from 'lucide-react';

/**
 * WP-FB-DATA-07b — EDIT.
 *
 * Two properties this form must have, both measured at the 07b gate against
 * the bare repository primitive:
 *
 *  1. It submits by `id`, taken from the row it was opened with and never from
 *     a user-editable control. A padded id created a phantom row with a
 *     whitespace identity; a stale id appended instead of refusing.
 *
 *  2. It submits the COMPLETE record. `update` is a full-row replace, so a
 *     partial form silently blanked `type`, `tag`, `currency` and `geography`.
 *
 * A refusal or a persistence failure keeps the modal OPEN and renders
 * `e.message`. Renaming onto a name another asset already uses is ALLOWED:
 * duplicate names are permitted (Q-D07b-1a = (c)).
 */

const ASSET_TYPES: AssetType[] = [
  'Equity', 'Debt', 'Real Estate', 'Commodities',
  'Cash & Savings', 'Crypto', 'Alternatives', 'Other'
];
const GEOGRAPHIES: GeographyType[] = ['India', 'International', 'Other'];

interface Props {
  asset: Asset | null;
  /** The whole portfolio, so the form can warn when a name is shared. */
  allAssets: Asset[];
  onClose: () => void;
  onSaved: (message: string) => void;
}

export const EditAssetModal: React.FC<Props> = ({ asset, allAssets, onClose, onSaved }) => {
  const { updateAsset } = useCanonicalLedger();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<AssetType | ''>('');
  const [tag, setTag] = useState('');
  const [currency, setCurrency] = useState('');
  const [geography, setGeography] = useState<GeographyType | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!asset) return;
    setName(asset.name ?? '');
    setAmount(String(asset.amount ?? ''));
    setType((asset.type as AssetType) ?? '');
    setTag(asset.tag ?? '');
    setCurrency(asset.currency ?? '');
    setGeography((asset.geography as GeographyType) ?? '');
    setError(null);
    setBusy(false);
  }, [asset]);

  if (!asset) return null;

  const sharesName = allAssets.some(
    a => a.id !== asset.id && (a.name || '').trim().toLowerCase() === name.trim().toLowerCase()
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await updateAsset({
        // Identity comes from the record this modal was opened with.
        id: asset.id as string,
        name: name.trim(),
        amount: Number(amount),
        type: type === '' ? undefined : type,
        tag: tag.trim() === '' ? undefined : tag.trim(),
        currency: currency.trim() === '' ? undefined : currency.trim(),
        geography: geography === '' ? undefined : geography
      });
      onSaved(`"${name.trim()}" is up to date.`);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div
        id="edit-asset-modal"
        data-asset-edit-target={asset.id}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 className="text-lg font-extrabold text-gray-900 dark:text-white">Edit Asset</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              The whole record is replaced. No other asset is affected.
            </p>
          </div>
          <button
            type="button"
            id="edit-asset-close"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Identity is shown, never edited. */}
          <div
            id="edit-asset-identity"
            className="rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 px-3.5 py-2.5"
          >
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Identity (permanent)
            </div>
            <div className="mt-1 font-mono text-[10px] text-gray-500 dark:text-gray-400 break-all">
              {asset.id}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Asset Name *</label>
            <input id="edit-asset-name" type="text" value={name} required
              onChange={(e) => setName(e.target.value)} className={field} />
            {/* Permitted, not refused — but never a surprise. */}
            {sharesName && (
              <div id="edit-asset-duplicate-hint" className="mt-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                Another asset already uses this name. Both are kept as separate holdings.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Valuation *</label>
              <input id="edit-asset-amount" type="number" step="0.01" value={amount} required
                onChange={(e) => setAmount(e.target.value)} className={field} />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Currency</label>
              <input id="edit-asset-currency" type="text" value={currency}
                onChange={(e) => setCurrency(e.target.value)} className={field} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select id="edit-asset-type" value={type}
                onChange={(e) => setType(e.target.value as AssetType | '')} className={field}>
                <option value="">Unclassified</option>
                {ASSET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Geography</label>
              <select id="edit-asset-geography" value={geography}
                onChange={(e) => setGeography(e.target.value as GeographyType | '')} className={field}>
                <option value="">Not Specified</option>
                {GEOGRAPHIES.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Tag</label>
            <input id="edit-asset-tag" type="text" value={tag}
              onChange={(e) => setTag(e.target.value)} className={field}
              placeholder="e.g. tranche 2021, Bangalore flat" />
          </div>

          {error && (
            <div
              id="edit-asset-error"
              data-asset-kind="error"
              role="alert"
              className="rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2.5 text-xs font-semibold text-rose-800 dark:text-rose-300"
            >
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-200 dark:border-gray-800 mt-6">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold transition">
              Cancel
            </button>
            <button id="edit-asset-submit" type="submit" disabled={busy}
              className="px-5 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-bold text-xs transition shadow-sm">
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** Re-exported for tests and for the workspace's confirmation copy. */
export const describeAssetDeletion = AssetLifecycleService.describeDeletion;
