/**
 * WEALTH-HOLDINGS-VIEW (working) — Holdings/Positions workspace.
 *
 * Bounded implementation of the owner-accepted product contract
 * (FINBOOM-WEALTH-HOLDINGS-VIEW-CR-PRODUCT-DECISION-AUTHORITY-REPORT.md §2–§11;
 * implementation authority per FINBOOM-WEALTH-HOLDINGS-VIEW-IMPLEMENTATION-
 * AUTHORITY-REPORT.md §5).
 *
 * This is a READ-ONLY projection of the canonical Holding array already
 * held by WealthPage (`useCanonicalLedger` state). It owns no data:
 *  - no store writes, no repository access, no persistence, no navigation
 *    wiring (the §10 navigation MAY-clause is deliberately unexercised);
 *  - sorting/filters operate on a copied, locally derived array
 *    (`[...rows].sort(...)`) — the store-owned array is never mutated;
 *  - exactly ten displayed fields per the ratified field contract;
 *    `averageCost`, `investedValue`, `xirrPercent` are intentionally
 *    withheld and MUST NOT appear;
 *  - D-02 remains inviolable: `closed_absent` holdings continue to
 *    contribute to wealth aggregation — the marking below is purely
 *    presentational and this component computes no wealth totals.
 */
import React, { useMemo, useState } from 'react';
import { Holding } from '../domain/types';
import { CurrencyValue } from '../components/CurrencyValue';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';

interface Props {
  /** Canonical store array — read-only projection source. Never mutated here. */
  holdings: readonly Holding[];
}

type SortKey =
  | 'instrumentName' | 'broker' | 'account' | 'ticker' | 'isin'
  | 'quantity' | 'currentPrice' | 'currentValue' | 'unrealisedPnL' | 'status';
type SortDir = 'asc' | 'desc';

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric?: boolean; currency?: boolean }> = [
  { key: 'instrumentName', label: 'Instrument' },
  { key: 'broker', label: 'Broker' },
  { key: 'account', label: 'Account' },
  { key: 'ticker', label: 'Ticker' },
  { key: 'isin', label: 'ISIN' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'currentPrice', label: 'LTP', currency: true },
  { key: 'currentValue', label: 'Current Value', numeric: true, currency: true },
  { key: 'unrealisedPnL', label: 'Unrealised P&L', numeric: true, currency: true },
  { key: 'status', label: 'Status' },
];

const EM_DASH = '—';

/** Local sort helper (MAY-boundary item: kept inside this file).
 * Undefined string values sort last in BOTH directions so missing
 * optional identity fields never crowd out present ones. */
const sortHoldings = (rows: readonly Holding[], key: SortKey, dir: SortDir): Holding[] => {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
    const as = av === undefined ? null : String(av);
    const bs = bv === undefined ? null : String(bv);
    if (as === null && bs === null) return 0;
    if (as === null) return 1;
    if (bs === null) return -1;
    return as.localeCompare(bs) * factor;
  });
};

export const HoldingsPositionsWorkspace: React.FC<Props> = ({ holdings }) => {
  const [query, setQuery] = useState('');
  const [brokerFilter, setBrokerFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('currentValue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const brokers = useMemo(
    () => Array.from(new Set(holdings.map(h => h.broker))).sort((a, b) => a.localeCompare(b)),
    [holdings]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = holdings.filter(h => {
      const brokerOk = brokerFilter === 'all' || h.broker === brokerFilter;
      if (!brokerOk) return false;
      if (q === '') return true;
      return (
        h.instrumentName.toLowerCase().includes(q) ||
        (h.ticker !== undefined && h.ticker.toLowerCase().includes(q))
      );
    });
    return sortHoldings(filtered, sortKey, sortDir);
  }, [holdings, query, brokerFilter, sortKey, sortDir]);

  const filtersActive = query.trim() !== '' || brokerFilter !== 'all';

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(dir => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // No holdings at all → existing Wealth EmptyState convention.
  if (holdings.length === 0) {
    return (
      <EmptyState
        title="No Holdings to Inspect"
        description="Imported broker holdings will appear here as individual positions contributing to your wealth picture."
      />
    );
  }

  return (
    <section aria-label="Wealth Holdings and Positions" data-testid="holdings-positions-view">
      {/* Filters — component-local state only; no persistence (§6 contract). */}
      <div className="flex flex-wrap items-end gap-3 pb-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="holdings-search-input" className="text-[11px] font-bold uppercase tracking-wider text-[#8B949E]">
            Search instrument or ticker
          </label>
          <input
            id="holdings-search-input"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="e.g. Nippon, TATA"
            className="px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-[#30363D] bg-white dark:bg-[#0D1117] text-gray-900 dark:text-[#F0F6FC] focus:outline-none focus:ring-2 focus:ring-green-500/40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="holdings-broker-filter" className="text-[11px] font-bold uppercase tracking-wider text-[#8B949E]">
            Broker
          </label>
          <select
            id="holdings-broker-filter"
            value={brokerFilter}
            onChange={e => setBrokerFilter(e.target.value)}
            className="px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-[#30363D] bg-white dark:bg-[#0D1117] text-gray-900 dark:text-[#F0F6FC]"
          >
            <option value="all">All brokers</option>
            {brokers.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
        {filtersActive && (
          <button
            id="holdings-filter-reset"
            type="button"
            onClick={() => { setQuery(''); setBrokerFilter('all'); }}
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#8B949E] hover:text-[#F0F6FC]"
          >
            Clear filters
          </button>
        )}
        <p className="ml-auto text-xs text-[#8B949E]" aria-live="polite">
          Showing {visible.length} of {holdings.length} positions
        </p>
      </div>

      {/* Projection table — established Wealth table conventions. */}
      <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-[#21262D]">
        <table id="holdings-positions-table" aria-label="Individual holdings contributing to wealth" className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-[#21262D] text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  scope="col"
                  className={`py-3.5 px-6 whitespace-nowrap ${col.numeric ? 'text-right' : ''}`}
                  aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    aria-label={`Sort by ${col.label}`}
                    className="inline-flex items-center gap-1 hover:text-[#F0F6FC] cursor-pointer uppercase tracking-wider text-[11px] font-bold"
                  >
                    <span>{col.label}</span>
                    <span aria-hidden="true">{sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-[#21262D] text-sm">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} role="status" className="py-8 text-center text-sm text-[#8B949E]">
                  No matching holdings
                </td>
              </tr>
            ) : (
              visible.map(h => (
                <tr key={h.id} data-holdings-row={h.id} data-holdings-status={h.status}>
                  <td className="py-3 px-6 font-semibold text-gray-900 dark:text-[#F0F6FC]">{h.instrumentName}</td>
                  <td className="py-3 px-6 text-[#8B949E]">{h.broker}</td>
                  <td className="py-3 px-6 text-[#8B949E]">{h.account ?? EM_DASH}</td>
                  <td className="py-3 px-6 text-[#8B949E]">{h.ticker ?? EM_DASH}</td>
                  <td className="py-3 px-6 text-[#8B949E]">{h.isin ?? EM_DASH}</td>
                  {/* Quantity renders as stored — no rounding (fractional units are first-class). */}
                  <td className="py-3 px-6 text-gray-900 dark:text-[#F0F6FC]">{String(h.quantity)}</td>
                  <td className="py-3 px-6 text-right"><CurrencyValue value={h.currentPrice} /></td>
                  <td className="py-3 px-6 text-right"><CurrencyValue value={h.currentValue} /></td>
                  <td className="py-3 px-6 text-right">
                    <CurrencyValue value={h.unrealisedPnL} className={h.unrealisedPnL < 0 ? 'text-red-500' : ''} />
                  </td>
                  <td className="py-3 px-6">
                    {h.status === 'closed_absent'
                      ? <StatusBadge status="Closed / absent" />
                      : <span className="text-xs text-green-500 font-bold uppercase tracking-wider">Active</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
