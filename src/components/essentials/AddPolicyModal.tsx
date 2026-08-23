import React, { useState } from 'react';
import { PolicyType } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { X, Shield, HeartPulse, ArrowLeft } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const AddPolicyModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedType, setSelectedType] = useState<PolicyType>('Term Life');
  const [provider, setProvider] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [coverAmount, setCoverAmount] = useState('');
  const [premiumAmount, setPremiumAmount] = useState('');
  const [renewalDate, setRenewalDate] = useState('');
  const [currency, setCurrency] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  /** WP-FB-DATA-08B: in-flight while persistence is unresolved. */
  const [busy, setBusy] = useState(false);

  const { addPolicy } = useCanonicalLedger();

  if (!isOpen) return null;

  const handleSelectType = (type: PolicyType) => {
    setSelectedType(type);
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    if (busy) return;
    e.preventDefault();
    setError('');

    if (!provider.trim()) {
      setError('Insurance provider name is required.');
      return;
    }
    if (!coverAmount || Number(coverAmount) <= 0) {
      setError('Cover amount must be greater than zero.');
      return;
    }

    setBusy(true);

    try {
      await addPolicy({
        type: selectedType,
        provider: provider.trim(),
        policyNumber: policyNumber.trim() || undefined,
        coverAmount: Number(coverAmount) || 0,
        premiumAmount: Number(premiumAmount) || 0,
        renewalDate: renewalDate || undefined,
        status: 'Active',
        currency: currency.trim() || undefined, // No INR default; preserves Not Specified
        notes: notes.trim() || undefined
      });

      // Reset and close
      setProvider('');
      setPolicyNumber('');
      setCoverAmount('');
      setPremiumAmount('');
      setRenewalDate('');
      setCurrency('');
      setNotes('');
      setStep(1);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error recording insurance policy.');
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
              {step === 1 ? 'Step 1: Select Policy Type' : `Step 2: Add ${selectedType} Policy`}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {step === 1 ? 'Choose an insurance protection classification' : 'Enter coverage details, premium, and renewal schedule'}
            </p>
          </div>
          <button
            id="btn-close-policy-modal"
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
          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => handleSelectType('Term Life')}
              className="p-5 border-2 border-gray-200 dark:border-gray-800 hover:border-green-600 dark:hover:border-green-500 rounded-2xl text-left transition group"
            >
              <Shield className="text-green-700 dark:text-green-400 mb-2 group-hover:scale-110 transition" size={24} />
              <div className="font-extrabold text-sm text-gray-900 dark:text-white">Term Life Cover</div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Pure life insurance protection for income replacement</p>
            </button>

            <button
              type="button"
              onClick={() => handleSelectType('Health')}
              className="p-5 border-2 border-gray-200 dark:border-gray-800 hover:border-green-600 dark:hover:border-green-500 rounded-2xl text-left transition group"
            >
              <HeartPulse className="text-cyan-600 dark:text-cyan-400 mb-2 group-hover:scale-110 transition" size={24} />
              <div className="font-extrabold text-sm text-gray-900 dark:text-white">Health Insurance</div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Medical and hospitalization cover for family members</p>
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                Insurance Provider / Company *
              </label>
              <input
                id="input-policy-provider"
                type="text"
                placeholder="e.g. HDFC Life, Star Health, ICICI Lombard"
                value={provider}
                onChange={e => setProvider(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Policy Number
                </label>
                <input
                  id="input-policy-number"
                  type="text"
                  placeholder="e.g. POL-998822"
                  value={policyNumber}
                  onChange={e => setPolicyNumber(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Sum Insured / Cover Amount (₹) *
                </label>
                <input
                  id="input-policy-cover"
                  type="number"
                  placeholder="e.g. 10000000"
                  value={coverAmount}
                  onChange={e => setCoverAmount(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 font-bold"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Annual Premium (₹)
                </label>
                <input
                  id="input-policy-premium"
                  type="number"
                  placeholder="e.g. 18500"
                  value={premiumAmount}
                  onChange={e => setPremiumAmount(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Next Renewal Date
                </label>
                <input
                  id="input-policy-renewal"
                  type="date"
                  value={renewalDate}
                  onChange={e => setRenewalDate(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                Notes / Covered Members
              </label>
              <input
                id="input-policy-notes"
                type="text"
                placeholder="e.g. Self, Spouse, 1 Child included"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
              />
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-800">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1 text-xs font-bold text-gray-500 hover:text-gray-900 dark:hover:text-white"
              >
                <ArrowLeft size={14} />
                <span>Back</span>
              </button>

              <div className="flex gap-2">
                <button
                  id="btn-cancel-policy-modal"
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 text-xs font-semibold text-gray-700 dark:text-gray-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="add-policy-submit"
                  data-write-busy={busy ? 'true' : 'false'}
                  disabled={busy}
                  className="px-5 py-2 rounded-xl bg-green-700 hover:bg-green-800 text-xs font-bold text-white transition shadow-sm"
                >
                  Save Policy
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
