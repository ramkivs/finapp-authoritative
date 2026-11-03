import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileCheck2,
  HardDrive,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import {
  BackupValidationError,
  LocalBackupEnvelope,
  LocalBackupReceipt,
  LocalBackupService,
} from '../services/LocalBackupService';

async function readLocalFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Failed to read the selected backup file.'));
    reader.readAsText(file);
  });
}

function triggerLocalJsonDownload(fileName: string, json: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export const SettingsPage: React.FC = () => {
  const transactions = useCanonicalLedger((s) => s.transactions);
  const assets = useCanonicalLedger((s) => s.assets);
  const liabilities = useCanonicalLedger((s) => s.liabilities);
  const holdings = useCanonicalLedger((s) => s.holdings);
  const holdingDeletionLog = useCanonicalLedger((s) => s.holdingDeletionLog);
  const snapshots = useCanonicalLedger((s) => s.snapshots);
  const accounts = useCanonicalLedger((s) => s.accounts);
  const budgets = useCanonicalLedger((s) => s.budgets);
  const policies = useCanonicalLedger((s) => s.policies);
  const goals = useCanonicalLedger((s) => s.goals);
  const profile = useCanonicalLedger((s) => s.profile);
  const exportLocalBackup = useCanonicalLedger((s) => s.exportLocalBackup);
  const restoreLocalBackup = useCanonicalLedger((s) => s.restoreLocalBackup);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [lastReceipt, setLastReceipt] = useState<LocalBackupReceipt | null>(() =>
    LocalBackupService.getLastBackupReceipt()
  );
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<LocalBackupReceipt | null>(null);

  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [pendingRawJson, setPendingRawJson] = useState<string | null>(null);
  const [verifiedPreview, setVerifiedPreview] = useState<LocalBackupEnvelope | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<{ code?: string; message: string } | null>(null);
  const [restoreSuccess, setRestoreSuccess] = useState<{
    digest: string;
    restoredAt: string;
    totalRecords: number;
  } | null>(null);

  const hasExistingVaultData =
    transactions.length > 0 ||
    assets.length > 0 ||
    liabilities.length > 0 ||
    holdings.length > 0 ||
    holdingDeletionLog.length > 0 ||
    snapshots.length > 0 ||
    accounts.length > 0 ||
    budgets.length > 0 ||
    policies.length > 0 ||
    goals.length > 0 ||
    profile !== null;

  const handleExportBackup = async () => {
    if (exportBusy || restoreBusy) return;
    setExportBusy(true);
    setExportError(null);
    setExportSuccess(null);
    try {
      const result = await exportLocalBackup();
      triggerLocalJsonDownload(result.fileName, result.json);
      const receipt = result.receipt as LocalBackupReceipt;
      setLastReceipt(receipt);
      setExportSuccess(receipt);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleSelectBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    setPendingRawJson(null);
    setVerifiedPreview(null);
    setRestoreError(null);
    setRestoreSuccess(null);

    try {
      const rawText = await readLocalFileText(file);
      const verified = await LocalBackupService.verifyAndParseBackup(rawText);
      setPendingRawJson(rawText);
      setVerifiedPreview(verified);
    } catch (err) {
      if (err instanceof BackupValidationError) {
        setRestoreError({ code: err.code, message: err.message });
      } else {
        setRestoreError({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRawJson || !verifiedPreview || restoreBusy || exportBusy) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const result = await restoreLocalBackup(pendingRawJson);
      const counts = result.recordCounts;
      const totalRecords =
        counts.transactions +
        counts.assets +
        counts.liabilities +
        counts.holdings +
        counts.holdingDeletionLog +
        counts.snapshots +
        counts.accounts +
        counts.budgets +
        counts.policies +
        counts.goals +
        (counts.hasProfile ? 1 : 0);

      setRestoreSuccess({
        digest: result.digest,
        restoredAt: result.restoredAt,
        totalRecords,
      });
      setPendingRawJson(null);
      setVerifiedPreview(null);
    } catch (err) {
      if (err instanceof BackupValidationError) {
        setRestoreError({ code: err.code, message: err.message });
      } else {
        setRestoreError({
          message:
            (err instanceof Error ? err.message : String(err)) +
            ' Existing local financial data was left unchanged.',
        });
      }
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleCancelRestore = () => {
    setPendingRawJson(null);
    setVerifiedPreview(null);
    setSelectedFileName(null);
    setRestoreError(null);
  };

  return (
    <div className="space-y-6" data-testid="settings-page">
      <div className="bg-surface-900 border border-surface-800 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-5 h-5 text-emerald-400" />
              <h1 className="text-xl font-bold text-slate-100">
                ArthaVault — Local Data Backup &amp; Verified Restore
              </h1>
            </div>
            <p className="text-sm text-slate-400 mt-1.5 max-w-3xl">
              Single-owner, client-only ArthaVault portability for your personal laptop. Backups export
              all 11 canonical IndexedDB collections to a local JSON file and verify integrity with
              FIPS 180-4 SHA-256 via Web Crypto <code className="text-slate-300">crypto.subtle</code> before restoration.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <ShieldCheck className="w-3.5 h-3.5" />
            100% Local Browser Execution
          </span>
        </div>

        {/* Live Canonical Dataset Summary */}
        <div className="mt-5 pt-5 border-t border-surface-800">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
            <Database className="w-3.5 h-3.5 text-brand-400" />
            <span>Current Local Vault Inventory</span>
          </div>
          <div
            className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5 text-xs"
            data-testid="backup-live-inventory"
          >
            <div className="bg-surface-950/70 border border-surface-800 rounded-lg px-3 py-2">
              <div className="text-slate-400">Transactions</div>
              <div className="text-slate-100 font-semibold text-sm">{transactions.length}</div>
            </div>
            <div className="bg-surface-950/70 border border-surface-800 rounded-lg px-3 py-2">
              <div className="text-slate-400">Holdings</div>
              <div className="text-slate-100 font-semibold text-sm">{holdings.length}</div>
            </div>
            <div className="bg-surface-950/70 border border-surface-800 rounded-lg px-3 py-2">
              <div className="text-slate-400">Deletion Audit</div>
              <div className="text-slate-100 font-semibold text-sm">{holdingDeletionLog.length}</div>
            </div>
            <div className="bg-surface-950/70 border border-surface-800 rounded-lg px-3 py-2">
              <div className="text-slate-400">Assets / Debt</div>
              <div className="text-slate-100 font-semibold text-sm">
                {assets.length} / {liabilities.length}
              </div>
            </div>
            <div className="bg-surface-950/70 border border-surface-800 rounded-lg px-3 py-2">
              <div className="text-slate-400">Accounts / Budgets</div>
              <div className="text-slate-100 font-semibold text-sm">
                {accounts.length} / {budgets.length}
              </div>
            </div>
            <div className="bg-surface-950/70 border border-surface-800 rounded-lg px-3 py-2">
              <div className="text-slate-400">Snapshots / Essentials</div>
              <div className="text-slate-100 font-semibold text-sm">
                {snapshots.length} / {policies.length + goals.length + (profile ? 1 : 0)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Export Card */}
        <section className="bg-surface-900 border border-surface-800 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-slate-100 font-semibold text-base">
              <Download className="w-4 h-4 text-brand-400" />
              <h2>Export Local JSON Backup</h2>
            </div>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
              Downloads a complete snapshot of transactions (including exclusions and supersession
              chains), broker holdings, holding deletion audit logs, assets, liabilities, snapshots,
              accounts, budgets, insurance policies, goals, and financial profile.
            </p>

            <div className="mt-4">
              <button
                type="button"
                data-testid="btn-export-local-backup"
                disabled={exportBusy || restoreBusy}
                onClick={handleExportBackup}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                <Download className="w-4 h-4" />
                {exportBusy ? 'Generating Backup…' : 'Download Local Backup (.json)'}
              </button>
            </div>

            {exportError && (
              <div
                role="alert"
                data-testid="backup-export-error"
                className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-200"
              >
                {exportError}
              </div>
            )}

            {(exportSuccess || lastReceipt) && (
              <div
                data-testid="backup-export-receipt"
                className="mt-4 rounded-lg border border-surface-700 bg-surface-950/70 p-3.5 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between text-slate-300 font-medium">
                  <span>{exportSuccess ? 'Backup Exported' : 'Last Retained Backup Receipt'}</span>
                  <span className="text-emerald-400">Schema v{(exportSuccess ?? lastReceipt)!.schemaVersion}</span>
                </div>
                <div className="text-slate-400">
                  File: <span className="text-slate-200 font-mono">{(exportSuccess ?? lastReceipt)!.fileName}</span>
                </div>
                <div className="text-slate-400">
                  Created: <span className="text-slate-200">{(exportSuccess ?? lastReceipt)!.createdAt}</span>
                </div>
                <div className="text-slate-400 break-all">
                  Integrity Digest:{' '}
                  <code className="text-emerald-300 font-mono" data-testid="backup-receipt-digest">
                    {(exportSuccess ?? lastReceipt)!.digest}
                  </code>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Restore Card */}
        <section className="bg-surface-900 border border-surface-800 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-slate-100 font-semibold text-base">
              <Upload className="w-4 h-4 text-emerald-400" />
              <h2>Verify &amp; Restore Backup</h2>
            </div>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
              Validates backup format, schema compatibility, record structure, and cryptographic
              digest before allowing restoration. Invalid or tampered files are rejected without
              modifying any existing local data.
            </p>

            <div className="mt-4">
              <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-surface-800 hover:bg-surface-700 border border-surface-700 text-slate-100 text-sm font-medium cursor-pointer transition-colors">
                <Upload className="w-4 h-4 text-emerald-400" />
                <span>Select Backup File (.json)</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  data-testid="input-restore-backup-file"
                  disabled={restoreBusy || exportBusy}
                  onChange={handleSelectBackupFile}
                  className="sr-only"
                />
              </label>
              {selectedFileName && (
                <div className="mt-2 text-xs text-slate-400">
                  Selected file: <span className="text-slate-200 font-mono">{selectedFileName}</span>
                </div>
              )}
            </div>

            {restoreError && (
              <div
                role="alert"
                data-testid="backup-restore-error"
                className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-200 space-y-1"
              >
                <div className="flex items-center gap-1.5 font-semibold text-rose-300">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Restore Refused{restoreError.code ? ` (${restoreError.code})` : ''}
                  </span>
                </div>
                <div>{restoreError.message}</div>
              </div>
            )}

            {verifiedPreview && (
              <div
                data-testid="backup-verify-preview"
                className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3.5 text-xs space-y-2.5"
              >
                <div className="flex items-center gap-1.5 text-emerald-300 font-semibold">
                  <FileCheck2 className="w-4 h-4 shrink-0" />
                  <span>Backup Integrity Verified — Ready to Restore</span>
                </div>
                <div className="text-slate-300 space-y-1">
                  <div>
                    Created: <span className="font-mono">{verifiedPreview.manifest.createdAt}</span>{' '}
                    (Schema v{verifiedPreview.manifest.schemaVersion}, DB v{verifiedPreview.manifest.dbVersion})
                  </div>
                  <div className="break-all">
                    Verified Digest:{' '}
                    <code className="text-emerald-300 font-mono">
                      {verifiedPreview.integrity.digest}
                    </code>
                  </div>
                  <div className="text-slate-400">
                    Records: {verifiedPreview.manifest.recordCounts.transactions} transactions,{' '}
                    {verifiedPreview.manifest.recordCounts.holdings} holdings,{' '}
                    {verifiedPreview.manifest.recordCounts.holdingDeletionLog} deletion logs,{' '}
                    {verifiedPreview.manifest.recordCounts.assets} assets,{' '}
                    {verifiedPreview.manifest.recordCounts.liabilities} liabilities,{' '}
                    {verifiedPreview.manifest.recordCounts.accounts} accounts,{' '}
                    {verifiedPreview.manifest.recordCounts.snapshots} snapshots,{' '}
                    {verifiedPreview.manifest.recordCounts.budgets} budgets,{' '}
                    {verifiedPreview.manifest.recordCounts.policies} policies,{' '}
                    {verifiedPreview.manifest.recordCounts.goals} goals, profile:{' '}
                    {verifiedPreview.manifest.recordCounts.hasProfile ? 'yes' : 'none'}.
                  </div>
                </div>

                {hasExistingVaultData && (
                  <div className="rounded border border-amber-500/30 bg-amber-950/30 px-2.5 py-2 text-amber-200">
                    Confirming restore will atomically replace the current local vault records in
                    this browser with the verified backup above.
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    data-testid="btn-confirm-restore-backup"
                    disabled={restoreBusy}
                    onClick={handleConfirmRestore}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium transition-colors"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {restoreBusy ? 'Restoring Vault…' : 'Confirm & Restore Backup'}
                  </button>
                  <button
                    type="button"
                    data-testid="btn-cancel-restore-backup"
                    disabled={restoreBusy}
                    onClick={handleCancelRestore}
                    className="px-3 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-slate-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {restoreSuccess && (
              <div
                role="status"
                data-testid="backup-restore-success"
                className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-200 space-y-1"
              >
                <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Backup Restored Successfully</span>
                </div>
                <div>
                  Restored {restoreSuccess.totalRecords} canonical record(s) across local memory and
                  IndexedDB (digest <code className="font-mono">{restoreSuccess.digest.slice(0, 16)}…</code>).
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
