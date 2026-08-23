import React, { useState } from 'react';
import { Asset, AssetType, GeographyType } from '../../domain/types';
import { AssetTable } from './AssetTable';
import { AddAssetModal } from './AddAssetModal';
import { EditAssetModal } from './EditAssetModal';
import { CurrencyValue } from '../CurrencyValue';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { AssetLifecycleService } from '../../services/AssetLifecycleService';
import { Plus, Search } from 'lucide-react';

interface Props {
  assets: Asset[];
}

/**
 * WP-FB-DATA-07b — notices follow the lifecycle convention already used by
 * Import History, the Money ledger and Liabilities: a bold headline saying WHAT
 * happened, then the detail.
 */
type Notice = { kind: 'success' | 'error'; headline: string; message: string };

export const AssetsWorkspace: React.FC<Props> = ({ assets }) => {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'All' | AssetType>('All');
  const [geoFilter, setGeoFilter] = useState<'All' | GeographyType>('All');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Which row's delete is in flight (Q-D07b-1b), per row as Import History does. */
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  /** Kept visible until persistence settles, so no deletion is claimed early. */
  const [pendingDelete, setPendingDelete] = useState<{ row: Asset; index: number } | null>(null);
  const accounts = useCanonicalLedger(s => s.accounts);
  const { removeAsset } = useCanonicalLedger();

  /**
   * WP-FB-DATA-07b — DELETE (Q-D07b-1b = (b)).
   *
   * Irreversible, so the confirmation quotes the exact name and amount, and —
   * when the asset is linked to an account — discloses that the link will be
   * cleared. That is a real consequence the user cannot see from the Wealth
   * page, and the 07b gate measured it happening in the same atomic write.
   */
  const handleDelete = async (asset: Asset) => {
    if (deleteBusy) {
      setNotice({
        kind: 'error',
        headline: 'One delete at a time.',
        message: 'Another asset is still being deleted. Wait for that to finish, then try again.'
      });
      return;
    }
    const claimer = accounts.find(a => a.linkedAssetId === asset.id) || null;
    const confirmed = window.confirm(
      AssetLifecycleService.describeDeletion(asset, claimer ? claimer.name : null)
    );
    if (!confirmed) return;

    setNotice(null);
    setDeleteBusy(asset.id as string);
    setPendingDelete({ row: asset, index: Math.max(0, assets.findIndex(a => a.id === asset.id)) });
    try {
      await removeAsset(asset.id as string);
      setNotice({
        kind: 'success',
        headline: 'Asset deleted.',
        message: claimer
          ? `"${asset.name}" is no longer part of your net worth, and the link to "${claimer.name}" was cleared.`
          : `"${asset.name}" is no longer part of your net worth.`
      });
    } catch (err: any) {
      setNotice({
        kind: 'error',
        headline: 'Delete refused.',
        message: err?.message || 'The asset could not be deleted.'
      });
    } finally {
      setDeleteBusy(null);
      setPendingDelete(null);
    }
  };

  const filtered = assets.filter(a => {
    if (typeFilter !== 'All' && a.type !== typeFilter) return false;
    if (geoFilter !== 'All' && a.geography !== geoFilter && !(geoFilter === 'India' && !a.geography)) return false;
    if (search) {
      const text = `${a.name} ${a.tag || ''} ${a.type || ''} ${a.currency || ''}`.toLowerCase();
      if (!text.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  /* A row whose delete is in flight stays on screen, in place, so the table
     never claims an outcome persistence has not given. Writes are optimistic:
     memory drops the row the instant delete is called. */
  const visibleAssets = React.useMemo(() => {
    if (!pendingDelete) return assets;
    if (assets.some(a => a.id === pendingDelete.row.id)) return assets;
    const merged = [...assets];
    merged.splice(Math.min(pendingDelete.index, merged.length), 0, pendingDelete.row);
    return merged;
  }, [assets, pendingDelete]);

  const visibleFiltered = React.useMemo(
    () => (pendingDelete && !filtered.some(a => a.id === pendingDelete.row.id)
      ? visibleAssets.filter(a => filtered.some(f => f.id === a.id) || a.id === pendingDelete.row.id)
      : filtered),
    [filtered, visibleAssets, pendingDelete]
  );

  const totVal = filtered.reduce((sum, a) => sum + a.amount, 0);

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 flex items-center gap-2 w-64">
            <Search size={15} className="text-gray-400" />
            <input
              type="text"
              placeholder="Search asset name, tag, currency..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent border-none text-xs text-gray-900 dark:text-white placeholder-gray-400 w-full outline-none"
            />
          </div>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-900 dark:text-white outline-none"
          >
            <option value="All">All Categories (8)</option>
            <option value="Equity">Equity</option>
            <option value="Debt">Debt</option>
            <option value="Real Estate">Real Estate</option>
            <option value="Commodities">Commodities</option>
            <option value="Cash & Savings">Cash & Savings</option>
            <option value="Crypto">Crypto</option>
            <option value="Alternatives">Alternatives</option>
            <option value="Other">Other</option>
          </select>

          <select
            value={geoFilter}
            onChange={(e) => setGeoFilter(e.target.value as any)}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-900 dark:text-white outline-none"
          >
            <option value="All">All Geographies</option>
            <option value="India">India (Domestic)</option>
            <option value="International">International</option>
            <option value="Other">Other</option>
          </select>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <span className="text-[11px] text-gray-500 dark:text-gray-400 font-bold block uppercase">Total Valuation</span>
            <span className="text-base font-extrabold text-green-700 dark:text-green-400">
              <CurrencyValue value={totVal} />
            </span>
          </div>

          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white font-bold text-xs transition shadow-sm"
          >
            <Plus size={15} />
            <span>Add Asset</span>
          </button>
        </div>
      </div>

      {notice && (
        <div
          id="asset-notice"
          data-asset-kind={notice.kind}
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

      {visibleAssets.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">No assets added</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-sm mx-auto">
            Add an asset to build your wealth inventory. Track equities, real estate, fixed income, gold, and more.
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-xs font-bold transition shadow-sm"
          >
            <Plus size={14} />
            <span>Add Asset</span>
          </button>
        </div>
      ) : visibleFiltered.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center text-xs text-gray-500 dark:text-gray-400 shadow-sm">
          No assets match your selected category or search filter.
        </div>
      ) : (
        <AssetTable
          assets={visibleFiltered}
          allAssets={visibleAssets}
          deleteBusyId={deleteBusy}
          onEdit={(a) => { setNotice(null); setEditing(a); }}
          onDelete={handleDelete}
        />
      )}

      <AddAssetModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={(message) => setNotice({ kind: 'success', headline: 'Asset added.', message })}
      />

      <EditAssetModal
        asset={editing}
        allAssets={visibleAssets}
        onClose={() => setEditing(null)}
        onSaved={(message) => setNotice({ kind: 'success', headline: 'Asset saved.', message })}
      />
    </div>
  );
};
