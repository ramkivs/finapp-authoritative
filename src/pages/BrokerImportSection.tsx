/**
 * WP-FB-IMPORT-BROKER-01 — WP-08 broker-import section.
 *
 * A React component that implements the broker-import flow on top of the
 * existing `BrokerImportService` and the `useCanonicalLedger.commitImportedHoldings`
 * hook. The component is designed to be embedded inside `ImportPage.tsx`
 * (or any other page) as a self-contained section.
 *
 * Flow:
 *   UPLOAD → DETECT → PARSE → PREVIEW → CONFIRM / CANCEL → COMMIT
 *
 * Preview state is transient React state (useState). The canonical `Holding`
 * collection is only updated when the user clicks "Confirm import" — never
 * during upload, detect, parse, reconcile, or preview.
 *
 * The component is read-only with respect to the store's `holdings` slice
 * during preview (it reads it via `getState()` at preview-build time, but
 * does not mutate it). The commit step is the only mutation.
 */

import React, { useRef, useState } from 'react';
import { Upload, CheckCircle2, AlertTriangle, XCircle, FileText, ChevronDown, ChevronUp, ShieldAlert, Trash2 } from 'lucide-react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { BrokerImportService, BrokerImportPreview, BrokerImportPreviewEntry, BrokerImportPreviewClosure } from '../services/BrokerImportService';
import { ImportRowIssue, StatementInput } from '../services/import/ImportTypes';
import { Holding } from '../domain/types';

interface CommitNotice {
  kind: 'success' | 'error';
  text: string;
}

/** Returns true if the filename has a native binary spreadsheet extension. */
function isBinarySpreadsheet(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.xls') || lower.endsWith('.xlsx');
}

export const BrokerImportSection: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { holdings, commitImportedHoldings } = useCanonicalLedger();

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BrokerImportPreview | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [commitNotice, setCommitNotice] = useState<CommitNotice | null>(null);
  const [showParserIssues, setShowParserIssues] = useState(false);

  /**
   * Read the selected file, detect + parse, and produce a preview.
   * On failure, surface the error in `rawError`. The preview state
   * is set on success.
   */
  const handleFileChosen = async (file: File) => {
    setBusy(true);
    setRawError(null);
    setCommitNotice(null);
    setPreview(null);
    try {
      const input: StatementInput = isBinarySpreadsheet(file.name)
        ? { kind: 'binary', content: new Uint8Array(await file.arrayBuffer()), fileName: file.name }
        : { kind: 'text', content: await file.text(), fileName: file.name };
      const parsed = BrokerImportService.detectAndParse(input);
      // Capture the live `holdings` slice at preview-build time. The
      // preview is a snapshot; subsequent changes to the store do
      // not retroactively mutate the preview.
      const liveHoldings = holdings;
      const pv = BrokerImportService.reconcile(parsed, liveHoldings);
      setPreview(pv);
    } catch (e) {
      setRawError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Cancel the preview. No mutation to the store. Discard the preview.
   */
  const handleCancel = () => {
    setPreview(null);
    setRawError(null);
    setCommitNotice(null);
    setShowParserIssues(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  /**
   * Confirm the preview. Commits the parsed Holdings atomically via the
   * store hook. Surfaces success or failure.
   */
  const handleConfirm = () => {
    if (!preview) return;
    setBusy(true);
    setCommitNotice(null);
    try {
      const outcome = commitImportedHoldings(preview.entries.map((e) => e.candidate));
      // outcome.persisted is the atomic write promise. Await it so we can
      // render the success/failure state correctly.
      if (outcome.persisted) {
        outcome.persisted
          .then(() => {
            setCommitNotice({
              kind: 'success',
              text:
                `Imported ${preview.counts.new} new, ${preview.counts.updated} updated, ` +
                `${preview.counts.closed_absent} closed-absent, ${preview.counts.unchanged} unchanged.`,
            });
            setBusy(false);
            // Clear the preview so the user can start a new import.
            setPreview(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
          })
          .catch((e: unknown) => {
            setCommitNotice({
              kind: 'error',
              text: e instanceof Error ? e.message : String(e),
            });
            setBusy(false);
          });
      } else {
        // No persistence was attempted (e.g. an all-UNCHANGED preview). This
        // should not happen because confirmationEligible is required for the
        // confirm button to be enabled, but be defensive.
        setCommitNotice({ kind: 'error', text: 'No persistence was attempted.' });
        setBusy(false);
      }
    } catch (e) {
      setCommitNotice({
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (preview) {
    return (
      <PreviewView
        preview={preview}
        busy={busy}
        commitNotice={commitNotice}
        showParserIssues={showParserIssues}
        onToggleParserIssues={() => setShowParserIssues((v) => !v)}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );
  }

  return (
    <UploadView
      fileInputRef={fileInputRef}
      busy={busy}
      rawError={rawError}
      onFileChosen={handleFileChosen}
    />
  );
};

// ---------------------------------------------------------------------------
// Sub-views (kept in the same file to avoid splitting UI state across files)
// ---------------------------------------------------------------------------

const UploadView: React.FC<{
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  rawError: string | null;
  onFileChosen: (file: File) => void;
}> = ({ fileInputRef, busy, rawError, onFileChosen }) => {
  return (
    <section className="rounded-lg border border-[#30363D] bg-[#161B22] p-4 mt-6">
      <h2 className="text-lg font-semibold text-[#F0F6FC] flex items-center gap-2">
        <FileText className="w-4 h-4" /> Broker Import (Zerodha / Groww / Dhan)
      </h2>
      <p className="text-sm text-[#8B949E] mt-2">
        Upload a broker holdings file. Detection is content-based — filename is
        not required. Supported: Zerodha Equity CSV, Groww Stocks XLSX, Groww
        Mutual Funds XLSX, Dhan Equity CSV, Dhan Mutual Funds CSV/XLSX.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) onFileChosen(f);
          }}
          className="block w-full text-sm text-[#F0F6FC] file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-[#21262D] file:text-[#F0F6FC] hover:file:bg-[#30363D] disabled:opacity-50"
        />
        {busy && (
          <span className="text-sm text-[#8B949E] flex items-center gap-1">
            <Upload className="w-3 h-3 animate-pulse" /> Parsing...
          </span>
        )}
      </div>
      {rawError && (
        <div className="mt-3 rounded border border-red-700 bg-red-900/30 p-3 flex items-start gap-2">
          <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-200">
            <div className="font-semibold">Detection or parse failed</div>
            <div className="text-red-300/80 text-xs mt-1 font-mono break-all">{rawError}</div>
          </div>
        </div>
      )}
    </section>
  );
};

const PreviewView: React.FC<{
  preview: BrokerImportPreview;
  busy: boolean;
  commitNotice: CommitNotice | null;
  showParserIssues: boolean;
  onToggleParserIssues: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ preview, busy, commitNotice, showParserIssues, onToggleParserIssues, onConfirm, onCancel }) => {
  const canConfirm = preview.confirmationEligible && !busy;
  return (
    <section className="rounded-lg border border-[#30363D] bg-[#161B22] p-4 mt-6">
      <h2 className="text-lg font-semibold text-[#F0F6FC] flex items-center gap-2">
        <ShieldAlert className="w-4 h-4" /> Broker Import — Preview
      </h2>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-[#8B949E]">
        <div>
          <span className="text-[#8B949E]">Broker:</span>{' '}
          <span className="text-[#F0F6FC] font-mono">{preview.broker}</span>
        </div>
        <div>
          <span className="text-[#8B949E]">Source file:</span>{' '}
          <span className="text-[#F0F6FC] font-mono">{preview.sourceFile}</span>
        </div>
        <div>
          <span className="text-[#8B949E]">Account:</span>{' '}
          <span className="text-[#F0F6FC] font-mono">
            {preview.account === undefined ? '(undefined — Dhan Equity)' : preview.account}
          </span>
        </div>
        <div>
          <span className="text-[#8B949E]">Imported at:</span>{' '}
          <span className="text-[#F0F6FC] font-mono text-xs">{preview.importedAt}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <CountChip label="NEW" n={preview.counts.new} tone="green" />
        <CountChip label="UPDATED" n={preview.counts.updated} tone="amber" />
        <CountChip label="UNCHANGED" n={preview.counts.unchanged} tone="slate" />
        <CountChip label="CLOSED_ABSENT" n={preview.counts.closed_absent} tone="red" />
      </div>

      {preview.entries.length > 0 && (
        <EntryTable title="Parsed entries" entries={preview.entries} />
      )}
      {preview.closures.length > 0 && (
        <ClosureTable title="Closures (will transition to closed_absent)" closures={preview.closures} />
      )}

      {preview.issues.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onToggleParserIssues}
            className="flex items-center gap-1 text-sm text-[#8B949E] hover:text-[#F0F6FC]"
          >
            {showParserIssues ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Parser issues ({preview.issues.length})
          </button>
          {showParserIssues && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded border border-[#30363D] bg-[#0D1117] p-2">
              {preview.issues.map((i: ImportRowIssue, idx: number) => (
                <div key={idx} className="text-xs font-mono text-[#8B949E] py-0.5">
                  R{i.rowNumber} [{i.code}] {i.field ? `${i.field}: ` : ''}{i.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {commitNotice && (
        <div
          className={`mt-4 rounded border p-3 flex items-start gap-2 ${
            commitNotice.kind === 'success'
              ? 'border-green-700 bg-green-900/30'
              : 'border-red-700 bg-red-900/30'
          }`}
        >
          {commitNotice.kind === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          )}
          <div className={`text-sm ${commitNotice.kind === 'success' ? 'text-green-200' : 'text-red-200'}`}>
            {commitNotice.text}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm}
          className="px-4 py-1.5 rounded bg-green-700 text-white text-sm font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> Confirm import
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-1.5 rounded bg-[#21262D] text-[#F0F6FC] text-sm font-medium hover:bg-[#30363D] disabled:opacity-50"
        >
          Cancel
        </button>
        {!preview.confirmationEligible && preview.counts.issueCount === 0 && (
          <span className="text-xs text-[#8B949E]">
            No mutations needed (all UNCHANGED).
          </span>
        )}
      </div>
    </section>
  );
};

const CountChip: React.FC<{ label: string; n: number; tone: 'green' | 'amber' | 'slate' | 'red' }> = ({ label, n, tone }) => {
  const toneClass =
    tone === 'green' ? 'border-green-700 text-green-300 bg-green-900/20'
    : tone === 'amber' ? 'border-amber-700 text-amber-300 bg-amber-900/20'
    : tone === 'red' ? 'border-red-700 text-red-300 bg-red-900/20'
    : 'border-[#30363D] text-[#8B949E] bg-[#0D1117]';
  return (
    <div className={`rounded border p-2 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold">{n}</div>
    </div>
  );
};

const EntryTable: React.FC<{ title: string; entries: BrokerImportPreviewEntry[] }> = ({ title, entries }) => {
  const [open, setOpen] = useState(false);
  // Show only UPDATED/UNCHANGED if there are many; cap at 20 rows for rendering.
  const showOnlyChanged = entries.filter((e) => e.classification !== 'UNCHANGED');
  const display = showOnlyChanged.length > 0 ? showOnlyChanged : entries;
  const truncated = display.length > 20;
  const rows = truncated ? display.slice(0, 20) : display;
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-sm text-[#8B949E] hover:text-[#F0F6FC]"
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {title} ({entries.length})
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-[#30363D] bg-[#0D1117]">
          <table className="w-full text-xs">
            <thead className="bg-[#21262D] text-[#8B949E]">
              <tr>
                <th className="text-left p-1.5">Class</th>
                <th className="text-left p-1.5">Instrument</th>
                <th className="text-right p-1.5">Qty</th>
                <th className="text-right p-1.5">Invested</th>
                <th className="text-right p-1.5">Current</th>
                <th className="text-right p-1.5">P&L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, idx) => {
                // WP-FB-IMPORT-BROKER-01 / WP-09: reactivation UI disclosure.
                // When a previously closed_absent holding reappears in the
                // parse, it is classified as UPDATED (because its
                // status differs from the parsed candidate's status).
                // The UI surfaces this as a small "REACTIVATED" badge
                // so the user can see the lifecycle transition.
                // The data condition is purely from existing preview
                // fields; no service or lifecycle change.
                const isReactivation =
                  e.existing?.status === 'closed_absent' &&
                  e.classification === 'UPDATED';
                return (
                  <tr key={idx} className="border-t border-[#21262D]">
                    <td className="p-1.5 font-mono">
                      {e.classification}
                      {isReactivation && (
                        <span
                          data-testid="reactivation-badge"
                          className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-cyan-950/40 text-cyan-300 border border-cyan-800/40"
                          title="This holding was previously marked closed_absent; re-importing it reactivates it to active."
                        >
                          REACTIVATED
                        </span>
                      )}
                    </td>
                    <td className="p-1.5">{e.candidate.instrumentName}</td>
                    <td className="p-1.5 text-right font-mono">{e.candidate.quantity}</td>
                    <td className="p-1.5 text-right font-mono">{e.candidate.investedValue.toFixed(2)}</td>
                    <td className="p-1.5 text-right font-mono">{e.candidate.currentValue.toFixed(2)}</td>
                    <td className={`p-1.5 text-right font-mono ${e.candidate.unrealisedPnL < 0 ? 'text-red-400' : ''}`}>
                      {e.candidate.unrealisedPnL.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {truncated && (
            <div className="p-2 text-xs text-[#8B949E] italic">
              ... {display.length - 20} more entries not shown. Expand the table to see all.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ClosureTable: React.FC<{ title: string; closures: BrokerImportPreviewClosure[] }> = ({ title, closures }) => {
  const [open, setOpen] = useState(true);
  // WP-FB-IMPORT-BROKER-01 / D-06: modal state for the closed_absent
  // permanent deletion flow. `deletionTarget` is the holding whose delete
  // the user has clicked; the modal renders only when it is set.
  const [deletionTarget, setDeletionTarget] = useState<Holding | null>(null);
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-sm text-[#8B949E] hover:text-[#F0F6FC]"
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {title} ({closures.length})
      </button>
      {open && (
        <div className="mt-2 rounded border border-red-700 bg-red-900/20 p-2">
          <p className="text-xs text-red-200 mb-2">
            The following existing holdings are absent from the new parse. They
            will be RETAINED in the ledger but their status will be transitioned
            to <code className="text-red-300">closed_absent</code>. The record is
            not removed. WP-FB-IMPORT-BROKER-01 / D-06: a <code className="text-red-300">closed_absent</code> row
            may be PERMANENTLY DELETED via the per-row &quot;Delete permanently&quot; button. The
            deletion is irreversible and writes an audit record.
          </p>
          <div className="max-h-48 overflow-y-auto rounded border border-[#30363D] bg-[#0D1117]">
            <table className="w-full text-xs">
              <thead className="bg-[#21262D] text-[#8B949E]">
                <tr>
                  <th className="text-left p-1.5">Instrument</th>
                  <th className="text-right p-1.5">Qty</th>
                  <th className="text-right p-1.5">Last Current Value</th>
                  <th className="text-right p-1.5">D-06</th>
                </tr>
              </thead>
              <tbody>
                {closures.map((c, idx) => (
                  <tr key={idx} className="border-t border-[#21262D]">
                    <td className="p-1.5">{c.existing.instrumentName}</td>
                    <td className="p-1.5 text-right font-mono">{c.existing.quantity}</td>
                    <td className="p-1.5 text-right font-mono">{c.existing.currentValue.toFixed(2)}</td>
                    <td className="p-1.5 text-right">
                      {/* D-06: only `closed_absent` rows carry the delete affordance.
                          The `ClosureTable` only renders `closed_absent` rows
                          (per the broker import flow), so the affordance is
                          always shown here. The defensive `status === 'closed_absent'`
                          guard below is the authoritative source of truth. */}
                      <button
                        type="button"
                        data-testid={`delete-holding-button-${c.existing.id}`}
                        onClick={() => setDeletionTarget(c.existing)}
                        disabled={c.existing.status !== 'closed_absent'}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-900/40 text-red-200 border border-red-800/60 hover:bg-red-800/60 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Permanently delete this closed_absent holding (D-06)"
                      >
                        <Trash2 className="w-3 h-3" /> Delete permanently
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {deletionTarget && (
            <DeleteHoldingModal
              holding={deletionTarget}
              onClose={() => setDeletionTarget(null)}
              onDeleted={() => {
                // On successful deletion, the closure table is a snapshot
                // of the pre-confirm preview; the deleted holding remains in
                // the snapshot until the user closes / re-opens the import
                // (which re-runs the preview). Closing the modal here is
                // sufficient; the data is already committed atomically.
                setDeletionTarget(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
};

/**
 * WP-FB-IMPORT-BROKER-01 / D-06 — modal that asks the user to confirm
 * permanent deletion of a single `closed_absent` Holding.
 *
 * The modal renders the 5 mandatory fields from D-06-12:
 *   1. Holding identity (instrument, ISIN, ticker)
 *   2. Broker / account
 *   3. Current value
 *   4. Irreversible-action warning
 *   5. Audit-record notice
 *
 * On confirm, the modal calls
 * `useCanonicalLedger.getState().commitHoldingDeletion(id)` which composes
 * the holding removal and the audit-record creation inside ONE atomic
 * `MemoryRepository.write` boundary (D-06 atomicity contract).
 *
 * The confirm button is `disabled` while the in-flight promise has not
 * settled (the `busy` state). On persistence failure, the data is
 * unchanged and a "Deletion failed" message is surfaced; no auto-retry
 * is attempted.
 *
 * D-06 is irreversible. There is no undo affordance.
 */
const DeleteHoldingModal: React.FC<{
  holding: Holding;
  onClose: () => void;
  onDeleted: () => void;
}> = ({ holding, onClose, onDeleted }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defensive re-validation: the affordance is rendered only for
  // closed_absent rows, but the modal also re-checks before invoking
  // commitHoldingDeletion. The store-side `planDelete` is the source
  // of truth and will throw `HOLDING_NOT_CLOSED` if the status changed.
  const isEligible = holding.status === 'closed_absent';

  const handleConfirm = () => {
    if (!isEligible) {
      setError('Only closed_absent holdings may be permanently deleted via D-06.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = useCanonicalLedger.getState().commitHoldingDeletion(holding.id);
      if (outcome.persisted) {
        outcome.persisted
          .then(() => {
            setBusy(false);
            onDeleted();
          })
          .catch((e: unknown) => {
            setBusy(false);
            setError(`Deletion failed; your data is unchanged. ${e instanceof Error ? e.message : String(e)}`);
          });
      } else {
        setBusy(false);
        setError('No persistence was attempted.');
      }
    } catch (e) {
      setBusy(false);
      // Pre-validation failure (HOLDING_NOT_FOUND / HOLDING_NOT_CLOSED /
      // INVALID_ID) — surface a clear message; the data is unchanged.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="delete-holding-modal"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-lg border border-red-800 bg-[#161B22] p-5">
        <h3 className="text-lg font-semibold text-[#F0F6FC] flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-red-400" /> Permanently delete this holding?
        </h3>
        <p className="mt-2 text-sm text-[#F0F6FC]">
          This action <strong className="text-red-300">cannot be undone</strong>.
          The holding&apos;s history will be recorded in an audit log.
        </p>

        <div className="mt-4 space-y-2 text-sm">
          <div className="rounded border border-[#30363D] bg-[#0D1117] p-3">
            <div className="text-xs text-[#8B949E] uppercase tracking-wide">Holding identity</div>
            <div className="mt-1 text-[#F0F6FC] font-mono" data-testid="delete-modal-instrument">
              {holding.instrumentName}
              {holding.isin ? ` (ISIN: ${holding.isin})` : ''}
              {holding.ticker ? ` (Ticker: ${holding.ticker})` : ''}
            </div>
          </div>
          <div className="rounded border border-[#30363D] bg-[#0D1117] p-3">
            <div className="text-xs text-[#8B949E] uppercase tracking-wide">Broker / Account</div>
            <div className="mt-1 text-[#F0F6FC] font-mono" data-testid="delete-modal-broker">
              {holding.broker}
              {holding.account ? ` / Account: ${holding.account}` : ''}
            </div>
          </div>
          <div className="rounded border border-[#30363D] bg-[#0D1117] p-3">
            <div className="text-xs text-[#8B949E] uppercase tracking-wide">Current value</div>
            <div className="mt-1 text-[#F0F6FC] font-mono" data-testid="delete-modal-value">
              {holding.currentValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {!isEligible && (
          <div className="mt-3 rounded border border-amber-700 bg-amber-900/30 p-3 text-xs text-amber-200">
            This holding is not closed_absent and cannot be deleted via D-06.
          </div>
        )}

        {error && (
          <div
            className="mt-3 rounded border border-red-700 bg-red-900/30 p-3 text-xs text-red-200"
            data-testid="delete-modal-error"
          >
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-1.5 rounded bg-[#21262D] text-[#F0F6FC] text-sm font-medium hover:bg-[#30363D] disabled:opacity-50"
            data-testid="delete-modal-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!isEligible || busy}
            className="px-4 py-1.5 rounded bg-red-700 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            data-testid="delete-modal-confirm"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete permanently
          </button>
        </div>
      </div>
    </div>
  );
};
