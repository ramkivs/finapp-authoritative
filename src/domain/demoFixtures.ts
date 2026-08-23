import { Transaction, Asset, Liability, NetWorthSnapshot, APP_AS_OF_DATE } from './types';
import { formatDisplayDate } from '../services/DateRangeService';

export const demoTransactions: Transaction[] = [
  { id: 'tx-1', date: '2026-08-06', dateStr: '06 Aug 2026', title: 'ITC Limited', narration: 'ACH/C-/ITC LTD DIVIDEND/NSE0098', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 2100, status: 'CLEARED', notes: 'Final dividend 2026 (Demo)' },
  { id: 'tx-2', date: '2026-08-04', dateStr: '04 Aug 2026', title: 'Coal India Ltd', narration: 'ECS/C/COAL INDIA INT DIVIDEND', account: 'SBI Bank', type: 'Income', category: 'DIVIDEND', amount: 1500, status: 'CLEARED', notes: 'PSU quarterly payout (Demo)' },
  { id: 'tx-3', date: '2026-08-02', dateStr: '02 Aug 2026', title: 'TCS Limited', narration: 'NEFT-DIV/TCS Q1 INTERIM DIVIDEND', account: 'ICICI Bank', type: 'Income', category: 'DIVIDEND', amount: 600, status: 'CLEARED', notes: 'Q1 interim dividend (Demo)' },
  { id: 'tx-4', date: '2026-07-28', dateStr: '28 Jul 2026', title: 'HDFC Bank Ltd', narration: 'ACH/C/HDFC BANK ANNUAL DIVIDEND', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 9400, status: 'CLEARED', notes: 'Annual dividend (Demo)' },
  { id: 'tx-5', date: '2026-07-25', dateStr: '25 Jul 2026', title: 'Swiggy Food Delivery', narration: 'UPI/SWIGGY/DINING OUT', account: 'HDFC Bank', type: 'Expense', category: 'DINING', amount: 1450, status: 'CLEARED', notes: 'Weekend dinner (Demo)' },
  { id: 'tx-6', date: '2026-07-19', dateStr: '19 Jul 2026', title: 'ONGC Ltd', narration: 'ECS/C/ONGC FINAL DIVIDEND', account: 'Axis Bank', type: 'Income', category: 'DIVIDEND', amount: 9000, status: 'CLEARED', notes: 'Final dividend (Demo)' },
  { id: 'tx-7', date: '2026-06-26', dateStr: '26 Jun 2026', title: 'ITC Limited', narration: 'ACH/C/ITC LTD FINAL DIVIDEND', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 24100, status: 'CLEARED', notes: 'Annual AGM payout (Demo)' },
  { id: 'tx-8', date: '2026-05-15', dateStr: '15 May 2026', title: 'Infosys Ltd', narration: 'NEFT/INFOSYS DIVIDEND', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 9800, status: 'CLEARED', notes: 'IT sector yield (Demo)' },
  { id: 'tx-9', date: '2026-04-10', dateStr: '10 Apr 2026', title: 'NTPC Ltd', narration: 'ACH/NTPC INTERIM DIVIDEND', account: 'SBI Bank', type: 'Income', category: 'DIVIDEND', amount: 6500, status: 'CLEARED', notes: 'Power utility dividend (Demo)' },
  { id: 'tx-10', date: '2026-03-20', dateStr: '20 Mar 2026', title: 'ITC Limited', narration: 'ACH/ITC INTERIM DIVIDEND', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 14200, status: 'CLEARED', notes: 'Interim payout (Demo)' },
  { id: 'tx-11', date: '2026-02-14', dateStr: '14 Feb 2026', title: 'Coal India Ltd', narration: 'ECS/COALINDIA INT DIVIDEND', account: 'SBI Bank', type: 'Income', category: 'DIVIDEND', amount: 16800, status: 'CLEARED', notes: 'Q3 interim payout (Demo)' },
  { id: 'tx-12', date: '2026-01-18', dateStr: '18 Jan 2026', title: 'TCS Limited', narration: 'NEFT/TCS INT DIVIDEND', account: 'ICICI Bank', type: 'Income', category: 'DIVIDEND', amount: 11500, status: 'CLEARED', notes: 'Q3 dividend (Demo)' },
  { id: 'tx-13', date: '2025-12-22', dateStr: '22 Dec 2025', title: 'ONGC Ltd', narration: 'ECS/ONGC DIVIDEND CREDIT', account: 'Axis Bank', type: 'Income', category: 'DIVIDEND', amount: 13100, status: 'CLEARED', notes: 'Oil sector dividend (Demo)' },
  { id: 'tx-14', date: '2025-11-10', dateStr: '10 Nov 2025', title: 'HDFC Bank Ltd', narration: 'ACH/HDFC BANK DIVIDEND', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 9200, status: 'CLEARED', notes: 'Interim bank dividend (Demo)' },
  { id: 'tx-15', date: '2025-10-15', dateStr: '15 Oct 2025', title: 'Infosys Ltd', narration: 'ACH/INFOSYS INT DIVIDEND', account: 'HDFC Bank', type: 'Income', category: 'DIVIDEND', amount: 12000, status: 'CLEARED', notes: 'Q2 interim dividend (Demo)' },
  { id: 'tx-16', date: '2025-09-12', dateStr: '12 Sep 2025', title: 'NTPC Ltd', narration: 'ACH/NTPC FINAL DIVIDEND', account: 'SBI Bank', type: 'Income', category: 'DIVIDEND', amount: 8500, status: 'CLEARED', notes: 'Final utility dividend (Demo)' }
];

export const demoAssets: Asset[] = [
  { name: '4 Bank Accounts (HDFC, ICICI, SBI, Axis)', amount: 482910 },
  { name: '3 Brokerages (Zerodha, Groww, Upstox)', amount: 3640000 },
  { name: 'Real Estate Property', amount: 4982500 }
];

export const demoLiabilities: Liability[] = [
  // WP-FB-DATA-07: fixture ids are stable literals so demo data is
  // reproducible; generated ids are only for user-created records.
  { id: 'lia-demo-home-loan', name: 'Home Loan (ICICI Bank)', amount: 1850000 }
];

export const demoSnapshots: NetWorthSnapshot[] = [
  {
    id: 'snap-live-0',
    dateStr: formatDisplayDate(APP_AS_OF_DATE) + ' (Today)',
    totalAssets: 482910 + 3640000 + 4982500,
    totalLiabilities: 1850000,
    netWorth: (482910 + 3640000 + 4982500) - 1850000,
    status: 'Active Preview'
  },
  { id: 'snap-1', dateStr: '01 Jul 2026', totalAssets: 9060000, totalLiabilities: 1880000, netWorth: 7180000, status: 'Anchored' },
  { id: 'snap-2', dateStr: '01 Jun 2026', totalAssets: 8950000, totalLiabilities: 1910000, netWorth: 7040000, status: 'Anchored' }
];
