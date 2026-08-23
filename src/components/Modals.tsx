import React, { useState } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const IncomeModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  const accounts = useCanonicalLedger(s => s.accounts);
  const defaultAcc = accounts.length > 0 ? accounts[0].name : 'HDFC Bank (...4921)';

  const [ticker, setTicker] = useState('ITC Limited');
  const [amount, setAmount] = useState(2100);
  const [account, setAccount] = useState(defaultAcc);
  const [type, setType] = useState('DIVIDEND');
  const [notes, setNotes] = useState('Quarterly Interim Dividend');

  const addIncome = useCanonicalLedger(s => s.addIncome);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isOpen) return null;

  /**
   * WP-FB-DATA-08B: the write is AWAITED.
   *
   * Measured at the 08B gate: this called and closed, so a persistence failure
   * left the ledger unchanged, told the user nothing, and escaped as an
   * unhandled page error.
   */
  const handleSave = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await addIncome(ticker, Number(amount), account, type, notes);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'The income could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">+ Add Income (Canonical Ledger)</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Income Type</label>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-medium text-gray-900 dark:text-white"
            >
              <option value="DIVIDEND">Dividend (Realized Cash Credit)</option>
              <option value="SALARY">Salary</option>
              <option value="BONUS">Bonus / Interest</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Security / Company Ticker</label>
            <input
              type="text"
              value={ticker}
              onChange={e => setTicker(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Amount (₹)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(Number(e.target.value))}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Credited Account</label>
            {accounts.length > 0 ? (
              <select
                value={account}
                onChange={e => setAccount(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={account}
                onChange={e => setAccount(e.target.value)}
                placeholder="e.g. HDFC Bank (...4921)"
                className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Notes / Provenance</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
            />
          </div>
        </div>
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          {error && (
            <div
              id="add-income-error"
              data-write-kind="error"
              role="alert"
              className="w-full mb-2 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs font-semibold text-rose-800 dark:text-rose-300"
            >
              {error}
            </div>
          )}
          <button
            id="add-income-submit"
            data-write-busy={busy ? 'true' : 'false'}
            disabled={busy}
            onClick={handleSave}
            className="px-5 py-2 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-sm"
          >
            {busy ? 'Saving…' : 'Save to Canonical Ledger'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const ExpenseModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  const accounts = useCanonicalLedger(s => s.accounts);
  const defaultAcc = accounts.length > 0 ? accounts[0].name : 'HDFC Bank (...4921)';

  const [title, setTitle] = useState('Swiggy Food Delivery');
  const [amount, setAmount] = useState(1450);
  const [account, setAccount] = useState(defaultAcc);
  const [category, setCategory] = useState('DINING');

  const addExpense = useCanonicalLedger(s => s.addExpense);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isOpen) return null;

  /**
   * WP-FB-DATA-08B: the write is AWAITED.
   *
   * Measured at the 08B gate: this called and closed, so a persistence failure
   * left the ledger unchanged, told the user nothing, and escaped as an
   * unhandled page error.
   */
  const handleSave = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await addExpense(title, Number(amount), account, category);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'The expense could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">- Add Expense</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Merchant / Description</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Amount (₹)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(Number(e.target.value))}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Debited Account</label>
            {accounts.length > 0 ? (
              <select
                value={account}
                onChange={e => setAccount(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={account}
                onChange={e => setAccount(e.target.value)}
                placeholder="e.g. HDFC Bank (...4921)"
                className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Category</label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-medium text-gray-900 dark:text-white"
            >
              <option value="DINING">Dining & Food</option>
              <option value="GROCERIES">Groceries</option>
              <option value="SHOPPING">Shopping</option>
              <option value="SUBSCRIPTION">Subscriptions & OTT</option>
              <option value="HOUSING">Housing & Rent</option>
              <option value="UTILITY">Utilities</option>
              <option value="TRANSPORT">Transport</option>
              <option value="INVESTMENT">Investment</option>
              <option value="OTHER">Other Expense</option>
            </select>
          </div>
        </div>
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          {error && (
            <div
              id="add-expense-error"
              data-write-kind="error"
              role="alert"
              className="w-full mb-2 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs font-semibold text-rose-800 dark:text-rose-300"
            >
              {error}
            </div>
          )}
          <button
            id="add-expense-submit"
            data-write-busy={busy ? 'true' : 'false'}
            disabled={busy}
            onClick={handleSave}
            className="px-5 py-2 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-sm"
          >
            {busy ? 'Saving…' : 'Save Expense'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const TransferModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  const accounts = useCanonicalLedger(s => s.accounts);
  const defaultSrc = accounts.length > 0 ? accounts[0].name : 'HDFC Bank (...4921)';
  const defaultDest = accounts.length > 1 ? accounts[1].name : 'Zerodha Trading Account';

  const [source, setSource] = useState(defaultSrc);
  const [dest, setDest] = useState(defaultDest);
  const [amount, setAmount] = useState(50000);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addTransfer = useCanonicalLedger(s => s.addTransfer);

  if (!isOpen) return null;

  /**
   * WP-FB-DATA-06b: awaits the write and keeps the modal OPEN on failure.
   *
   * This previously called addTransfer(...) and then onClose() unconditionally.
   * With an integrity gate in place that pattern would close the dialog on a
   * silently-swallowed unhandled rejection — the user would believe their money
   * had been recorded when it had been refused. An invariant the user cannot
   * see is not an invariant they can act on.
   */
  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await addTransfer(source, dest, Number(amount));
      setSaving(false);
      onClose();
    } catch (e: any) {
      setSaving(false);
      setError(e?.message || 'The transfer could not be recorded.');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">⇄ Add Bank-to-Bank Transfer (₹0 Impact)</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Source Account (Debit)</label>
            {accounts.length > 0 ? (
              <select
                value={source}
                onChange={e => setSource(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={source}
                onChange={e => setSource(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Destination Account (Credit)</label>
            {accounts.length > 0 ? (
              <select
                value={dest}
                onChange={e => setDest(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={dest}
                onChange={e => setDest(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
              />
            )}
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Amount (₹)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(Number(e.target.value))}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
            />
          </div>
          {error && (
            <div id="transfer-error" className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950/40">
              <p className="text-xs font-semibold text-red-800 dark:text-red-200">
                This transfer was not recorded.
              </p>
              <p className="mt-0.5 text-xs text-red-700 dark:text-red-300">{error}</p>
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                Nothing was saved and no balance changed. A transfer must be a complete, balanced pair.
              </p>
            </div>
          )}
        </div>
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white text-sm font-bold shadow-sm"
          >
            {saving ? 'Recording…' : 'Record Transfer (₹0 Net Impact)'}
          </button>
        </div>
      </div>
    </div>
  );
};
