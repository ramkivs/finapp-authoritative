import React, { useState } from 'react';
import { Liability } from '../../domain/types';
import { LiabilityTable } from './LiabilityTable';
import { AddLiabilityModal } from './AddLiabilityModal';
import { EditLiabilityModal } from './EditLiabilityModal';
import { CurrencyValue } from '../CurrencyValue';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { LiabilityLifecycleService } from '../../services/LiabilityLifecycleService';
import { Plus } from 'lucide-react';

interface Props {
  liabilities: Liability[];
}

/**
 * WP-FB-DATA-07c — notices follow the established lifecycle convention:
 * a bold headline saying WHAT happened, then the detail. Import History and the
 * Money ledger already read "Import rolled back." / "Correction refused." and
 * liabilities were the odd surface out with message-only notices.
 */
type Notice = { kind: 'success' | 'error'; headline: string; message: string };

export const LiabilitiesWorkspace: React.FC<Props> = ({ liabilities }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Liability | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * WP-FB-DATA-07c / F-07b-2 — which row's delete is in flight.
   *
   * Delete used to leave every control live while its write was pending, so a
   * second click — on the same row or another — could start an overlapping
   * write. That was the most reachable trigger for the rollback race closed in
   * this package. Per-row, exactly like Import History's rollbackBusy.
   */
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  /**
   * The row whose delete is pending, kept so it stays VISIBLE until persistence
   * settles.
   *
   * Repository writes are optimistic: memory drops the row the instant delete
   * is called. Without this, the row vanished immediately and reappeared if the
   * write failed — the UI announcing a completed deletion before storage had
   * agreed to it. Now it stays on screen, disabled and labelled "Deleting…",
   * and only leaves when the write actually succeeds.
   */
  const [pendingDelete, setPendingDelete] = useState<{ row: Liability; index: number } | null>(null);
  const { removeLiability } = useCanonicalLedger();
  const totDebt = liabilities.reduce((s, l) => s + l.amount, 0);

  /**
   * WP-FB-DATA-07a — DELETE (Q-D07a-3 = (b)).
   *
   * This is the product's first irreversible destructive operation, so the
   * confirmation quotes the exact name AND amount, and declining writes
   * nothing at all. The call is AWAITED: a refusal (the row is already gone)
   * or a persistence failure is rendered rather than swallowed.
   */
  const handleDelete = async (liability: Liability) => {
    /* One delete at a time.
     *
     * The pending row's own control is disabled, but every other row's stays
     * live, so this guard is the thing that actually prevents two overlapping
     * destructive writes — the most reachable trigger for the rollback race
     * closed in this package. It refuses out loud: a control that silently
     * does nothing is exactly the defect WP-21 left on the dashboard. */
    if (deleteBusy) {
      setNotice({
        kind: 'error',
        headline: 'One delete at a time.',
        message: 'Another liability is still being deleted. Wait for that to finish, then try again.'
      });
      return;
    }
    const confirmed = window.confirm(LiabilityLifecycleService.describeDeletion(liability));
    if (!confirmed) return;
    setNotice(null);
    setDeleteBusy(liability.id as string);
    setPendingDelete({
      row: liability,
      index: Math.max(0, liabilities.findIndex(l => l.id === liability.id))
    });
    try {
      await removeLiability(liability.id as string);
      setNotice({
        kind: 'success',
        headline: 'Liability deleted.',
        message: `"${liability.name}" is no longer part of your net worth.`
      });
    } catch (err: any) {
      setNotice({
        kind: 'error',
        headline: 'Delete refused.',
        message: err?.message || 'The liability could not be deleted.'
      });
    } finally {
      // Re-enabled on success AND on failure — a control stuck disabled after a
      // refusal would be its own defect.
      setDeleteBusy(null);
      setPendingDelete(null);
    }
  };

  /* While a delete is in flight the row is still shown, in its original
     position, so the table never claims an outcome persistence has not given. */
  const visibleLiabilities = React.useMemo(() => {
    if (!pendingDelete) return liabilities;
    if (liabilities.some(l => l.id === pendingDelete.row.id)) return liabilities;
    const merged = [...liabilities];
    merged.splice(Math.min(pendingDelete.index, merged.length), 0, pendingDelete.row);
    return merged;
  }, [liabilities, pendingDelete]);

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-5 rounded-2xl shadow-sm">
        <div>
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Active Credit Facilities & Loans</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Reconciled debt obligations across 9 loan classifications</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <span className="text-[11px] text-gray-500 dark:text-gray-400 font-bold block uppercase">Total Debt Obligation</span>
            <span className="text-base font-extrabold text-rose-600 dark:text-rose-400">
              <CurrencyValue value={totDebt} />
            </span>
          </div>

          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white font-bold text-xs transition shadow-sm"
          >
            <Plus size={15} />
            <span>Add Liability</span>
          </button>
        </div>
      </div>

      {notice && (
        <div
          id="liability-notice"
          data-liability-kind={notice.kind}
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

      {visibleLiabilities.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-12 text-center shadow-sm">
          <div className="text-base font-bold text-gray-900 dark:text-white">No liabilities recorded</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 max-w-sm mx-auto">
            Add a liability to calculate your net worth accurately. Track mortgages, vehicle loans, personal loans, and credit cards.
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-5 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white text-xs font-bold transition shadow-sm"
          >
            <Plus size={14} />
            <span>Add Liability</span>
          </button>
        </div>
      ) : (
        <LiabilityTable
          liabilities={visibleLiabilities}
          deleteBusyId={deleteBusy}
          onEdit={(l) => { setNotice(null); setEditing(l); }}
          onDelete={handleDelete}
        />
      )}

      <AddLiabilityModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={(message) => setNotice({ kind: 'success', headline: 'Liability added.', message })}
      />

      <EditLiabilityModal
        liability={editing}
        onClose={() => setEditing(null)}
        onSaved={(message) => setNotice({ kind: 'success', headline: 'Liability saved.', message })}
      />
    </div>
  );
};
