/**
 * WP-FB-DATA-10 — startup initialization disclosure.
 *
 * SCOPE: exactly the four areas the 10 authorization names.
 *
 *   1. useCanonicalLedger startup timer — rejection handling
 *   2. store initialization state (loading / ready / failed)
 *   3. App-level #startup-notice
 *   4. retry affordance
 *
 * WHAT WAS MEASURED (10 discovery gate, real Chromium, live IndexedDB)
 *
 * With IndexedDB blocked before app boot, `initialize()` rejected, the
 * rejection escaped as an unhandled pageerror, and the user was shown an
 * ordinary empty FinBoom ledger:
 *
 *     C4a  startupNoticePresent : false      anyFailureWordOnPage : false
 *     C4b  pageErrors           : ["blocked ..."]
 *     C4e  verdict              : "NO — presented as an ordinary empty ledger"
 *
 * Data safety was already intact and is NOT changed here: the READFAIL latch
 * refused the subsequent write (C5) and a later successful initialize restored
 * the real ledger (C6). The recovery path worked; it was simply unreachable,
 * because nothing told the user anything had failed. This WP closes the
 * disclosure and reachability gap only.
 *
 * NOT FIXED HERE: the import cycle
 * store -> repositories -> MemoryRepository -> store. Handling the rejection
 * stops vitest reporting the resulting `undefined.initialize` TypeError, but
 * that is a reporting change; the test-lifecycle race is untouched and out of
 * scope (discovery gate §6, R8).
 *
 *   §1  initialization state contract
 *   §2  failure is caught and disclosed
 *   §3  retry
 *   §4  success path is unchanged and silent
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

import { App } from '../App';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger, runStartupInitialization } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Transaction } from '../domain/types';

const repo = repository as any;
const IDB = IndexedDBStorageService as any;
const S = () => useCanonicalLedger.getState() as any;
const drain = () => new Promise(r => setTimeout(r, 30));
const settle = (p: any) =>
  Promise.resolve(p).then(() => 'ok' as const).catch(() => 'rejected' as const);

const tx = (id: string, title = 'row'): Transaction =>
  ({
    id, date: '2026-08-01', amount: 100, narration: title, title,
    account: 'Cash', type: 'Income', category: 'Salary', status: 'CLEARED'
  } as unknown as Transaction);

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.holdingsData = [];
  repo.snapshotsData = []; repo.accountsData = []; repo.budgetsData = [];
  repo.policiesData = []; repo.goalsData = []; repo.profileData = null;
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], assets: [], liabilities: [], snapshots: [], accounts: [],
    budgets: [], policies: [], goals: [], profile: null,
    initStatus: 'ready', initError: null
  } as any);
}
async function persistAll() {
  await IndexedDBStorageService.saveAll({
    transactions: repo.transactionsData, assets: repo.assetsData, liabilities: repo.liabilitiesData,
    snapshots: repo.snapshotsData, accounts: repo.accountsData, budgets: repo.budgetsData,
    policies: repo.policiesData, goals: repo.goalsData, profile: repo.profileData
  });
}

describe('WP-FB-DATA-10 — startup initialization disclosure', () => {
  beforeEach(() => {
    reset();
    IDB.simulateFailureOnce = false;
    IDB.simulateReadFailureOnce = false;
    IDB.simulateQueueFailureOnce = false;
  });

  afterEach(async () => {
    await drain();
    vi.restoreAllMocks();
    cleanup();
    IDB.simulateFailureOnce = false;
    IDB.simulateReadFailureOnce = false;
    IDB.simulateQueueFailureOnce = false;
    /* HARNESS: a simulated read failure leaves the READFAIL latch set, and the
     * latch refuses every subsequent write — including this teardown's own
     * persistAll. Clear it with a genuine successful load FIRST, exactly as a
     * real recovery would, or teardown fails and the failure is misread as an
     * application defect. */
    await settle(IndexedDBStorageService.loadAll());
    reset();
    await persistAll();
    await drain();
  });

  /* ═══════════════ §1 initialization state contract ═══════════════ */
  describe('§1 the store exposes an observable initialization outcome', () => {
    it('a successful initialize transitions to ready with no error', async () => {
      useCanonicalLedger.setState({ initStatus: 'loading', initError: null } as any);
      await S().initialize();
      expect(S().initStatus).toBe('ready');
      expect(S().initError).toBeNull();
    });

    it('a FAILED initialize transitions to failed and records an actionable message', async () => {
      IDB.simulateReadFailureOnce = true;
      const outcome = await settle(S().initialize());
      expect(outcome).toBe('rejected');
      expect(S().initStatus).toBe('failed');
      expect(typeof S().initError).toBe('string');
      expect(S().initError).toMatch(/read failure/i);
    });

    it('still rethrows, so 06c-READFAIL propagation is unchanged', async () => {
      IDB.simulateReadFailureOnce = true;
      await expect(S().initialize()).rejects.toThrow(/read failure/i);
    });

    it('does not replace the data-safety authority — loadFailed remains the latch', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      expect(IndexedDBStorageService.loadFailed).toBe(true);
      // and the write refusal that protects stored data still fires
      await expect(S().addIncome('BLOCKED', 1, 'Cash', 'Salary'))
        .rejects.toThrow(/Refusing to persist/i);
    });

    it('a later successful initialize clears the failed state', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      expect(S().initStatus).toBe('failed');
      await S().initialize();
      expect(S().initStatus).toBe('ready');
      expect(S().initError).toBeNull();
    });

    it('initialize sets loading before it resolves', async () => {
      useCanonicalLedger.setState({ initStatus: 'ready' } as any);
      let seen: string | null = null;
      const spy = vi.spyOn(repo, 'initialize').mockImplementation(async () => {
        seen = S().initStatus;
      });
      await S().initialize();
      spy.mockRestore();
      expect(seen).toBe('loading');
    });
  });

  /* ═══════════════ §2 failure is caught and disclosed ═══════════════ */
  describe('§2 the failure is caught and shown to the user', () => {
    it('the startup handler SWALLOWS the rejection — it resolves, never rejects', async () => {
      IDB.simulateReadFailureOnce = true;
      // The shipped startup unit itself, not a re-implementation of its shape.
      await expect(runStartupInitialization()).resolves.toBeUndefined();
      expect(S().initStatus).toBe('failed');
    });

    it('the startup handler produces no unhandled rejection', async () => {
      const unhandled: any[] = [];
      const onUnhandled = (e: any) => { unhandled.push(e); e.preventDefault?.(); };
      window.addEventListener('unhandledrejection', onUnhandled);

      IDB.simulateReadFailureOnce = true;
      await act(async () => {
        void runStartupInitialization();
        await drain();
      });

      window.removeEventListener('unhandledrejection', onUnhandled);
      expect(unhandled).toHaveLength(0);
      expect(S().initStatus).toBe('failed');
    });

    it('the startup handler still reaches ready on the success path', async () => {
      await expect(runStartupInitialization()).resolves.toBeUndefined();
      expect(S().initStatus).toBe('ready');
    });

    it('renders #startup-notice when initialization has failed', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());
    });

    it('the notice carries the error classification attribute', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());
      expect(container.querySelector('#startup-notice')!.getAttribute('data-startup-kind')).toBe('error');
      expect(container.querySelector('#startup-notice')!.getAttribute('role')).toBe('alert');
    });

    it('distinguishes "could not be loaded" from "the ledger is empty"', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());
      const text = container.querySelector('#startup-notice')!.textContent!;
      expect(text).toMatch(/could not be loaded/i);
      expect(text).toMatch(/not an empty ledger/i);
      expect(text).toMatch(/nothing has been changed or deleted/i);
    });

    it('uses the headline + detail convention and never alert()', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());
      expect(container.querySelector('#startup-notice strong')).toBeTruthy();
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('surfaces the underlying failure message', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());
      expect(container.querySelector('#startup-notice')!.textContent).toMatch(/read failure/i);
    });
  });

  /* ═══════════════ §3 retry ═══════════════ */
  describe('§3 retry', () => {
    it('a retry control is present in the failure notice', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#btn-retry-startup')).toBeTruthy());
    });

    it('retry actually re-runs initialization', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#btn-retry-startup')).toBeTruthy());

      const spy = vi.spyOn(repo, 'initialize');
      fireEvent.click(container.querySelector('#btn-retry-startup')!);
      await waitFor(() => expect(spy).toHaveBeenCalled());
    });

    it('a successful retry restores the ledger and removes the notice', async () => {
      repo.transactionsData = [tx('t-real')];
      await persistAll();
      repo.transactionsData = [];
      repo.syncStore();

      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      expect(S().initStatus).toBe('failed');

      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());

      fireEvent.click(container.querySelector('#btn-retry-startup')!);

      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeNull());
      expect(S().initStatus).toBe('ready');
      expect(repo.transactionsData.map((t: any) => t.id)).toEqual(['t-real']);
    });

    it('a failing retry keeps the notice visible', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());

      IDB.simulateReadFailureOnce = true;
      fireEvent.click(container.querySelector('#btn-retry-startup')!);
      await drain();
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeTruthy());
      expect(S().initStatus).toBe('failed');
    });

    it('retry has an observable busy state and claims no success while pending', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#btn-retry-startup')).toBeTruthy());

      let release!: () => void;
      const gate = new Promise<void>(res => { release = res; });
      const real = repo.initialize.bind(repo);
      const spy = vi.spyOn(repo, 'initialize').mockImplementation(async () => {
        await gate;
        return real();
      });

      fireEvent.click(container.querySelector('#btn-retry-startup')!);

      await waitFor(() => expect(
        (container.querySelector('#btn-retry-startup') as HTMLButtonElement).disabled
      ).toBe(true));
      const btn = container.querySelector('#btn-retry-startup') as HTMLButtonElement;
      expect(btn.getAttribute('aria-busy')).toBe('true');
      // still failed, notice still up: no premature success
      expect(container.querySelector('#startup-notice')).toBeTruthy();
      expect(S().initStatus).toBe('loading');

      release();
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeNull());
      expect(S().initStatus).toBe('ready');
      spy.mockRestore();
    });

    it('does not introduce duplicate initialization — one click, one call', async () => {
      IDB.simulateReadFailureOnce = true;
      await settle(S().initialize());
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('#btn-retry-startup')).toBeTruthy());

      const spy = vi.spyOn(repo, 'initialize');
      fireEvent.click(container.querySelector('#btn-retry-startup')!);
      await waitFor(() => expect(container.querySelector('#startup-notice')).toBeNull());
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  /* ═══════════════ §4 the success path is unchanged and silent ═══════════════ */
  describe('§4 successful startup is silent', () => {
    it('no startup notice is rendered when initialization succeeded', async () => {
      await S().initialize();
      expect(S().initStatus).toBe('ready');
      const { container } = render(<App />);
      await drain();
      expect(container.querySelector('#startup-notice')).toBeNull();
      expect(container.querySelector('#btn-retry-startup')).toBeNull();
    });

    it('no startup notice while merely loading — a failure is not implied', async () => {
      useCanonicalLedger.setState({ initStatus: 'loading', initError: null } as any);
      const { container } = render(<App />);
      await drain();
      expect(container.querySelector('#startup-notice')).toBeNull();
    });

    it('a successful load still populates the ledger exactly as before', async () => {
      repo.transactionsData = [tx('t-1'), tx('t-2')];
      await persistAll();
      repo.transactionsData = [];
      repo.syncStore();

      await S().initialize();

      expect(S().initStatus).toBe('ready');
      expect(repo.transactionsData.map((t: any) => t.id).sort()).toEqual(['t-1', 't-2']);
    });

    it('writes work normally after a successful startup', async () => {
      await S().initialize();
      await expect(S().addIncome('NORMAL', 100, 'Cash', 'Salary')).resolves.toBeUndefined();
      expect(repo.transactionsData).toHaveLength(1);
    });
  });
});
