/**
 * ARTHAVAULT WP-22: RFC 8785 JSON Canonicalization Scheme (JCS) Service
 * Pure TypeScript implementation guaranteeing cross-runtime byte-level deterministic serialization.
 */

export class JcsSerializationService {
  /**
   * Serialize a normalized JavaScript data structure to an exact RFC 8785 canonical JSON string.
   */
  static canonicalize(data: unknown): string {
    if (data === null) {
      return 'null';
    }

    if (typeof data === 'boolean') {
      return data ? 'true' : 'false';
    }

    if (typeof data === 'number') {
      return this.serializeNumber(data);
    }

    if (typeof data === 'string') {
      return this.serializeString(data);
    }

    if (Array.isArray(data)) {
      const items = data.map(item => this.canonicalize(item));
      return `[${items.join(',')}]`;
    }

    if (typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      // RFC 8785 §3.2.3: Sort object keys lexicographically by UTF-16 code units
      const keys = Object.keys(obj).sort((a, b) => this.compareUtf16(a, b));
      const entries: string[] = [];

      for (const key of keys) {
        const val = obj[key];
        if (val !== undefined && typeof val !== 'symbol' && typeof val !== 'function') {
          entries.push(`${this.serializeString(key)}:${this.canonicalize(val)}`);
        }
      }

      return `{${entries.join(',')}}`;
    }

    throw new Error(`Unsupported type for RFC 8785 canonicalization: ${typeof data}`);
  }

  /**
   * Compare two strings according to RFC 8785 §3.2.3 UTF-16 code units.
   */
  private static compareUtf16(a: string, b: string): number {
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
      const codeA = a.charCodeAt(i);
      const codeB = b.charCodeAt(i);
      if (codeA !== codeB) {
        return codeA - codeB;
      }
    }
    return a.length - b.length;
  }

  /**
   * Serialize number according to RFC 8785 and ECMA-262 §7.1.12.1 rules.
   */
  private static serializeNumber(n: number): string {
    if (!isFinite(n) || isNaN(n)) {
      throw new Error(`Cannot serialize non-finite number: ${n}`);
    }
    if (Object.is(n, -0)) {
      return '0';
    }
    return JSON.stringify(n);
  }

  /**
   * Serialize string according to RFC 8785 minimal escape rules.
   */
  private static serializeString(s: string): string {
    // JSON.stringify handles standard ECMA-262 escaping which matches RFC 8785 requirements for UTF-8 strings
    return JSON.stringify(s);
  }
}
