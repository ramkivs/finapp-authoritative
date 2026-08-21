import React, { useState } from 'react';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { getEffectiveAsOfDate } from '../services/DateRangeService';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CustomDateModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  const [start, setStart] = useState('2026-07-01');
  const [end, setEnd] = useState(getEffectiveAsOfDate()); // Effective production/as-of date

  const setCustomRange = useCanonicalLedger(s => s.setCustomRange);

  if (!isOpen) return null;

  const handleApply = () => {
    if (start && end) {
      setCustomRange(start, end);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">🗓 Select Custom Date Range</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Start Date (YYYY-MM-DD)</label>
            <input
              type="date"
              value={start}
              onChange={e => setStart(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">End Date (YYYY-MM-DD)</label>
            <input
              type="date"
              value={end}
              onChange={e => setEnd(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm"
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
          <button
            onClick={handleApply}
            className="px-5 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-bold shadow-sm"
          >
            Apply Date Filter
          </button>
        </div>
      </div>
    </div>
  );
};
