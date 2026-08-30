/**
 * D-06-F1-D — persistent WHOLE-LEDGER (GLOBAL) closed-positions cleanup.
 *
 * Authority: FINBOOM-D-06-F6-F1D-IMPLEMENTATION-AUTHORITY-REPORT.md
 * (§5 product contract ACCEPTED; §6 boundary — a SEPARATE component is
 * architecturally forced because the promoted F1-B/C surface pins its DOM;
 * this file adds zero behavior to MULTI_SELECT/BROKER_WIDE/ACCOUNT_WIDE —
 * NO retro-fit). Eligible set = every LIVE canonical Holding with
 * status === 'closed_absent', across ALL brokers and accounts; Holdings with
 * no defined account are included (no C-3 analogue — universality is
 * inclusion by definition). Selection is always explicit; "select all" is an
 * opt-in action over the current live eligible set; zero eligible renders an
 * informational state with NO destructive control; review enumerates the
 * complete effective batch (no cap).
 *
 * F6 (ACCEPTED, GLOBAL-only): the final confirmation additionally requires
 * TYPING THE LIVE EFFECTIVE COUNT (Option D). The count is re-derived at the
 * confirmation boundary; any drift re-locks the typed gate. Wrong/empty input
 * can never submit; Enter is inert (no form submit path exists).
 *
 * Deletion executes through the ONE ratified engine — BatchDeleteHoldingModal
 * → commitBatchHoldingDeletion(ids, 'GLOBAL') → planDeleteMany →
 * buildAtomicMutationForBatch → one atomic MemoryRepository.write. Audit:
 * per-row entries, shared `hdlb-*` batchId, batchScope 'GLOBAL', broker/
 * account attribution from the live ledger per row. No new engine, no
 * migration (DB_VERSION 7), no selection persistence, no asset effect
 * (F10-C); wealth impact is the unchanged canonical recompute (F11 A/INCLUDE).
 */
import React, { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { Holding } from '../domain/types';
import { BatchDeleteHoldingModal } from './BrokerImportSection';

const NO_IDS: ReadonlySet<string> = new Set<string>();

export const GlobalLedgerCleanupSection: React.FC = () => {
  // Read-only LIVE canonical subscription — same ratified idiom as the
  // F1-B/C surface. This component never mutates anything itself.
  const holdings = useCanonicalLedger((s) => s.holdings);

  // GLOBAL eligibility: status predicate ONLY. No broker/account filtering;
  // undefined-account Holdings are included by universality.
  const eligible = useMemo(
    () => holdings.filter((h) => h.status === 'closed_absent'),
    [holdings],
  );

  // Selection lives ONLY here (component state) — never persisted. Rebuilt
  // against the live eligible set on scope changes elsewhere via the
  // reviewTargets intersection below; rows can never be deleted while
  // stale-selected, and rows never auto-select (mount ids: empty set).
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_IDS);
  const [reviewing, setReviewing] = useState(false);

  // Reconciliation + confirmation-time re-resolution (ratified B-4 policy,
  // inherited): the effective batch is selection ∩ LIVE eligible, recomputed
  // on every render. A row that became active or vanished mid-flow simply
  // drops out — it is NEVER deleted on a stale selection. Broker/account
  // changes do not affect GLOBAL eligibility in either direction (no scope
  // predicate exists to broaden or restrict).
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
      className="rounded-lg border border-red-900/60 bg-[#161B22] p-4 mt-4"
      data-testid="global-cleanup"
    >
      <h2 className="text-lg font-semibold text-[#F0F6FC] flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-red-400" /> Whole-ledger cleanup (entire ledger — all
        brokers)
      </h2>
      <p className="text-xs text-[#8B949E] mt-1">
        Permanently removes EVERY holdings record whose live canonical status is closed_absent,
        across all brokers and accounts (D-06-F1-D, whole-ledger scope). Rows are never
        pre-selected; “select all” is an explicit opt-in over the current live set. This scope
        additionally requires typing the live count to confirm. Each confirmed batch is atomic,
        audited with GLOBAL attribution, and cannot be undone.
      </p>

      {holdings.length === 0 ? (
        <div className="mt-3 text-sm text-[#8B949E]" data-testid="global-cleanup-empty">
          The ledger holds no records — nothing to clean up.
        </div>
      ) : eligible.length === 0 ? (
        // Zero-eligible policy (inherited): informational state ONLY — no
        // destructive control is rendered.
        <div className="mt-3 text-sm text-[#8B949E]" data-testid="global-cleanup-empty">
          No closed positions are eligible for permanent whole-ledger cleanup right now.
        </div>
      ) : (
        <>
          <div className="mt-3 text-xs font-mono text-[#8B949E]" data-testid="global-cleanup-scope-label">
            Whole ledger · {eligible.length} eligible closed_absent holding{eligible.length === 1 ? '' : 's'}
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
                <tr key={h.id} data-testid={`global-cleanup-row-${h.id}`}>
                  <td className="p-1.5">
                    <input
                      type="checkbox"
                      data-testid={`global-cleanup-check-${h.id}`}
                      checked={selected.has(h.id)}
                      onChange={(e) => toggleId(h.id, e.target.checked)}
                      aria-label={`Select ${h.instrumentName} (${h.broker}) for permanent whole-ledger deletion`}
                    />
                  </td>
                  <td className="p-1.5">{h.instrumentName}</td>
                  <td className="p-1.5 font-mono">{h.broker}</td>
                  <td className="p-1.5 font-mono">{h.account ?? '—'}</td>
                  <td className="p-1.5 font-mono">
                    {h.currentValue.toLocaleString('en-IN', {
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
              data-testid="global-cleanup-select-all"
              onClick={selectAll}
              className="px-2 py-0.5 rounded bg-[#21262D] text-[#F0F6FC] text-xs font-medium hover:bg-[#30363D]"
            >
              Select all eligible ({eligible.length})
            </button>
            {selectedCount > 0 && (
              <>
                <span className="text-xs text-red-200" data-testid="global-cleanup-selected-count">
                  {selectedCount} closed_absent holding{selectedCount === 1 ? '' : 's'} selected
                  {' · total '}
                  {aggregate.toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <button
                  type="button"
                  data-testid="global-cleanup-delete"
                  onClick={() => setReviewing(true)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-700 text-white text-xs font-medium hover:bg-red-600"
                  title="Review and permanently delete the selected closed_absent holdings across the whole ledger (D-06-F1-D)"
                >
                  <Trash2 className="w-3 h-3" /> Delete {selectedCount} selected permanently…
                </button>
              </>
            )}
          </div>
        </>
      )}

      {reviewing && (
        <BatchDeleteHoldingModal
          holdings={reviewTargets}
          batchScope="GLOBAL"
          typedConfirmExpectedCount={reviewTargets.length}
          onClose={() => setReviewing(false)}
          onDeleted={() => {
            setReviewing(false);
            // Rows are gone from the live ledger; reset so no stale ids remain.
            setSelected(NO_IDS);
          }}
        />
      )}
    </section>
  );
};
