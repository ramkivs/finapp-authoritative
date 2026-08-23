import React, { useState } from 'react';
import { AssetType, GeographyType } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { X, ArrowLeft } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** WP-FB-DATA-07b: lets the workspace report the outcome next to the table. */
  onSaved?: (message: string) => void;
}

const ASSET_CATEGORIES: Array<{ type: AssetType; desc: string }> = [
  { type: 'Equity', desc: 'Stocks, mutual funds & ETFs' },
  { type: 'Debt', desc: 'Bonds, FDs, PPF & liquid funds' },
  { type: 'Real Estate', desc: 'Physical properties & REITs' },
  { type: 'Commodities', desc: 'Gold, silver & sovereign bonds' },
  { type: 'Cash & Savings', desc: 'Checking, savings & wallets' },
  { type: 'Crypto', desc: 'Digital assets & tokens' },
  { type: 'Alternatives', desc: 'Private equity & venture' },
  { type: 'Other', desc: 'Other institutional assets' }
];

export const AddAssetModal: React.FC<Props> = ({ isOpen, onClose, onSaved }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedType, setSelectedType] = useState<AssetType>('Equity');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [tag, setTag] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [geography, setGeography] = useState<GeographyType>('India');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { addAssetWithMetadata } = useCanonicalLedger();

  if (!isOpen) return null;

  const handleSelectCategory = (type: AssetType) => {
    setSelectedType(type);
    setStep(2);
  };

  /**
   * WP-FB-DATA-07b: the write is AWAITED.
   *
   * Previously this called and closed. The 07b gate measured a failing create
   * closing the modal as if it had worked, with no notice and an unhandled page
   * error. A refusal or a persistence failure now keeps the modal open and says
   * why.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !amount || busy) return;
    setError(null);
    setBusy(true);
    try {
      await addAssetWithMetadata({
        name: name.trim(),
        amount: Number(amount),
        type: selectedType,
        tag: tag || undefined,
        currency: currency || undefined,
        geography: geography || undefined
      });
      onSaved?.(`"${name.trim()}" is now part of your net worth.`);
      setName('');
      setAmount('');
      setTag('');
      setStep(1);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'The asset could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 className="text-lg font-extrabold text-gray-900 dark:text-white">
              {step === 1 ? 'Step 1: Select Asset Category' : `Step 2: Add ${selectedType} Asset`}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {step === 1 ? 'Choose an institutional asset class' : 'Enter asset valuation and metadata'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        {step === 1 ? (
          <div className="grid grid-cols-2 gap-3">
            {ASSET_CATEGORIES.map((cat) => (
              <button
                key={cat.type}
                onClick={() => handleSelectCategory(cat.type)}
                className="bg-gray-50 dark:bg-gray-800 hover:bg-green-50 dark:hover:bg-green-950/20 border border-gray-200 dark:border-gray-700 hover:border-green-600 dark:hover:border-green-500 p-4 rounded-xl text-left transition flex flex-col justify-between h-24 group"
              >
                <span className="text-sm font-bold text-gray-900 dark:text-white group-hover:text-green-700 dark:group-hover:text-green-400">{cat.type}</span>
                <span className="text-[11px] text-gray-500 dark:text-gray-400">{cat.desc}</span>
              </button>
            ))}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Asset Name *</label>
              <input
                type="text"
                placeholder="e.g. HDFC Savings, Zerodha Equity"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Valuation (INR) *</label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Geography</label>
                <select
                  value={geography}
                  onChange={(e) => setGeography(e.target.value as GeographyType)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
                >
                  <option value="India">India</option>
                  <option value="International">International</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Currency (Metadata)</label>
                <input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">Tag (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Core, High Growth"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 dark:focus:border-green-500"
                />
              </div>
            </div>

            {error && (
              <div
                id="add-asset-error"
                data-asset-kind="error"
                role="alert"
                className="rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2.5 text-xs font-semibold text-rose-800 dark:text-rose-300"
              >
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t border-gray-200 dark:border-gray-800 mt-6">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold transition"
              >
                <ArrowLeft size={14} />
                <span>Back</span>
              </button>

              <button
                id="add-asset-submit"
                type="submit"
                disabled={busy}
                className="px-5 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-bold text-xs transition shadow-sm"
              >
                {busy ? 'Saving…' : 'Save Asset'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
