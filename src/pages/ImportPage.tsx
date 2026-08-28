import React, { useState, useRef } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { ImportBatchRollbackService, ImportBatchSummary } from '../services/ImportBatchRollbackService';
import { ImportPipelineService, CSVImportResult } from '../services/ImportPipelineService';
import { ImportHistoryService, ImportHistoryEntry } from '../services/ImportHistoryService';
import { DividendClassifier, DividendClassificationResult, DividendClassifyAllResult } from '../services/DividendClassifier';
import { Transaction } from '../domain/types';
import { BrokerImportSection } from './BrokerImportSection';
import { StandardImportSection } from './StandardImportSection';
import { Upload, FileText, CheckCircle2, AlertTriangle, XCircle, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * FINBOOM-CR (CR-02) — sub-tab discriminator. The Import page now
 * exposes two parallel sub-tabs: `broker` (Broker Import) and
 * `bank` (Bank Statement Import). The default tab is `broker`
 * (per the spec: the broker workflow is the elevated flow).
 *
 * FINBOOM-CR (CR-STANDARD-IMPORT) — extended to a third value
 * `standard` for the Requirement #1 Standard Import flow. The
 * default tab is unchanged (`broker`); the new sub-tab is added
 * at the end of the tab strip.
 */
type ImportSubTab = 'broker' | 'bank' | 'standard';

/**
 * FINBOOM Broker/Bank Import UI — the bank-section institution keys.
 * Exactly 3 banks per the approved implementation authorization:
 * HDFC Bank, ICICI Bank, SBI Bank. No brokers; no Generic CSV (it
 * remains internally registered in the bank detection pipeline, but
 * must not become a visible bank-institution button).
 */
type BankInstitution = 'HDFC Bank' | 'ICICI Bank' | 'SBI Bank';

/** Returns true if the filename has a native binary spreadsheet extension */
function isBinarySpreadsheet(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.xls') || lower.endsWith('.xlsx');
}

const SAMPLE_DEFAULT_CSV = `Date,Title,Narration,Amount,Type,Account
2026-08-06,ITC Limited,ACH/C-/ITC LTD DIVIDEND/NSE0098,2100,INCOME,HDFC Bank
2026-08-04,Coal India Ltd,ECS/C/COAL INDIA INT DIVIDEND,1500,INCOME,SBI Bank
2026-08-01,Imported Payout 1,ACH/C/DIVIDEND-CREDIT-ROW-1,1000,INCOME,HDFC Bank (...4921)
2026-08-01,Imported Payout 2,ACH/C/DIVIDEND-CREDIT-ROW-2,1000,INCOME,HDFC Bank (...4921)
2026-08-01,=HYPERLINK("https://evil.com","Click"),HOSTILE-PAYLOAD,100,INCOME,HDFC Bank`;

export const ImportPage: React.FC = () => {
  // FINBOOM-CR (CR-02) — sub-tab state. Default to 'broker' so the
  // elevated broker workflow is the first thing the user sees.
  const [subTab, setSubTab] = useState<ImportSubTab>('broker');
  // FINBOOM-CR (CR-04) — history panel collapsed by default.
  const [showHistory, setShowHistory] = useState(false);

  // FINBOOM Broker/Bank Import UI — the bank-section institution state
  // is now correctly named `selectedBank` (was misleadingly `selectedBroker`).
  // Default: 'HDFC Bank' (the bank with the strongest multi-indicator
  // detection signature; matches the existing pre-populated SAMPLE_DEFAULT_CSV).
  const [selectedBank, setSelectedBank] = useState<BankInstitution>('HDFC Bank');
  const [showReview, setShowReview] = useState(false);
  const [importResult, setImportResult] = useState<CSVImportResult | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('Simulated_Statement.csv');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // FINBOOM-CR-TRANSACTION-CLASSIFICATION — per-row user override map.
  // The user can override the classifier's per-row category via a
  // per-row `<select>` in the Review surface. The override is held
  // here in local component state. The override is NOT applied to
  // importResult.validRows directly on `<select>` change; instead, it
  // is merged into importResult.validRows in `handleCommit` (see
  // below) so that the `importResult` array passed to
  // `commitImportedRows` is the canonical, override-merged array.
  // This is the only safe pattern: the classifier must not be re-run
  // on the override; the override must not be stored in a separate
  // path that the commit can forget; the override must survive all
  // the way through the commit.
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({});

  // FINBOOM-CR-TRANSACTION-CLASSIFICATION — per-row MEDIUM-confirmation
  // map. When a row has a MEDIUM classification, the user must
  // explicitly confirm it (by checking a per-row checkbox) to upgrade
  // the row's `category` to 'DIVIDEND'. The confirmation is held here.
  // The upgrade is applied to the override map (which is then merged
  // into validRows at commit time).
  const [mediumConfirmations, setMediumConfirmations] = useState<Record<string, boolean>>({});

  // FINBOOM-CR-TRANSACTION-CLASSIFICATION — the classifier's per-row
  // result, parallel to importResult.validRows. Used by the Review
  // surface to render the per-row chip, the MEDIUM checkbox, the
  // per-row `<select>`, and the import-level summary line. Reset
  // whenever a new import is processed.
  const [classification, setClassification] = useState<DividendClassificationResult[] | null>(null);

  const { transactions, commitImportedRows, rollbackImportBatch, restoreImportBatch } = useCanonicalLedger();

  // WP-FB-DATA-06c-6a. Derived from the persisted rows on every render, so the
  // list reconciles itself after a rollback with no manual refresh.
  const importBatches = ImportBatchRollbackService.listBatches(transactions);
  const [rollbackBusy, setRollbackBusy] = useState<string | null>(null);
  const [rollbackNotice, setRollbackNotice] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);
  /** WP-FB-DATA-08A: the commit is in flight; nothing may be claimed yet. */
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitNotice, setCommitNotice] = useState<
    { kind: 'success' | 'error'; headline: string; text: string } | null
  >(null);
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);

  /**
   * WP-FB-DATA-06c-6a — roll back one import batch.
   *
   * Confirmation states the exact consequence before the user commits to it,
   * following the AccountsWorkspace deletion precedent. The outcome — success or
   * refusal — is rendered inline and is never swallowed: an integrity refusal
   * the user cannot see is not a safeguard they can act on (the F-06b-2 lesson).
   */
  const handleRollback = async (batch: ImportBatchSummary) => {
    setRollbackNotice(null);
    setRestoreNotice(null);

    const message =
      `Roll back the import of "${batch.file}"?\n\n` +
      `${batch.rowCount} transaction${batch.rowCount === 1 ? '' : 's'} will be EXCLUDED from all ` +
      `balances and reports.\n\n` +
      `Nothing is deleted. Every row stays in the Canonical Ledger, marked EXCLUDED, ` +
      `so you can still see exactly what was imported.\n\n` +
      `This cannot be undone from the app.`;

    if (!window.confirm(message)) return;

    setRollbackBusy(batch.batchId);
    try {
      const result = await rollbackImportBatch(batch.batchId);
      setRollbackBusy(null);
      setRollbackNotice({
        kind: 'success',
        text:
          `Rolled back "${batch.file}". ${result.excludedCount} transaction` +
          `${result.excludedCount === 1 ? '' : 's'} excluded from balances and reports. ` +
          `They remain visible in the Canonical Ledger; nothing was deleted.`
      });
    } catch (e: any) {
      setRollbackBusy(null);
      setRollbackNotice({
        kind: 'error',
        text: e?.message || 'The import batch could not be rolled back.'
      });
    }
  };

  /**
   * WP-FB-DATA-06c-2c — restore one import batch (Decision D6-1 = R5, D6-2).
   *
   * Deliberately the mirror of `handleRollback` above: same confirmation
   * discipline, same busy state, same inline notice, same never-swallow rule.
   *
   * ⚠️ THE CONFIRMATION QUOTES `restoreTargetCount`, NOT `rowCount`.
   * A batch containing a superseded original is restorable for only part of
   * itself — the 06c-2c gate measured `rowCount 3` against
   * `restoreTargetCount 1`. Saying "3 transactions will be restored" would
   * overstate what the user is agreeing to by two rows.
   *
   * ⚠️ THE NOTICE RENDERS `e.message`, NEVER `e.code`.
   * `BatchRestoreError` carries a code, but a READFAIL or a genuine IndexedDB
   * failure arrives as a plain `Error` with no code at all — the gate measured
   * exactly that. A handler keying on `.code` would print "undefined" on the
   * one failure that matters most.
   */
  const handleRestore = async (batch: ImportBatchSummary) => {
    setRollbackNotice(null);
    setRestoreNotice(null);

    const n = batch.restoreTargetCount;
    const untouched = batch.restoreUntouchedCount;
    const message =
      `Restore the import of "${batch.file}"?\n\n` +
      `${n} transaction${n === 1 ? '' : 's'} will be returned to your balances and reports.\n\n` +
      (untouched > 0
        ? `${untouched} other row${untouched === 1 ? '' : 's'} in this import stay excluded for a ` +
          `different reason and are not affected.\n\n`
        : '') +
      `The rollback stays recorded in this import's history.`;

    if (!window.confirm(message)) return;

    setRestoreBusy(batch.batchId);
    try {
      const result = await restoreImportBatch(batch.batchId);
      setRestoreBusy(null);
      setRestoreNotice({
        kind: 'success',
        text:
          `Restored "${batch.file}". ${result.restoredCount} transaction` +
          `${result.restoredCount === 1 ? '' : 's'} are counted in your balances and reports again. ` +
          `This import's rollback history is still recorded.`
      });
    } catch (e: any) {
      setRestoreBusy(null);
      setRestoreNotice({
        kind: 'error',
        text: e?.message || 'The import batch could not be restored.'
      });
    }
  };

  // FINBOOM Broker/Bank Import UI — the institution selector in the
  // Bank Statement Import section now contains banks only. The
  // pre-IMPLEMENTATION list (which mixed brokers and banks) has been
  // replaced. The 4-step bank structure (Choose Account / Download
  // Template / Prepare Your File / Upload File) is implemented in JSX
  // below; this list populates Step 1.
  const bankInstitutions: BankInstitution[] = ['HDFC Bank', 'ICICI Bank', 'SBI Bank'];

  const runPipeline = (csvText: string, fileName: string) => {
    const result = ImportPipelineService.processCSV(csvText, transactions, selectedBank, fileName);
    // FINBOOM-CR-TRANSACTION-CLASSIFICATION — apply the classifier to
    // the validRows BEFORE setting importResult. The classifier is a
    // pure transformation that may upgrade some rows'
    // `category: 'GENERAL'` to `category: 'DIVIDEND'`. The classifier
    // is forward-only; it never mutates the input array (it returns
    // a new array with shallow-copied elements for upgrades and
    // identity-preserved references for no-ops).
    const classified: DividendClassifyAllResult = DividendClassifier.classifyAll(result.validRows);
    setImportResult({ ...result, validRows: classified.rows });
    setClassification(classified.perRow);
    setCategoryOverrides({});
    setMediumConfirmations({});
    setSelectedFileName(fileName);
    setShowReview(true);
    setShowDiagnostics(result.unsupportedFormat || (result.invalidRows && result.invalidRows.length > 0) || (result.ambiguousRows && result.ambiguousRows.length > 0));
  };

  const handleSimulate = () => {
    runPipeline(SAMPLE_DEFAULT_CSV, `${selectedBank}_Statement_Aug2026.csv`);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isBinarySpreadsheet(file.name)) {
      // Native binary XLS/XLSX path: read as raw bytes → processBinaryFile
      const reader = new FileReader();
      reader.onload = (event) => {
        const buffer = event.target?.result as ArrayBuffer;
        if (buffer) {
          const bytes = new Uint8Array(buffer);
          const result = ImportPipelineService.processBinaryFile(bytes, transactions, selectedBank, file.name);
          // FINBOOM-CR-TRANSACTION-CLASSIFICATION — apply the
          // classifier to the validRows BEFORE setting importResult.
          const classified: DividendClassifyAllResult = DividendClassifier.classifyAll(result.validRows);
          setImportResult({ ...result, validRows: classified.rows });
          setClassification(classified.perRow);
          setCategoryOverrides({});
          setMediumConfirmations({});
          setSelectedFileName(file.name);
          setShowReview(true);
          setShowDiagnostics(result.unsupportedFormat || (result.invalidRows && result.invalidRows.length > 0) || (result.ambiguousRows && result.ambiguousRows.length > 0));
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Text path: CSV, TXT, HTML .xls (already text-encoded)
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        if (text) {
          runPipeline(text, file.name);
        }
      };
      reader.readAsText(file);
    }
  };

  /**
   * WP-FB-DATA-08A — the commit reports only what actually reached storage.
   *
   * Measured at the 08 gate with persistence failing: this reported
   * `appended: 1` and alerted "Appended 1 new rows" while memory AND storage
   * both held ZERO rows. That is an affirmative false claim, not merely a
   * silent failure - the worst shape in the whole fire-and-forget family.
   *
   * The counts are an ADMISSION decision and stay synchronous; `persisted` is
   * awaited before anything is reported, and a rejection is rendered with the
   * real message instead of a success line. The review surface is only cleared
   * once storage has agreed, so a failed commit can be retried.
   */
  const handleCommit = async () => {
    if (!importResult || commitBusy) return;
    setCommitNotice(null);

    // FINBOOM-CR-TRANSACTION-CLASSIFICATION — apply the per-row
    // override map to importResult.validRows BEFORE calling
    // commitImportedRows. The override merge covers:
    //
    //   1. The per-row `<select>` override (the user flipped a row to
    //      a different category — e.g. flipped a HIGH to GENERAL, or
    //      manually picked DIVIDEND on an unflagged row).
    //   2. The per-row MEDIUM-confirmation checkbox (the user
    //      confirmed a MEDIUM row, which upgrades it to DIVIDEND).
    //
    // Both sources write to `categoryOverrides` (the single source
    // of override truth). The override-merged `validRows` is the
    // canonical array passed to `commitImportedRows`. The override
    // survives all the way through the commit. The classifier is
    // NOT re-run here; the override is the user's authoritative
    // choice.
    const validRowsWithOverrides: Transaction[] = importResult.validRows.map((r) => {
      // Build the effective override for this row, checking the
      // per-row `<select>` first and then the per-row MEDIUM
      // confirmation (which is a special case of "override to
      // DIVIDEND").
      let effectiveOverride: string | undefined = categoryOverrides[r.id];
      if (effectiveOverride === undefined && classification) {
        // The per-row MEDIUM checkbox promotes the row to DIVIDEND.
        // This is conditional on the classifier having produced a
        // MEDIUM result for this row (defence-in-depth: the
        // checkbox is only meaningful for MEDIUM rows).
        const perRow = classification.find((c) => c.candidate.id === r.id);
        if (perRow && perRow.confidence === 'MEDIUM' && mediumConfirmations[r.id]) {
          effectiveOverride = 'DIVIDEND';
        }
      }
      if (effectiveOverride === undefined) return r;
      return { ...r, category: effectiveOverride };
    });

    const {
      appended, duplicates, divergentDuplicates,
      rejectedTransferRows, rejectedTransferReasons,
      rejectedDuplicateIdRows, rejectedDuplicateIdReasons,
      persisted
    } = commitImportedRows(validRowsWithOverrides);

    setCommitBusy(true);
    try {
      // Nothing is claimed until storage has agreed.
      if (persisted) await persisted;
    } catch (e: any) {
      setCommitBusy(false);
      // CR-04: record the failed bank import.
      ImportHistoryService.record({
        importType: 'BANK_STATEMENT',
        institution: selectedBank,
        sourceFilename: selectedFileName,
        result: 'failure',
        processedCount: importResult.totalDetected,
        importedCount: 0,
        rejectedCount: importResult.totalDetected,
        errorSummary: [e?.message || 'Persistence failed.'],
      });
      setCommitNotice({
        kind: 'error',
        headline: 'Import not committed.',
        text: `${e?.message || 'The rows could not be saved.'} Nothing was imported — the reviewed rows are still here, so you can try again.`
      });
      return;
    }
    setCommitBusy(false);

    setShowReview(false);
    setImportResult(null);
    // FINBOOM-CR-TRANSACTION-CLASSIFICATION — clear the per-row
    // override state and the classifier result on a successful
    // commit. The next import will produce a fresh classification
    // and a fresh override map.
    setClassification(null);
    setCategoryOverrides({});
    setMediumConfirmations({});
    // WP-FB-DATA-06a: an excluded row may be reported, but never silently dropped.
    const divergentNote = divergentDuplicates > 0
      ? ` Note: ${divergentDuplicates} of the excluded duplicates disagreed with the stored row on direction/type; those differences were NOT applied.`
      : '';
    // WP-FB-DATA-06b / T3-b: a rejected transfer row is never silently discarded.
    const transferNote = rejectedTransferRows > 0
      ? ` Rejected: ${rejectedTransferRows} row(s) claimed to be transfers but did not form a valid balanced pair, so they were NOT imported. ` +
        rejectedTransferReasons.join(' · ')
      : '';
    // WP-FB-DATA-06c-0 / P-1: a row refused for a colliding id is reported, never silent.
    const duplicateIdNote = rejectedDuplicateIdRows > 0
      ? ` Rejected: ${rejectedDuplicateIdRows} row(s) were NOT imported because their transaction id is already in use. No existing row was overwritten. ` +
        rejectedDuplicateIdReasons.join(' · ')
      : '';
    setCommitNotice({
      kind: 'success',
      headline: 'Import committed.',
      text: `Appended ${appended} new rows. Automatically excluded ${duplicates} exact duplicates.${divergentNote}${transferNote}${duplicateIdNote}`
    });
    // CR-04: record the successful bank import. The recording is
    // best-effort; a failure here does not affect the import
    // outcome (which has already been committed atomically by
    // `commitImportedRows`).
    const totalRejected = (importResult.duplicateCount ?? 0) + divergentDuplicates
      + rejectedTransferRows + rejectedDuplicateIdRows
      + (importResult.invalidCount ?? 0) + (importResult.ambiguousCount ?? 0);
    const result: 'success' | 'partial' | 'failure' =
      totalRejected === 0 ? 'success' : (appended === 0 ? 'failure' : 'partial');
    ImportHistoryService.record({
      importType: 'BANK_STATEMENT',
      institution: selectedBank,
      sourceFilename: selectedFileName,
      result,
      processedCount: importResult.totalDetected,
      importedCount: appended,
      rejectedCount: totalRejected,
      errorSummary: [
        ...(divergentNote ? [divergentNote.trim()] : []),
        ...(transferNote ? [transferNote.trim()] : []),
        ...(duplicateIdNote ? [duplicateIdNote.trim()] : []),
      ].slice(0, 10),
    });
  };

  const allIssues = [
    ...(importResult?.invalidRows || []),
    ...(importResult?.ambiguousRows || [])
  ].sort((a, b) => a.rowNumber - b.rowNumber);

  // CR-04: history entries (in-memory; refreshed each render).
  const historyEntries: ImportHistoryEntry[] = ImportHistoryService.list();

  return (
    <div className="space-y-8">
      {/* FINBOOM-CR (CR-02) — sub-tab control. Two sub-tabs:
          `Broker Import` (default) and `Bank Statement Import`.
          The control is at the top of the page; the active
          sub-tab's content is rendered below. */}
      <div
        role="tablist"
        aria-label="Import workflow"
        className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-800"
        data-testid="import-subtabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'broker'}
          data-testid="import-subtab-broker"
          onClick={() => setSubTab('broker')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition ${
            subTab === 'broker'
              ? 'border-green-600 text-green-700 dark:text-green-400'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          Broker Import
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'bank'}
          data-testid="import-subtab-bank"
          onClick={() => setSubTab('bank')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition ${
            subTab === 'bank'
              ? 'border-green-600 text-green-700 dark:text-green-400'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          Bank Statement Import
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'standard'}
          data-testid="import-subtab-standard"
          onClick={() => setSubTab('standard')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition ${
            subTab === 'standard'
              ? 'border-green-600 text-green-700 dark:text-green-400'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          Standard Import
        </button>
      </div>

      {/* FINBOOM-CR (CR-02) — broker sub-tab. Renders the existing
          self-contained broker workflow. */}
      {subTab === 'broker' && (
        <div data-testid="import-subtab-panel-broker">
          {/* WP-FB-IMPORT-BROKER-01 — WP-08 broker-import section.
              Self-contained: file upload → detect → parse → preview → confirm / cancel. */}
          <BrokerImportSection />
        </div>
      )}

      {/* FINBOOM-CR (CR-02) — bank sub-tab. Renders the existing
          5-stage engine with the heading renamed. The engine is
          unchanged in code (per CR-03). */}
      {subTab === 'bank' && (
        <div data-testid="import-subtab-panel-bank">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
              Bank Statement Import
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              1. UPLOAD ➔ 2. DETECT ➔ 3. PARSE ➔ 4. NORMALIZE ➔ 5. REVIEW ➔ COMMIT (Append Mode)
            </p>
          </div>

      {/* WP-FB-DATA-08A: the commit outcome, reported only after storage has
          agreed. This replaces an alert() that announced "Appended N new rows"
          before the write had resolved - measured claiming 1 row while both
          memory and storage held zero. */}
      {commitNotice && (
        <div
          id="commit-notice"
          data-commit-kind={commitNotice.kind}
          role="status"
          className={`rounded-2xl border p-4 text-xs ${
            commitNotice.kind === 'success'
              ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200'
              : 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200'
          }`}
        >
          <strong>{commitNotice.headline}</strong>{' '}
          {commitNotice.text}
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm">
        {/* Step 1: Choose Account (banks only) */}
        <h3
          className="font-bold text-gray-900 dark:text-white text-base mb-4"
          data-testid="bank-step-1"
          data-testid-bank-step="1"
        >
          Step 1: Choose Account
        </h3>
        <div
          role="tablist"
          aria-label="Choose bank account"
          className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6"
        >
          {bankInstitutions.map(b => {
            const active = selectedBank === b;
            return (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={active}
                aria-pressed={active}
                data-testid={`bank-institution-${b.replace(/ /g, '_')}`}
                onClick={() => setSelectedBank(b)}
                className={`py-3 px-3 rounded-xl border text-sm font-bold transition ${
                  active
                    ? 'bg-green-50 dark:bg-green-900/30 border-green-600 text-green-700 dark:text-green-400'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50'
                }`}
              >
                {b}
              </button>
            );
          })}
        </div>

        {/* Step 2: Download Template (existing bank template affordance) */}
        <div data-testid="bank-step-2" data-testid-bank-step="2" className="mt-6">
          <h3 className="font-bold text-gray-900 dark:text-white text-base mb-2">
            Step 2: Download Template
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Use your bank&apos;s official statement download (HDFC / ICICI / SBI
            web portal, or net-banking). The statement will be detected
            automatically by content.
          </p>
        </div>

        {/* Step 3: Prepare Your File (bank-specific guidance) */}
        <div data-testid="bank-step-3" data-testid-bank-step="3" className="mt-6">
          <h3 className="font-bold text-gray-900 dark:text-white text-base mb-2">
            Step 3: Prepare Your File
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <strong>Supported file type(s):</strong> CSV (and XLS / XLSX via
            the spreadsheet parser for SBI-style exports).
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 dark:text-gray-400 mt-2 space-y-1">
            <li>Upload the file exactly as the bank exports it. Do not edit column headers.</li>
            <li>Detection is content-based — multi-indicator signature matching — filename is not used.</li>
            <li>Deterministic fingerprint deduplication and formula sanitization are applied automatically.</li>
          </ul>
        </div>

        {/* Step 4: Upload File */}
        <div data-testid="bank-step-4" data-testid-bank-step="4" className="mt-6">
          <h3 className="font-bold text-gray-900 dark:text-white text-base mb-4">
            Step 4: Upload File
          </h3>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".csv,.txt,.xls,.xlsx"
            className="hidden"
          />
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-2xl p-10 text-center bg-gray-50 dark:bg-gray-800/50 hover:border-green-600 cursor-pointer transition mb-4"
          >
            <Upload className="mx-auto mb-2 text-gray-400" size={32} />
            <h4 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
              Upload Statement File (.csv, .txt, .xls, .xlsx)
            </h4>
            <p className="text-sm text-gray-500 mb-5">
              Native support for HDFC Bank, ICICI Bank, SBI Bank &amp; Generic CSV exports with deterministic fingerprint deduplication and formula sanitization.
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="px-5 py-2.5 rounded-lg bg-green-700 hover:bg-green-800 text-white font-bold text-sm shadow-sm mr-3"
            >
              Select File (.csv, .txt, .xls, .xlsx)
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSimulate();
              }}
              className="px-5 py-2.5 rounded-lg bg-gray-600 hover:bg-gray-700 text-white font-bold text-sm shadow-sm"
            >
              Simulate Upload
            </button>
          </div>
        </div>

        {/* WP-FB-DATA-06c-6a — Import history + rollback. Derived from persisted
            rows, so it reconciles automatically after a rollback. */}
        {importBatches.length > 0 && (
          <div id="import-history" className="mt-6 border-t border-gray-200 dark:border-gray-800 pt-5">
            <h4 className="font-bold text-gray-900 dark:text-white text-sm mb-1">Import History</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Rolling back an import excludes its transactions from balances and reports.
              Nothing is deleted &mdash; the rows stay in the Canonical Ledger, marked EXCLUDED.
              A rolled-back import can be restored, and the rollback stays recorded either way.
            </p>

            {rollbackNotice && (
              <div
                id="rollback-notice"
                data-rollback-kind={rollbackNotice.kind}
                className={`mb-3 rounded-lg border p-3 text-xs ${
                  rollbackNotice.kind === 'success'
                    ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200'
                    : 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200'
                }`}
              >
                <strong>{rollbackNotice.kind === 'success' ? 'Import rolled back.' : 'Rollback refused.'}</strong>{' '}
                {rollbackNotice.text}
              </div>
            )}

            {restoreNotice && (
              <div
                id="restore-notice"
                data-restore-kind={restoreNotice.kind}
                className={`mb-3 rounded-lg border p-3 text-xs ${
                  restoreNotice.kind === 'success'
                    ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200'
                    : 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200'
                }`}
              >
                <strong>{restoreNotice.kind === 'success' ? 'Import restored.' : 'Restore refused.'}</strong>{' '}
                {restoreNotice.text}
              </div>
            )}

            <div className="space-y-2">
              {importBatches.map(batch => (
                <div
                  key={batch.batchId}
                  data-import-batch={batch.batchId}
                  data-batch-status={batch.status}
                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-gray-900 dark:text-white truncate">{batch.file}</span>
                      {batch.status === 'ROLLED_BACK' && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[9px] font-bold">
                          ROLLED BACK
                        </span>
                      )}
                      {batch.status === 'PARTIALLY_EXCLUDED' && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 text-[9px] font-bold">
                          PARTIALLY EXCLUDED
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      {batch.provider} &middot; {batch.rowCount} row{batch.rowCount === 1 ? '' : 's'}
                      {batch.importedAt && <> &middot; imported {batch.importedAt.slice(0, 10)}</>}
                      {batch.excludedCount > 0 && <> &middot; {batch.excludedCount} excluded</>}
                    </div>
                    {/* WP-FB-DATA-06c-2a / Q-UI-3(iii).
                        Q1b = c keeps a correction in this batch for provenance but excludes it
                        from rollback targeting, so rolling the batch back does NOT undo it.
                        That was previously disclosed only inside a refusal string, which
                        disappears the moment the batch becomes eligible again. It is now a
                        standing statement of fact on the batch itself. */}
                    {batch.correctionCount > 0 && (
                      <div
                        data-batch-corrections={batch.correctionCount}
                        className="mt-1 text-[11px] text-cyan-700 dark:text-cyan-300"
                      >
                        {batch.correctionCount} corrected row{batch.correctionCount === 1 ? '' : 's'} —
                        {' '}your own corrected figures, which a rollback of this import will not undo.
                      </div>
                    )}
                    {/* WP-FB-DATA-06c-2c / Q1 = (b) — RESTORE HISTORY.
                        Decision D6-3 required that a restore must not erase the fact that a
                        rollback happened, and 06c-2b satisfied that in the DATA. The 06c-2c
                        gate then measured that it was invisible on screen: after
                        rollback -> restore -> rollback the row read exactly like a plain
                        rollback. `restoredCount` already persists; this renders it, so the
                        audit event the user's data records is an audit event the user can see. */}
                    {batch.restoredCount > 0 && (
                      <div
                        data-batch-restored={batch.restoredCount}
                        className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300"
                      >
                        {batch.restoredCount} row{batch.restoredCount === 1 ? '' : 's'} previously restored
                      </div>
                    )}
                    {!batch.restoreEligible && batch.restoreBlockedReason && batch.status !== 'LIVE' && (
                      <div
                        data-batch-restore-blocked={batch.restoreBlockedCode}
                        className="mt-1 text-[11px] text-amber-700 dark:text-amber-300"
                      >
                        Cannot restore: {batch.restoreBlockedReason}
                      </div>
                    )}
                    {!batch.rollbackEligible && batch.rollbackBlockedReason && batch.status !== 'ROLLED_BACK' && (
                      <div
                        data-batch-blocked={batch.rollbackBlockedCode}
                        className="mt-1 text-[11px] text-amber-700 dark:text-amber-300"
                      >
                        Cannot roll back: {batch.rollbackBlockedReason}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                  <button
                    data-restore-batch={batch.batchId}
                    onClick={() => handleRestore(batch)}
                    disabled={!batch.restoreEligible || restoreBusy === batch.batchId}
                    title={batch.restoreEligible
                      ? `Return ${batch.restoreTargetCount} transaction(s) to balances and reports`
                      : batch.restoreBlockedReason}
                    className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {restoreBusy === batch.batchId ? 'Restoring…' : 'Restore Import'}
                  </button>
                  <button
                    data-rollback-batch={batch.batchId}
                    onClick={() => handleRollback(batch)}
                    disabled={!batch.rollbackEligible || rollbackBusy === batch.batchId}
                    title={batch.rollbackEligible ? 'Exclude this import from balances and reports' : batch.rollbackBlockedReason}
                    className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {rollbackBusy === batch.batchId ? 'Rolling back…' : 'Roll Back Import'}
                  </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {showReview && importResult && (
          <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <span className="font-bold text-base text-gray-900 dark:text-white flex items-center gap-2">
                <FileText size={18} /> Stage 5: Data Quality & Duplicate Review ({selectedFileName})
              </span>
              <div className="flex items-center gap-2">
                <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                  importResult.unsupportedFormat
                    ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
                    : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                }`}>
                  Format: {importResult.formatDisplayName}
                </span>
                {!importResult.unsupportedFormat && (
                  <span className="px-2.5 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-bold">
                    {importResult.totalDetected} Rows Detected
                  </span>
                )}
              </div>
            </div>

            {importResult.unsupportedFormat ? (
              <div className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/40 rounded-xl flex items-start gap-3">
                <ShieldAlert className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" size={20} />
                <div>
                  <h4 className="text-sm font-bold text-red-900 dark:text-red-200">
                    Unsupported / Unrecognized Statement Format
                  </h4>
                  <p className="text-xs text-red-700 dark:text-red-300 mt-0.5">
                    The uploaded file content does not match any recognized bank statement signature (HDFC, ICICI, SBI) or generic CSV header signature. Please check the file format or select a supported statement download.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-green-600" />
                    <span><strong>{importResult.validRows.length} Valid New Transactions</strong> (Unique canonical fingerprints)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className="text-amber-600" />
                    <span><strong>{importResult.duplicateCount} Duplicates Flagged</strong> (Matching existing fingerprint Set, automatically skipped)</span>
                  </div>
                  {/* FINBOOM-CR-TRANSACTION-CLASSIFICATION — import-level
                      classification summary. Visible only when the
                      classifier has produced a result. Shows the
                      number of rows classified as DIVIDEND (HIGH),
                      pending confirmation (MEDIUM), and rejected by a
                      negative rule. */}
                  {classification && (() => {
                    const high = classification.filter((c) => c.confidence === 'HIGH').length;
                    const medium = classification.filter((c) => c.confidence === 'MEDIUM').length;
                    const rejected = classification.filter((c) => c.ruleId !== null && c.confidence === 'NONE').length;
                    return (
                      <div
                        className="flex items-center gap-2"
                        data-testid="dividend-classification-summary"
                      >
                        <FileText size={16} className="text-blue-600" />
                        <span>
                          <strong>{high} rows classified as Dividend</strong>
                          {' '}({high} HIGH{medium > 0 ? `, ${medium} MEDIUM pending confirmation` : ''}{rejected > 0 ? `, ${rejected} rejected as non-dividend` : ''})
                        </span>
                      </div>
                    );
                  })()}
                  {importResult.divergentDuplicateCount > 0 && (
                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
                        <div>
                          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                            {importResult.divergentDuplicateCount} of those duplicates disagree with the stored row on direction / type
                          </p>
                          <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                            These rows hash to the same fingerprint as a transaction you already have, so they were excluded &mdash;
                            but they describe the money as moving the other way. If these are corrections, they have <strong>not</strong> been applied.
                          </p>
                          <ul className="mt-1.5 space-y-0.5">
                            {importResult.divergentDuplicateRows.map(d => (
                              <li key={`${d.rowNumber}-${d.fingerprint}`} className="text-[11px] text-amber-800 dark:text-amber-300">
                                Row {d.rowNumber}: {d.narration} &mdash; incoming{' '}
                                <strong>{d.incomingDirection || d.incomingType}</strong> vs stored{' '}
                                <strong>{d.existingDirection || d.existingType}</strong>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
                  {importResult.ambiguousCount > 0 && (
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={16} className="text-orange-500" />
                      <span><strong>{importResult.ambiguousCount} Ambiguous Rows</strong> (Both debit and credit populated)</span>
                    </div>
                  )}
                  {importResult.invalidCount > 0 && (
                    <div className="flex items-center gap-2">
                      <XCircle size={16} className="text-red-600" />
                      <span><strong>{importResult.invalidCount} Invalid/Malformed Rows</strong> (Rejected)</span>
                    </div>
                  )}
                </div>

                {allIssues.length > 0 && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setShowDiagnostics(!showDiagnostics)}
                      className="text-xs font-bold text-gray-700 dark:text-gray-300 hover:text-green-600 flex items-center gap-1 cursor-pointer"
                    >
                      {showDiagnostics ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      <span>{showDiagnostics ? 'Hide' : 'Show'} Row Diagnostics ({allIssues.length} issues logged)</span>
                    </button>

                    {showDiagnostics && (
                      <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden text-xs">
                        <table className="w-full text-left border-collapse">
                          <thead className="bg-gray-100 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 font-bold">
                            <tr>
                              <th className="py-2 px-3">Row #</th>
                              <th className="py-2 px-3">Severity</th>
                              <th className="py-2 px-3">Code</th>
                              <th className="py-2 px-3">Message</th>
                              <th className="py-2 px-3">Raw Value</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200 dark:divide-gray-800 text-gray-700 dark:text-gray-300">
                            {allIssues.map((issue, idx) => (
                              <tr key={idx} className="hover:bg-gray-100/50 dark:hover:bg-gray-800/50">
                                <td className="py-2 px-3 font-mono font-bold">{issue.rowNumber || 'N/A'}</td>
                                <td className="py-2 px-3">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    issue.severity === 'AMBIGUOUS'
                                      ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                                      : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                                  }`}>
                                    {issue.severity}
                                  </span>
                                </td>
                                <td className="py-2 px-3 font-mono text-[11px] text-gray-500">{issue.code}</td>
                                <td className="py-2 px-3">{issue.message}</td>
                                <td className="py-2 px-3 font-mono text-[11px] text-gray-500 truncate max-w-[200px]">
                                  {issue.rawValue || issue.field || '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* FINBOOM-CR-TRANSACTION-CLASSIFICATION — per-row
                    override UI. Rendered as a compact table under the
                    import-level summary. Each row shows:
                      - the row's narration
                      - a classification chip (HIGH/MEDIUM/GENERAL) with
                        the rule id
                      - a per-row `<select>` for the user's category
                        override
                      - a per-row MEDIUM-confirmation checkbox (only
                        meaningful for MEDIUM rows) */}
                {classification && classification.length > 0 && (
                  <div className="mt-4 border-t border-gray-200 dark:border-gray-800 pt-3">
                    <h4 className="font-bold text-sm text-gray-900 dark:text-white mb-2">
                      Dividend Classification Per-Row Override
                    </h4>
                    <div className="max-h-64 overflow-y-auto rounded border border-gray-200 dark:border-gray-800">
                      <table
                        className="w-full text-xs"
                        data-testid="dividend-classification-table"
                      >
                        <thead className="bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-400 font-bold sticky top-0">
                          <tr>
                            <th className="text-left py-1.5 px-2">Row</th>
                            <th className="text-left py-1.5 px-2">Narration</th>
                            <th className="text-left py-1.5 px-2">Classification</th>
                            <th className="text-left py-1.5 px-2">Override (Category)</th>
                            <th className="text-left py-1.5 px-2">Confirm</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-800 text-gray-700 dark:text-gray-300">
                          {importResult.validRows.map((r, idx) => {
                            const perRow = classification[idx];
                            const conf = perRow ? perRow.confidence : 'NONE';
                            const ruleId = perRow ? perRow.ruleId : null;
                            const currentOverride = categoryOverrides[r.id] !== undefined
                              ? categoryOverrides[r.id]
                              : r.category;
                            return (
                              <tr key={r.id} data-testid={`classification-row-${r.id}`}>
                                <td className="py-1.5 px-2 font-mono">{idx + 1}</td>
                                <td className="py-1.5 px-2 truncate max-w-[280px]">{r.narration}</td>
                                <td className="py-1.5 px-2">
                                  <span
                                    data-classification={conf}
                                    data-rule-id={ruleId ?? ''}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                      conf === 'HIGH'
                                        ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                                        : conf === 'MEDIUM'
                                        ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                                    }`}
                                  >
                                    {conf}
                                    {ruleId ? ` · ${ruleId}` : ''}
                                  </span>
                                </td>
                                <td className="py-1.5 px-2">
                                  <select
                                    data-row-category={r.id}
                                    value={currentOverride}
                                    onChange={(e) => {
                                      const newValue = e.target.value;
                                      setCategoryOverrides((prev) => {
                                        if (newValue === r.category) {
                                          const { [r.id]: _, ...rest } = prev;
                                          return rest;
                                        }
                                        return { ...prev, [r.id]: newValue };
                                      });
                                    }}
                                    className="text-xs px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800"
                                  >
                                    <option value="GENERAL">GENERAL</option>
                                    <option value="DIVIDEND">DIVIDEND</option>
                                    <option value="SALARY">SALARY</option>
                                    <option value="BONUS">BONUS</option>
                                    <option value="INVESTMENT">INVESTMENT</option>
                                    <option value="OTHER">OTHER</option>
                                  </select>
                                </td>
                                <td className="py-1.5 px-2">
                                  {conf === 'MEDIUM' && (
                                    <input
                                      type="checkbox"
                                      data-confirm-dividend={r.id}
                                      checked={!!mediumConfirmations[r.id]}
                                      onChange={(e) => {
                                        setMediumConfirmations((prev) => ({
                                          ...prev,
                                          [r.id]: e.target.checked,
                                        }));
                                      }}
                                    />
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="pt-2">
                  <button
                    id="btn-commit-import"
                    onClick={handleCommit}
                    disabled={importResult.validRows.length === 0 || commitBusy}
                    className={`px-5 py-2.5 rounded-lg font-bold text-sm shadow-sm transition ${
                      importResult.validRows.length === 0
                        ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                        : 'bg-green-700 hover:bg-green-800 text-white'
                    }`}
                  >
                    {commitBusy
                      ? 'Committing…'
                      : `Review & Commit ${importResult.validRows.length} Valid Rows to Canonical Ledger (Append Mode)`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
        </div>
      )}

      {/* FINBOOM-CR (CR-STANDARD-IMPORT) — third sub-tab.
          Renders the self-contained Standard Import flow. */}
      {subTab === 'standard' && (
        <StandardImportSection />
      )}

      {/* FINBOOM-CR (CR-04) — Import History panel. Visible on the
          Import page (cross-cutting, NOT scoped to a sub-tab).
          Collapsed by default; the [show history] toggle expands
          it. The history is in-memory only and is reset on full
          page reload (per the spec: no IndexedDB schema change). */}
      <div
        data-testid="import-history-panel"
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm"
      >
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-white"
          data-testid="import-history-toggle"
        >
          {showHistory ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          <span>Import History ({historyEntries.length})</span>
        </button>
        {showHistory && (
          <div className="mt-3" data-testid="import-history-content">
            {historyEntries.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                No imports recorded yet. Broker and bank imports will be listed here
                as they complete. History is in-memory and resets on page reload.
              </p>
            ) : (
              <div className="space-y-2">
                {historyEntries.map((e) => (
                  <div
                    key={e.id}
                    data-testid="import-history-entry"
                    data-history-result={e.result}
                    data-history-type={e.importType}
                    className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                          e.result === 'success'
                            ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                            : e.result === 'partial'
                            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                            : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {e.result}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                          e.importType === 'BROKER_HOLDINGS'
                            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                            : e.importType === 'STANDARD_IMPORT'
                            ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                            : 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                        }`}
                      >
                        {e.importType === 'BROKER_HOLDINGS' ? 'Broker' : e.importType === 'STANDARD_IMPORT' ? 'Standard' : 'Bank'}
                      </span>
                      <span className="font-semibold text-gray-900 dark:text-white">
                        {e.institution}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400 font-mono truncate">
                        {e.sourceFilename}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                      {new Date(e.timestamp).toLocaleString()} &middot; processed {e.processedCount} &middot; imported {e.importedCount} &middot; rejected {e.rejectedCount}
                    </div>
                    {e.errorSummary.length > 0 && (
                      <ul className="mt-1 text-[11px] text-amber-700 dark:text-amber-300 list-disc list-inside">
                        {e.errorSummary.map((msg, idx) => (
                          <li key={idx}>{msg}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
