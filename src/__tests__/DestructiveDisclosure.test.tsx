/**
 * WP-FB-DATA-08A — destructive-deletion and import-commit disclosure.
 *
 * SCOPE: Tier 1 + Tier 2 of the WP-FB-DATA-08 discovery gate, and nothing else.
 *
 *   Tier 1  commitImportedRows — an affirmative FALSE CLAIM
 *   Tier 2  removeAccount, removePolicy, removeGoal — silent destruction
 *
 * WHAT WAS MEASURED (08 gate, real Chromium, live IndexedDB)
 *
 * With persistence failing, `commitImportedRows` returned `{ appended: 1 }`
 * while memory AND storage both held ZERO transactions, and ImportPage alerted
 * "Appended 1 new rows". The user was told an import landed that never did.
 * That is the worst shape in the fire-and-forget family: not silence, but a
 * confident lie.
 *
 * The three deletions were merely silent, which is bad enough for a destructive
 * action: the user confirmed, the write failed, the row stayed on screen, and
 * nothing was said — the rejection escaped as an unhandled page error.
 *
 * In all four cases memory reverted correctly and matched storage. The 07c
 * write boundary was never the problem; disclosure was.
 *
 * WHY `appended` STAYS SYNCHRONOUS
 *
 * The counts are an ADMISSION decision — which rows were accepted, which were
 * exact duplicates, which were refused — computed before anything is written,
 * and read synchronously by 20 existing assertions. `persisted` is the separate
 * question of whether the admitted rows reached storage. This is the
 * `LinkOutcome` pattern from 07c-R2, applied unchanged.
 *
 *   §1  the store contract
 *   §2  Tier 1 — the import commit no longer claims what it did not store
 *   §3  Tier 2 — destructive deletions report their outcome
 *   §4  no unhandled rejections
 *   §5  scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { ImportPage } from '../pages/ImportPage';
import { AccountsWorkspace } from '../components/money/AccountsWorkspace';
import { GoalsWorkspace } from '../components/essentials/GoalsWorkspace';
import { InsuranceWorkspace } from '../components/essentials/InsuranceWorkspace';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Transaction, Account, FinancialGoal, InsurancePolicy } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const drain = () => new Promise(r => setTimeout(r, 30));

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.snapshotsData = []; repo.accountsData = []; repo.budgetsData = [];
  repo.policiesData = []; repo.goalsData = []; repo.profileData = null;
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], assets: [], liabilities: [], snapshots: [], accounts: [],
    budgets: [], policies: [], goals: [], profile: null
  } as any);
}
async function persistAll() {
  await IndexedDBStorageService.saveAll({
    transactions: repo.transactionsData, assets: repo.assetsData, liabilities: repo.liabilitiesData,
    snapshots: repo.snapshotsData, accounts: repo.accountsData, budgets: repo.budgetsData,
    policies: repo.policiesData, goals: repo.goalsData, profile: repo.profileData
  });
}
const storedCount = async (k: 'transactions'|'accounts'|'goals'|'policies') =>
  ((await IndexedDBStorageService.loadAll()) as any)[k].length;

/** Holds `persist` open so the in-flight state can be observed. */
let pendingRelease: (() => void) | null = null;
function gatePersist() {
  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  const real = (IndexedDBStorageService as any).persist.bind(IndexedDBStorageService);
  const spy = vi.spyOn(IndexedDBStorageService, 'persist')
    .mockImplementation(async (lease: any, st: any) => { await gate; return real(lease, st); });
  pendingRelease = release;
  return { release, spy };
}
async function drainWriteQueue() {
  pendingRelease?.(); pendingRelease = null;
  await IndexedDBStorageService.runExclusive(async () => {}).catch(() => {});
}

const acct = (id: string, name: string): Account =>
  ({ id, name, type: 'Bank', openingBalance: 1000, asOfDate: '2026-08-01' } as Account);
const goal = (id: string, name: string): FinancialGoal =>
  ({ id, name, template: 'Emergency Buffer', targetAmount: 100000, currentSavedAmount: 0,
     targetDate: '2027-01-01', status: 'In Progress' } as FinancialGoal);
const policy = (id: string, provider: string): InsurancePolicy =>
  ({ id, provider, type: 'Term Life', coverAmount: 1000000, premiumAmount: 12000,
     renewalDate: '2027-01-01', status: 'Active' } as InsurancePolicy);
const importRow = (id: string, accountName: string, accountId: string): Transaction =>
  ({ id, date: '2026-08-10', dateStr: '10 Aug 2026', title: id, narration: id.toUpperCase(),
     account: accountName, accountId, direction: 'CREDIT', type: 'Income', category: 'Income',
     amount: 100, status: 'CLEARED', origin: 'IMPORT', importBatchId: 'b1' } as Transaction);

describe('WP-FB-DATA-08A — destructive deletion and import commit disclosure', () => {
  beforeEach(reset);
  afterEach(async () => {
    cleanup();
    await drainWriteQueue();
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    await IndexedDBStorageService.loadAll().catch(() => {});
    reset();
  });

  /* ═══════════════ §1 the store contract ═════════════════════════════════ */
  describe('§1 the store contract', () => {
    it('AC-1 the three destructive actions return a promise', () => {
      const s = S();
      for (const k of ['removeAccount', 'removePolicy', 'removeGoal']) {
        const returned = (() => { try { return s[k]('nope'); } catch { return undefined; } })();
        expect(typeof returned?.then).toBe('function');
        returned?.catch(() => {});
      }
    });

    it('AC-1 commitImportedRows exposes `persisted` when it writes', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      const outcome = S().commitImportedRows([importRow('imp-1', 'HDFC', 'acc-1')]);
      expect(typeof outcome.persisted?.then).toBe('function');
      await outcome.persisted;
      expect(repo.transactionsData).toHaveLength(1);
    });

    it('AC-7 the admission counts stay SYNCHRONOUS and unchanged', () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      const outcome = S().commitImportedRows([importRow('imp-1', 'HDFC', 'acc-1')]);
      // read without awaiting anything, exactly as 20 existing assertions do
      expect(outcome.appended).toBe(1);
      expect(outcome.duplicates).toBe(0);
      expect(outcome.rejectedTransferRows).toBe(0);
      expect(outcome.rejectedDuplicateIdRows).toBe(0);
      expect(Array.isArray(outcome.rejectedTransferReasons)).toBe(true);
      outcome.persisted?.catch(() => {});
    });

    it('a commit that writes nothing promises nothing', () => {
      const outcome = S().commitImportedRows([]);
      expect(outcome.appended).toBe(0);
      expect(outcome.persisted).toBeUndefined();
    });
  });

  /* ═══════════════ §2 Tier 1 — the false claim ═══════════════════════════ */
  describe('§2 the import commit reports only what was stored', () => {
    it('AC-5 a failed commit rejects, and memory and storage stay empty', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      await persistAll();

      IndexedDBStorageService.simulateFailureOnce = true;
      const outcome = S().commitImportedRows([importRow('imp-1', 'HDFC', 'acc-1')]);
      await expect(outcome.persisted).rejects.toThrow(/Simulated IndexedDB persistence failure/);
      await drain();

      expect(repo.transactionsData).toHaveLength(0);
      expect(await storedCount('transactions')).toBe(0);
    });

    /**
     * These drive the REAL commit button. "Simulate Upload" runs the built-in
     * sample CSV through the pipeline and puts the page into review state
     * synchronously, which is the only way to exercise handleCommit — its
     * await, its catch and its message are otherwise uncovered. (Three
     * mutations escaped on exactly that gap before these existed.)
     */
    const openReview = async () => {
      render(<ImportPage />);
      fireEvent.click([...document.querySelectorAll('button')]
        .find(b => /Simulate Upload/i.test(b.textContent || ''))!);
      await waitFor(() => expect(document.getElementById('btn-commit-import')).toBeTruthy());
    };
    const commitNotice = () => document.getElementById('commit-notice');

    it('AC-5 a FAILED commit says so and never claims rows were appended', async () => {
      await openReview();
      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.click(document.getElementById('btn-commit-import')!);

      await waitFor(() => expect(commitNotice()).toBeTruthy());
      expect(commitNotice()!.getAttribute('data-commit-kind')).toBe('error');
      expect(commitNotice()!.querySelector('strong')!.textContent).toBe('Import not committed.');
      // the real message, and NO success claim anywhere on the page
      expect(commitNotice()!.textContent).toContain('Simulated IndexedDB persistence failure');
      expect(commitNotice()!.textContent).not.toContain('undefined');
      expect(document.body.textContent).not.toMatch(/Appended \d+ new rows/);
      // nothing stored, and the review surface is still there to retry
      expect(repo.transactionsData).toHaveLength(0);
      expect(await storedCount('transactions')).toBe(0);
      expect(document.getElementById('btn-commit-import')).toBeTruthy();
    });

    it('AC-5 a SUCCESSFUL commit through the button reports and clears review', async () => {
      await openReview();
      fireEvent.click(document.getElementById('btn-commit-import')!);

      await waitFor(() => expect(commitNotice()).toBeTruthy());
      expect(commitNotice()!.getAttribute('data-commit-kind')).toBe('success');
      expect(commitNotice()!.querySelector('strong')!.textContent).toBe('Import committed.');
      expect(commitNotice()!.textContent).toMatch(/Appended \d+ new rows/);
      expect(repo.transactionsData.length).toBeGreaterThan(0);
      expect(await storedCount('transactions')).toBe(repo.transactionsData.length);
      expect(document.getElementById('btn-commit-import')).toBeNull();   // review cleared
    });

    it('AC-6 the commit button is disabled in flight and claims nothing yet', async () => {
      await openReview();
      const { release } = gatePersist();
      fireEvent.click(document.getElementById('btn-commit-import')!);

      await waitFor(() =>
        expect(document.getElementById('btn-commit-import')!.matches(':disabled')).toBe(true));
      expect(document.getElementById('btn-commit-import')!.textContent).toContain('Committing');
      expect(commitNotice()).toBeNull();

      release();
      await waitFor(() => expect(commitNotice()!.getAttribute('data-commit-kind')).toBe('success'));
    });

    it('AC-5 a SUCCESSFUL commit still reports its counts verbatim', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      await persistAll();
      const outcome = S().commitImportedRows([importRow('imp-1', 'HDFC', 'acc-1')]);
      await outcome.persisted;
      await drain();
      expect(outcome.appended).toBe(1);
      expect(repo.transactionsData).toHaveLength(1);
      expect(await storedCount('transactions')).toBe(1);
    });

    it('AC-7 refusals are still computed and reported (semantics preserved)', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      const transferRow = {
        ...importRow('imp-t', 'HDFC', 'acc-1'), type: 'Transfer', transferId: undefined
      } as Transaction;
      const outcome = S().commitImportedRows([transferRow]);
      expect(outcome.rejectedTransferRows).toBe(1);
      expect(outcome.rejectedTransferReasons[0]).toContain('transferId');
      outcome.persisted?.catch(() => {});
    });
  });

  /* ═══════════════ §3 Tier 2 — destructive deletions ═════════════════════ */
  const surfaces = [
    {
      label: 'account',
      seed: () => { repo.accountsData = [acct('acc-1', 'HDFC'), acct('acc-2', 'ICICI')]; },
      render: () => {
        const View: React.FC = () => {
          const accounts = useCanonicalLedger(s => s.accounts);
          return <AccountsWorkspace accounts={accounts} />;
        };
        return render(<View />);
      },
      btn: (id: string) => document.querySelector(`[data-account-delete="${id}"]`) as HTMLButtonElement,
      busyAttr: 'data-account-delete-busy',
      notice: () => document.getElementById('account-notice'),
      kindAttr: 'data-account-kind',
      collection: () => repo.accountsData,
      stored: () => storedCount('accounts'),
      firstId: 'acc-1', secondId: 'acc-2',
      successHeadline: 'Account removed.'
    },
    {
      label: 'goal',
      seed: () => { repo.goalsData = [goal('goal-1', 'Emergency'), goal('goal-2', 'Car')]; },
      render: () => {
        const View: React.FC = () => {
          const goals = useCanonicalLedger(s => s.goals);
          return <GoalsWorkspace goals={goals} />;
        };
        return render(<View />);
      },
      btn: (id: string) => document.querySelector(`[data-goal-delete="${id}"]`) as HTMLButtonElement,
      busyAttr: 'data-goal-delete-busy',
      notice: () => document.getElementById('goal-notice'),
      kindAttr: 'data-goal-kind',
      collection: () => repo.goalsData,
      stored: () => storedCount('goals'),
      firstId: 'goal-1', secondId: 'goal-2',
      successHeadline: 'Goal removed.'
    },
    {
      label: 'policy',
      seed: () => { repo.policiesData = [policy('pol-1', 'LIC'), policy('pol-2', 'HDFC Ergo')]; },
      render: () => {
        const View: React.FC = () => {
          const policies = useCanonicalLedger(s => s.policies);
          return <InsuranceWorkspace policies={policies} />;
        };
        return render(<View />);
      },
      btn: (id: string) => document.querySelector(`[data-policy-delete="${id}"]`) as HTMLButtonElement,
      busyAttr: 'data-policy-delete-busy',
      notice: () => document.getElementById('policy-notice'),
      kindAttr: 'data-policy-kind',
      collection: () => repo.policiesData,
      stored: () => storedCount('policies'),
      firstId: 'pol-1', secondId: 'pol-2',
      successHeadline: 'Policy removed.'
    }
  ];

  for (const s of surfaces) {
    describe(`§3 ${s.label} deletion`, () => {
      const setup = async () => { reset(); s.seed(); repo.syncStore();
        useCanonicalLedger.setState({
          accounts: repo.accountsData, goals: repo.goalsData, policies: repo.policiesData
        } as any);
        await persistAll(); };

      it(`AC-2 a failed ${s.label} removal is DISCLOSED and the row survives`, async () => {
        await setup();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        IndexedDBStorageService.simulateFailureOnce = true;
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await waitFor(() => expect(s.notice()).toBeTruthy());

        expect(s.notice()!.getAttribute(s.kindAttr)).toBe('error');
        expect(s.notice()!.querySelector('strong')!.textContent).toBe('Removal refused.');
        expect(s.notice()!.textContent).toContain('Simulated IndexedDB persistence failure');
        expect(s.notice()!.textContent).not.toContain('undefined');
        // memory and storage both intact
        expect(s.collection()).toHaveLength(2);
        expect(await s.stored()).toBe(2);
      });

      it(`AC-3 a successful ${s.label} removal reports success and persists`, async () => {
        await setup();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await waitFor(() => expect(s.collection()).toHaveLength(1));
        await waitFor(() => expect(s.notice()).toBeTruthy());

        expect(s.notice()!.getAttribute(s.kindAttr)).toBe('success');
        expect(s.notice()!.querySelector('strong')!.textContent).toBe(s.successHeadline);
        expect(await s.stored()).toBe(1);
      });

      it(`AC-7 declining the ${s.label} confirmation still writes nothing`, async () => {
        await setup();
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        const spy = vi.spyOn(IndexedDBStorageService, 'persist');
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await drain();
        expect(spy).not.toHaveBeenCalled();
        expect(s.collection()).toHaveLength(2);
        expect(s.notice()).toBeNull();
      });

      it(`AC-6 the ${s.label} control is disabled in flight and re-enabled after`, async () => {
        await setup();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { release } = gatePersist();
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await waitFor(() => expect(s.btn(s.firstId).getAttribute(s.busyAttr)).toBe('true'));
        expect(s.btn(s.firstId).matches(':disabled')).toBe(true);
        // only the pending row
        expect(s.btn(s.secondId).matches(':disabled')).toBe(false);
        expect(s.notice()).toBeNull();      // nothing claimed yet

        release();
        await waitFor(() => expect(s.collection()).toHaveLength(1));
        await waitFor(() => expect(s.btn(s.secondId).matches(':disabled')).toBe(false));
      });

      it(`AC-3 the pending ${s.label} row STAYS VISIBLE until storage agrees`, async () => {
        /* Writes are optimistic, so memory drops the row immediately. The list
           must not report a removal storage has not confirmed - the same defect
           self-caught in 07a and 07b. */
        await setup();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { release } = gatePersist();
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await waitFor(() => expect(s.btn(s.firstId)).toBeTruthy());
        // still rendered…
        expect(s.btn(s.firstId).getAttribute(s.busyAttr)).toBe('true');
        // …while memory has already dropped it
        expect(s.collection()).toHaveLength(1);
        expect(s.notice()).toBeNull();

        release();
        await waitFor(() => expect(s.btn(s.firstId)).toBeNull());
      });

      it(`AC-6 the ${s.label} control re-enables after a FAILURE`, async () => {
        await setup();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        IndexedDBStorageService.simulateFailureOnce = true;
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await waitFor(() => expect(s.notice()!.getAttribute(s.kindAttr)).toBe('error'));
        await waitFor(() => expect(s.btn(s.firstId).matches(':disabled')).toBe(false));
        expect(s.btn(s.firstId).getAttribute(s.busyAttr)).toBe('false');
      });

      it(`a second ${s.label} removal is refused, out loud, while one is in flight`, async () => {
        await setup();
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { release } = gatePersist();
        s.render();

        fireEvent.click(s.btn(s.firstId));
        await waitFor(() => expect(s.btn(s.firstId).matches(':disabled')).toBe(true));
        fireEvent.click(s.btn(s.secondId));

        await waitFor(() => expect(s.notice()).toBeTruthy());
        expect(s.notice()!.querySelector('strong')!.textContent).toBe('One removal at a time.');
        expect(confirmSpy).toHaveBeenCalledTimes(1);

        release();
        await waitFor(() => expect(s.collection()).toHaveLength(1));
      });
    });
  }

  /* ═══════════════ §4 no unhandled rejections ════════════════════════════ */
  describe('§4 rejections are observable, never unhandled', () => {
    it('AC-4 an ignored destructive rejection produces no unhandled rejection', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      await persistAll();
      const unhandled: string[] = [];
      const handler = (e: any) => unhandled.push(String(e?.reason ?? e));
      process.on('unhandledRejection', handler);

      IndexedDBStorageService.simulateFailureOnce = true;
      S().removeAccount('acc-1').catch(() => {});   // a caller that observes
      await drain(); await drain();
      process.off('unhandledRejection', handler);
      expect(unhandled).toEqual([]);
    });

    it('AC-4 an ignored commit rejection produces no unhandled rejection', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      await persistAll();
      const unhandled: string[] = [];
      const handler = (e: any) => unhandled.push(String(e?.reason ?? e));
      process.on('unhandledRejection', handler);

      IndexedDBStorageService.simulateFailureOnce = true;
      S().commitImportedRows([importRow('imp-1', 'HDFC', 'acc-1')]);   // promise ignored
      await drain(); await drain();
      process.off('unhandledRejection', handler);
      expect(unhandled).toEqual([]);
    });
  });

  /* ═══════════════ §5 scope boundary ═════════════════════════════════════ */
  describe('§5 scope boundary — Tier 1 + Tier 2 only', () => {
    it('Tier 3 and 4 actions are deliberately UNCHANGED by this package', () => {
      const s = S();
      // still void-returning: out of scope for 08A, carried to 08B
      for (const k of ['addAccount', 'addIncome', 'addExpense', 'saveMonthlyBudget',
                       'addPolicy', 'addGoal', 'saveProfile', 'captureSnapshot', 'addPastSnapshot']) {
        const returned = (() => { try { return s[k](...[undefined, undefined, undefined, undefined] as any); } catch { return undefined; } })();
        expect(typeof (returned as any)?.then).not.toBe('function');
      }
    });

    it('the transaction write surface is unchanged — D9-A holds', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
      for (const forbidden of ['remove', 'delete', 'removeBatch', 'purge']) {
        expect(typeof t[forbidden]).toBe('undefined');
      }
    });

    it('no new store action was introduced', () => {
      const s = S();
      for (const k of ['undoRemoveAccount', 'restoreAccount', 'restoreGoal', 'restorePolicy',
                       'archiveAccount', 'softDeleteGoal']) {
        expect(typeof s[k]).toBe('undefined');
      }
    });

    it('the ImportPage no longer reports through alert()', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      await persistAll();
      const outcome = S().commitImportedRows([importRow('imp-1', 'HDFC', 'acc-1')]);
      await outcome.persisted;
      await drain();
      expect(alertSpy).not.toHaveBeenCalled();
    });
  });
});
