export interface ParsedAmountResult {
  /** False when a non-empty string could not be parsed as a valid finite monetary amount. */
  valid: boolean;
  /** True when the raw input was blank or a benign placeholder (`""`, `"-"`, `"NIL"`, `"NA"`). */
  empty: boolean;
  /** Signed numeric value (rounded to 4 decimal places to eliminate IEEE-754 drift). */
  value: number;
  /** Explicit Credit/Debit indicator found in the amount token (`CR` or `DR`), if any. */
  indicator: 'CR' | 'DR' | null;
}

export class AmountNormalizer {
  /**
   * Strictly parses a raw financial amount cell (`DEF-17`).
   *
   * Supports:
   * - Indian & Western comma groupings (`1,38,311.58`, `138,311.58`)
   * - Currency prefixes/suffixes (`₹`, `Rs`, `Rs.`, `INR`)
   * - Accounting parentheses (`(1,250.50)` -> `-1250.5`)
   * - Explicit `Cr`/`CR`/`Credit` and `Dr`/`DR`/`Debit` indicators (`1,50,000.00 Cr`, `500.00 Dr`)
   * - Benign blank/zero placeholders (`""`, `"-"`, `"--"`, `"NIL"`, `"NA"`, `"N/A"`)
   *
   * Rejects corrupted alphanumeric strings such as `"12abc"` or `"invalid-amount"` with
   * `valid: false` instead of silently truncating via `parseFloat`.
   */
  static parseStrict(rawVal: string | number | undefined | null): ParsedAmountResult {
    if (rawVal === undefined || rawVal === null) {
      return { valid: true, empty: true, value: 0, indicator: null };
    }

    if (typeof rawVal === 'number') {
      if (!Number.isFinite(rawVal)) {
        return { valid: false, empty: false, value: 0, indicator: null };
      }
      return {
        valid: true,
        empty: false,
        value: Math.round(rawVal * 10000) / 10000,
        indicator: null
      };
    }

    let s = String(rawVal).replace(/\u00A0/g, ' ').trim();
    if (s === '' || /^(?:-+|nil|na|n\/a|null|none)$/i.test(s)) {
      return { valid: true, empty: true, value: 0, indicator: null };
    }

    let indicator: 'CR' | 'DR' | null = null;
    let isNegative = false;

    // Extract leading/trailing Cr / Dr indicators (e.g. "1,500.00 Cr", "500.00(Dr)", "Dr. 500.00")
    const trailingInd = s.match(/^(.*?)(?:\s+|\s*\()?(cr|credit|dr|debit)\.?(?:\))?$/i);
    if (trailingInd && /\d/.test(trailingInd[1])) {
      s = trailingInd[1].trim();
      indicator = /^d/i.test(trailingInd[2]) ? 'DR' : 'CR';
    } else {
      const leadingInd = s.match(/^(cr|credit|dr|debit)\.?\s+(.*)$/i);
      if (leadingInd && /\d/.test(leadingInd[2])) {
        s = leadingInd[2].trim();
        indicator = /^d/i.test(leadingInd[1]) ? 'DR' : 'CR';
      }
    }

    // Accounting parentheses e.g. "(1,250.50)" or "(₹1,250.50)"
    if (/^\(.*\)$/.test(s)) {
      isNegative = true;
      s = s.slice(1, -1).trim();
    }

    // Leading sign before currency symbol e.g. "-₹1,250.50" or "+Rs. 500"
    if (/^[-+]/.test(s)) {
      if (s[0] === '-') isNegative = !isNegative;
      s = s.slice(1).trim();
    }

    // Remove currency symbols (₹, Rs., INR, Rs)
    s = s.replace(/^(?:₹|Rs\.?|INR)\s*/i, '');
    s = s.replace(/\s*(?:₹|Rs\.?|INR)$/i, '');

    // Accounting parentheses after currency symbol e.g. "Rs. (2,500.00)" or "₹(1,250.50)"
    if (/^\(.*\)$/.test(s)) {
      isNegative = !isNegative;
      s = s.slice(1, -1).trim();
    }

    // Leading/trailing sign after currency symbol e.g. "₹ -1,250.50" or "1,250.50-"
    if (/^[-+]/.test(s)) {
      if (s[0] === '-') isNegative = !isNegative;
      s = s.slice(1).trim();
    } else if (/[-+]$/.test(s)) {
      if (s[s.length - 1] === '-') isNegative = !isNegative;
      s = s.slice(0, -1).trim();
    }

    // Remove commas (Indian or Western thousands separators)
    const noCommas = s.replace(/,/g, '').trim();

    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(noCommas)) {
      return { valid: false, empty: false, value: 0, indicator };
    }

    const num = Number(noCommas);
    if (!Number.isFinite(num)) {
      return { valid: false, empty: false, value: 0, indicator };
    }

    // If an explicit DR indicator was present without an explicit minus sign, sign is negative
    const effectiveNegative = isNegative || (indicator === 'DR' && num > 0);
    const signed = effectiveNegative ? -num : num;
    const rounded = Object.is(signed, -0) ? 0 : Math.round(signed * 10000) / 10000;

    return {
      valid: true,
      empty: false,
      value: rounded,
      indicator
    };
  }

  /**
   * Backward-compatible numeric parser returning a finite number (`0` when blank or invalid).
   */
  static parseAmount(rawVal: string | number | undefined | null): number {
    const parsed = this.parseStrict(rawVal);
    return parsed.valid ? parsed.value : 0;
  }

  /**
   * Resolves debit, credit, closing balance, and strict validation diagnostics for a bank row.
   * Supports both two-column (`debitRaw` + `creditRaw`) and single-column (`amountRaw` + `drCrRaw`).
   */
  static resolveBankRowAmounts(params: {
    debitRaw?: string;
    creditRaw?: string;
    amountRaw?: string;
    drCrRaw?: string;
    balanceRaw?: string;
  }): {
    debitAmount: number;
    creditAmount: number;
    closingBalance?: number;
    amountError?: string;
    rawAmountText?: string;
  } {
    const debitParsed = this.parseStrict(params.debitRaw);
    if (!debitParsed.valid) {
      return {
        debitAmount: 0,
        creditAmount: 0,
        amountError: `Invalid numeric value in Debit/Withdrawal column: "${params.debitRaw}"`,
        rawAmountText: params.debitRaw
      };
    }

    const creditParsed = this.parseStrict(params.creditRaw);
    if (!creditParsed.valid) {
      return {
        debitAmount: 0,
        creditAmount: 0,
        amountError: `Invalid numeric value in Credit/Deposit column: "${params.creditRaw}"`,
        rawAmountText: params.creditRaw
      };
    }

    let debitAmount = Math.abs(debitParsed.value);
    let creditAmount = Math.abs(creditParsed.value);

    // Single-column Amount + Cr/Dr fallback when separate Debit/Credit columns are absent/zero
    if (debitAmount === 0 && creditAmount === 0 && params.amountRaw !== undefined && params.amountRaw.trim() !== '') {
      const amtParsed = this.parseStrict(params.amountRaw);
      if (!amtParsed.valid) {
        return {
          debitAmount: 0,
          creditAmount: 0,
          amountError: `Invalid numeric value in Amount column: "${params.amountRaw}"`,
          rawAmountText: params.amountRaw
        };
      }

      const mag = Math.abs(amtParsed.value);
      const drCrUpper = (params.drCrRaw || '').trim().toUpperCase();
      const isExplicitDebit =
        amtParsed.indicator === 'DR' ||
        drCrUpper === 'DR' ||
        drCrUpper === 'D' ||
        drCrUpper.includes('DEBIT') ||
        drCrUpper.includes('WITHDRAW') ||
        (amtParsed.indicator !== 'CR' && amtParsed.value < 0);

      if (mag > 0) {
        if (isExplicitDebit) {
          debitAmount = mag;
        } else {
          creditAmount = mag;
        }
      }
    }

    let closingBalance: number | undefined = undefined;
    if (params.balanceRaw !== undefined && params.balanceRaw.trim() !== '') {
      const balParsed = this.parseStrict(params.balanceRaw);
      if (balParsed.valid && !balParsed.empty) {
        closingBalance = balParsed.value;
      }
    }

    return {
      debitAmount,
      creditAmount,
      closingBalance
    };
  }
}
