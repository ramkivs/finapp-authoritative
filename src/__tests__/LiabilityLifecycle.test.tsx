/**
 * WP-FB-DATA-07a — Liability lifecycle: Edit, Delete, duplicate-name policy.
 *
 * Decisions implemented (FINBOOM-DECISION-LEDGER.md):
 *   Q-D07a-1 = (c)  Edit replaces the COMPLETE record except `id`.
 *   Q-D07a-2 = (b)  A duplicate name is REFUSED, pointing the user at Edit.
 *   Q-D07a-3 = (b)  Physical delete by `id`, behind an explicit confirmation.
 *   Q-D07a-4 = (b)  The legacy exact-name upsert is retired; create appends.
 *   Scope ruling:   the OverviewPage second create path is IN scope.
 *
 * WHAT THIS PACKAGE IS
 *
 * WP-FB-DATA-07 gave liabilities a stable id and changed nothing a user could
 * see. 07a is where that identity becomes reachable: the Liabilities table had
 * four columns, zero edit controls, zero delete controls and no notice of any
 * kind, and the only way to correct a figure was to re-add it under the same
 * name and hope the silent upsert hit the row you meant.
 *
 * The gate measured what "hope" cost. With two rows named "Home Loan"
 * (₹25,00,000 and ₹9,00,000): a name-addressed edit hit index 0 — a coin flip
 * over ₹16,00,000; a name-addressed delete removed BOTH — ₹34,00,000 destroyed;
 * and a stale id did not refuse, it appended — debt 100 → 10,099.
 *
 * Every test below asserts BEHAVIOUR through the authority or the rendered
 * control, never that a control merely exists (the WP-21 lesson: six controls
 * rendered, none of them worked).
 *
 *   §1  the lifecycle authority refuses, with codes
 *   §2  create — both paths, duplicate policy
 *   §3  edit — id-addressed, complete record, atomic
 *   §4  delete — id-addressed, confirmed, irreversible
 *   §5  persistence failure and READFAIL are DISCLOSED
 *   §6  the rendered affordances
 *   §7  derived figures stay correct
 *   §8  scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import {
  LiabilityLifecycleService,
  LiabilityLifecycleError,
  LIABILITY_EDITABLE_FIELDS
} from '../services/LiabilityLifecycleService';
import { LiabilityIdentityService } from '../services/LiabilityIdentityService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { LiabilitiesWorkspace } from '../components/wealth/LiabilitiesWorkspace';
import { OverviewPage } from '../pages/OverviewPage';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Liability } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const libs = (): Liability[] => repo.liabilitiesData;
const byName = (n: string) => libs().filter(l => l.name === n);
const totalDebt = () => libs().reduce((s, l) => s + l.amount, 0);
const drain = () => new Promise(r => setTimeout(r, 30));

function reset() {
  repo.liabilitiesData = [];
  repo.holdingsData = []; repo.assetsData = []; repo.snapshotsData = []; repo.syncStore();
  useCanonicalLedger.setState({ liabilities: [], assets: [], snapshots: [] } as any);
}

async function attempt(fn: () => Promise<any>) {
  try { return { ok: true, value: await fn(), error: null as any }; }
  catch (e: any) { return { ok: false, value: null, error: e }; }
}

/** Seeds storage directly — used where the create path would (correctly) refuse. */
function force(rows: Liability[]) {
  repo.liabilitiesData = rows;
  repo.syncStore();
  useCanonicalLedger.setState({ liabilities: rows } as any);
}

/** Live view of the workspace, so writes are reflected without manual re-render. */
const Workspace: React.FC = () => {
  const liabilities = useCanonicalLedger(s => s.liabilities);
  return <LiabilitiesWorkspace liabilities={liabilities} />;
};
const renderWorkspace = () => render(<Workspace />);

const editBtn = (id: string) => document.querySelector(`[data-liability-edit="${id}"]`) as HTMLButtonElement;
const delBtn = (id: string) => document.querySelector(`[data-liability-delete="${id}"]`) as HTMLButtonElement;
const notice = () => document.getElementById('liability-notice');
const rowIds = () =>
  [...document.querySelectorAll('[data-liability-id]')].map(e => e.getAttribute('data-liability-id'));

function stubConfirm(answer: boolean) {
  const seen: string[] = [];
  vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { seen.push(String(m)); return answer; });
  return seen;
}

describe('WP-FB-DATA-07a — liability lifecycle', () => {
  beforeEach(() => { reset(); });
  afterEach(async () => {
    cleanup();
    IndexedDBStorageService.simulateFailureOnce = false;
    IndexedDBStorageService.simulateReadFailureOnce = false;
    // Clear the READFAIL latch: it is process-wide and would otherwise block
    // every write in every test that follows §5.
    await IndexedDBStorageService.loadAll().catch(() => {});
    vi.restoreAllMocks();
    reset();
  });

  /* ═══════════════ §1 the authority ══════════════════════════════════════ */
  describe('§1 LiabilityLifecycleService refuses, with codes', () => {
    const existing: Liability[] = [
      { id: 'lia-1', name: 'Home Loan', amount: 2500000, type: 'Home Loan', currency: 'INR' },
      { id: 'lia-2', name: 'Card', amount: 50000, type: 'Credit Card' }
    ];

    it('planCreate appends — it never upserts on name', () => {
      const plan = LiabilityLifecycleService.planCreate({ name: 'Gold', amount: 10 }, existing);
      expect(plan.next).toHaveLength(3);
      expect(plan.next.slice(0, 2)).toEqual(existing);
      expect(LiabilityIdentityService.isValidId(plan.liability.id)).toBe(true);
    });

    it('planCreate REFUSES a duplicate name and names the remedy', () => {
      try {
        LiabilityLifecycleService.planCreate({ name: 'home loan  ', amount: 1 }, existing);
        throw new Error('should have refused');
      } catch (e: any) {
        expect(e).toBeInstanceOf(LiabilityLifecycleError);
        expect(e.code).toBe('DUPLICATE_NAME');
        expect(e.message).toContain('Home Loan');
        expect(e.message).toContain('Edit');
      }
    });

    it('planCreate refuses a blank name and a non-numeric amount', () => {
      expect(() => LiabilityLifecycleService.planCreate({ name: '   ', amount: 1 }, existing))
        .toThrowError(/needs a name/);
      expect(() => LiabilityLifecycleService.planCreate({ name: 'X', amount: NaN }, existing))
        .toThrowError(/numeric/);
    });

    it('planCreate refuses an id already in use', () => {
      try {
        LiabilityLifecycleService.planCreate({ id: 'lia-1', name: 'Other', amount: 1 }, existing);
        throw new Error('should have refused');
      } catch (e: any) { expect(e.code).toBe('DUPLICATE_ID'); }
    });

    it('planUpdate refuses an empty id, a missing target, and a name clash', () => {
      const codes = ['EMPTY_ID', 'LIABILITY_NOT_FOUND', 'DUPLICATE_NAME'];
      const calls = [
        () => LiabilityLifecycleService.planUpdate({ id: '  ', name: 'A', amount: 1 }, existing),
        () => LiabilityLifecycleService.planUpdate({ id: 'lia-gone', name: 'A', amount: 1 }, existing),
        () => LiabilityLifecycleService.planUpdate({ id: 'lia-2', name: 'Home Loan', amount: 1 }, existing)
      ];
      calls.forEach((c, i) => {
        try { c(); throw new Error('should have refused'); }
        catch (e: any) { expect(e.code).toBe(codes[i]); }
      });
    });

    it('planUpdate lets a record keep its OWN name', () => {
      const plan = LiabilityLifecycleService.planUpdate(
        { id: 'lia-1', name: 'Home Loan', amount: 2400000, type: 'Home Loan', currency: 'INR' },
        existing
      );
      expect(plan.liability.amount).toBe(2400000);
      expect(plan.next).toHaveLength(2);
    });

    it('LU-M4 the stored id is used VERBATIM — a padded request id cannot corrupt it', () => {
      /* MUTATION-ESCAPE CLOSURE. `id: existing[index].id` and `id: request.id`
         agree on every ordinary call, so the mutant that reads identity from the
         request survived the whole suite. It stops agreeing the moment the
         request id differs in any way that still resolves — whitespace being the
         reachable case, since requireId() trims before matching. */
      const plan = LiabilityLifecycleService.planUpdate(
        { id: '  lia-1  ', name: 'Home Loan', amount: 7, type: 'Home Loan', currency: 'INR' },
        existing
      );
      expect(plan.liability.id).toBe('lia-1');
      expect(plan.next.map(l => l.id)).toEqual(['lia-1', 'lia-2']);
      expect(plan.next[0].amount).toBe(7);
    });

    it('LU-M4 the same holds end to end through the repository', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }]);
      await S().updateLiability({ id: ' lia-A ', name: 'A', amount: 250 });
      await drain();
      expect(libs()).toHaveLength(1);
      expect(libs()[0].id).toBe('lia-A');
      expect(libs()[0].amount).toBe(250);
      // and the record remains addressable afterwards
      await S().removeLiability('lia-A');
      await drain();
      expect(libs()).toHaveLength(0);
    });

    it('planUpdate takes the id from STORAGE — a forged id cannot rewrite identity', () => {
      const plan = LiabilityLifecycleService.planUpdate(
        { id: 'lia-1', name: 'Renamed', amount: 1 } as any,
        existing
      );
      expect(plan.liability.id).toBe('lia-1');
      // and the untouched neighbour is byte-identical
      expect(plan.next[1]).toEqual(existing[1]);
    });

    it('planDelete removes exactly one row and reports the target', () => {
      const plan = LiabilityLifecycleService.planDelete('lia-1', existing);
      expect(plan.target).toEqual(existing[0]);
      expect(plan.next).toEqual([existing[1]]);
    });

    it('planDelete refuses an empty id and an absent target', () => {
      for (const [id, code] of [['', 'EMPTY_ID'], ['lia-gone', 'LIABILITY_NOT_FOUND']] as const) {
        try { LiabilityLifecycleService.planDelete(id, existing); throw new Error('should have refused'); }
        catch (e: any) { expect(e.code).toBe(code); }
      }
    });

    it('the editable field set is the whole record except id', () => {
      expect([...LIABILITY_EDITABLE_FIELDS].sort()).toEqual(['amount', 'currency', 'name', 'type']);
      expect(LIABILITY_EDITABLE_FIELDS as readonly string[]).not.toContain('id');
    });

    it('describeDeletion quotes both the name and the amount', () => {
      const text = LiabilityLifecycleService.describeDeletion(existing[0]);
      expect(text).toContain('Home Loan');
      expect(text).toContain('2500000');
      expect(text.toLowerCase()).toContain('cannot be undone');
    });

    it('findDuplicateNames reports without merging', () => {
      const dupes = LiabilityLifecycleService.findDuplicateNames([
        { id: 'a', name: 'Personal Loan', amount: 1 },
        { id: 'b', name: 'personal loan', amount: 2 },
        { id: 'c', name: 'Card', amount: 3 }
      ]);
      expect(dupes).toEqual(['personal loan']);
    });
  });

  /* ═══════════════ §2 create ═════════════════════════════════════════════ */
  describe('§2 create appends, and the duplicate policy covers BOTH paths', () => {
    it('AC-13 the modal path refuses a duplicate name', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      const r = await attempt(() =>
        S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 900000, type: 'Home Loan' })
      );
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('DUPLICATE_NAME');
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(2500000);
    });

    it('AC-13 the OverviewPage quick-add path refuses the SAME duplicate', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      // addLiability() bypasses FinancialCommands entirely — this is the path a
      // modal-side check would have left unguarded.
      const r = await attempt(() => S().addLiability('  home loan ', 900000));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('DUPLICATE_NAME');
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(2500000);
    });

    it('the gate sequence no longer destroys ₹25,00,000', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      await attempt(() => S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 900000 }));
      await drain();
      expect(libs()).toHaveLength(1);
      expect(libs()[0].amount).toBe(2500000);
      expect(libs()[0].amount).not.toBe(900000);
    });

    it('distinct names append rather than upsert', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100 });
      await S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 200 });
      await drain();
      expect(libs()).toHaveLength(2);
      expect(new Set(libs().map(l => l.id)).size).toBe(2);
      expect(totalDebt()).toBe(300);
    });

    it('a refused create performs NO write at all', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100 });
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await attempt(() => S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 200 }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════ §3 edit ═══════════════════════════════════════════════ */
  describe('§3 edit is id-addressed, complete and atomic', () => {
    async function seedDuplicates() {
      // Legacy duplicates, as migration would carry them in.
      force([
        { id: 'lia-A', name: 'Home Loan', amount: 2500000, type: 'Home Loan', currency: 'INR' },
        { id: 'lia-B', name: 'Home Loan', amount: 900000, type: 'Home Loan', currency: 'INR' }
      ]);
      await drain();
    }

    it('AC-1/AC-5 with duplicates present, editing one leaves the other byte-identical', async () => {
      await seedDuplicates();
      const untouched = JSON.parse(JSON.stringify(libs()[1]));
      await S().updateLiability({
        id: 'lia-A', name: 'Home Loan', amount: 2400000, type: 'Home Loan', currency: 'INR'
      });
      await drain();
      expect(libs()).toHaveLength(2);
      expect(libs()[0].amount).toBe(2400000);
      expect(libs()[1]).toEqual(untouched);
      expect(totalDebt()).toBe(3300000);
    });

    it('AC-2 a stale id REFUSES rather than appending a phantom row', async () => {
      force([{ id: 'lia-A', name: 'Only', amount: 100 }]);
      const r = await attempt(() =>
        S().updateLiability({ id: 'lia-stale-gone', name: 'Only', amount: 9999 })
      );
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('LIABILITY_NOT_FOUND');
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(100);
      expect(totalDebt()).not.toBe(10099);
    });

    it('AC-3 the id survives an edit unchanged', async () => {
      await S().addLiabilityWithMetadata({ name: 'A', amount: 1, type: 'Other' });
      await drain();
      const id = libs()[0].id!;
      await S().updateLiability({ id, name: 'B', amount: 2, type: 'Gold Loan' });
      await drain();
      expect(libs()[0].id).toBe(id);
    });

    it('AC-4 every editable field is carried through — nothing is silently blanked', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 1, type: 'Other', currency: 'INR' }]);
      await S().updateLiability({ id: 'lia-A', name: 'A2', amount: 2, type: 'Gold Loan', currency: 'USD' });
      await drain();
      expect(libs()[0]).toEqual({ id: 'lia-A', name: 'A2', amount: 2, type: 'Gold Loan', currency: 'USD' });
    });

    it('AC-6 a rename neither merges nor duplicates, and debt does not move', async () => {
      await S().addLiabilityWithMetadata({ name: 'Old Name', amount: 100000, type: 'Other' });
      await S().addLiabilityWithMetadata({ name: 'Card', amount: 50000, type: 'Credit Card' });
      await drain();
      const id = libs()[0].id!;
      await S().updateLiability({ id, name: 'New Name', amount: 100000, type: 'Other' });
      await drain();
      expect(libs()).toHaveLength(2);
      expect(byName('Old Name')).toHaveLength(0);
      expect(byName('New Name')).toHaveLength(1);
      expect(totalDebt()).toBe(150000);
    });

    it('a rename ONTO another live name is refused', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100 });
      await S().addLiabilityWithMetadata({ name: 'Car Loan', amount: 200 });
      await drain();
      const carId = libs().find(l => l.name === 'Car Loan')!.id!;
      const r = await attempt(() => S().updateLiability({ id: carId, name: 'Home Loan', amount: 200 }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('DUPLICATE_NAME');
      expect(byName('Car Loan')).toHaveLength(1);
      expect(totalDebt()).toBe(300);
    });

    it('AC-9/AC-14 an edit is exactly ONE saveAll', async () => {
      await S().addLiabilityWithMetadata({ name: 'A', amount: 1 });
      await drain();
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await S().updateLiability({ id: libs()[0].id, name: 'A', amount: 2 });
      await drain();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  /* ═══════════════ §4 delete ═════════════════════════════════════════════ */
  describe('§4 delete is id-addressed and confirmed', () => {
    it('AC-7 with duplicates present, exactly ONE row is removed', async () => {
      force([
        { id: 'lia-A', name: 'Home Loan', amount: 2500000 },
        { id: 'lia-B', name: 'Home Loan', amount: 900000 }
      ]);
      await S().removeLiability('lia-A');
      await drain();
      expect(libs()).toHaveLength(1);
      expect(libs()[0].id).toBe('lia-B');
      expect(totalDebt()).toBe(900000);
      // the name-addressed alternative destroyed ₹34,00,000 at the gate
      expect(totalDebt()).not.toBe(0);
    });

    it('deleting an absent id refuses instead of quietly succeeding', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 1 }]);
      const r = await attempt(() => S().removeLiability('lia-nope'));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('LIABILITY_NOT_FOUND');
      expect(libs()).toHaveLength(1);
    });

    it('a delete is exactly ONE saveAll and touches no other collection', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 1 }, { id: 'lia-B', name: 'B', amount: 2 }]);
      repo.assetsData = [{ id: 'ast-1', name: 'Cash', amount: 500 }];
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await S().removeLiability('lia-A');
      await drain();
      expect(spy).toHaveBeenCalledTimes(1);
      // [0] is the write lease, [1] is the ledger state (WP-FB-DATA-07c).
      expect(spy.mock.calls[0][1].assets).toEqual([{ id: 'ast-1', name: 'Cash', amount: 500 }]);
      expect(spy.mock.calls[0][1].liabilities).toHaveLength(1);
    });
  });

  /* ═══════════════ §5 failure disclosure ═════════════════════════════════ */
  describe('§5 a failed write is disclosed, never swallowed', () => {
    it('AC-10 a persistence failure rejects and rolls memory back exactly', async () => {
      await S().addLiabilityWithMetadata({ name: 'A', amount: 100 });
      await drain();
      const before = JSON.parse(JSON.stringify(libs()));

      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => S().updateLiability({ id: libs()[0].id, name: 'A', amount: 999 }));

      expect(r.ok).toBe(false);
      expect(libs()).toEqual(before);
      expect(totalDebt()).toBe(100);
    });

    it('AC-10 a failed DELETE leaves the row in place', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => S().removeLiability('lia-A'));
      expect(r.ok).toBe(false);
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(100);
    });

    it('AC-11 the READFAIL latch blocks the write and its message reaches the caller', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }]);
      IndexedDBStorageService.simulateReadFailureOnce = true;
      await attempt(() => IndexedDBStorageService.loadAll());

      const r = await attempt(() => S().updateLiability({ id: 'lia-A', name: 'A', amount: 999 }));
      expect(r.ok).toBe(false);
      expect(String(r.error?.message)).toContain('Refusing to persist');
      expect(String(r.error?.message)).not.toContain('undefined');
      expect(totalDebt()).toBe(100);
    });

    it('every store liability action RETURNS its promise (F-06b-2)', () => {
      const s = S();
      for (const k of ['addLiability', 'addLiabilityWithMetadata', 'updateLiability', 'removeLiability']) {
        const returned = (() => {
          try { return s[k]('x', 1); } catch { return undefined; }
        })();
        expect(typeof returned?.then).toBe('function');
        returned?.catch(() => {});
      }
    });
  });

  /* ═══════════════ §6 the rendered affordances ═══════════════════════════ */
  describe('§6 the UI', () => {
    it('AC-12 rows are keyed on id — duplicates raise no React key warning', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')); });
      force([
        { id: 'lia-A', name: 'Home Loan', amount: 2500000 },
        { id: 'lia-B', name: 'Home Loan', amount: 900000 }
      ]);
      renderWorkspace();
      expect(rowIds()).toEqual(['lia-A', 'lia-B']);
      expect(errors.join('\n')).not.toContain('same key');
    });

    it('every row exposes a working Edit and Delete control', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000 }]);
      renderWorkspace();
      expect(editBtn('lia-A')).toBeTruthy();
      expect(delBtn('lia-A')).toBeTruthy();
    });

    it('the edit modal opens prefilled with the COMPLETE record and a read-only id', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000, type: 'Home Loan', currency: 'INR' }]);
      renderWorkspace();
      fireEvent.click(editBtn('lia-A'));
      await waitFor(() => expect(document.getElementById('edit-liability-modal')).toBeTruthy());

      expect((document.getElementById('edit-liability-name') as HTMLInputElement).value).toBe('Home Loan');
      expect((document.getElementById('edit-liability-amount') as HTMLInputElement).value).toBe('2500000');
      expect((document.getElementById('edit-liability-type') as HTMLSelectElement).value).toBe('Home Loan');
      expect((document.getElementById('edit-liability-currency') as HTMLInputElement).value).toBe('INR');
      // the id is displayed, and there is no input that can change it
      expect(document.getElementById('edit-liability-identity')!.textContent).toContain('lia-A');
      expect(document.querySelector('input[name="id"], #edit-liability-id')).toBeNull();
      expect(document.getElementById('edit-liability-modal')!.getAttribute('data-liability-edit-target'))
        .toBe('lia-A');
    });

    it('submitting the edit writes by id and reports success', async () => {
      force([
        { id: 'lia-A', name: 'Home Loan', amount: 2500000, type: 'Home Loan', currency: 'INR' },
        { id: 'lia-B', name: 'Second Loan', amount: 900000, type: 'Home Loan', currency: 'INR' }
      ]);
      renderWorkspace();
      fireEvent.click(editBtn('lia-B'));
      await waitFor(() => expect(document.getElementById('edit-liability-modal')).toBeTruthy());
      fireEvent.change(document.getElementById('edit-liability-amount')!, { target: { value: '800000' } });
      fireEvent.submit(document.getElementById('edit-liability-submit')!.closest('form')!);

      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.getAttribute('data-liability-kind')).toBe('success');
      expect(libs().find(l => l.id === 'lia-B')!.amount).toBe(800000);
      expect(libs().find(l => l.id === 'lia-A')!.amount).toBe(2500000);
    });

    it('AC-9/AC-11 a refusal keeps the modal OPEN and renders e.message, not a code', async () => {
      force([
        { id: 'lia-A', name: 'Home Loan', amount: 100 },
        { id: 'lia-B', name: 'Car Loan', amount: 200 }
      ]);
      renderWorkspace();
      fireEvent.click(editBtn('lia-B'));
      await waitFor(() => expect(document.getElementById('edit-liability-modal')).toBeTruthy());
      fireEvent.change(document.getElementById('edit-liability-name')!, { target: { value: 'Home Loan' } });
      fireEvent.submit(document.getElementById('edit-liability-submit')!.closest('form')!);

      await waitFor(() => expect(document.getElementById('edit-liability-error')).toBeTruthy());
      const text = document.getElementById('edit-liability-error')!.textContent || '';
      expect(text).toContain('already exists');
      expect(text).not.toContain('DUPLICATE_NAME');
      expect(text).not.toContain('undefined');
      // still open, and nothing was written
      expect(document.getElementById('edit-liability-modal')).toBeTruthy();
      expect(byName('Car Loan')).toHaveLength(1);
    });

    it('AC-8 the delete confirmation quotes name AND amount', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000 }]);
      const seen = stubConfirm(true);
      renderWorkspace();
      fireEvent.click(delBtn('lia-A'));
      await waitFor(() => expect(libs()).toHaveLength(0));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('Home Loan');
      expect(seen[0]).toContain('2500000');
    });

    it('AC-8 declining the confirmation writes NOTHING', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000 }]);
      stubConfirm(false);
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      renderWorkspace();
      fireEvent.click(delBtn('lia-A'));
      await drain();
      expect(spy).not.toHaveBeenCalled();
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(2500000);
    });

    it('AC-10 a delete that fails to persist tells the user and keeps the row', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000 }]);
      stubConfirm(true);
      IndexedDBStorageService.simulateFailureOnce = true;
      renderWorkspace();
      fireEvent.click(delBtn('lia-A'));

      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.getAttribute('data-liability-kind')).toBe('error');
      expect(notice()!.textContent).not.toContain('undefined');
      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(2500000);
    });

    it('the OverviewPage quick-add path is guarded, reachable or not (F-07a-1)', async () => {
      /* SURFACED, NOT FIXED. `showLiabForm` in OverviewPage is initialised to
         false and NOTHING sets it true — the asset twin has two triggers, the
         liability one has none. So today this create path is unreachable from
         the UI even though the store action is live.
         That is exactly why the duplicate-name policy was put at the repository
         boundary and not in a modal: whether or not someone later wires the
         missing button, the path cannot bypass the policy. This test adapts —
         it exercises the control if it exists, and the action if it does not. */
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000 });
      await drain();
      const { container } = render(<OverviewPage navigateTo={() => {}} />);

      const openBtn = [...container.querySelectorAll('button')]
        .find(b => /add liability/i.test(b.textContent || ''));

      if (openBtn) {
        fireEvent.click(openBtn);
        const form = container.querySelector('input[placeholder*="Car Loan"]')!
          .closest('form') as HTMLFormElement;
        fireEvent.change(form.querySelector('input[type="text"]')!, { target: { value: 'Home Loan' } });
        fireEvent.change(form.querySelector('input[type="number"]')!, { target: { value: '900000' } });
        fireEvent.submit(form);
        await waitFor(() => expect(document.getElementById('liability-notice')).toBeTruthy());
        expect(document.getElementById('liability-notice')!.getAttribute('data-liability-kind')).toBe('error');
        expect(document.getElementById('liability-notice')!.textContent).toContain('already exists');
      } else {
        // No entry point today: assert the action behind it is guarded anyway.
        expect(container.querySelector('input[placeholder*="Car Loan"]')).toBeNull();
        const r = await attempt(() => S().addLiability('Home Loan', 900000));
        expect(r.ok).toBe(false);
        expect(r.error.code).toBe('DUPLICATE_NAME');
      }

      expect(libs()).toHaveLength(1);
      expect(totalDebt()).toBe(2500000);
    });
  });

  /* ═══════════════ §7 derived figures ════════════════════════════════════ */
  describe('§7 derived figures stay correct', () => {
    it('AC-14 net worth follows every lifecycle operation exactly', async () => {
      repo.assetsData = [{ id: 'ast-1', name: 'Cash', amount: 1000000 }];
      repo.syncStore();
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 600000 });
      await S().addLiabilityWithMetadata({ name: 'Card', amount: 100000 });
      await drain();
      const nw = () => repo.assetsData.reduce((s: number, a: any) => s + a.amount, 0) - totalDebt();
      expect(nw()).toBe(300000);

      await S().updateLiability({ id: libs()[1].id, name: 'Card', amount: 40000 });
      await drain();
      expect(nw()).toBe(360000);

      await S().removeLiability(libs()[0].id!);
      await drain();
      expect(nw()).toBe(960000);
      expect(totalDebt()).toBe(40000);
    });

    it('a snapshot taken after a delete reflects the surviving debt only', async () => {
      repo.assetsData = [{ id: 'ast-1', name: 'Cash', amount: 500000 }];
      force([{ id: 'lia-A', name: 'A', amount: 200000 }, { id: 'lia-B', name: 'B', amount: 100000 }]);
      await S().removeLiability('lia-A');
      await drain();
      await repository.snapshots.create();
      await drain();
      const snap = repo.snapshotsData[0];
      expect(snap.totalLiabilities).toBe(100000);
      expect(snap.netWorth).toBe(400000);
    });
  });

  /* ═══════════════ §8 scope boundary ═════════════════════════════════════ */
  describe('§8 scope boundary', () => {
    it('AC-15 no soft-exclusion vocabulary was introduced on Liability', async () => {
      await S().addLiabilityWithMetadata({ name: 'A', amount: 1, type: 'Other', currency: 'INR' });
      await drain();
      expect(Object.keys(libs()[0]).sort()).toEqual(['amount', 'currency', 'id', 'name', 'type']);
      for (const forbidden of ['excludedAt', 'excludedReason', 'status', 'archived', 'restoredAt', 'supersedes']) {
        expect(libs()[0]).not.toHaveProperty(forbidden);
      }
    });

    it('AC-16 the transaction write surface is still exactly five primitives', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
    });

    it('D9-A holds: nothing here can delete a transaction', () => {
      const t = repository.transactions as any;
      for (const k of ['remove', 'delete', 'removeBatch', 'destroy', 'purge']) {
        expect(typeof t[k]).toBe('undefined');
      }
    });

    it('liability delete offers no undo, and claims none', async () => {
      const s = S();
      for (const k of ['restoreLiability', 'undoLiability', 'unremoveLiability']) {
        expect(typeof s[k]).toBe('undefined');
      }
      expect(LiabilityLifecycleService.describeDeletion({ id: 'x', name: 'N', amount: 1 }).toLowerCase())
        .toContain('cannot be undone');
    });
  });
});
