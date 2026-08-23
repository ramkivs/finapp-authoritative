/**
 * FinBoom deterministic content digest.
 *
 * ⚠️ THIS IS NOT SHA-256, DESPITE THE CLASS NAME.
 *
 * Measured at the POST10 discovery gate against the RFC known-answer vectors
 * and against the browser's own `crypto.subtle.digest('SHA-256', …)`:
 *
 *     hash('abc') -> 8466c30a3bdfa36dc3d7959f676fc764606b043baa55931857bb5487d3ced497
 *     SHA-256('abc') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 *
 * The two do not agree, and neither does the empty-string vector. The cause is
 * an operator-precedence error in the message schedule below: `+` binds tighter
 * than `^`, so the sigma0 group is XORed with the sum of the remaining terms
 * instead of being added to them. The enclosing parentheses the reference
 * algorithm requires are absent.
 *
 * WHAT IT ACTUALLY IS: a deterministic, stable, 64-hex-character digest.
 * Identical input always yields identical output, which is the only property
 * its callers depend on.
 *
 * WHAT IT IS NOT — do not claim any of these without new measurement:
 *   - it is NOT SHA-256, and NOT equivalent to SHA-256
 *   - it is NOT a standards-conforming digest of any kind
 *   - it is NOT independently verifiable by a third party
 *   - it has NOT been analysed for collision resistance (NOT MEASURED)
 *
 * WHY IT IS NOT BEING CORRECTED (Decision Q-POST10-1 = (c)):
 * `Transaction.fingerprint` is PERSISTED in users' IndexedDB, and
 * `TransactionIdentityService.fingerprintOf` prefers the stored value.
 * Changing the algorithm would change every newly computed fingerprint while
 * stored ones kept the old value, so a re-imported row that duplicates an
 * existing one would stop matching and be inserted twice. The measured harm was
 * the false claim, not the behaviour, so the claim was corrected and the digest
 * left byte-for-byte intact. No migration, no recomputation.
 *
 * The class name is retained deliberately: renaming it would touch every
 * consumer for no behavioural gain. The name is internal and never shown to a
 * user; every user-facing and documentation claim has been corrected.
 */
export class Sha256Service {
  /**
   * Deterministic 64-hex-character digest of `ascii`.
   *
   * Stable across calls and across reloads. NOT SHA-256 — see the class note.
   */
  static hash(ascii: string): string {
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    const lengthProperty = 'length';
    let i, j; // Used as a counter across the whole file
    let result = '';

    const words: number[] = [];
    const asciiBitLength = ascii[lengthProperty] * 8;

    let hash = (Sha256Service as any)._h;
    let k = (Sha256Service as any)._k;
    if (!hash) {
      hash = (Sha256Service as any)._h = [];
      k = (Sha256Service as any)._k = [];
      let primeCounter = k[lengthProperty];
      const isPrime = (n: number) => {
        for (let factor = 2; factor * factor <= n; factor++) {
          if (n % factor === 0) return false;
        }
        return true;
      };
      let candidate = 2;
      while (primeCounter < 64) {
        if (isPrime(candidate)) {
          if (primeCounter < 8) {
            hash[primeCounter] = (mathPow(candidate, 1 / 2) * maxWord) | 0;
          }
          k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
          primeCounter++;
        }
        candidate++;
      }
    }

    const initialHash = hash.slice(0);

    for (i = 0; i < ascii[lengthProperty]; i++) {
      words[i >> 2] |= (ascii.charCodeAt(i) & 0xff) << ((3 - i % 4) * 8);
    }
    words[i >> 2] |= 0x80 << ((3 - i % 4) * 8);
    words[(((ascii[lengthProperty] + 8) >> 6) + 1) * 16 - 1] = asciiBitLength;

    const w = new Array(64);
    for (j = 0; j < words[lengthProperty]; j += 16) {
      const h = initialHash.slice(0);

      for (i = 0; i < 64; i++) {
        let w15, w2, a, e, temp1, temp2;
        if (i < 16) {
          w[i] = words[j + i] | 0;
        } else {
          w15 = w[i - 15];
          w2 = w[i - 2];
          w[i] = (
            ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3) +
            w[i - 7] +
            (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) +
            w[i - 16]
          ) | 0;
        }

        a = h[0];
        e = h[4];

        temp1 = (
          h[7] +
          (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
          ((e & h[5]) ^ (~e & h[6])) +
          k[i] +
          w[i]
        ) | 0;

        temp2 = (
          (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
          ((a & h[1]) ^ (a & h[2]) ^ (h[1] & h[2]))
        ) | 0;

        h.pop();
        h.unshift((temp1 + temp2) | 0);
        h[4] = (h[4] + temp1) | 0;
      }

      for (i = 0; i < 8; i++) {
        initialHash[i] = (initialHash[i] + h[i]) | 0;
      }
    }

    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        const b = (initialHash[i] >> (8 * j)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }
}
