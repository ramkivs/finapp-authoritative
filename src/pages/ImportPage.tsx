import React, { useState, useRef } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { ImportPipelineService, CSVImportResult } from '../services/ImportPipelineService';
import { Upload, FileText, CheckCircle2, AlertTriangle, XCircle, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';

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
  const [selectedBroker, setSelectedBroker] = useState('Zerodha');
  const [showReview, setShowReview] = useState(false);
  const [importResult, setImportResult] = useState<CSVImportResult | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('Simulated_Statement.csv');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { transactions, commitImportedRows } = useCanonicalLedger();

  const brokers = [
    'Zerodha', 'Groww', 'INDmoney', 'Upstox', 'ICICI Direct',
    'CDSL', 'Angel One', 'HDFC Bank', 'SBI Bank', 'ICICI Bank'
  ];

  const runPipeline = (csvText: string, fileName: string) => {
    const result = ImportPipelineService.processCSV(csvText, transactions, selectedBroker, fileName);
    setImportResult(result);
    setSelectedFileName(fileName);
    setShowReview(true);
    setShowDiagnostics(result.unsupportedFormat || (result.invalidRows && result.invalidRows.length > 0) || (result.ambiguousRows && result.ambiguousRows.length > 0));
  };

  const handleSimulate = () => {
    runPipeline(SAMPLE_DEFAULT_CSV, `${selectedBroker}_Statement_Aug2026.csv`);
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
          const result = ImportPipelineService.processBinaryFile(bytes, transactions, selectedBroker, file.name);
          setImportResult(result);
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

  const handleCommit = () => {
    if (!importResult) return;
    const { appended, duplicates, divergentDuplicates } = commitImportedRows(importResult.validRows);
    setShowReview(false);
    setImportResult(null);
    // WP-FB-DATA-06a: an excluded row may be reported, but never silently dropped.
    const divergentNote = divergentDuplicates > 0
      ? `\n\nNote: ${divergentDuplicates} of the excluded duplicates disagreed with the stored row on direction/type. Those differences were NOT applied.`
      : '';
    alert(`Algorithmic Set<fingerprint>: Appended ${appended} new rows. Automatically excluded ${duplicates} exact duplicates.${divergentNote}`);
  };

  const allIssues = [
    ...(importResult?.invalidRows || []),
    ...(importResult?.ambiguousRows || [])
  ].sort((a, b) => a.rowNumber - b.rowNumber);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white tracking-tight">
          5-Stage Bulk Import Engine
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          1. UPLOAD ➔ 2. DETECT ➔ 3. PARSE ➔ 4. NORMALIZE ➔ 5. REVIEW ➔ COMMIT (Append Mode)
        </p>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm">
        <h3 className="font-bold text-gray-900 dark:text-white text-base mb-4">
          Select Institution (18+ Supported Brokerages & Indian Banks)
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {brokers.map(b => {
            const active = selectedBroker === b;
            return (
              <button
                key={b}
                onClick={() => setSelectedBroker(b)}
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
            Native support for HDFC Bank, ICICI Bank, SBI Bank & Generic CSV exports with SHA-256 deduplication and formula sanitization.
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

                <div className="pt-2">
                  <button
                    onClick={handleCommit}
                    disabled={importResult.validRows.length === 0}
                    className={`px-5 py-2.5 rounded-lg font-bold text-sm shadow-sm transition ${
                      importResult.validRows.length === 0
                        ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                        : 'bg-green-700 hover:bg-green-800 text-white'
                    }`}
                  >
                    Review & Commit {importResult.validRows.length} Valid Rows to Canonical Ledger (Append Mode)
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
