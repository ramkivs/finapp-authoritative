import React, { useState } from 'react';
import { GoalTemplateType, GOAL_TEMPLATES } from '../../domain/types';
import { useCanonicalLedger } from '../../store/useCanonicalLedger';
import { X, Target, Landmark, Shield, GraduationCap, Plane, Car, Heart, ArrowLeft } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const TEMPLATE_METADATA: Array<{ template: GoalTemplateType; desc: string; icon: any }> = [
  { template: 'Retirement', desc: 'Long-term financial independence corpus', icon: Landmark },
  { template: 'Emergency Buffer', desc: 'Liquid living expenses buffer', icon: Shield },
  { template: 'Home Purchase', desc: 'Real estate down-payment & interior corpus', icon: Landmark },
  { template: 'Education', desc: 'Higher education & tuition corpus', icon: GraduationCap },
  { template: 'Vacation', desc: 'Travel & family holiday savings', icon: Plane },
  { template: 'Vehicle', desc: 'Car or two-wheeler purchase corpus', icon: Car },
  { template: 'Wedding', desc: 'Family celebration & wedding fund', icon: Heart },
  { template: 'Custom Milestone', desc: 'Personalized financial milestone', icon: Target }
];

export const AddGoalModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTemplate, setSelectedTemplate] = useState<GoalTemplateType>('Retirement');
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currentSavedAmount, setCurrentSavedAmount] = useState('');
  const [monthlyContribution, setMonthlyContribution] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [currency, setCurrency] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  /** WP-FB-DATA-08B: in-flight while persistence is unresolved. */
  const [busy, setBusy] = useState(false);

  const { addGoal } = useCanonicalLedger();

  if (!isOpen) return null;

  const handleSelectTemplate = (tmpl: GoalTemplateType) => {
    setSelectedTemplate(tmpl);
    setName(tmpl === 'Custom Milestone' ? '' : `${tmpl} Corpus`);
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    if (busy) return;
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Goal name is required.');
      return;
    }
    if (!targetAmount || Number(targetAmount) <= 0) {
      setError('Target corpus amount must be greater than zero.');
      return;
    }

    setBusy(true);

    try {
      await addGoal({
        name: name.trim(),
        template: selectedTemplate,
        targetAmount: Number(targetAmount) || 0,
        currentSavedAmount: Number(currentSavedAmount) || 0,
        monthlyContribution: Number(monthlyContribution) || 0,
        targetDate: targetDate || undefined,
        status: 'In Progress',
        currency: currency.trim() || undefined,
        notes: notes.trim() || undefined
      });

      // Reset and close
      setName('');
      setTargetAmount('');
      setCurrentSavedAmount('');
      setMonthlyContribution('');
      setTargetDate('');
      setCurrency('');
      setNotes('');
      setStep(1);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error recording financial goal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 className="text-lg font-extrabold text-gray-900 dark:text-white">
              {step === 1 ? 'Step 1: Select Financial Milestone Template' : `Step 2: Define ${selectedTemplate} Parameters`}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {step === 1 ? 'Select from 8 standardized milestone corpus templates' : 'Enter target corpus, target timeline, and monthly SIP commitments'}
            </p>
          </div>
          <button
            id="btn-close-goal-modal"
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
          <div className="grid grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
            {TEMPLATE_METADATA.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.template}
                  type="button"
                  onClick={() => handleSelectTemplate(item.template)}
                  className="p-4 border-2 border-gray-200 dark:border-gray-800 hover:border-green-600 dark:hover:border-green-500 rounded-2xl text-left transition group"
                >
                  <Icon className="text-green-700 dark:text-green-400 mb-1.5 group-hover:scale-110 transition" size={20} />
                  <div className="font-extrabold text-xs text-gray-900 dark:text-white">{item.template}</div>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">{item.desc}</p>
                </button>
              );
            })}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                Milestone / Goal Name *
              </label>
              <input
                id="input-goal-name"
                type="text"
                placeholder="e.g. Retirement Corpus 2050"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 font-bold"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Target Corpus Amount (₹) *
                </label>
                <input
                  id="input-goal-target"
                  type="number"
                  placeholder="e.g. 25000000"
                  value={targetAmount}
                  onChange={e => setTargetAmount(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 font-bold"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Current Accumulated Amount (₹)
                </label>
                <input
                  id="input-goal-current"
                  type="number"
                  placeholder="e.g. 5000000"
                  value={currentSavedAmount}
                  onChange={e => setCurrentSavedAmount(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Monthly Systematic Allocation (₹ / mo)
                </label>
                <input
                  id="input-goal-monthly"
                  type="number"
                  placeholder="e.g. 45000"
                  value={monthlyContribution}
                  onChange={e => setMonthlyContribution(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600 font-bold text-cyan-600"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                  Target Horizon Date
                </label>
                <input
                  id="input-goal-date"
                  type="date"
                  value={targetDate}
                  onChange={e => setTargetDate(e.target.value)}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl px-3.5 py-2 text-xs text-gray-900 dark:text-white outline-none focus:border-green-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">
                Notes & Strategy
              </label>
              <input
                id="input-goal-notes"
                type="text"
                placeholder="e.g. Equity index funds + PPF systematic contribution"
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
                  id="btn-cancel-goal-modal"
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 text-xs font-semibold text-gray-700 dark:text-gray-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="add-goal-submit"
                  data-write-busy={busy ? 'true' : 'false'}
                  disabled={busy}
                  className="px-5 py-2 rounded-xl bg-green-700 hover:bg-green-800 text-xs font-bold text-white transition shadow-sm"
                >
                  Save Goal
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
