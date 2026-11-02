/**
 * D-06-F1-B / D-06-F1-C — persistent closed-positions cleanup surface.
 *
 * Authority: FINBOOM-D-06-F1-BCD-PRODUCT-DECISION-AUTHORITY-REPORT.md
 * (F1-B ACCEPTED, B2 definition; F1-C ACCEPTED, (broker, account) pair key;
 * C-3: brokers without account-bearing Holdings expose NO account-wide
 * control) and FINBOOM-D-06-F1-BC-IMPLEMENTATION-AUTHORITY-REPORT.md
 * (design: single mechanism over the LIVE canonical ledger, opt-in
 * "select all eligible", click-time live re-resolution, service
 * whole-batch rejection as the backstop, audit tags BROKER_WIDE /
 * ACCOUNT_WIDE, NO typed confirmation — F6 remains DEFERRED; NO global
 * scope — F1-D remains DEFERRED).
 *
 * This section is deliberately INDEPENDENT of the transient import
 * ClosureTable/preview surface: it is mounted persistently in the Import
 * tab (placement candidate A, recorded at the execution gate step 0). It
 * owns no mutation logic: every deletion executes through the ratified
 * single engine (commitBatchHoldingDeletion → planDeleteMany →
 * buildAtomicMutationForBatch → one atomic MemoryRepository.write) via the
 * reused BatchDeleteHoldingModal, with only the additive audit-scope tag.
 * NO ASSET EFFECT (D-06-F10-C) holds by construction; wealth impact is the
 * unchanged canonical recompute (D-06-F11 A / INCLUDE).
 */
import React, { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { Holding, HoldingDeletionBatchScope } from '../domain/types';
import { BatchDeleteHoldingModal } from './BrokerImportSection';

/** Sentinel for "no account refinement — broker-wide scope". */
const WHOLE_BROKER = '__BROKER_WIDE__';
const NO_IDS: ReadonlySet<string> = new Set<string>();

export const ClosedPositionsCleanupSection: React.FC = () => {
  // Read-only LIVE canonical subscription (same idiom as the ratified
  // ClosureTable live-status resolution; this component never mutates).
  const holdings = useCanonicalLedger((s) => s.holdings);

  // Scope option lists are derived from the LEDGER (distinct h.broker /
  // per-broker distinct defined h.account strings) — never from the
  // importer's SupportedBroker list and never from FinancialAccount
  // entities (no linkage exists; inventing one is NOT AUTHORIZED).
  const brokerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const h of holdings) set.add(h.broker);
    return Array.from(set).sort();
  }, [holdings]);

  const [pickedBroker, setPickedBroker] = useState<string | null>(null);
  const [pickedAccount, setPickedAccount] = useState<string>(WHOLE_BROKER);
  // Selection keyed to the scope: switching scope structurally drops stale
  // ids — nothing is ever pre-selected or carried across scopes.
  const [selection, setSelection] = useState<{ scopeKey: string; ids: ReadonlySet<string> }>({
    scopeKey: '',
    ids: NO_IDS,
  });
  const [reviewing, setReviewing] = useState(false);

  const broker =
    pickedBroker && brokerOptions.includes(pickedBroker) ? pickedBroker : brokerOptions[0] ?? null;

  // C-3 (ACCEPTED product policy): account-bearing holdings only. A broker
  // whose canonical Holdings carry no defined account string exposes NO
  // account-wide control — the account selector is simply not rendered.
  const accountOptions = useMemo(() => {
    if (broker === null) return [] as string[];
    const set = new Set<string>();
    for (const h of holdings) {
      if (h.broker === broker && typeof h.account === 'string' && h.account.trim() !== '') {
        set.add(h.account);
      }
    }
    return Array.from(set).sort();
  }, [holdings, broker]);

  const accountScoped =
    accountOptions.length > 0 &&
    pickedAccount !== WHOLE_BROKER &&
    accountOptions.includes(pickedAccount);
  const account: string | null = accountScoped ? pickedAccount : null;

  const scopeKey = `${broker ?? ''}::${account ?? ''}`;
  const selectedIds = selection.scopeKey === scopeKey ? selection.ids : NO_IDS;

  // ELIGIBLE SET: LIVE canonical Holdings AND status === 'closed_absent'
  // AND exact scope match. F1-B: broker only. F1-C: (broker, account) pair.
  const eligible = useMemo(
    () =>
      holdings.filter(
        (h) =>
          h.broker === broker &&
          (account === null || h.account === account) &&
          h.status === 'closed_absent',
      ),
    [holdings, broker, account],
  );

  // CONFIRMATION-TIME LIVE RE-RESOLUTION (ratified B-4): the modal receives
  // the live-derived targets on every render, so a row that became active,
  // vanished, or changed broker/account between review and the confirm click
  // drops out of the effective batch — it can never become "silently
  // deletable". Residual races stay the service's job: planDeleteMany
  // re-validates every shipped id against the live ledger and rejects the
  // WHOLE batch on any mismatch (backstop, never weakened).
  const reviewTargets = eligible.filter((h) => selectedIds.has(h.id));
  const selectedCount = reviewTargets.length;
  const aggregate = reviewTargets.reduce((sum, h) => sum + (Number(h.currentValue) || 0), 0);
  const scopeTag: HoldingDeletionBatchScope = account === null ? 'BROKER_WIDE' : 'ACCOUNT_WIDE';

  const toggleId = (id: string, checked: boolean) => {
    setSelection((prev) => {
      const base = prev.scopeKey === scopeKey ? new Set(prev.ids) : new Set<string>();
      if (checked) base.add(id);
      else base.delete(id);
      return { scopeKey, ids: base };
    });
  };

  return (
    <section
      className="rounded-lg border border-[#30363D] bg-[#161B22] p-4 mt-4"
      data-testid="closed-cleanup"
    >
      <h2 className="text-lg font-semibold text-[#F0F6FC] flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-red-400" /> Closed-positions cleanup
      </h2>
      <p className="text-xs text-[#8B949E] mt-1">
        Permanently removes holdings whose live canonical status is closed_absent, scoped by broker
        (D-06-F1-B) or by broker + account (D-06-F1-C). Selection is always explicit — rows are never
        pre-selected and “select all” is an opt-in action. Each confirmed batch is atomic, audited,
        and cannot be undone.
      </p>

      {broker === null ? (
        <div className="mt-3 text-sm text-[#8B949E]" data-testid="closed-cleanup-empty">
          No holdings are recorded in the ledger — nothing to clean up.
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-[#8B949E]">
              Broker
              <select
                className="bg-[#0D1117] border border-[#30363D] rounded px-2 py-1 text-[#F0F6FC]"
                data-testid="closed-cleanup-broker"
                value={broker}
                onChange={(e) => {
                  setPickedBroker(e.target.value);
                  // Scope change resets the account refinement to broker-wide
                  // and (via scopeKey) drops any prior selection.
                  setPickedAccount(WHOLE_BROKER);
                  setReviewing(false);
                }}
              >
                {brokerOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            {accountOptions.length > 0 && (
              <label className="flex items-center gap-2 text-[#8B949E]">
                Account
                <select
                  className="bg-[#0D1117] border border-[#30363D] rounded px-2 py-1 text-[#F0F6FC]"
                  data-testid="closed-cleanup-account"
                  value={pickedAccount}
                  onChange={(e) => {
                    setPickedAccount(e.target.value);
                    setReviewing(false);
                  }}
                >
                  <option value={WHOLE_BROKER}>All accounts (broker-wide)</option>
                  {accountOptions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="text-xs font-mono text-[#8B949E]" data-testid="closed-cleanup-scope-label">
              {account === null ? `Broker-wide: ${broker}` : `Account scope: ${broker} · ${account}`}
            </span>
          </div>

          {eligible.length === 0 ? (
            // Zero-eligible policy (ACCEPTED): informational state ONLY —
            // no destructive control is rendered.
            <div className="mt-3 text-sm text-[#8B949E]" data-testid="closed-cleanup-empty">
              No closed positions are eligible for permanent cleanup in this scope.
            </div>
          ) : (
            <>
              <table className="mt-3 w-full text-left text-xs">
                <thead className="text-[#8B949E]">
                  <tr>
                    <th className="p-1.5 w-6"></th>
                    <th className="p-1.5">Instrument</th>
                    <th className="p-1.5">Account</th>
                    <th className="p-1.5">Current value</th>
                    <th className="p-1.5">Source file</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#21262D] text-[#F0F6FC]">
                  {eligible.map((h) => (
                    <tr key={h.id} data-testid={`closed-cleanup-row-${h.id}`}>
                      <td className="p-1.5">
                        <input
                          type="checkbox"
                          data-testid={`closed-cleanup-check-${h.id}`}
                          checked={selectedIds.has(h.id)}
                          onChange={(e) => toggleId(h.id, e.target.checked)}
                          aria-label={`Select ${h.instrumentName} for permanent deletion`}
                        />
                      </td>
                      <td className="p-1.5">{h.instrumentName}</td>
                      <td className="p-1.5 font-mono">{h.account ?? '—'}</td>
                      <td className="p-1.5 font-mono">
                        {h.currentValue.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="p-1.5 font-mono text-[#8B949E]">{h.sourceFile}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  data-testid="closed-cleanup-select-all"
                  onClick={() => setSelection({ scopeKey, ids: new Set(eligible.map((h) => h.id)) })}
                  className="px-2 py-0.5 rounded bg-[#21262D] text-[#F0F6FC] text-xs font-medium hover:bg-[#30363D]"
                >
                  Select all eligible ({eligible.length})
                </button>
                {selectedCount > 0 && (
                  <>
                    <span className="text-xs text-red-200" data-testid="closed-cleanup-selected-count">
                      {selectedCount} closed_absent holding{selectedCount === 1 ? '' : 's'} selected
                      {' · total '}
                      {aggregate.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                    <button
                      type="button"
                      data-testid="closed-cleanup-delete"
                      onClick={() => setReviewing(true)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-700 text-white text-xs font-medium hover:bg-red-600"
                      title="Review and permanently delete the selected closed_absent holdings (D-06-F1-B/C)"
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
              batchScope={scopeTag}
              onClose={() => setReviewing(false)}
              onDeleted={() => {
                setReviewing(false);
                // Rows are gone from the live ledger; reset explicitly so no
                // stale ids linger in the (now smaller) selection.
                setSelection({ scopeKey, ids: NO_IDS });
              }}
            />
          )}
        </>
      )}
    </section>
  );
};
