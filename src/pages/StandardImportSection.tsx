/**
 * FINBOOM — REQUIREMENT #1 STANDARD IMPORT
 *
 * Standard Import panel.
 *
 * Rendered as the third sub-tab of `ImportPage` (Broker | Bank | Standard).
 * Implements the 5-step flow:
 *  1. Download CSV Template
 *  2. Select Default Asset Class (optional)
 *  3. Upload File
 *  4. Review (read-only)
 *  5. Commit
 *
 * The panel is intentionally self-contained. It does NOT share state
 * with the broker or bank sub-tabs. The only external dependency is
 * the canonical ledger via the `useCanonicalLedger` hook (for
 * `commitImportedStandardAssets` and reading existing Assets for
 * duplicate detection).
 *
 * Per the IMPLEMENTATION AUTHORITY REPORT:
 *  - V1 has NO rollback. The commit-success message explicitly
 *    communicates this limitation.
 *  - Review is strictly read-only; per-row source chip is rendered
 *    but not editable.
 *  - Changing the Default Asset Class re-runs the precedence rules
 *    and refreshes the review.
 *  - The 20-value Asset Class vocabulary is UI-only; the canonical
 *    8-value `AssetType` is what reaches `Asset.type`.
 */

import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { Asset } from '../domain/types';
import { ImportHistoryService } from '../services/ImportHistoryService';
import { Upload, FileText, CheckCircle2, AlertTriangle, XCircle, Download } from 'lucide-react';

import {
  STANDARD_IMPORT_ASSET_CLASSES,
  StandardAssetClass,
  INTERNATIONAL_MAPPING_NOTE
} from '../services/import/standard/StandardAssetClasses';
import {
  StandardImportIssue,
  STANDARD_IMPORT_ISSUE_MESSAGES
} from '../services/import/standard/StandardImportErrors';
import {
  StandardImportResult,
  StandardImportRowResolution
} from '../services/import/standard/StandardImportResult';
import { StandardImportService } from '../services/import/standard/StandardImportService';

const TEMPLATE_FILENAME = 'finboom_standard_import_template.csv';
const TEMPLATE_MIME = 'text/csv;charset=utf-8;';
const TEMPLATE_HEADER = 'Asset Name,Current Value,Asset Class,Tag,Currency,Geography';
const TEMPLATE_EXAMPLE_1 = 'HDFC Savings Account,50000,Cash & Savings,Core,INR,India';
const TEMPLATE_EXAMPLE_2 = 'EPF Balance,350000,EPF / PPF / NPS,Retirement,INR,India';
const TEMPLATE_CONTENT = `${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE_1}\n${TEMPLATE_EXAMPLE_2}\n`;

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CONTENT], { type: TEMPLATE_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', TEMPLATE_FILENAME);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Best-effort URL release; safe in browsers and jsdom.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface CommitState {
  kind: 'idle' | 'busy' | 'success' | 'error';
  message?: string;
}

export const StandardImportSection: React.FC = () => {
  const { assets, commitImportedStandardAssets } = useCanonicalLedger();

  // Default Asset Class is OPTIONAL with no default. Null = unset.
  const [defaultAssetClass, setDefaultAssetClass] = useState<StandardAssetClass | null>(null);

  // The most recent parse result (file-level + per-row). Null = no file uploaded yet.
  const [result, setResult] = useState<StandardImportResult | null>(null);
  // The selected source filename.
  const [selectedFileName, setSelectedFileName] = useState<string>(TEMPLATE_FILENAME);

  const [commitState, setCommitState] = useState<CommitState>({ kind: 'idle' });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(String(e.target?.result ?? ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    try {
      const text = await readFileAsText(file);
      const r = StandardImportService.parseAndValidate({
        csvText: text,
        sourceFilename: file.name,
        defaultAssetClass,
        existingAssets: assets
      });
      setResult(r);
      setCommitState({ kind: 'idle' });
    } catch (err: any) {
      setResult({
        validRows: [],
        issues: [
          {
            code: 'STANDARD_MALFORMED_CSV',
            severity: 'INVALID',
            message: err?.message || 'Failed to read the file.'
          }
        ],
        perRowResolution: [],
        summary: {
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          duplicateInBatch: 0,
          duplicateOfExistingAsset: 0,
          csvSuppliedAssetClass: 0,
          uiDefaultApplied: 0,
          uiDefaultReplacedInvalid: 0,
          templateUploadedUnchanged: false
        },
        sourceFilename: file.name
      });
      setCommitState({ kind: 'idle' });
    } finally {
      // Allow the same file to be re-selected.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Re-run the review when the user changes the Default Asset Class.
  // We re-parse the LAST uploaded file text. To do that without
  // re-asking the user for the file, we cache the original text in
  // a ref keyed by filename.
  const lastTextRef = useRef<{ filename: string; text: string } | null>(null);
  useEffect(() => {
    if (!result) return;
    if (!lastTextRef.current) return;
    if (lastTextRef.current.filename !== result.sourceFilename) return;
    const r = StandardImportService.parseAndValidate({
      csvText: lastTextRef.current.text,
      sourceFilename: lastTextRef.current.filename,
      defaultAssetClass,
      existingAssets: assets
    });
    // Preserve the source filename.
    r.sourceFilename = lastTextRef.current.filename;
    setResult(r);
    setCommitState({ kind: 'idle' });
    // We intentionally depend on defaultAssetClass + assets to
    // re-trigger; result is in the deps to capture the latest filename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAssetClass, assets]);

  // Wrap the file-upload handler to also cache the text in the ref.
  const handleFileUploadWithCache = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    try {
      const text = await readFileAsText(file);
      lastTextRef.current = { filename: file.name, text };
      const r = StandardImportService.parseAndValidate({
        csvText: text,
        sourceFilename: file.name,
        defaultAssetClass,
        existingAssets: assets
      });
      setResult(r);
      setCommitState({ kind: 'idle' });
    } catch (err: any) {
      setResult({
        validRows: [],
        issues: [
          {
            code: 'STANDARD_MALFORMED_CSV',
            severity: 'INVALID',
            message: err?.message || 'Failed to read the file.'
          }
        ],
        perRowResolution: [],
        summary: {
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          duplicateInBatch: 0,
          duplicateOfExistingAsset: 0,
          csvSuppliedAssetClass: 0,
          uiDefaultApplied: 0,
          uiDefaultReplacedInvalid: 0,
          templateUploadedUnchanged: false
        },
        sourceFilename: file.name
      });
      lastTextRef.current = null;
      setCommitState({ kind: 'idle' });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCommit = async () => {
    if (!result) return;
    if (result.validRows.length === 0) return;
    if (commitState.kind === 'busy') return;
    setCommitState({ kind: 'busy' });
    try {
      const outcome = commitImportedStandardAssets(result.validRows);
      if (outcome.persisted) await outcome.persisted;
      // Compute the V1 message.
      const issues = result.issues;
      const errorMessages = issues
        .filter((i: StandardImportIssue) => i.severity === 'INVALID')
        .slice(0, 10)
        .map((i: StandardImportIssue) => i.message);
      const totalRejected = result.summary.invalidRows + result.summary.duplicateInBatch;
      const headline = result.summary.templateUploadedUnchanged
        ? 'Template uploaded unchanged.'
        : 'Import committed.';
      const detail = result.summary.templateUploadedUnchanged
        ? 'No assets were imported. Add your assets to the template and re-upload.'
        : `Imported ${outcome.appended} asset${outcome.appended === 1 ? '' : 's'}. ` +
            `Note: V1 Standard Import does not support rollback. ` +
            `To remove an imported asset, use the Edit / Remove affordance in the Wealth workspace.` +
            (totalRejected > 0 ? ` ${totalRejected} row(s) were skipped (see issues below).` : '');
      setCommitState({ kind: 'success', message: `${headline} ${detail}` });
      // Record the import history entry.
      const importResult: 'success' | 'partial' | 'failure' =
        totalRejected === 0
          ? 'success'
          : outcome.appended === 0
          ? 'failure'
          : 'partial';
      try {
        ImportHistoryService.record({
          importType: 'STANDARD_IMPORT',
          institution: 'Standard Import',
          sourceFilename: result.sourceFilename,
          result: importResult,
          processedCount: result.summary.totalRows,
          importedCount: outcome.appended,
          rejectedCount: totalRejected,
          errorSummary: errorMessages
        });
      } catch {
        // Best-effort; a failure to record history does not affect the
        // import outcome, which has already been committed.
      }
      // Clear the review state on success.
      setResult(null);
      lastTextRef.current = null;
    } catch (err: any) {
      // Record the failure too.
      try {
        ImportHistoryService.record({
          importType: 'STANDARD_IMPORT',
          institution: 'Standard Import',
          sourceFilename: result.sourceFilename,
          result: 'failure',
          processedCount: result.summary.totalRows,
          importedCount: 0,
          rejectedCount: result.summary.totalRows,
          errorSummary: [err?.message || 'Persistence failed.']
        });
      } catch { /* best-effort */ }
      setCommitState({
        kind: 'error',
        message: err?.message || 'The import could not be saved. Nothing was imported — the reviewed rows are still here, so you can try again.'
      });
    }
  };

  // Issues split by severity for the diagnostics table.
  const issuesBySeverity = useMemo(() => {
    if (!result) return { invalid: [] as StandardImportIssue[], warning: [] as StandardImportIssue[], info: [] as StandardImportIssue[] };
    const invalid: StandardImportIssue[] = [];
    const warning: StandardImportIssue[] = [];
    const info: StandardImportIssue[] = [];
    for (const i of result.issues) {
      if (i.severity === 'INVALID') invalid.push(i);
      else if (i.severity === 'WARNING') warning.push(i);
      else info.push(i);
    }
    return { invalid, warning, info };
  }, [result]);

  const isTemplateUnchanged = result?.summary.templateUploadedUnchanged === true;
  const canCommit = !!result && result.validRows.length > 0 && commitState.kind !== 'busy';

  return (
    <div className="space-y-6" data-testid="import-subtab-panel-standard">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
          Standard Import
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          1. DOWNLOAD TEMPLATE ➔ 2. SELECT DEFAULT ASSET CLASS ➔ 3. UPLOAD ➔ 4. REVIEW ➔ 5. COMMIT
        </p>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm space-y-6">
        {/* Step 1: Download Template */}
        <div data-testid="standard-step-1" data-testid-standard-step="1">
          <h3 className="font-bold text-gray-900 dark:text-white text-base mb-2">
            Step 1: Download CSV Template
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            Download the Standard Import template. Required columns: Asset Name, Current Value.
            Optional columns: Asset Class, Tag, Currency, Geography.
          </p>
          <button
            type="button"
            data-testid="standard-download-template"
            onClick={downloadTemplate}
            className="px-5 py-2.5 rounded-lg bg-green-700 hover:bg-green-800 text-white font-bold text-sm shadow-sm inline-flex items-center gap-2"
          >
            <Download size={16} /> Download CSV Template
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            Filename: <code>{TEMPLATE_FILENAME}</code>
          </p>
        </div>

        {/* Step 2: Default Asset Class */}
        <div data-testid="standard-step-2" data-testid-standard-step="2">
          <h3 className="font-bold text-gray-900 dark:text-white text-base mb-2">
            Step 2: Select Default Asset Class
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            Default Asset Class <span className="text-gray-500">(optional)</span>:
          </p>
          <select
            data-testid="standard-default-asset-class"
            value={defaultAssetClass ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') {
                setDefaultAssetClass(null);
              } else {
                setDefaultAssetClass(v as StandardAssetClass);
              }
            }}
            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white"
          >
            <option value="">— Select —</option>
            {STANDARD_IMPORT_ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            If you leave this unset, each row must have its own Asset Class in the CSV.
          </p>
        </div>

        {/* Step 3: Upload */}
        <div data-testid="standard-step-3" data-testid-standard-step="3">
          <h3 className="font-bold text-gray-900 dark:text-white text-base mb-2">
            Step 3: Upload File
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
            Upload the completed CSV (UTF-8, no BOM required; LF line endings).
          </p>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUploadWithCache}
            accept=".csv,text/csv"
            className="hidden"
            data-testid="standard-file-input"
          />
          <button
            type="button"
            data-testid="standard-select-file"
            onClick={() => fileInputRef.current?.click()}
            className="px-5 py-2.5 rounded-lg bg-gray-700 hover:bg-gray-800 text-white font-bold text-sm shadow-sm inline-flex items-center gap-2"
          >
            <Upload size={16} /> Select File (.csv)
          </button>
        </div>

        {/* Commit notice */}
        {commitState.kind !== 'idle' && commitState.message && (
          <div
            data-testid="standard-commit-notice"
            data-commit-kind={commitState.kind === 'busy' ? 'busy' : commitState.kind}
            className={`rounded-lg border p-3 text-xs ${
              commitState.kind === 'success'
                ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200'
                : commitState.kind === 'error'
                ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200'
                : 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200'
            }`}
          >
            {commitState.message}
          </div>
        )}

        {/* Step 4: Review */}
        {result && (
          <div
            data-testid="standard-review"
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-base text-gray-900 dark:text-white inline-flex items-center gap-2">
                <FileText size={18} /> Stage 4: Review ({result.sourceFilename})
              </span>
            </div>

            {/* Summary line */}
            <div
              data-testid="standard-summary"
              className="text-sm text-gray-600 dark:text-gray-400 space-y-1"
            >
              {isTemplateUnchanged ? (
                <div
                  data-testid="standard-template-unchanged"
                  className="flex items-center gap-2"
                >
                  <AlertTriangle size={16} className="text-amber-600" />
                  <span>{STANDARD_IMPORT_ISSUE_MESSAGES.STANDARD_TEMPLATE_UPLOADED_UNCHANGED}</span>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-green-600" />
                    <span>
                      <strong>{result.summary.validRows} Valid Assets</strong>
                      {result.summary.invalidRows > 0 && (
                        <> · <strong>{result.summary.invalidRows}</strong> row error(s)</>
                      )}
                      {result.summary.duplicateInBatch > 0 && (
                        <> · <strong>{result.summary.duplicateInBatch}</strong> duplicate(s) in file</>
                      )}
                      {result.summary.duplicateOfExistingAsset > 0 && (
                        <> · <strong>{result.summary.duplicateOfExistingAsset}</strong> duplicate name (existing Asset)</>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>
                      Asset Class: {result.summary.csvSuppliedAssetClass} CSV-supplied,{' '}
                      {result.summary.uiDefaultApplied} UI default,{' '}
                      {result.summary.uiDefaultReplacedInvalid} default-replaced-invalid
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Per-row review table (read-only) */}
            {!isTemplateUnchanged && result.validRows.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded border border-gray-200 dark:border-gray-800">
                <table
                  className="w-full text-xs"
                  data-testid="standard-review-table"
                >
                  <thead className="bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-400 font-bold sticky top-0">
                    <tr>
                      <th className="text-left py-1.5 px-2">#</th>
                      <th className="text-left py-1.5 px-2">Asset Name</th>
                      <th className="text-left py-1.5 px-2">Current Value</th>
                      <th className="text-left py-1.5 px-2">Asset Class (Resolved)</th>
                      <th className="text-left py-1.5 px-2">Source</th>
                      <th className="text-left py-1.5 px-2">Tag</th>
                      <th className="text-left py-1.5 px-2">Currency</th>
                      <th className="text-left py-1.5 px-2">Geography</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-800 text-gray-700 dark:text-gray-300">
                    {result.validRows.map((a: Asset, idx: number) => {
                      const r: StandardImportRowResolution | undefined = result.perRowResolution[idx];
                      return (
                        <tr
                          key={idx}
                          data-testid={`standard-review-row-${idx}`}
                          data-row-source={r?.source ?? 'CSV'}
                          data-row-duplicate={r?.isDuplicateOfExistingAsset ? 'true' : 'false'}
                        >
                          <td className="py-1.5 px-2 font-mono">{idx + 1}</td>
                          <td className="py-1.5 px-2 truncate max-w-[200px]">{a.name}</td>
                          <td className="py-1.5 px-2 font-mono">{a.amount}</td>
                          <td className="py-1.5 px-2">{a.type}</td>
                          <td className="py-1.5 px-2">
                            <span
                              data-testid={`standard-row-source-chip-${idx}`}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                r?.source === 'CSV'
                                  ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                                  : r?.source === 'Default'
                                  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                                  : r?.source === 'Default (was invalid)'
                                  ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                              }`}
                            >
                              {r?.source ?? 'CSV'}
                              {r?.isDuplicateOfExistingAsset ? ' · Dup' : ''}
                            </span>
                          </td>
                          <td className="py-1.5 px-2">{a.tag ?? ''}</td>
                          <td className="py-1.5 px-2">{a.currency ?? ''}</td>
                          <td className="py-1.5 px-2">{a.geography ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* International note (visible if any row triggered the mapping) */}
            {result.perRowResolution.some((r) => r.note) && (
              <div
                data-testid="standard-international-note"
                className="rounded-md border border-blue-300 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-950/40 text-xs text-blue-800 dark:text-blue-200"
              >
                {INTERNATIONAL_MAPPING_NOTE}
              </div>
            )}

            {/* Issues / diagnostics */}
            {(issuesBySeverity.invalid.length > 0 || issuesBySeverity.warning.length > 0) && (
              <details
                data-testid="standard-issues"
                className="rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs"
              >
                <summary className="cursor-pointer font-bold text-gray-700 dark:text-gray-300">
                  {issuesBySeverity.invalid.length} error(s) · {issuesBySeverity.warning.length} warning(s)
                </summary>
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {[...issuesBySeverity.invalid, ...issuesBySeverity.warning].map((i, k) => (
                    <div
                      key={k}
                      data-issue-code={i.code}
                      data-issue-severity={i.severity}
                      className={`flex items-start gap-1 ${
                        i.severity === 'INVALID' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'
                      }`}
                    >
                      {i.severity === 'INVALID'
                        ? <XCircle size={12} className="mt-0.5 shrink-0" />
                        : <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                      <span>
                        {i.rowNumber !== undefined && <strong>Row {i.rowNumber}: </strong>}
                        {i.message}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Step 5: Commit */}
            <div className="pt-2">
              <button
                type="button"
                data-testid="standard-commit"
                onClick={handleCommit}
                disabled={!canCommit}
                className={`px-5 py-2.5 rounded-lg font-bold text-sm shadow-sm transition ${
                  canCommit
                    ? 'bg-green-700 hover:bg-green-800 text-white'
                    : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                }`}
              >
                {commitState.kind === 'busy'
                  ? 'Committing…'
                  : isTemplateUnchanged
                  ? 'Nothing to commit (template uploaded unchanged)'
                  : `Review & Commit ${result.validRows.length} Valid Asset${result.validRows.length === 1 ? '' : 's'} to Net Worth`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
