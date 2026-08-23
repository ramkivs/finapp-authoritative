import React, { useState } from 'react';
import { InsurancePolicy } from '../../domain/types';
import { CurrencyValue } from '../CurrencyValue';
import { AddPolicyModal } from './AddPolicyModal';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { Shield, Plus, Trash2, Calendar, CheckCircle2, AlertTriangle } from 'lucide-react';

interface Props {
  policies: InsurancePolicy[];
}

export const InsuranceWorkspace: React.FC<Props> = ({ policies }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const { removePolicy } = useCanonicalLedger();
  /** WP-FB-DATA-08A: which policy's removal is in flight. */
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

  const totalCover = policies
    .filter(p => p.status === 'Active')
    .reduce((sum, p) => sum + p.coverAmount, 0);

  const totalPremium = policies
    .filter(p => p.status === 'Active')
    .reduce((sum, p) => sum + p.premiumAmount, 0);

  const activeCount = policies.filter(p => p.status === 'Active').length;

  /**
   * WP-FB-DATA-08A — a destructive deletion that reports its outcome.
   *
   * Measured at the 08 gate: the write failed, the row stayed on screen and
   * nothing was said; the rejection escaped as an unhandled page error. The
   * confirmation copy is unchanged - only the outcome is now told.
   */
  const handleDelete = async (id: string, provider: string) => {
    if (deleteBusy) {
      setNotice({
        kind: 'error',
        headline: 'One removal at a time.',
        message: 'Another policy is still being removed. Wait for that to finish, then try again.'
      });
      return;
    }
    if (!window.confirm(`Are you sure you want to remove policy from "${provider}"?`)) return;

    setNotice(null);
    setDeleteBusy(id);
    setPendingDelete({
      row: policies.find((x: any) => x.id === id),
      index: Math.max(0, policies.findIndex((x: any) => x.id === id))
    });
    try {
      await removePolicy(id);
      setNotice({ kind: 'success', headline: 'Policy removed.', message: `"${provider}" is gone.` });
    } catch (err: any) {
      setNotice({
        kind: 'error',
        headline: 'Removal refused.',
        message: err?.message || 'The policy could not be removed.'
      });
    } finally {
      setDeleteBusy(null);
      setPendingDelete(null);
    }
  };

  /* The pending row stays on screen, in place, so the list never claims an
     outcome persistence has not given. */
  const visiblePolicies = React.useMemo(() => {
    if (!pendingDelete || !pendingDelete.row) return policies;
    if (policies.some((x: any) => x.id === pendingDelete.row.id)) return policies;
    const merged = [...policies];
    merged.splice(Math.min(pendingDelete.index, merged.length), 0, pendingDelete.row);
    return merged;
  }, [policies, pendingDelete]);

  return (
    <div className="space-y-6">
      {notice && (
        <div
          id="policy-notice"
          data-policy-kind={notice.kind}
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

      {/* Controls Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">
            Insurance Policy Schedule ({policies.length})
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Canonical policy schedule across Term Life and Health Insurance coverages
          </p>
        </div>

        <button
          id="btn-add-policy"
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white font-bold text-xs transition shadow-sm"
        >
          <Plus size={15} />
          <span>+ Add Policy</span>
        </button>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Total Active Coverage
          </span>
          <div className="text-2xl font-black text-gray-900 dark:text-white mt-1">
            <CurrencyValue value={totalCover} />
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {activeCount} Active Policy Lines
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Total Annual Premium
          </span>
          <div className="text-2xl font-black text-cyan-600 dark:text-cyan-400 mt-1">
            <CurrencyValue value={totalPremium} />
            <span className="text-xs font-bold text-gray-500"> / yr</span>
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            Annualized protection commitment
          </span>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block">
            Protection Coverage Health
          </span>
          <div className="text-2xl font-black text-green-700 dark:text-green-400 mt-1">
            {activeCount > 0 ? 'Protected' : 'Uninsured'}
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-1 block">
            {activeCount > 0 ? `${activeCount} verified policy schedules` : 'No active insurance policies'}
          </span>
        </div>
      </div>

      {/* Policies Inventory Table */}
      {policies.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">
            No active insurance policies
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-md mx-auto">
            Record Term Life and Health insurance coverages to track sum-insured schedules, annual premiums, and upcoming renewal dates.
          </p>
          <button
            onClick={() => setModalOpen(true)}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-xs font-bold transition shadow-sm"
          >
            <Plus size={14} />
            <span>+ Add Policy</span>
          </button>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/40 text-gray-400 font-bold uppercase tracking-wider">
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4">Provider / Plan</th>
                  <th className="py-3 px-4">Policy Number</th>
                  <th className="py-3 px-4">Sum Insured</th>
                  <th className="py-3 px-4">Annual Premium</th>
                  <th className="py-3 px-4">Renewal Date</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {visiblePolicies.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition">
                    <td className="py-3 px-4 font-semibold">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        p.type === 'Term Life'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : p.type === 'Health'
                          ? 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                      }`}>
                        {p.type}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-extrabold text-gray-900 dark:text-white">{p.provider}</div>
                      {p.notes && <div className="text-[10px] text-gray-400 mt-0.5">{p.notes}</div>}
                    </td>
                    <td className="py-3 px-4 text-gray-600 dark:text-gray-300 font-mono text-[11px]">
                      {p.policyNumber || <span className="italic text-gray-400">—</span>}
                    </td>
                    <td className="py-3 px-4 font-black text-gray-900 dark:text-white">
                      <CurrencyValue value={p.coverAmount} />
                    </td>
                    <td className="py-3 px-4 font-bold text-gray-700 dark:text-gray-300">
                      <CurrencyValue value={p.premiumAmount} />
                      <span className="text-[10px] text-gray-400 font-normal"> / yr</span>
                    </td>
                    <td className="py-3 px-4 text-gray-600 dark:text-gray-300 font-medium">
                      {p.renewalDate || <span className="italic text-gray-400">—</span>}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        data-policy-delete={p.id}
                        data-policy-delete-busy={deleteBusy === p.id ? 'true' : 'false'}
                        disabled={deleteBusy === p.id}
                        onClick={() => handleDelete(p.id, p.provider)}
                        className="p-1 text-gray-400 hover:text-rose-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        title={deleteBusy === p.id ? `Removing ${p.provider}…` : 'Delete policy'}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AddPolicyModal isOpen={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
};
