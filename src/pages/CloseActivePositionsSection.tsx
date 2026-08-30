/**
 * D-06-F2-A — user-initiated CLOSE pathway (not a deletion surface).
 *
 * Authority: FINBOOM-D-06-F2-PRODUCT-DECISION-AUTHORITY-REPORT.md (F2-A
 * accepted: active → closed_absent transition feeding the EXISTING deletion
 * machinery) + FINBOOM-D-06-F2-IMPLEMENTATION-AUTHORITY-REPORT.md (§3–§5
 * boundary). This component closes nothing permanently: it transitions live
 * ACTIVE Holdings to `closed_absent` through the unmodified promoted
 * lifecycle planner (store action `commitUserCloses`).
 *
 * Ratified behavior: persistent Import-page section; eligibility is the LIVE
 * canonical status predicate `status === 'active'` only (never an import
 * preview); selection is explicit — never auto-selected, Select-All is an
 * opt-in over the current live set; zero-eligible renders an informational
 * state with NO actionable control; review enumerates the complete effective
 * batch (no cap) with count + aggregate; two-stage review → confirm; NO
 * typed confirmation (F6 remains GLOBAL-only by ratified decision — applying
 * it here would itself be a product decision); no reopen affordance (a later
 * broker import reactivates still-reported rows — the honest, ratified
 * lifecycle; there is deliberately no tombstone/suppression state); no
 * close-event audit and no reason capture (product decision C); no new
 * persisted state or schema (DB_VERSION 7 stands).
 */
import React, { useMemo, useState } from 'react';
import { CheckSquare } from 'lucide-react';

import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { Holding } from '../domain/types';

const NO_IDS: ReadonlySet<string> = new Set<string>();

type Stage = 'review' | 'confirm';

interface CloseReviewModalProps {
  /** The parent's live-reconciled effective selection (active ∩ selected). */
  targets: readonly Holding[];
  onCancel: () => void;
  onClosed: () => void;
}

/**
 * F2's own two-stage modal. It intentionally does NOT reuse or touch
 * BatchDeleteHoldingModal (a pinned F1-A/B/C/D deletion surface with the
 * closed_absent filter and the F6 typed gate): this action is a status
 * transition, its copy must not imply deletion, and its confirmation is
 * two-stage WITHOUT a typed gate (F6 non-applicability is a ratified
 * product decision). There is no <form> and no text input anywhere in this
 * component, so Enter cannot submit anything; the confirm action is guarded
 * in its handler, not only on the button.
 */
const CloseReviewModal: React.FC<CloseReviewModalProps> = ({ targets, onCancel, onClosed }) => {
  const [stage, setStage] = useState<Stage>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defensive live re-derivation inside the modal (mirrors the ratified
  // architecture): rows that stopped being active since the parent rendered
  // are excluded here, and the store re-validates everything again at commit.
  const live = targets.filter((h) => h.status === 'active');
  const aggregate = live.reduce((sum, h) => sum + (Number(h.currentValue) || 0), 0);

  const handleConfirm = () => {
    if (busy) return;
    if (live.length === 0) {
      // Fail-closed zero-guard: an empty effective batch never reaches the
      // store; there is no whole-ledger or no-op path.
      setError('Nothing can be closed right now; the selected rows are no longer active.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { persisted } = useCanonicalLedger.getState().commitUserCloses(live.map((h) => h.id));
      persisted
        .then(() => {
          setBusy(false);
          onClosed();
        })
        .catch((e: unknown) => {
          setBusy(false);
          setError(
            `The close could not be saved; your ledger is unchanged. ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
    } catch (e) {
      // Whole-batch validation failure (NOT_FOUND / ALREADY_CLOSED for a
      // row that drifted or a duplicate id). NOTHING was changed — no
      // partial close exists by construction.
      setBusy(false);
      setError(
        `Close rejected for the whole batch; nothing was changed. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      data-testid="close-positions-modal"
      data-stage={stage}
    >
      <div className="w-full max-w-lg rounded-lg border border-[#30363D] bg-[#0D1117] p-4">
        <h3 className="text-base font-semibold text-[#F0F6FC]">
          {stage === 'review' ? 'Review close' : 'Confirm close — this changes status, it does not delete'}
        </h3>
        <p className="mt-1 text-xs text-[#8B949E]" data-testid="close-positions-modal-count">
          {live.length} active holding{live.length === 1 ? '' : 's'} will be marked
          closed_absent · total {aggregate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
        <p className="mt-2 text-xs text-[#F0F6FC]" data-testid="close-positions-modal-disclosure">
          This action does NOT delete anything. A later broker import that still
          reports these positions will reactivate them; if a position is later
          permanently deleted (a separate, audited action), a reappearing import
          row is classified as new. Closing only makes rows eligible for the
          closed-positions cleanup.
        </p>
        <ul className="mt-3 max-h-48 overflow-auto rounded border border-[#21262D]">
          {live.map((h) => (
            <li
              key={h.id}
              className="flex justify-between px-2 py-1 text-xs text-[#F0F6FC]"
              data-testid={`close-positions-modal-row-${h.id}`}
            >
              <span>
                {h.instrumentName} <span className="text-[#8B949E]">({h.broker}{h.account ? ` · ${h.account}` : ''})</span>
              </span>
              <span className="font-mono">
                {(Number(h.currentValue) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </li>
          ))}
        </ul>
        {error && (
          <p className="mt-2 text-xs text-red-300" data-testid="close-positions-modal-error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {stage === 'review' ? (
            <>
              <button
                type="button"
                className="rounded border border-[#30363D] px-3 py-1.5 text-sm text-[#F0F6FC]"
                data-testid="close-positions-modal-cancel"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-[#1F6FEB] px-3 py-1.5 text-sm font-semibold text-white"
                data-testid="close-positions-modal-next"
                onClick={() => setStage('confirm')}
                disabled={live.length === 0}
              >
                Review {live.length} to close…
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="rounded border border-[#30363D] px-3 py-1.5 text-sm text-[#F0F6FC]"
                data-testid="close-positions-modal-back"
                onClick={() => {
                  setStage('review');
                  setError(null);
                }}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="rounded border border-[#30363D] px-3 py-1.5 text-sm text-[#F0F6FC]"
                data-testid="close-positions-modal-cancel-confirm"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-[#9E6A03] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                data-testid="close-positions-modal-confirm"
                onClick={handleConfirm}
                disabled={busy || live.length === 0}
                title="Mark the reviewed active holdings as closed_absent (D-06-F2-A)"
              >
                Mark {live.length} holding{live.length === 1 ? '' : 's'} as closed
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const CloseActivePositionsSection: React.FC = () => {
  // Read-only LIVE canonical subscription — same ratified idiom as the
  // F1-B/C/D surfaces. This component mutates nothing itself.
  const holdings = useCanonicalLedger((s) => s.holdings);

  // F2 eligibility: LIVE `active` rows only — no broker/account predicate,
  // never an import preview, no cap.
  const eligible = useMemo(() => holdings.filter((h) => h.status === 'active'), [holdings]);

  // Selection is component state only (never persisted). The effective batch
  // is re-resolved against the LIVE eligible set on every render (ratified
  // B-4 policy): rows that became closed_absent or vanished drop out — they
  // can never be closed on a stale selection, and rows never auto-select.
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_IDS);
  const [reviewing, setReviewing] = useState(false);
  const reviewTargets = eligible.filter((h) => selected.has(h.id));
  const selectedCount = reviewTargets.length;
  const aggregate = reviewTargets.reduce((sum, h) => sum + (Number(h.currentValue) || 0), 0);

  const toggleId = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(eligible.map((h) => h.id)));

  return (
    <section
      className="rounded-lg border border-amber-900/60 bg-[#161B22] p-4 mt-4"
      data-testid="close-positions-section"
    >
      <h2 className="text-lg font-semibold text-[#F0F6FC] flex items-center gap-2">
        <CheckSquare className="w-4 h-4 text-amber-400" /> Close active positions (feeds the closed-positions cleanup)
      </h2>
      <p className="text-xs text-[#8B949E] mt-1">
        Marks selected ACTIVE holdings as closed_absent across the whole ledger (D-06-F2-A — a
        status change, not a deletion). Rows are never pre-selected; “select all” is an explicit
        opt-in over the current live active set. A later broker import that still reports a closed
        position reactivates it. Permanent deletion remains a separate, audited action available
        only for closed positions.
      </p>

      {holdings.length === 0 ? (
        <div className="mt-3 text-sm text-[#8B949E]" data-testid="close-positions-empty">
          The ledger holds no records — nothing to close.
        </div>
      ) : eligible.length === 0 ? (
        // Zero-eligible policy (inherited): informational state ONLY — no
        // actionable control is rendered.
        <div className="mt-3 text-sm text-[#8B949E]" data-testid="close-positions-empty">
          No active positions are eligible for closing right now.
        </div>
      ) : (
        <>
          <div className="mt-3 text-xs font-mono text-[#8B949E]" data-testid="close-positions-scope-label">
            Whole ledger · {eligible.length} active holding{eligible.length === 1 ? '' : 's'}
          </div>

          <table className="mt-3 w-full text-left text-xs">
            <thead className="text-[#8B949E]">
              <tr>
                <th className="p-1.5 w-6"></th>
                <th className="p-1.5">Instrument</th>
                <th className="p-1.5">Broker</th>
                <th className="p-1.5">Account</th>
                <th className="p-1.5">Current value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262D] text-[#F0F6FC]">
              {eligible.map((h) => (
                <tr key={h.id} data-testid={`close-positions-row-${h.id}`}>
                  <td className="p-1.5">
                    <input
                      type="checkbox"
                      data-testid={`close-positions-check-${h.id}`}
                      checked={selected.has(h.id)}
                      onChange={(e) => toggleId(h.id, e.target.checked)}
                      aria-label={`Mark ${h.instrumentName} (${h.broker}) as closed`}
                    />
                  </td>
                  <td className="p-1.5">{h.instrumentName}</td>
                  <td className="p-1.5">{h.broker}</td>
                  <td className="p-1.5">{h.account ?? '—'}</td>
                  <td className="p-1.5 text-right font-mono">
                    {(Number(h.currentValue) || 0).toLocaleString('en-IN', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className="rounded border border-[#30363D] px-2 py-1 text-xs text-[#F0F6FC]"
              data-testid="close-positions-select-all"
              onClick={selectAll}
            >
              Select all active ({eligible.length})
            </button>
            {selectedCount > 0 && (
              <>
                <span className="text-xs text-amber-200" data-testid="close-positions-selected-count">
                  {selectedCount} active holding{selectedCount === 1 ? '' : 's'} selected
                  {' · total '}
                  {aggregate.toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <button
                  type="button"
                  className="rounded bg-[#9E6A03] px-2.5 py-1 text-xs font-semibold text-white"
                  data-testid="close-positions-open"
                  onClick={() => setReviewing(true)}
                  title="Review marking the selected active holdings as closed_absent (D-06-F2-A)"
                >
                  <CheckSquare className="inline w-3 h-3 mr-1" /> Close {selectedCount} selected…
                </button>
              </>
            )}
          </div>
        </>
      )}

      {reviewing && (
        <CloseReviewModal
          targets={reviewTargets}
          onCancel={() => setReviewing(false)}
          onClosed={() => {
            setReviewing(false);
            // Rows left the live active set; reset so no stale ids remain.
            setSelected(NO_IDS);
          }}
        />
      )}
    </section>
  );
};
