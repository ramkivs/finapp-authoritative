/**
 * WP-FB-DATA-11 — the fingerprint digest must not be described as SHA-256.
 *
 * DECISION Q-POST10-1 = (c): keep the existing deterministic digest exactly as
 * it is, and correct the claim instead.
 *
 * WHAT WAS MEASURED (POST10 discovery gate, real Chromium)
 *
 *   Sha256Service.hash('abc')
 *     -> 8466c30a3bdfa36dc3d7959f676fc764606b043baa55931857bb5487d3ced497
 *   SHA-256('abc')
 *      = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 *
 * They disagree, and so does the empty-string vector, and so does the browser's
 * own `crypto.subtle.digest('SHA-256', …)`. Cause: an operator-precedence error
 * in the message schedule (`+` binds tighter than `^`, so the sigma0 group is
 * XORed with the sum instead of added to it).
 *
 * The digest is nonetheless deterministic and stable, and it is PERSISTED on
 * `Transaction.fingerprint`. Correcting the algorithm would change every newly
 * computed fingerprint while stored ones kept the old value, so a re-imported
 * duplicate would stop matching and be inserted twice. The measured harm was
 * the false claim, not the behaviour.
 *
 * THE CENTRAL GUARD (§2)
 *
 * This file does not merely assert today's wording. It ties the claim to the
 * implementation: the application may describe its digest as SHA-256 IF AND
 * ONLY IF the implementation actually satisfies the SHA-256 known-answer
 * vectors. Whichever way a future change moves — someone fixes the algorithm,
 * or someone re-adds the wording — the pair stays honest or this fails.
 *
 *   §1  the digest is unchanged, byte for byte
 *   §2  claim/implementation consistency guard
 *   §3  persisted fingerprints are not recomputed or migrated
 *   §4  deduplication behaviour is unchanged
 *   §5  provenance determinism and JCS canonicalization still hold
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Sha256Service } from '../services/Sha256Service';
import { TransactionIdentityService } from '../services/TransactionIdentityService';
import { ImportPipelineService } from '../services/ImportPipelineService';
import { ProvenanceService } from '../services/mathematics/ProvenanceService';
import { JcsSerializationService } from '../services/mathematics/JcsSerializationService';
import { Transaction } from '../domain/types';

/** RFC 6234 / FIPS 180-4 known-answer vectors. */
const SHA256_KAT: Array<[string, string]> = [
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
   '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1']
];

/** True only if the implementation really is SHA-256. */
const implementationIsRealSha256 = (): boolean =>
  SHA256_KAT.every(([input, expected]) => Sha256Service.hash(input) === expected);

const SRC = path.resolve(__dirname, '..');

/** Every shipped source file, excluding tests. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * A line mentions SHA-256 as a CLAIM unless it explicitly negates it.
 * The corrected code deliberately still names SHA-256 in order to say what the
 * digest is NOT, and to record the reference vector; those must not trip this.
 */
const NEGATION = /\bNOT SHA-?256\b|\bnot SHA-?256\b|do not describe|equivalent to SHA-?256|SHA-256\('abc'\)|crypto\.subtle/i;

function sha256ClaimLines(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of sourceFiles()) {
    // The service's own identifier is not a prose claim.
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (!/SHA-?256/i.test(text)) return;
      if (NEGATION.test(text)) return;
      // `Sha256Service` as an identifier / import is a symbol, not a claim.
      const withoutIdentifier = text.replace(/Sha256Service/g, '');
      if (!/SHA-?256/i.test(withoutIdentifier)) return;
      hits.push({ file: path.relative(SRC, file), line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 't-1', date: '2026-06-01', amount: 5000, narration: 'acme payroll jun',
  account: 'HDFC Bank', type: 'Income', category: 'Salary', status: 'CLEARED',
  ...over
} as unknown as Transaction);

describe('WP-FB-DATA-11 — the digest must not be described as SHA-256', () => {

  /* ═══════════════ §1 the digest itself is untouched ═══════════════ */
  describe('§1 the existing digest is preserved byte-for-byte', () => {
    it('still produces the exact values measured at the POST10 gate', () => {
      // Frozen expectations. If these ever change, persisted fingerprints in
      // users' IndexedDB have been orphaned.
      expect(Sha256Service.hash('abc'))
        .toBe('8466c30a3bdfa36dc3d7959f676fc764606b043baa55931857bb5487d3ced497');
      expect(Sha256Service.hash('HDFC Bank|2026-06-01|5000|acme payroll jun'))
        .toBe(TransactionIdentityService.fingerprint(tx()));
    });

    it('is deterministic across repeated calls', () => {
      const a = Sha256Service.hash('stability check');
      for (let i = 0; i < 25; i++) expect(Sha256Service.hash('stability check')).toBe(a);
    });

    it('emits 64 lowercase hex characters', () => {
      for (const s of ['', 'a', 'abc', 'x'.repeat(1000)]) {
        expect(Sha256Service.hash(s)).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('distinguishes different inputs', () => {
      const seen = new Set(
        ['a', 'b', 'ab', 'ba', 'HDFC|1', 'HDFC|2'].map(s => Sha256Service.hash(s))
      );
      expect(seen.size).toBe(6);
    });
  });

  /* ═══════════════ §2 THE GUARD ═══════════════ */
  describe('§2 the claim and the implementation cannot diverge', () => {
    it('the implementation does NOT satisfy the SHA-256 known-answer vectors', () => {
      // Documents the measured reality this WP is built on. If someone later
      // corrects the algorithm, this flips and §2's main guard relaxes.
      expect(implementationIsRealSha256()).toBe(false);
      expect(Sha256Service.hash('abc')).not.toBe(SHA256_KAT[0][1]);
    });

    it('claims SHA-256 in shipped source ONLY IF the implementation really is SHA-256', () => {
      const claims = sha256ClaimLines();
      if (implementationIsRealSha256()) {
        // Algorithm was corrected — describing it as SHA-256 is then truthful.
        return;
      }
      expect(
        claims,
        'The digest does not satisfy the SHA-256 known-answer vectors, so no shipped ' +
        'source file may describe it as SHA-256. Offending lines:\n' +
        claims.map(c => `  ${c.file}:${c.line}  ${c.text}`).join('\n')
      ).toEqual([]);
    });

    it('the provenance badge does not advertise SHA-256', () => {
      const badge = fs.readFileSync(
        path.join(SRC, 'components/ui/ProvenanceBadge.tsx'), 'utf8');
      expect(badge).not.toMatch(/SHA-?256/i);
      expect(badge).toMatch(/RFC 8785 JCS/); // the part that IS true
    });

    it('the Import page does not advertise SHA-256 deduplication', () => {
      const page = fs.readFileSync(path.join(SRC, 'pages/ImportPage.tsx'), 'utf8');
      expect(page).not.toMatch(/SHA-?256/i);
    });

    it('no shipped source claims the digest is independently verifiable', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles()) {
        const body = fs.readFileSync(file, 'utf8');
        for (const line of body.split('\n')) {
          if (/independently verifiab/i.test(line) && !/NOT independently verifiab|are NOT independently/i.test(line)) {
            offenders.push(`${path.relative(SRC, file)}: ${line.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  /* ═══════════════ §3 persisted fingerprints are untouched ═══════════════ */
  describe('§3 no persisted fingerprint is recomputed or migrated', () => {
    it('a stored fingerprint is returned verbatim, never recomputed', () => {
      const stored = 'deadbeef'.repeat(8); // deliberately not a real digest
      const row = tx({ fingerprint: stored } as any);
      expect(TransactionIdentityService.fingerprintOf(row)).toBe(stored);
      expect(TransactionIdentityService.fingerprintOf(row))
        .not.toBe(TransactionIdentityService.fingerprint(row));
    });

    it('a row WITHOUT a stored fingerprint is computed with the unchanged digest', () => {
      const row = tx();
      expect(TransactionIdentityService.fingerprintOf(row))
        .toBe(Sha256Service.hash('HDFC Bank|2026-06-01|5000|acme payroll jun'));
    });

    it('the canonical string is unchanged — the input to every persisted digest', () => {
      expect(TransactionIdentityService.canonicalString(tx()))
        .toBe('HDFC Bank|2026-06-01|5000|acme payroll jun');
    });

    it('reading a fingerprint does not mutate the row', () => {
      const row = tx({ fingerprint: 'abc123' } as any);
      const before = JSON.stringify(row);
      TransactionIdentityService.fingerprintOf(row);
      expect(JSON.stringify(row)).toBe(before);
    });
  });

  /* ═══════════════ §4 deduplication behaviour is unchanged ═══════════════ */
  describe('§4 import deduplication is unchanged', () => {
    it('identical rows still collide', () => {
      expect(TransactionIdentityService.fingerprint(tx()))
        .toBe(TransactionIdentityService.fingerprint(tx({ id: 'other-id' })));
    });

    it('narration case and padding still normalise to the same fingerprint', () => {
      expect(TransactionIdentityService.fingerprint(tx({ narration: '  ACME Payroll JUN  ' })))
        .toBe(TransactionIdentityService.fingerprint(tx()));
    });

    it('a different amount still produces a different fingerprint', () => {
      expect(TransactionIdentityService.fingerprint(tx({ amount: 5001 })))
        .not.toBe(TransactionIdentityService.fingerprint(tx()));
    });

    it('the import pipeline still delegates to the one authority', () => {
      expect(ImportPipelineService.generateFingerprint(tx()))
        .toBe(TransactionIdentityService.fingerprint(tx()));
    });

    it('a row carrying an old stored fingerprint still dedups against it', () => {
      const stored = TransactionIdentityService.fingerprint(tx());
      const existing = tx({ id: 'stored', fingerprint: stored } as any);
      const incoming = tx({ id: 'incoming' });
      expect(TransactionIdentityService.fingerprintOf(existing))
        .toBe(TransactionIdentityService.fingerprintOf(incoming));
    });
  });

  /* ═══════════════ §5 provenance / JCS unchanged ═══════════════ */
  describe('§5 provenance determinism and JCS canonicalization', () => {
    it('JCS orders object keys lexicographically', () => {
      expect(JcsSerializationService.canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    });

    it('provenance is stable under input key reordering', () => {
      const mk = (raw: unknown) => ProvenanceService.createProvenance({
        engineId: 'e', algorithmId: 'A', algorithmVersion: '1',
        rawInputs: raw, referenceType: 'FIRST_PRINCIPLES'
      });
      expect(mk({ b: 2, a: 1 }).executionFingerprint)
        .toBe(mk({ a: 1, b: 2 }).executionFingerprint);
    });

    it('different inputs yield different execution fingerprints', () => {
      const mk = (raw: unknown) => ProvenanceService.createProvenance({
        engineId: 'e', algorithmId: 'A', algorithmVersion: '1',
        rawInputs: raw, referenceType: 'FIRST_PRINCIPLES'
      });
      expect(mk({ a: 1 }).executionFingerprint).not.toBe(mk({ a: 2 }).executionFingerprint);
    });

    it('provenance still emits a 64-hex fingerprint', () => {
      const p = ProvenanceService.createProvenance({
        engineId: 'e', algorithmId: 'A', algorithmVersion: '1',
        rawInputs: { x: 1 }, referenceType: 'FIRST_PRINCIPLES'
      });
      expect(p.executionFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(p.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
