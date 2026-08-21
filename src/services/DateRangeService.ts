import { APP_AS_OF_DATE, DateBounds } from '../domain/types';

/* =============================================================================
 * EFFECTIVE AS-OF DATE AUTHORITY (WP-FB-DATA-02)
 *
 * Production "today" and the deterministic fixture/audit constant are two
 * different concepts and must not be conflated.
 *
 *   Production / live mode  -> the real current date
 *   Test / fixture / audit  -> an explicit as-of date via setAsOfDateOverride()
 *
 * Previously `APP_AS_OF_DATE` ('2026-08-09') silently served as production
 * "today". Because the Canonical Ledger bounds every date range by it, any
 * transaction dated after that constant was permanently unreachable through
 * the surface labelled "Source of Truth" (RC-L09).
 *
 * `APP_AS_OF_DATE` is deliberately retained: demo fixtures, historical
 * snapshots and deterministic tests still depend on a frozen reference point.
 * This module is the single place that decides which one applies, so no
 * uncontrolled `new Date()` calls are scattered through the application.
 * ========================================================================== */

let asOfDateOverride: string | null = null;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Installs an explicit as-of date (ISO `YYYY-MM-DD`) for deterministic
 * test, fixture or historical/audit scenarios. Pass `null` to clear.
 */
export function setAsOfDateOverride(isoDate: string | null): void {
  asOfDateOverride = isoDate;
}

/** Clears any installed override, restoring live production behaviour. */
export function resetAsOfDateOverride(): void {
  asOfDateOverride = null;
}

/** True when a deterministic override is currently installed. */
export function hasAsOfDateOverride(): boolean {
  return asOfDateOverride !== null;
}

/**
 * The effective "today" for the application.
 * Returns the installed override when present, otherwise the real current
 * local date as an ISO `YYYY-MM-DD` string.
 *
 * Local (not UTC) components are used deliberately: all canonical transaction
 * dates are local calendar dates, and a UTC conversion would shift the
 * boundary by a day for users east of Greenwich (FinBoom's timezone is
 * Asia/Kolkata).
 */
export function getEffectiveAsOfDate(): string {
  if (asOfDateOverride) return asOfDateOverride;
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function formatDisplayDate(isoStr: string = APP_AS_OF_DATE): string {
  const d = new Date(isoStr + 'T00:00:00');
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export class DateRangeService {
  static getBounds(
    range: string,
    asOfDateStr: string = getEffectiveAsOfDate(),
    customStart: string | null = null,
    customEnd: string | null = null
  ): DateBounds {
    const asOf = new Date(asOfDateStr + 'T00:00:00');
    const pad = (n: number) => String(n).padStart(2, '0');
    const toISODate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    let start = new Date(asOf);
    let end = new Date(asOf);

    if (range === 'This Week') {
      const day = start.getDay() || 7; // Monday = 1
      start.setDate(start.getDate() - day + 1);
    } else if (range === 'This Month') {
      start.setDate(1);
    } else if (range === 'Last 30 Days') {
      start.setDate(start.getDate() - 29);
    } else if (range === 'Last Month') {
      start = new Date(asOf.getFullYear(), asOf.getMonth() - 1, 1);
      end = new Date(asOf.getFullYear(), asOf.getMonth(), 0);
    } else if (range === '3M') {
      start = new Date(asOf.getFullYear(), asOf.getMonth() - 3, 1);
    } else if (range === '6M') {
      start = new Date(asOf.getFullYear(), asOf.getMonth() - 6, 1);
    } else if (range === '12M') {
      start = new Date(asOf.getFullYear(), asOf.getMonth() - 11, 1);
    } else if (range === 'YTD') {
      start = new Date(asOf.getFullYear(), 0, 1);
    } else if (range === 'Custom' && customStart && customEnd) {
      return { startDate: customStart, endDate: customEnd };
    }

    return { startDate: toISODate(start), endDate: toISODate(end) };
  }
}
