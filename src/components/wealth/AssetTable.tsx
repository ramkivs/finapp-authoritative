import React from 'react';
import { Asset } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { AssetLifecycleService } from '../../services/AssetLifecycleService';
import { Pencil, Trash2 } from 'lucide-react';

interface AssetTableProps {
  assets: Asset[];
  /**
   * WP-FB-DATA-07b: ambiguity is judged against the WHOLE portfolio, not the
   * filtered view. A search that happens to show only one "Gold" must not make
   * that row look unambiguous when a second "Gold" exists behind the filter.
   */
  allAssets?: Asset[];
  /** The row whose delete is currently in flight (Q-D07b-1b). */
  deleteBusyId?: string | null;
  onEdit?: (asset: Asset) => void;
  onDelete?: (asset: Asset) => void;
}

export const AssetTable: React.FC<AssetTableProps> = ({
  assets, allAssets, deleteBusyId, onEdit, onDelete
}) => {
  if (assets.length === 0) return null;

  const universe = allAssets && allAssets.length ? allAssets : assets;
  const showActions = Boolean(onEdit || onDelete);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table id="asset-table" className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-800 text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <th className="py-3.5 px-6">Asset Name</th>
              <th className="py-3.5 px-6">Category</th>
              <th className="py-3.5 px-6">Geography</th>
              <th className="py-3.5 px-6">Currency</th>
              <th className="py-3.5 px-6 text-right">Valuation</th>
              {showActions && <th className="py-3.5 px-6 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-sm">
            {/* WP-FB-DATA-07b: keyed on the STABLE id, not the display name.
                `key={a.name}` produced React duplicate-key warnings in Chromium
                the moment two assets shared a name — and Q-D07b-1a = (c) makes
                that a supported state, not an accident. */}
            {assets.map((a) => {
              const distinguishing = AssetLifecycleService.describeDistinguishing(a, universe);
              return (
                <tr
                  key={a.id}
                  data-asset-id={a.id}
                  data-asset-ambiguous={distinguishing ? 'true' : 'false'}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
                >
                  <td className="py-3.5 px-6 font-bold text-gray-900 dark:text-white">
                    {a.name}
                    {/* Duplicate names are permitted, so the product owes the
                        user a way to tell them apart at a glance. Shown ONLY
                        when another asset shares this name. */}
                    {distinguishing && (
                      <span
                        data-asset-distinguisher={a.id}
                        title="Another asset shares this name"
                        className="ml-2 align-middle px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 text-[10px] font-bold"
                      >
                        {distinguishing}
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-6">
                    <span className="px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs font-bold">
                      {a.type || 'Unclassified'}
                    </span>
                  </td>
                  <td className="py-3.5 px-6 text-gray-600 dark:text-gray-400 text-xs">
                    {a.geography || 'Not Specified'}
                  </td>
                  <td className="py-3.5 px-6 text-gray-600 dark:text-gray-400 text-xs">
                    {a.currency || 'Not Specified'}
                  </td>
                  <td className="py-3.5 px-6 font-bold text-green-700 dark:text-green-400 text-right">
                    <CurrencyValue value={a.amount} />
                  </td>
                  {showActions && (
                    <td className="py-3.5 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        {onEdit && (
                          <button
                            type="button"
                            data-asset-edit={a.id}
                            disabled={deleteBusyId === a.id}
                            onClick={() => onEdit(a)}
                            title={`Edit ${a.name}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-700 dark:text-gray-200 text-xs font-bold transition"
                          >
                            <Pencil size={13} />
                            <span>Edit</span>
                          </button>
                        )}
                        {onDelete && (
                          /* Only the row actually being deleted is disabled;
                             another row's Delete stays live and is refused by
                             the handler, with a notice. */
                          <button
                            type="button"
                            data-asset-delete={a.id}
                            data-asset-delete-busy={deleteBusyId === a.id ? 'true' : 'false'}
                            disabled={deleteBusyId === a.id}
                            onClick={() => onDelete(a)}
                            title={deleteBusyId === a.id ? `Deleting ${a.name}…` : `Delete ${a.name}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-900/40 disabled:opacity-40 disabled:cursor-not-allowed text-rose-700 dark:text-rose-400 text-xs font-bold transition"
                          >
                            <Trash2 size={13} />
                            <span>{deleteBusyId === a.id ? 'Deleting…' : 'Delete'}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
