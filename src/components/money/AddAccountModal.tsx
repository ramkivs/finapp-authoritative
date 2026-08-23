import React, { useState } from 'react';
import { ControlledAccountType } from '../../domain/types';
import { getEffectiveAsOfDate } from '../../services/DateRangeService';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { X, Building2, CreditCard, Wallet, Landmark, HelpCircle, ArrowLeft } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const ACCOUNT_TYPES: Array<{ type: ControlledAccountType; desc: string; icon: any }> = [
  { type: 'Bank', desc: 'Checking, savings & current accounts', icon: Landmark },
  { type: 'Credit Card', desc: 'Revolving credit & charge cards', icon: CreditCard },
  { type: 'Cash', desc: 'Physical currency & petty cash', icon: Wallet },
  { type: 'Wallet', desc: 'Digital wallets & UPI balances', icon: Wallet },
  { type: 'Broker', desc: 'Investment & trading accounts', icon: Building2 },
  { type: 'Other', desc: 'Other financial accounts', icon: HelpCircle }
];

export const AddAccountModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedType, setSelectedType] = useState<ControlledAccountType>('Bank');
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [lastFourDigits, setLastFourDigits] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [currency, setCurrency] = useState('');
  const [asOfDate, setAsOfDate] = useState(getEffectiveAsOfDate());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  /** WP-FB-DATA-08B: in-flight while persistence is unresolved. */
  const [busy, setBusy] = useState(false);

  const { addAccount } = useCanonicalLedger();

  if (!isOpen) return null;

  const handleSelectType = (type: ControlledAccountType) => {
    setSelectedType(type);
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    if (busy) return;
    e.preventDefault();
    setError('');

    if (!name || !name.trim()) {
      setError('Account name is required.');
      return;
    }

    setBusy(true);

    try {
      await addAccount({
        name: name.trim(),
        type: selectedType,
        institution: institution.trim() || undefined,
        lastFourDigits: lastFourDigits.trim() || undefined,
        openingBalance: Number(openingBalance) || 0,
        currency: currency.trim() || undefined, // No default INR; preserves Not Specified
        asOfDate: asOfDate || getEffectiveAsOfDate(),
        notes: notes.trim() || undefined
      });

      // Reset and close
      setName('');
      setInstitution('');
      setLastFourDigits('');
      setOpeningBalance('');
      setCurrency('');
      setNotes('');
      setStep(1);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error recording account.');
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
              {step === 1 ? 'Step 1: Select Account Type' : `Step 2: Add ${selectedType} Account`}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {step === 1 ? 'Choose an institutional account classification' : 'Enter account identifiers and opening balance'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 rounded-xl text-rose-700 dark:text-rose-400 text-xs font-semibold mb-4">
            {error}
          </div>
        )}

        {step === 1 ? (
          <div className="grid grid-cols-2 gap-3">
            {ACCOUNT_TYPES.map(cat => {
              const Icon = cat.icon;
              return (
                <button
                  key={cat.type}
                  onClick={() => handleSelectType(cat.type)}
                  className="bg-gray-50 dark:bg-gray-800 hover:bg-green-50 dark:hover:bg-green-950/20 border border-gray-200 dark:border-gray-700 hover:border-green-600 dark:hover:border-green-500 p-4 rounded-xl text-left transition flex flex-col justify-between h-24 group"
                >
                  <div className="flex items-center gap-2">
                    <Icon size={16} className="text-gray-500 group-hover:text-green-600" />
                    <span className="text-sm font-bold text-gray-900 dark:text-white group-hover:text-green-700 dark:group-hover:text-green-400">
                      {cat.type}
                    </span>
                  </div>
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">{cat.desc}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                Account Name (Unique) *
              </label>
              <input
                type="text"
                placeholder="e.g. HDFC Salary Account, Zerodha Equity"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Institution / Provider
                </label>
                <input
                  type="text"
                  placeholder="e.g. HDFC Bank, ICICI"
                  value={institution}
                  onChange={e => setInstitution(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Last 4 Digits
                </label>
                <input
                  type="text"
                  placeholder="e.g. 4921"
                  maxLength={4}
                  value={lastFourDigits}
                  onChange={e => setLastFourDigits(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Opening Balance
                </label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={openingBalance}
                  onChange={e => setOpeningBalance(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Currency (Metadata)
                </label>
                <input
                  type="text"
                  placeholder="e.g. INR, USD (optional)"
                  value={currency}
                  onChange={e => setCurrency(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                Balance As-Of Date <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                required
                value={asOfDate}
                onChange={e => setAsOfDate(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2.5 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
              />
              {/* WP-FB-DATA-05a / Decision B4: the anchor is a financial input,
                  not an incidental timestamp. State its meaning explicitly so it
                  is never silently interpreted as "today". */}
              <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                The date this opening balance was actually true. Transactions{' '}
                <span className="font-semibold">on or before</span> it are treated as already
                included in the opening balance; only later transactions change the current
                balance. Set this to the statement date your opening figure came from — if you
                plan to import older history, choose a date before it.
              </p>
            </div>

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
                type="submit"
                  id="add-account-submit"
                  data-write-busy={busy ? 'true' : 'false'}
                  disabled={busy}
                className="px-5 py-2.5 rounded-xl bg-green-700 hover:bg-green-800 text-white font-bold text-xs transition shadow-sm"
              >
                Save Account
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
