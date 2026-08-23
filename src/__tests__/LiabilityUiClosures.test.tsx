/**
 * WP-FB-DATA-07c — liability UI closures.
 *
 *   F-07a-1  the Overview liability quick-add trigger, lost in WP-21 Phase 21C
 *   F-07b-2  a per-row busy state on delete
 *   notice   the headline + detail convention the rest of the app already uses
 *
 * WHY F-07a-1 MATTERS AND WHY IT IS TESTED THROUGH BEHAVIOUR
 *
 * The v2.11.2 baseline rendered "Asset" and "Liability" quick-add buttons side
 * by side. WP-21's visual modernization kept the asset trigger (twice) and
 * dropped the liability one, so `showLiabForm` could never become true. The
 * form, its submit handler, its duplicate-name guard and its error notice were
 * all present and all unreachable — the same defect family as the six inert
 * dashboard anchors, where a control rendered and did nothing. So these tests
 * click the control and assert what the LEDGER does, never that a button
 * exists.
 *
 * WHY F-07b-2 MATTERS
 *
 * Delete left every control live while its write was pending. Two clicks
 * produced two overlapping writes, which is precisely the trigger for the
 * rollback race closed in this package. The busy state removes the trigger;
 * `PersistenceRollbackIntegrity.test.ts` closes the underlying defect.
 *
 *   §1  the Overview trigger
 *   §2  the delete busy state
 *   §3  the notice convention
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { OverviewPage } from '../pages/OverviewPage';
import { LiabilitiesWorkspace } from '../components/wealth/LiabilitiesWorkspace';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Liability } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const libs = (): Liability[] => repo.liabilitiesData;
const debt = () => libs().reduce((s, l) => s + l.amount, 0);
const drain = () => new Promise(r => setTimeout(r, 30));

function reset() {
  repo.liabilitiesData = []; repo.assetsData = []; repo.snapshotsData = [];
  repo.accountsData = []; repo.transactionsData = []; repo.syncStore();
  useCanonicalLedger.setState({
    liabilities: [], assets: [], snapshots: [], accounts: [], transactions: []
  } as any);
}
function force(rows: Liability[]) {
  repo.liabilitiesData = rows;
  repo.syncStore();
  useCanonicalLedger.setState({ liabilities: rows } as any);
}
function setValue(el: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Live view of the workspace so writes are reflected without manual re-render. */
const Workspace: React.FC = () => {
  const liabilities = useCanonicalLedger(s => s.liabilities);
  return <LiabilitiesWorkspace liabilities={liabilities} />;
};

const delBtn = (id: string) => document.querySelector(`[data-liability-delete="${id}"]`) as HTMLButtonElement;
const editBtn = (id: string) => document.querySelector(`[data-liability-edit="${id}"]`) as HTMLButtonElement;
const notice = () => document.getElementById('liability-notice');

/**
 * A pending write holds the write lock, and a write that is still in flight
 * when a test ends will finish DURING the next test and clobber its state.
 * Every gate registers itself here so the teardown can release it and wait for
 * the queue to drain before anything is reset. (Caught while writing these
 * tests: three §2 cases failed because the previous case's hung write landed
 * mid-test.)
 */
let pendingRelease: (() => void) | null = null;
async function drainWriteQueue() {
  pendingRelease?.();
  pendingRelease = null;
  await IndexedDBStorageService.runExclusive(async () => {}).catch(() => {});
}

describe('WP-FB-DATA-07c — liability UI closures', () => {
  beforeEach(reset);
  afterEach(async () => {
    cleanup();
    await drainWriteQueue();
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    await IndexedDBStorageService.loadAll().catch(() => {});
    reset();
  });

  /* ═══════════════ §1 F-07a-1 — the Overview trigger ═════════════════════ */
  describe('§1 the Overview liability quick-add is reachable again', () => {
    const renderOverview = () => render(<OverviewPage navigateTo={() => {}} />);

    it('F-07a-1 the trigger exists, alongside the asset one it was paired with', () => {
      renderOverview();
      expect(document.getElementById('overview-add-liability')).toBeTruthy();
      expect(document.getElementById('overview-add-asset')).toBeTruthy();
    });

    it('F-07a-1 clicking it opens the EXISTING quick-add form', async () => {
      renderOverview();
      expect(document.getElementById('overview-liability-form')).toBeNull();
      fireEvent.click(document.getElementById('overview-add-liability')!);
      await waitFor(() => expect(document.getElementById('overview-liability-form')).toBeTruthy());
      // it is the pre-existing form, not a second one
      expect(document.querySelectorAll('#overview-liability-form').length).toBe(1);
    });

    it('F-07a-1 the trigger reaches the authoritative create path', async () => {
      const spy = vi.spyOn(repository.liabilities, 'add');
      renderOverview();
      fireEvent.click(document.getElementById('overview-add-liability')!);
      const form = document.getElementById('overview-liability-form') as HTMLFormElement;
      setValue(form.querySelector('input[type="text"]')!, 'Car Loan');
      setValue(form.querySelector('input[type="number"]')!, '350000');
      fireEvent.submit(form);

      await waitFor(() => expect(libs()).toHaveLength(1));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(libs()[0].name).toBe('Car Loan');
      expect(libs()[0].amount).toBe(350000);
      // identity generation is unchanged
      expect(String(libs()[0].id).startsWith('lia-')).toBe(true);
    });

    it('F-07a-1 the duplicate-name policy still applies through this path', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 2500000, type: 'Home Loan' });
      await drain();
      renderOverview();
      fireEvent.click(document.getElementById('overview-add-liability')!);
      const form = document.getElementById('overview-liability-form') as HTMLFormElement;
      setValue(form.querySelector('input[type="text"]')!, '  home loan ');
      setValue(form.querySelector('input[type="number"]')!, '900000');
      fireEvent.submit(form);

      await waitFor(() => expect(document.getElementById('liability-notice')).toBeTruthy());
      const el = document.getElementById('liability-notice')!;
      expect(el.getAttribute('data-liability-kind')).toBe('error');
      expect(el.textContent).toContain('already exists');
      expect(el.textContent).not.toContain('undefined');
      // nothing moved
      expect(libs()).toHaveLength(1);
      expect(debt()).toBe(2500000);
    });

    it('F-07a-1 a persistence failure on this path is surfaced, not swallowed', async () => {
      renderOverview();
      fireEvent.click(document.getElementById('overview-add-liability')!);
      IndexedDBStorageService.simulateFailureOnce = true;
      const form = document.getElementById('overview-liability-form') as HTMLFormElement;
      setValue(form.querySelector('input[type="text"]')!, 'Gold Loan');
      setValue(form.querySelector('input[type="number"]')!, '50000');
      fireEvent.submit(form);

      await waitFor(() => expect(document.getElementById('liability-notice')).toBeTruthy());
      expect(document.getElementById('liability-notice')!.getAttribute('data-liability-kind')).toBe('error');
      expect(libs()).toHaveLength(0);
    });

    it('F-07a-1 no SECOND create path was introduced', () => {
      renderOverview();
      // exactly one liability quick-add trigger and one form on the page
      expect(document.querySelectorAll('#overview-add-liability').length).toBe(1);
      fireEvent.click(document.getElementById('overview-add-liability')!);
      expect(document.querySelectorAll('form#overview-liability-form').length).toBe(1);
      // and the store surface is still exactly the authorised one
      expect(Object.keys(S()).filter(k => /iabilit/i.test(k)).sort())
        .toEqual(['addLiability', 'addLiabilityWithMetadata', 'liabilities', 'removeLiability', 'updateLiability']);
    });
  });

  /* ═══════════════ §2 F-07b-2 — the delete busy state ════════════════════ */
  describe('§2 delete is disabled while its write is in flight', () => {
    /** Holds `persist` open so the pending state can be observed. */
    function hangPersist() {
      let release!: () => void;
      let fail!: (e: Error) => void;
      const gate = new Promise<void>((res, rej) => {
        release = () => res();
        fail = (e) => rej(e);
      });
      const spy = vi.spyOn(IndexedDBStorageService, 'persist')
        .mockImplementation(async () => { await gate; });
      pendingRelease = release;
      return { release, fail, spy };
    }

    it('F-07b-2 the row STAYS VISIBLE while its delete is pending', async () => {
      // Writes are optimistic, so memory drops the row immediately. The table
      // must not report a deletion storage has not confirmed.
      force([{ id: 'lia-A', name: 'A', amount: 100 }, { id: 'lia-B', name: 'B', amount: 200 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { release } = hangPersist();
      render(<Workspace />);

      fireEvent.click(delBtn('lia-A'));
      await waitFor(() => expect(delBtn('lia-A')).toBeTruthy());
      // still rendered, still in its original position
      expect([...document.querySelectorAll('[data-liability-id]')]
        .map(e => e.getAttribute('data-liability-id'))).toEqual(['lia-A', 'lia-B']);
      // but memory has already dropped it — the row on screen is the pending one
      expect(libs().map(l => l.id)).toEqual(['lia-B']);
      // and no success has been claimed yet
      expect(notice()).toBeNull();

      release();
      await waitFor(() => expect(document.querySelector('[data-liability-id="lia-A"]')).toBeNull());
    });

    it('F-07b-2 the control disables during the pending promise and says so', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }, { id: 'lia-B', name: 'B', amount: 200 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { release } = hangPersist();
      render(<Workspace />);

      expect(delBtn('lia-A').matches(':disabled')).toBe(false);
      fireEvent.click(delBtn('lia-A'));

      await waitFor(() => expect(delBtn('lia-A').matches(':disabled')).toBe(true));
      expect(delBtn('lia-A').getAttribute('data-liability-delete-busy')).toBe('true');
      expect(delBtn('lia-A').textContent).toContain('Deleting');
      expect(editBtn('lia-A').matches(':disabled')).toBe(true);
      // ONLY the row being deleted is disabled; the other row is left usable
      expect(delBtn('lia-B').matches(':disabled')).toBe(false);
      expect(delBtn('lia-B').getAttribute('data-liability-delete-busy')).toBe('false');

      release();
      await waitFor(() => expect(libs()).toHaveLength(1));
    });

    it('F-07b-2 the control re-enables after SUCCESS', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }, { id: 'lia-B', name: 'B', amount: 200 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { release } = hangPersist();
      render(<Workspace />);

      fireEvent.click(delBtn('lia-A'));
      await waitFor(() => expect(delBtn('lia-A').matches(':disabled')).toBe(true));
      release();

      await waitFor(() => expect(libs().map(l => l.id)).toEqual(['lia-B']));
      await waitFor(() => expect(delBtn('lia-B').matches(':disabled')).toBe(false));
      expect(editBtn('lia-B').matches(':disabled')).toBe(false);
      expect(document.querySelector('[data-liability-delete-busy="true"]')).toBeNull();
    });

    it('F-07b-2 the control re-enables after FAILURE, and the row survives', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }, { id: 'lia-B', name: 'B', amount: 200 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { fail } = hangPersist();
      render(<Workspace />);

      fireEvent.click(delBtn('lia-A'));
      await waitFor(() => expect(delBtn('lia-A').matches(':disabled')).toBe(true));
      fail(new Error('Simulated IndexedDB persistence failure'));

      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.getAttribute('data-liability-kind')).toBe('error');
      // a control left stuck disabled after a refusal would be its own defect
      await waitFor(() => expect(delBtn('lia-A').matches(':disabled')).toBe(false));
      expect(delBtn('lia-A').textContent).toContain('Delete');
      expect(delBtn('lia-A').textContent).not.toContain('Deleting');
      expect(libs()).toHaveLength(2);
      expect(debt()).toBe(300);
    });

    it('F-07b-2 a second delete is REFUSED, out loud, while one is in flight', async () => {
      /* The pending row's control is disabled, so the only way to start a
         second destructive write is from ANOTHER row — which stays live. The
         handler refuses it and says why. This is the guard that removes the
         reachable trigger for the rollback race; a mutation deleting it must
         fail here. */
      force([{ id: 'lia-A', name: 'A', amount: 100 }, { id: 'lia-B', name: 'B', amount: 200 }]);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { release } = hangPersist();
      render(<Workspace />);

      fireEvent.click(delBtn('lia-A'));
      await waitFor(() => expect(delBtn('lia-A').matches(':disabled')).toBe(true));

      // another row's Delete is live — click it
      expect(delBtn('lia-B').matches(':disabled')).toBe(false);
      fireEvent.click(delBtn('lia-B'));

      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.getAttribute('data-liability-kind')).toBe('error');
      expect(notice()!.querySelector('strong')!.textContent).toBe('One delete at a time.');
      // it never even asked for confirmation, and started no second write
      expect(confirmSpy).toHaveBeenCalledTimes(1);

      release();
      await waitFor(() => expect(libs().map(l => l.id)).toEqual(['lia-B']));
      expect(debt()).toBe(200);
    });

    it('declining the confirmation leaves nothing busy', async () => {
      force([{ id: 'lia-A', name: 'A', amount: 100 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<Workspace />);
      fireEvent.click(delBtn('lia-A'));
      await drain();
      expect(delBtn('lia-A').matches(':disabled')).toBe(false);
      expect(libs()).toHaveLength(1);
    });
  });

  /* ═══════════════ §3 the notice convention ══════════════════════════════ */
  describe('§3 notices read like the rest of the application', () => {
    it('a successful delete renders a headline AND the detail', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<Workspace />);
      fireEvent.click(delBtn('lia-A'));

      await waitFor(() => expect(notice()).toBeTruthy());
      const el = notice()!;
      expect(el.getAttribute('data-liability-kind')).toBe('success');
      expect(el.querySelector('strong')!.textContent).toBe('Liability deleted.');
      expect(el.textContent).toContain('Home Loan');
    });

    it('a refused delete renders the refusal headline and the real message', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      IndexedDBStorageService.simulateFailureOnce = true;
      render(<Workspace />);
      fireEvent.click(delBtn('lia-A'));

      await waitFor(() => expect(notice()).toBeTruthy());
      const el = notice()!;
      expect(el.getAttribute('data-liability-kind')).toBe('error');
      expect(el.querySelector('strong')!.textContent).toBe('Delete refused.');
      // the real message, never a code and never "undefined"
      expect(el.textContent).toContain('Simulated IndexedDB persistence failure');
      expect(el.textContent).not.toContain('undefined');
    });

    it('an edit reports under its own headline', async () => {
      force([{ id: 'lia-A', name: 'Home Loan', amount: 2500000, type: 'Home Loan', currency: 'INR' }]);
      render(<Workspace />);
      fireEvent.click(editBtn('lia-A'));
      await waitFor(() => expect(document.getElementById('edit-liability-modal')).toBeTruthy());
      setValue(document.getElementById('edit-liability-amount')!, '2400000');
      fireEvent.submit(document.getElementById('edit-liability-submit')!.closest('form')!);

      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.querySelector('strong')!.textContent).toBe('Liability saved.');
      expect(libs()[0].amount).toBe(2400000);
    });
  });
});
