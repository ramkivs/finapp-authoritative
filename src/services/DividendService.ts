import { MonthBucket, Transaction } from '../domain/types';
import { getEffectiveAsOfDate } from './DateRangeService';

export function generateMonthlyBuckets(asOfDateStr: string = getEffectiveAsOfDate(), numBuckets: number = 12): MonthBucket[] {
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthBuckets: MonthBucket[] = [];
  const asOf = new Date(asOfDateStr + 'T00:00:00');

  for (let i = numBuckets - 1; i >= 0; i--) {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyyMm = `${yyyy}-${mm}`;
    const monthName = monthNames[d.getMonth()];
    const shortYr = String(yyyy).slice(-2);
    let label = monthName;
    if (i === 0) {
      label = `${monthName} (MTD)*`;
    } else if (i === numBuckets - 1 || d.getMonth() === 0) {
      label = `${monthName} '${shortYr}`;
    }
    monthBuckets.push({ yyyyMm, label, isMtd: (i === 0) });
  }
  return monthBuckets;
}

export class DividendService {
  static getMonthlyTotals(transactions: Transaction[], asOfDateStr: string = getEffectiveAsOfDate()) {
    const monthBuckets = generateMonthlyBuckets(asOfDateStr, 12);
    return monthBuckets.map(b => {
      const matching = transactions.filter(t => 
        t.date.startsWith(b.yyyyMm) && t.category === 'DIVIDEND' && t.status === 'CLEARED' && t.date <= asOfDateStr
      );
      const amt = matching.reduce((sum, t) => sum + t.amount, 0);
      return {
        month: b.label,
        amount: amt,
        payoutCount: matching.length,
        isMtd: b.isMtd
      };
    });
  }
}
