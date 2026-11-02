const MONTH_LOOKUP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function buildValidatedIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function expandTwoDigitYear(yy: number): number {
  return yy >= 70 ? 1900 + yy : 2000 + yy;
}

export class DateNormalizer {
  /**
   * Normalizes diverse Indian bank & PPF statement date formats into strict ISO `YYYY-MM-DD`:
   * - `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY.MM.DD` (with optional time suffix)
   * - `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY` (with optional time suffix)
   * - `DD/MM/YY`, `DD-MM-YY`, `DD.MM.YY` (with optional time suffix; >=70 -> 19xx, <70 -> 20xx)
   * - `DD MMM YYYY`, `DD-MMM-YYYY`, `DD/MMM/YYYY`, `DD.MMM.YYYY` (e.g., `18 Aug 2026`, `05-APR-2026`)
   * - `DD MMM YY`, `DD-MMM-YY`, `DD/MMM/YY` (e.g., `18-Aug-26`, `05-APR-26`)
   * - `MMM DD, YYYY` / `MMM DD YYYY` (e.g., `Aug 18, 2026`)
   *
   * Enforces strict Gregorian calendar bounds (`DEF-16`) so impossible dates such as
   * `2026-02-31`, `29/02/2026`, `32/08/2026`, or `15/13/2026` return `null`.
   */
  static normalize(rawDate: string): string | null {
    if (!rawDate || typeof rawDate !== 'string') return null;

    let clean = rawDate
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .replace(/\u00A0/g, ' ')
      .trim();

    if (!clean) return null;

    // Strip trailing ISO or bank timestamp suffix (e.g. "T10:30:00Z", " 14:22:05", " 02:15:00 PM")
    clean = clean
      .replace(/[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:AM|PM|Z|[+-]\d{2}:?\d{2})?$/i, '')
      .trim();

    // 1. YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
    const ymd = clean.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (ymd) {
      const [, yyyy, mm, dd] = ymd;
      return buildValidatedIsoDate(parseInt(yyyy, 10), parseInt(mm, 10), parseInt(dd, 10));
    }

    // 2. DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
    const dmy4 = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (dmy4) {
      const [, dd, mm, yyyy] = dmy4;
      return buildValidatedIsoDate(parseInt(yyyy, 10), parseInt(mm, 10), parseInt(dd, 10));
    }

    // 3. DD/MM/YY, DD-MM-YY, DD.MM.YY
    const dmy2 = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
    if (dmy2) {
      const [, dd, mm, yy] = dmy2;
      const fullYear = expandTwoDigitYear(parseInt(yy, 10));
      return buildValidatedIsoDate(fullYear, parseInt(mm, 10), parseInt(dd, 10));
    }

    // 4. Textual month: DD-MMM-YYYY, DD MMM YYYY, DD/MMM/YYYY, DD-MMM-YY, DD MMM YY
    const dMmmY = clean.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.]+(\d{2}|\d{4})$/);
    if (dMmmY) {
      const [, dd, monRaw, yrRaw] = dMmmY;
      const month = MONTH_LOOKUP[monRaw.toLowerCase()];
      if (!month) return null;
      const year = yrRaw.length === 2 ? expandTwoDigitYear(parseInt(yrRaw, 10)) : parseInt(yrRaw, 10);
      return buildValidatedIsoDate(year, month, parseInt(dd, 10));
    }

    // 5. Textual month first: MMM DD, YYYY / MMM DD YYYY
    const mmmDY = clean.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mmmDY) {
      const [, monRaw, dd, yyyy] = mmmDY;
      const month = MONTH_LOOKUP[monRaw.toLowerCase()];
      if (!month) return null;
      return buildValidatedIsoDate(parseInt(yyyy, 10), month, parseInt(dd, 10));
    }

    return null;
  }
}
