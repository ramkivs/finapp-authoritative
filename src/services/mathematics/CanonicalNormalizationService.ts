/**
 * ARTHAVAULT WP-22: Canonical Normalization Service
 * Pre-canonicalization domain sanitization and normalization pipeline
 */

export class CanonicalNormalizationService {
  /**
   * Normalize an unknown input value according to ArthaVault domain rules.
   */
  static normalize(value: unknown): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return this.normalizeNumber(value);
    }

    if (typeof value === 'string') {
      return this.normalizeString(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => this.normalize(item));
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const normalizedVal = this.normalize(obj[key]);
        if (normalizedVal !== undefined) {
          result[this.normalizeString(key)] = normalizedVal;
        }
      }
      return result;
    }

    throw new Error(`Unsupported type for canonical normalization: ${typeof value}`);
  }

  /**
   * Normalize floating point numbers:
   * - Rejects NaN, +Infinity, -Infinity
   * - Converts -0.0 to +0
   */
  static normalizeNumber(n: number): number {
    if (isNaN(n)) {
      throw new Error('Non-finite number rejection: NaN is not permissible in canonical mathematical inputs.');
    }
    if (!isFinite(n)) {
      throw new Error('Non-finite number rejection: Infinity is not permissible in canonical mathematical inputs.');
    }
    // Normalize signed zero (-0 -> 0)
    if (Object.is(n, -0)) {
      return 0;
    }
    return n;
  }

  /**
   * Normalize strings to Unicode Normalization Form C (NFC).
   */
  static normalizeString(s: string): string {
    return s.normalize('NFC');
  }

  /**
   * Validate that a string adheres strictly to calendar date format 'YYYY-MM-DD'.
   */
  static validateCalendarDate(dateStr: string): string {
    const norm = this.normalizeString(dateStr.trim());
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(norm)) {
      throw new Error(`Invalid CalendarDate format: "${dateStr}". Expected YYYY-MM-DD.`);
    }
    const [year, month, day] = norm.split('-').map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`CalendarDate out of range: "${dateStr}".`);
    }
    return norm;
  }
}
