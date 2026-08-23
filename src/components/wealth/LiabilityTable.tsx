import React from 'react';
import { Liability } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { Pencil, Trash2 } from 'lucide-react';

interface LiabilityTableProps {
  liabilities: Liability[];
  onEdit?: (liability: Liability) => void;
  onDelete?: (liability: Liability) => void;
}

export const LiabilityTable: React.FC<LiabilityTableProps> = ({ liabilities, onEdit, onDelete }) => {
  if (liabilities.length === 0) return null;

  const showActions = Boolean(onEdit || onDelete);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table id="liability-table" className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-800 text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <th className="py-3.5 px-6">Liability Name</th>
              <th className="py-3.5 px-6">Loan Type</th>
              <th className="py-3.5 px-6">Currency</th>
              <th className="py-3.5 px-6 text-right">Obligation</th>
              {showActions && <th className="py-3.5 px-6 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 text-sm">
            {/* WP-FB-DATA-07a: keyed on the STABLE id, not the display name.
                `key={l.name}` produced three "two children with the same key"
                warnings in Chromium the moment two liabilities shared a name —
                and duplicates are representable in storage. */}
            {liabilities.map((l) => (
              <tr
                key={l.id}
                data-liability-id={l.id}
                className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
              >
                <td className="py-3.5 px-6 font-bold text-gray-900 dark:text-white">{l.name}</td>
                <td className="py-3.5 px-6">
                  <span className="px-2.5 py-1 rounded-full bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400 text-xs font-bold">
                    {l.type || 'Unclassified'}
                  </span>
                </td>
                <td className="py-3.5 px-6 text-gray-600 dark:text-gray-400 text-xs">
                  {l.currency || 'Not Specified'}
                </td>
                <td className="py-3.5 px-6 font-bold text-rose-600 dark:text-rose-400 text-right">
                  <CurrencyValue value={l.amount} />
                </td>
                {showActions && (
                  <td className="py-3.5 px-6 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      {onEdit && (
                        <button
                          type="button"
                          data-liability-edit={l.id}
                          onClick={() => onEdit(l)}
                          title={`Edit ${l.name}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-bold transition"
                        >
                          <Pencil size={13} />
                          <span>Edit</span>
                        </button>
                      )}
                      {onDelete && (
                        <button
                          type="button"
                          data-liability-delete={l.id}
                          onClick={() => onDelete(l)}
                          title={`Delete ${l.name}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-700 dark:text-rose-400 text-xs font-bold transition"
                        >
                          <Trash2 size={13} />
                          <span>Delete</span>
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
