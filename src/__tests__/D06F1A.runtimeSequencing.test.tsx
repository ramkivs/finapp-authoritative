/**
 * D-06-F1-A — REAL RUNTIME SEQUENCING + PROMOTION GUARD.
 *
 * Why this file exists
 * --------------------
 * The D-06-F1-A sequencing tests in
 * `BrokerImportSection.destructiveDisclosure.test.tsx` mock
 * `BrokerImportService.detectAndParse` and seed the repository with
 * hand-made Holdings whose ids are hard-coded to the ids in the preview
 * snapshot. They also run under jsdom, where `window.indexedDB` is
 * undefined, so `IndexedDBStorageService` silently takes its
 * "no IndexedDB in this environment" fallback and no persistence boundary
 * is exercised at all. A suite with those properties is green for both the
 * pre-correction implementation (`c.existing.status`, i.e. the eligibility
 * source that made the real Windows UI unusable) and the promoted one — so
 * it can neither prove the correction nor detect its loss. That is how
 * "promoted + green suite + broken Windows UI" was possible.
 *
 * This file removes all three escape hatches:
 *
 *   1. NO MOCKS. Real Groww-shaped XLSX bytes (built with the same `xlsx`
 *      package the app uses, including the preamble row that carries the
 *      Groww MF account key) go through the real
 *      `BrokerImportService.detectAndParse` → real `reconcile` → real
 *      `commitImportedHoldings` → real `MemoryRepository.write` → real
 *      `HoldingLifecycleService.planClose`. The canonical ids are therefore
 *      parser-generated ids that survived an import, not fixture ids.
 *   2. REAL PERSISTENCE. `fake-indexeddb` provides
 *      `window.indexedDB`, so the write actually runs a readwrite
 *      transaction and the ledger is reloaded from storage.
 *   3. PROMOTION GUARD. The eligibility SOURCE of `ClosureTable` is asserted
 *      against the shipped source text, so a runtime built from a
 *      pre-correction commit fails this file loudly instead of silently.
 *
 * Contract preserved (unchanged, deliberately):
 *   - eligibility is exactly `status === 'closed_absent'` on the canonical
 *     Holding — this test asserts the *value*, never a looser rule;
 *   - D-06-F10-C: no asset effect;
 *   - D-06-F11: A / INCLUDE;
 *   - whole-batch atomic, review → explicit confirm, irreversible,
 *     batch-attributable audit (the batch modal is exercised, not bypassed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// Must be imported BEFORE the app modules: it installs `window.indexedDB`
// (and `globalThis.indexedDB`) so the real persistence branch runs.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';

import { BrokerImportSection } from '../pages/BrokerImportSection';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import type { Holding } from '../domain/types';

// ---------------------------------------------------------------------------
// Real Groww fixture, built the way Groww exports it.
// ---------------------------------------------------------------------------

/** Groww Mutual Funds account key lives in the preamble ("Mobile Number"). */
const MOBILE = '9876543210';

/** Verbatim header sequence the Groww adapter binds detection to. */
const MF_HEADERS = [
  'Scheme Name', 'AMC', 'Category', 'Sub-category', 'Folio No.', 'Source',
  'Units', 'Invested Value', 'Current Value', 'Returns', 'XIRR',
] as const;

interface MfRow { scheme: string; units: number; invested: number; current: number }
const mfRow = (scheme: string, units: number, invested: number, current: number): MfRow =>
  ({ scheme, units, invested, current });

/** The two Holdings affected by the reported Windows failure. */
const CLOSED_SCHEMES = ['TATAAML-TATAGOLD', 'UTIAMC-UTIGOLDBETA'];

/** Import #1: 6 Holdings. */
const SIX_HOLDINGS: MfRow[] = [
  mfRow('TATAAML-TATAGOLD', 100, 50000, 55000),
  mfRow('UTIAMC-UTIGOLDBETA', 200, 100000, 108000),
  mfRow('INF00K10U1T4-HDFCBANK', 50, 80000, 90000),
  mfRow('INF202K01021-SBIMAGIC', 30, 60000, 61000),
  mfRow('AXISLTD-AXISBANKETF', 40, 20000, 21000),
  mfRow('ICICIGOLD-ETF', 60, 30000, 33000),
];

/** Import #2: 4 remain (re-valued), the two gold rows become CLOSED ABSENT. */
const FOUR_HOLDINGS: MfRow[] = SIX_HOLDINGS.slice(2).map((x) => ({
  ...x, current: x.current + 500,
}));

function growwMfBytes(rows: MfRow[]): Uint8Array {
  const aoa: (string | number)[][] = [
    ['Groww Mutual Funds Holdings'],
    ['Statement Date', '23-08-2026'],
    ['PAN', 'ABCDE1234F'],
    [''],
    ['HOLDING SUMMARY'],
    ['No. of Schemes', String(rows.length)],
    ['Invested Value', rows.reduce((s, x) => s + x.invested, 0)],
    ['Mobile Number', MOBILE],
    [...MF_HEADERS],
    ...rows.map((x) => [
      x.scheme, x.scheme.split('-')[0], 'EQUITY', 'GOLD', 'FOLIO-1', 'Fundhouse',
      x.units, x.invested, x.current, '2.03%', '3.10%', '',
    ]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Holdings');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

function growwFile(rows: MfRow[], fileName: string): File {
  const bytes = growwMfBytes(rows);
  const file = new File([bytes as unknown as BlobPart], fileName, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  // jsdom may not implement Blob.arrayBuffer; the component only needs bytes.
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return file;
}

// ---------------------------------------------------------------------------
// DOM helpers (queried by instrument, because the ids are parser-generated)
// ---------------------------------------------------------------------------

const checkboxes = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-testid^="batch-select-checkbox-"]'));

const rowBoxFor = (instrument: string) =>
  checkboxes().find((el) => (el.closest('tr')?.textContent ?? '').includes(instrument)) ?? null;

const rowDeleteFor = (instrument: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-testid^="delete-holding-button-"]'))
    .find((el) => (el.closest('tr')?.textContent ?? '').includes(instrument)) ?? null;

const closureSurfaceTitle = () =>
  document.body.textContent?.match(/Closures \([^)]*\) \(\d+\)/)?.[0] ?? null;

const canonical = () => useCanonicalLedger.getState().holdings;

const statusOf = (instrument: string): Holding['status'] | undefined =>
  canonical().find((h) => h.instrumentName === instrument)?.status;

const idOf = (instrument: string): string | undefined =>
  canonical().find((h) => h.instrumentName === instrument)?.id;

async function upload(rows: MfRow[], fileName: string) {
  fireEvent.change(screen.getByTestId('broker-file-input'), {
    target: { files: [growwFile(rows, fileName)] },
  });
  await waitFor(() => expect(document.body.textContent).toContain('Step 4: Broker Import — Preview'));
}

async function confirmImport() {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => /Confirm import/i.test(b.textContent ?? ''));
  if (!btn) throw new Error('Confirm import button not rendered');
  expect(btn.disabled, 'a mutation-bearing preview must be confirmable').toBe(false);
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByTestId('broker-import-commit-notice')).toBeTruthy());
}

// ---------------------------------------------------------------------------

describe('D-06-F1-A — real runtime sequencing (real parser, real store, real IndexedDB)', () => {
  beforeEach(async () => {
    cleanup();
    await IndexedDBStorageService.clearAll();
    const repo = repository as unknown as {
      holdingsData: Holding[]; holdingDeletionLogData: unknown[]; syncStore: () => void; initialize: () => Promise<void>;
    };
    repo.holdingsData = [];
    repo.holdingDeletionLogData = [];
    repo.syncStore();
    useCanonicalLedger.setState({ holdings: [], holdingDeletionLog: [] } as never);
    await repo.initialize();
  });

  afterEach(async () => {
    cleanup();
    await IndexedDBStorageService.clearAll();
  });

  it('import #1 creates 6 canonical Holdings with parser-generated ids', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_Mutual_Funds_6995348108_23-08-2026.xlsx');
    // Nothing is selectable before any closure exists at all.
    expect(checkboxes()).toHaveLength(0);
    await confirmImport();

    expect(screen.getByTestId('broker-import-commit-notice').textContent)
      .toContain('Imported 6 new, 0 updated, 0 closed-absent, 0 unchanged.');
    expect(canonical()).toHaveLength(6);
    expect(canonical().every((h) => h.status === 'active')).toBe(true);
    expect(canonical().every((h) => h.broker === 'Groww' && h.account === MOBILE)).toBe(true);
    // Ids came from the import, i.e. they are the persisted canonical ids.
    expect(new Set(canonical().map((h) => h.id)).size).toBe(6);
    expect(canonical().every((h) => /^hld-/.test(h.id))).toBe(true);
  });

  it('pre-confirm: closure rows visible but not selectable; canonical still active', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_6.xlsx');
    await confirmImport();
    await upload(FOUR_HOLDINGS, 'Groww_29.xlsx');

    expect(closureSurfaceTitle()).toContain('Closures (will transition to closed_absent) (2)');
    for (const scheme of CLOSED_SCHEMES) {
      expect(rowBoxFor(scheme), `checkbox row for ${scheme}`).not.toBeNull();
      expect(rowBoxFor(scheme)!.disabled, `checkbox ${scheme} pre-confirm`).toBe(true);
      expect(rowDeleteFor(scheme)!.disabled, `single delete ${scheme} pre-confirm`).toBe(true);
      expect(statusOf(scheme)).toBe('active');
    }
    expect(screen.queryByTestId('batch-delete-button')).toBeNull();
  });

  it('POST-CONFIRM (the Windows failure): rows become selectable from the LIVE canonical ledger', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_6.xlsx');
    await confirmImport();
    await upload(FOUR_HOLDINGS, 'Groww_4.xlsx');
    await confirmImport();

    // The confirmed import reported the closures…
    expect(screen.getByTestId('broker-import-commit-notice').textContent)
      .toContain('Imported 0 new, 4 updated, 2 closed-absent, 0 unchanged.');
    // …the canonical ledger actually transitioned…
    for (const scheme of CLOSED_SCHEMES) {
      expect(statusOf(scheme), `canonical status of ${scheme}`).toBe('closed_absent');
    }
    // …and the post-confirm surface is mounted with the same canonical ids.
    expect(closureSurfaceTitle()).toContain('Closures (transitioned to closed_absent — eligible for permanent deletion) (2)');
    for (const scheme of CLOSED_SCHEMES) {
      const box = rowBoxFor(scheme);
      expect(box, `checkbox row for ${scheme} after confirm`).not.toBeNull();
      expect(box!.disabled, `${scheme} must be selectable after the confirmed transition`).toBe(false);
      // D-06-F1-A: the checkbox is keyed by the CANONICAL holding id (§8 of the
      // diagnosis: preview id == confirmed id == canonical id).
      expect(box!.getAttribute('data-testid'))
        .toBe(`batch-select-checkbox-${idOf(scheme)}`);
      expect(rowDeleteFor(scheme)!.disabled, `single delete ${scheme} after confirm`).toBe(false);
    }
    // The four surviving rows are untouched and still active.
    expect(FOUR_HOLDINGS.every((x) => statusOf(x.scheme) === 'active')).toBe(true);
  });

  it('eligibility survives a real reload of the ledger from storage', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_6.xlsx');
    await confirmImport();
    await upload(FOUR_HOLDINGS, 'Groww_4.xlsx');
    await confirmImport();
    const idsBefore = CLOSED_SCHEMES.map((s) => idOf(s));

    cleanup();
    await repository.initialize();
    render(<BrokerImportSection />);

    // Canonical truth survived persistence byte-for-byte.
    expect(CLOSED_SCHEMES.map((s) => idOf(s))).toEqual(idsBefore);
    expect(CLOSED_SCHEMES.every((s) => statusOf(s) === 'closed_absent')).toBe(true);
  });

  it('the post-confirm surface stays reachable when the Step 1 broker chip is touched', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_6.xlsx');
    await confirmImport();
    await upload(FOUR_HOLDINGS, 'Groww_4.xlsx');
    await confirmImport();

    // Step 1 defaults to 'Zerodha' while the import is detected from content.
    // A user tapping the actual broker after confirming must NOT lose the
    // only surface that can reach F1-A deletion for already-closed rows.
    const chip = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => (b.textContent ?? '').trim() === 'Groww');
    expect(chip, 'Groww chip in Step 1').toBeTruthy();
    fireEvent.click(chip!);
    await waitFor(() => expect(closureSurfaceTitle())
      .toContain('Closures (transitioned to closed_absent — eligible for permanent deletion) (2)'));

    for (const scheme of CLOSED_SCHEMES) {
      expect(rowBoxFor(scheme)!.disabled,
        `${scheme} must remain selectable after a broker-chip click`).toBe(false);
    }
    // And the ledger is untouched by a chip click.
    expect(CLOSED_SCHEMES.every((s) => statusOf(s) === 'closed_absent')).toBe(true);
  });

  it('batch flow on the post-confirm surface: select → review → explicit confirm → atomic, audited, irreversible', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_6.xlsx');
    await confirmImport();
    await upload(FOUR_HOLDINGS, 'Groww_4.xlsx');
    await confirmImport();

    fireEvent.click(rowBoxFor(CLOSED_SCHEMES[0])!);
    fireEvent.click(rowBoxFor(CLOSED_SCHEMES[1])!);
    expect(screen.getByTestId('batch-delete-count').textContent).toContain('2');

    const expectedIds = CLOSED_SCHEMES.map((scheme) => {
      const id = idOf(scheme);
      expect(id, `canonical id for ${scheme} before deletion`).toBeTruthy();
      return id as string;
    });

    fireEvent.click(screen.getByTestId('batch-delete-button'));
    expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('review');
    fireEvent.click(screen.getByTestId('batch-modal-review-next'));
    expect(screen.getByTestId('batch-delete-modal').getAttribute('data-stage')).toBe('confirm');
    fireEvent.click(screen.getByTestId('batch-modal-confirm'));

    await waitFor(() => expect(canonical().map((h) => h.instrumentName).sort())
      .toEqual([...FOUR_HOLDINGS].map((x) => x.scheme).sort()));
    expect(CLOSED_SCHEMES.some((s) => canonical().some((h) => h.instrumentName === s))).toBe(false);

    const log = (repository as unknown as { holdingDeletionLogData: Array<Record<string, unknown>> }).holdingDeletionLogData;
    expect(log).toHaveLength(2);
    // D-06-F1-A: whole batch, one attribution, user-selected scope only.
    expect(new Set(log.map((e) => e.batchId as string)).size).toBe(1);
    expect(log.every((e) => e.batchScope === 'MULTI_SELECT')).toBe(true);
    expect([...log.map((e) => e.holdingId as string)].sort())
      .toEqual([...expectedIds].sort());

    // D-06-F10-C: no asset effect — no Asset was created or mutated by any
    // of this (holdings never mint assets on the import/deletion path).
    expect(useCanonicalLedger.getState().assets).toHaveLength(0);
  });

  it('a new import supersedes the surface, and cancel drops it (lifecycle boundaries unchanged)', async () => {
    render(<BrokerImportSection />);
    await upload(SIX_HOLDINGS, 'Groww_6.xlsx');
    await confirmImport();
    await upload(FOUR_HOLDINGS, 'Groww_4.xlsx');
    await confirmImport();
    expect(closureSurfaceTitle()).toContain('(2)');

    // New import ⇒ supersede.
    await upload(SIX_HOLDINGS, 'Groww_6_again.xlsx');
    expect(closureSurfaceTitle()).toBeNull();       // preview owns the screen now
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => /^Cancel$/.test((b.textContent ?? '').trim()));
    fireEvent.click(cancel!);
    await waitFor(() => expect(document.body.textContent).not.toContain('Step 4: Broker Import — Preview'));
    // Cancel drops the previous surface as before (explicit cancel semantics).
    expect(closureSurfaceTitle()).toBeNull();
  });
});

describe('D-06-F1-A — promotion guard (proves the correction is the code under test)', () => {
  const SRC_RAW = readFileSync(resolve(__dirname, '../pages/BrokerImportSection.tsx'), 'utf8');
  // Guards below are CODE guards, not prose guards: comments are stripped so
  // that an explanatory note can never satisfy (or break) an assertion.
  const SRC = SRC_RAW.replace(/\/\/[^\n]*/g, '');
  const table = SRC.slice(SRC.indexOf('export const ClosureTable'));
  expect(table.length, 'ClosureTable must exist in the shipped source').toBeGreaterThan(1000);

  it('ClosureTable resolves eligibility from the LIVE canonical ledger subscription', () => {
    expect(table).toContain('useCanonicalLedger((s) => s.holdings)');
    expect(table).toContain('liveById.get(c.existing.id)');
    expect(table).toContain("const isDeletionEligible = (h: Holding) => h.status === 'closed_absent'");
    expect(table).toContain('disabled={!isDeletionEligible(live)}');
  });

  it('ClosureTable does NOT read eligibility off the preview snapshot (the pre-correction defect)', () => {
    // `5b05781` — the runtime that produced the Windows symptom — derived the
    // checkbox / delete-affordance state from `c.existing.status`, a snapshot
    // object captured BEFORE the import transitioned anything. That source
    // must stay gone: the only permitted consumer of `c.existing` is `.id`.
    expect(table).not.toMatch(/[=(]\s*c\.existing\.status\s*[=!]==?/);
    expect(table).not.toContain("existing.status !== 'closed_absent'");
    expect(table).not.toContain("existing.status === 'closed_absent'");
  });

  it('the broker-chip reset no longer destroys the post-confirm closure surface', () => {
    const effect = SRC.slice(SRC.indexOf('useEffect(() => {'), SRC.indexOf('}, [selectedBroker]);'));
    expect(effect.length).toBeGreaterThan(0);
    expect(effect).not.toContain('setConfirmedClosures(null)');
    // The real lifecycle boundaries still own the clear.
    expect(SRC).toContain('setConfirmedClosures(null)');
  });

  it('the broker chip never gates eligibility (no chip-derived condition in the table)', () => {
    expect(table).not.toMatch(/selectedBroker/);
  });
});
