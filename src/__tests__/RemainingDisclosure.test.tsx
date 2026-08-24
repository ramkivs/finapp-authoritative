/**
 * WP-FB-DATA-08B — the remaining persistence-failure disclosure surface.
 *
 * SCOPE: exactly the eleven paths the 08B discovery gate measured.
 *
 *   nine store actions  addAccount, addIncome, addExpense, addPastSnapshot,
 *                       captureSnapshot, saveMonthlyBudget, addPolicy,
 *                       addGoal, saveProfile
 *   two direct paths    BudgetWorkspace autoSuggestBudget / copyBudgetFromPreviousMonth
 *
 * WHAT WAS MEASURED (08B gate, real Chromium, live IndexedDB)
 *
 * Every one of the eleven discarded its persistence promise: memory reverted
 * correctly, `mem == storage` held, and the failure produced exactly ONE
 * unhandled page error while the user was told nothing.
 *
 * One additionally made an affirmative FALSE CLAIM: with persistence failing,
 * `copyBudgetFromPreviousMonth` returned a truthy budget, firing the toast
 * "Copied budget allocations from previous month (Total: ₹900)" for a month
 * that was never stored.
 *
 * Three modals carried a `try/catch` that was proven, at the boundary, to see
 * synchronous validation ("Account name is required.") and to be structurally
 * BLIND to persistence. That validation behaviour is preserved here and
 * asserted, because breaking it would be a regression, not a fix.
 *
 * WHY PLAIN PROMISES AND NOT THE 08A SPLIT
 *
 * 08A needed an admission/`persisted` split because 20 assertions read
 * `appended` inline. Discovery measured ZERO callers consuming a return value
 * from these eleven, so ordinary promise propagation is the whole fix.
 *
 *   §1  the contracts
 *   §2  synchronous validation still works (and is not the fix)
 *   §3  every path discloses its persistence failure
 *   §4  the modals stay open, show the real message, and retry
 *   §5  the budget false claim
 *   §6  snapshot secondary callers on OverviewPage
 *   §7  busy state
 *   §8  no unhandled rejections · scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { AddAccountModal } from '../components/money/AddAccountModal';
import { AddPastEntryModal } from '../components/wealth/AddPastEntryModal';
import { TakeSnapshotModal } from '../components/wealth/TakeSnapshotModal';
import { EditBudgetModal } from '../components/money/EditBudgetModal';
import { IncomeModal, ExpenseModal } from '../components/Modals';
import { AddPolicyModal } from '../components/essentials/AddPolicyModal';
import { AddGoalModal } from '../components/essentials/AddGoalModal';
import { BudgetWorkspace } from '../components/money/BudgetWorkspace';
import { OverviewPage } from '../pages/OverviewPage';
import { FinancialProfileWorkspace } from '../components/essentials/FinancialProfileWorkspace';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { FinancialCommands } from '../application/commands';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Account } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const drain = () => new Promise(r => setTimeout(r, 30));
const settle = (p: any) => Promise.resolve(p).then(() => 'ok' as const).catch(() => 'rejected' as const);

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.holdingsData = [];
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
const stored = async (k: string) => {
  const st = (await IndexedDBStorageService.loadAll()) as any;
  const v = st[k];
  return Array.isArray(v) ? v.length : (v ? 1 : 0);
};
const inMemory = (k: string) => {
  const v = repo[k];
  return Array.isArray(v) ? v.length : (v ? 1 : 0);
};
const acct = (id: string, name: string): Account =>
  ({ id, name, type: 'Bank', openingBalance: 1000, asOfDate: '2026-08-01' } as Account);
function setValue(el: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Holds `persist` open so an in-flight state can be observed. */
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

describe('WP-FB-DATA-08B — remaining persistence-failure disclosure', () => {
  beforeEach(reset);
  afterEach(async () => {
    cleanup();
    await drainWriteQueue();
    IndexedDBStorageService.simulateFailureOnce = false;
    vi.restoreAllMocks();
    await IndexedDBStorageService.loadAll().catch(() => {});
    reset();
  });

  /* ═══════════════ §1 contracts ══════════════════════════════════════════ */
  describe('§1 the store and command contracts', () => {
    it('AC-1 all nine store actions return a promise', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      const s = S();
      const calls: Array<[string, () => any]> = [
        ['addAccount', () => s.addAccount({ name: 'X', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' })],
        ['addIncome', () => s.addIncome('Pay', 10, 'HDFC', 'Income')],
        ['addExpense', () => s.addExpense('Rent', 10, 'HDFC', 'Housing')],
        ['addPastSnapshot', () => s.addPastSnapshot({ dateStr: '2026-07-01', totalAssets: 1, totalLiabilities: 0 })],
        ['captureSnapshot', () => s.captureSnapshot()],
        ['saveMonthlyBudget', () => s.saveMonthlyBudget('2026-08', { Housing: 10 })],
        ['addPolicy', () => s.addPolicy({ provider: 'LIC', type: 'Term Life', coverAmount: 1, premiumAmount: 1 })],
        ['addGoal', () => s.addGoal({ name: 'G', template: 'Emergency Buffer', targetAmount: 1 })],
        ['saveProfile', () => s.saveProfile({ id: 'p', monthlyIncome: 1, monthlyExpenses: 1, savingsRate: 1, updatedAt: '' } as any)]
      ];
      for (const [name, call] of calls) {
        const r = call();
        expect(typeof r?.then, `${name} must return a promise`).toBe('function');
        await r;
      }
    });

    it('AC-1 both direct BudgetWorkspace command paths return promises', async () => {
      const a = FinancialCommands.saveMonthlyBudget('2026-07', { Housing: 900 });
      expect(typeof a?.then).toBe('function');
      await a;
      const b = FinancialCommands.copyBudgetFromPreviousMonth('2026-08');
      expect(typeof b?.then).toBe('function');
      await b;
    });

    it('commands still hand back their record — after storage agrees', async () => {
      const budget = await FinancialCommands.saveMonthlyBudget('2026-08', { Housing: 10 });
      expect(budget.monthStr).toBe('2026-08');
      expect(await stored('budgets')).toBe(1);
    });
  });

  /* ═══════════════ §2 validation preserved ═══════════════════════════════ */
  describe('§2 synchronous validation is unchanged', () => {
    const invalid: Array<[string, () => any, RegExp]> = [
      ['addAccount', () => S().addAccount({ name: '', type: 'Bank', openingBalance: 0 }), /name is required/i],
      ['addPolicy', () => S().addPolicy({ provider: '', type: 'Term Life', coverAmount: 1, premiumAmount: 1 }), /provider name is required/i],
      ['addGoal', () => S().addGoal({ name: '', template: 'Emergency Buffer', targetAmount: 1 }), /name is required/i],
      ['saveProfile', () => S().saveProfile({ id: 'p', monthlyIncome: -1, monthlyExpenses: 1, savingsRate: 1, updatedAt: '' } as any), /cannot be negative/i]
    ];
    for (const [name, call, re] of invalid) {
      it(`AC-7 ${name} still throws SYNCHRONOUSLY on invalid input`, () => {
        expect(call).toThrowError(re);
      });
    }

    it('AC-7 a synchronous refusal performs no write', () => {
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      try { S().addAccount({ name: '', type: 'Bank', openingBalance: 0 }); } catch { /* expected */ }
      expect(spy).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════ §3 every path discloses ═══════════════════════════════ */
  describe('§3 a persistence failure reaches the caller on every path', () => {
    const paths: Array<[string, () => any, string]> = [
      ['addAccount', () => S().addAccount({ name: 'X', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' }), 'accountsData'],
      ['addIncome', () => S().addIncome('Pay', 10, 'HDFC', 'Income'), 'transactionsData'],
      ['addExpense', () => S().addExpense('Rent', 10, 'HDFC', 'Housing'), 'transactionsData'],
      ['addPastSnapshot', () => S().addPastSnapshot({ dateStr: '2026-07-01', totalAssets: 1, totalLiabilities: 0 }), 'snapshotsData'],
      ['captureSnapshot', () => S().captureSnapshot(), 'snapshotsData'],
      ['saveMonthlyBudget', () => S().saveMonthlyBudget('2026-08', { Housing: 10 }), 'budgetsData'],
      ['addPolicy', () => S().addPolicy({ provider: 'LIC', type: 'Term Life', coverAmount: 1, premiumAmount: 1 }), 'policiesData'],
      ['addGoal', () => S().addGoal({ name: 'G', template: 'Emergency Buffer', targetAmount: 1 }), 'goalsData'],
      ['saveProfile', () => S().saveProfile({ id: 'p', monthlyIncome: 1, monthlyExpenses: 1, savingsRate: 1, updatedAt: '' } as any), 'profileData'],
      ['autoSuggestBudget(cmd)', () => FinancialCommands.saveMonthlyBudget('2026-08', { Housing: 5 }), 'budgetsData'],
      ['copyBudgetFromPreviousMonth(cmd)', () => FinancialCommands.copyBudgetFromPreviousMonth('2026-09'), 'budgetsData']
    ];
    for (const [name, call, coll] of paths) {
      it(`AC-2 ${name} rejects, and memory still equals storage`, async () => {
        repo.accountsData = [acct('acc-1', 'HDFC')];
        repo.budgetsData = [];
        repo.syncStore();
        await persistAll();
        if (name.startsWith('copyBudget')) { await FinancialCommands.saveMonthlyBudget('2026-08', { Housing: 900 }); }

        const memBefore = inMemory(coll);
        const stBefore = await stored(coll.replace('Data', ''));

        IndexedDBStorageService.simulateFailureOnce = true;
        expect(await settle(call())).toBe('rejected');
        await drain();

        expect(inMemory(coll)).toBe(memBefore);
        expect(await stored(coll.replace('Data', ''))).toBe(stBefore);
      });
    }
  });

  /* ═══════════════ §4 the three deceptive-catch modals ═══════════════════ */
  /* All three are two-step modals: a classification grid, then the form. The
     test must reach step 2 before any input exists — driving step 1 is part of
     exercising the real surface. */
  const toStep2 = (re: RegExp) => {
    const b = [...document.querySelectorAll('button')].find(x => re.test(x.textContent || ''));
    if (b) fireEvent.click(b);
  };
  const textInputs = () =>
    [...document.querySelectorAll('input')].filter(i => i.type === 'text' || i.type === '');
  const numberInputs = () => [...document.querySelectorAll('input[type="number"]')];

  const modals = [
    {
      label: 'AddAccountModal',
      render: () => render(<AddAccountModal isOpen onClose={onCloseSpy} />),
      step2: () => toStep2(/Checking, savings/i),
      fill: () => { setValue(textInputs()[0], 'Probe Account'); },
      collection: 'accountsData'
    },
    {
      label: 'AddPolicyModal',
      render: () => render(<AddPolicyModal isOpen onClose={onCloseSpy} />),
      step2: () => toStep2(/Term Life/i),
      fill: () => {
        setValue(textInputs()[0], 'LIC Probe');
        const nums = numberInputs();
        if (nums[0]) setValue(nums[0], '1000000');
        if (nums[1]) setValue(nums[1], '12000');
      },
      collection: 'policiesData'
    },
    {
      label: 'AddGoalModal',
      render: () => render(<AddGoalModal isOpen onClose={onCloseSpy} />),
      step2: () => toStep2(/Liquid living expenses buffer/i),
      fill: () => {
        setValue(textInputs()[0], 'Probe Goal');
        const nums = numberInputs();
        if (nums[0]) setValue(nums[0], '100000');
      },
      collection: 'goalsData'
    }
  ];
  let onCloseSpy: any;

  for (const m of modals) {
    describe(`§4 ${m.label}`, () => {
      beforeEach(() => { onCloseSpy = vi.fn(); });

      const submit = () => {
        const form = document.querySelector('form');
        if (form) fireEvent.submit(form);
        else {
          const b = [...document.querySelectorAll('button')].find(x => /save|add|record/i.test(x.textContent || ''));
          if (b) fireEvent.click(b);
        }
      };
      const errorText = () =>
        [...document.querySelectorAll('[role="alert"], [class*="rose"], [class*="red"]')]
          .map(e => e.textContent || '').join(' ');

      it('AC-3 a persistence failure keeps the modal OPEN and shows the real message', async () => {
        m.render();
        m.step2();
        m.fill();
        IndexedDBStorageService.simulateFailureOnce = true;
        submit();

        await waitFor(() => expect(errorText()).toMatch(/Simulated IndexedDB persistence failure/));
        expect(onCloseSpy).not.toHaveBeenCalled();
        expect(errorText()).not.toContain('undefined');
        expect(inMemory(m.collection)).toBe(0);
        expect(await stored(m.collection.replace('Data', ''))).toBe(0);
      });

      it('AC-4 a successful retry after the failure closes the modal and persists', async () => {
        m.render();
        m.step2();
        m.fill();
        IndexedDBStorageService.simulateFailureOnce = true;
        submit();
        await waitFor(() => expect(errorText()).toMatch(/Simulated/));

        submit();   // retry
        await waitFor(() => expect(onCloseSpy).toHaveBeenCalled());
        expect(inMemory(m.collection)).toBe(1);
        expect(await stored(m.collection.replace('Data', ''))).toBe(1);
      });

      it('AC-7 the synchronous validation branch still reports, and never closes', async () => {
        m.render();
        m.step2();
        submit();                     // empty form
        await waitFor(() => expect(errorText()).toMatch(/required|greater than zero/i));
        expect(onCloseSpy).not.toHaveBeenCalled();
      });
    });
  }

  /* ═══════════════ §4b income / expense modals ══════════════════════════ */
  describe('§4b the income and expense modals', () => {
    const seedAccount = async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')];
      repo.syncStore();
      useCanonicalLedger.setState({ accounts: repo.accountsData } as any);
      await persistAll();
    };
    const errorText = () =>
      [...document.querySelectorAll('[role="alert"], [class*="rose"], [class*="red"]')]
        .map(e => e.textContent || '').join(' ');

    const cases = [
      { label: 'IncomeModal', render: (onClose: any) => render(<IncomeModal isOpen onClose={onClose} />),
        submitId: 'add-income-submit', errorId: 'add-income-error' },
      { label: 'ExpenseModal', render: (onClose: any) => render(<ExpenseModal isOpen onClose={onClose} />),
        submitId: 'add-expense-submit', errorId: 'add-expense-error' }
    ];

    for (const c of cases) {
      it(`AC-3 ${c.label}: a persistence failure keeps it OPEN with the real message`, async () => {
        await seedAccount();
        const onClose = vi.fn();
        c.render(onClose);
        IndexedDBStorageService.simulateFailureOnce = true;
        fireEvent.click(document.getElementById(c.submitId)!);

        await waitFor(() => expect(document.getElementById(c.errorId)).toBeTruthy());
        expect(document.getElementById(c.errorId)!.textContent)
          .toContain('Simulated IndexedDB persistence failure');
        expect(document.getElementById(c.errorId)!.textContent).not.toContain('undefined');
        expect(onClose).not.toHaveBeenCalled();
        expect(inMemory('transactionsData')).toBe(0);
        expect(await stored('transactions')).toBe(0);
      });

      it(`AC-4 ${c.label}: a successful retry closes it and persists`, async () => {
        await seedAccount();
        const onClose = vi.fn();
        c.render(onClose);
        IndexedDBStorageService.simulateFailureOnce = true;
        fireEvent.click(document.getElementById(c.submitId)!);
        await waitFor(() => expect(document.getElementById(c.errorId)).toBeTruthy());

        fireEvent.click(document.getElementById(c.submitId)!);
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(await stored('transactions')).toBe(1);
      });

      it(`AC-6 ${c.label}: the submit control is busy in flight and claims nothing`, async () => {
        await seedAccount();
        const onClose = vi.fn();
        const { release } = gatePersist();
        c.render(onClose);
        fireEvent.click(document.getElementById(c.submitId)!);

        await waitFor(() =>
          expect(document.getElementById(c.submitId)!.getAttribute('data-write-busy')).toBe('true'));
        expect(document.getElementById(c.submitId)!.matches(':disabled')).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        release();
        await waitFor(() => expect(onClose).toHaveBeenCalled());
      });
    }
  });

  /* ═══════════════ §4c the remaining single-step modals ════════════════ */
  describe('§4c past-entry, snapshot and budget modals', () => {
    const errorText = () =>
      [...document.querySelectorAll('[role="alert"], [class*="rose"], [class*="red"]')]
        .map(e => e.textContent || '').join(' ');
    const submitForm = () => fireEvent.submit(document.querySelector('form')!);

    it('AC-3 AddPastEntryModal stays open and shows the real message', async () => {
      const onClose = vi.fn();
      render(<AddPastEntryModal isOpen onClose={onClose} />);
      setValue(document.querySelector('input[placeholder="dd-mm-yyyy e.g. 09-08-2025"]')!, '01-07-2026');
      const nums = [...document.querySelectorAll('input[type="number"]')];
      setValue(nums[0], '100'); setValue(nums[1], '50');

      IndexedDBStorageService.simulateFailureOnce = true;
      submitForm();

      await waitFor(() => expect(errorText()).toMatch(/Simulated IndexedDB persistence failure/));
      expect(onClose).not.toHaveBeenCalled();
      expect(inMemory('snapshotsData')).toBe(0);
      expect(await stored('snapshots')).toBe(0);
    });

    it('AC-4 AddPastEntryModal retries successfully', async () => {
      const onClose = vi.fn();
      render(<AddPastEntryModal isOpen onClose={onClose} />);
      setValue(document.querySelector('input[placeholder="dd-mm-yyyy e.g. 09-08-2025"]')!, '01-07-2026');
      const nums = [...document.querySelectorAll('input[type="number"]')];
      setValue(nums[0], '100'); setValue(nums[1], '50');

      IndexedDBStorageService.simulateFailureOnce = true;
      submitForm();
      await waitFor(() => expect(errorText()).toMatch(/Simulated/));
      submitForm();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(await stored('snapshots')).toBe(1);
    });

    it('AC-3 TakeSnapshotModal stays open and shows the real message', async () => {
      const onClose = vi.fn();
      render(<TakeSnapshotModal isOpen onClose={onClose} />);
      IndexedDBStorageService.simulateFailureOnce = true;
      submitForm();

      await waitFor(() => expect(document.getElementById('take-snapshot-error')).toBeTruthy());
      expect(document.getElementById('take-snapshot-error')!.textContent)
        .toContain('Simulated IndexedDB persistence failure');
      expect(onClose).not.toHaveBeenCalled();
      expect(await stored('snapshots')).toBe(0);
    });

    it('AC-6 TakeSnapshotModal is busy in flight and closes only after success', async () => {
      const onClose = vi.fn();
      const { release } = gatePersist();
      render(<TakeSnapshotModal isOpen onClose={onClose} />);
      submitForm();

      await waitFor(() =>
        expect(document.getElementById('take-snapshot-submit')!.getAttribute('data-write-busy')).toBe('true'));
      expect(document.getElementById('take-snapshot-submit')!.matches(':disabled')).toBe(true);
      expect(onClose).not.toHaveBeenCalled();

      release();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('AC-3 EditBudgetModal stays open and shows the real message', async () => {
      const onClose = vi.fn();
      render(<EditBudgetModal isOpen onClose={onClose} monthStr="2026-08" initialAllocations={{ Housing: 100 }} />);
      IndexedDBStorageService.simulateFailureOnce = true;
      submitForm();

      await waitFor(() => expect(document.getElementById('edit-budget-error')).toBeTruthy());
      expect(document.getElementById('edit-budget-error')!.textContent)
        .toContain('Simulated IndexedDB persistence failure');
      expect(onClose).not.toHaveBeenCalled();
      expect(await stored('budgets')).toBe(0);
    });

    it('AC-4 EditBudgetModal retries successfully and persists', async () => {
      const onClose = vi.fn();
      render(<EditBudgetModal isOpen onClose={onClose} monthStr="2026-08" initialAllocations={{ Housing: 100 }} />);
      IndexedDBStorageService.simulateFailureOnce = true;
      submitForm();
      await waitFor(() => expect(document.getElementById('edit-budget-error')).toBeTruthy());

      submitForm();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(await stored('budgets')).toBe(1);
    });
  });

  /* ═══════════════ §5 the budget false claim ═════════════════════════════ */
  describe('§5 BudgetWorkspace — the measured false claim', () => {
    const renderBudget = () => {
      const View: React.FC = () => {
        const transactions = useCanonicalLedger(s => s.transactions);
        const budgets = useCanonicalLedger(s => s.budgets);
        return <BudgetWorkspace transactions={transactions} budgets={budgets} />;
      };
      return render(<View />);
    };
    const toast = () => document.body.textContent || '';

    const seedPrevious = async () => {
      await FinancialCommands.saveMonthlyBudget('2026-07', { Housing: 900 });
      useCanonicalLedger.setState({ budgets: repo.budgetsData } as any);
      await persistAll();
    };

    it('AC-5 a failed copy-previous does NOT claim success', async () => {
      await seedPrevious();
      renderBudget();
      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.click(document.getElementById('btn-copy-previous-budget')!);

      await waitFor(() => expect(document.getElementById('budget-error')).toBeTruthy());
      expect(document.getElementById('budget-error')!.textContent)
        .toContain('Simulated IndexedDB persistence failure');
      // the measured false claim must be absent
      expect(toast()).not.toMatch(/Copied budget allocations from previous month/);
      expect(await stored('budgets')).toBe(1);      // only the source month
    });

    it('AC-5 a SUCCESSFUL copy-previous still shows its toast, after storage agrees', async () => {
      await seedPrevious();
      renderBudget();
      fireEvent.click(document.getElementById('btn-copy-previous-budget')!);

      await waitFor(() => expect(toast()).toMatch(/Copied budget allocations from previous month/));
      expect(await stored('budgets')).toBe(2);
      expect(document.getElementById('budget-error')).toBeNull();
    });

    it('AC-5 a failed auto-suggest does NOT claim success', async () => {
      renderBudget();
      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.click(document.getElementById('btn-auto-suggest-budget')!);

      await waitFor(() => expect(document.getElementById('budget-error')).toBeTruthy());
      expect(toast()).not.toMatch(/Auto-suggest populated/);
      expect(await stored('budgets')).toBe(0);
    });

    it('AC-6 the budget controls are busy in flight and recover after failure', async () => {
      await seedPrevious();
      const { release } = gatePersist();
      renderBudget();
      fireEvent.click(document.getElementById('btn-copy-previous-budget')!);

      await waitFor(() =>
        expect(document.getElementById('btn-copy-previous-budget')!.getAttribute('data-budget-busy')).toBe('true'));
      expect(document.getElementById('btn-copy-previous-budget')!.matches(':disabled')).toBe(true);
      expect(document.getElementById('btn-auto-suggest-budget')!.matches(':disabled')).toBe(true);
      expect(toast()).not.toMatch(/Copied budget allocations/);   // nothing claimed yet

      release();
      await waitFor(() => expect(toast()).toMatch(/Copied budget allocations/));
      await waitFor(() =>
        expect(document.getElementById('btn-copy-previous-budget')!.matches(':disabled')).toBe(false));
    });
  });

  /* ═══════════════ §6 OverviewPage snapshot callers ══════════════════════ */
  describe('§6 the OverviewPage snapshot buttons (secondary callers)', () => {
    it('AC-8 the chart-card snapshot button discloses a failure inline', async () => {
      render(<OverviewPage navigateTo={() => {}} />);
      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.click(document.getElementById('overview-capture-snapshot')!);

      await waitFor(() => expect(document.getElementById('snapshot-notice')).toBeTruthy());
      expect(document.getElementById('snapshot-notice')!.getAttribute('data-snapshot-kind')).toBe('error');
      expect(document.getElementById('snapshot-notice')!.textContent)
        .toContain('Simulated IndexedDB persistence failure');
      expect(inMemory('snapshotsData')).toBe(0);
    });

    it('AC-8 the empty-state snapshot button is wired to the same disclosure', async () => {
      render(<OverviewPage navigateTo={() => {}} />);
      const empty = document.getElementById('overview-capture-snapshot-empty');
      expect(empty, 'the empty-state capture button must exist').toBeTruthy();
      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.click(empty!);

      await waitFor(() => expect(document.getElementById('snapshot-notice')).toBeTruthy());
      expect(document.getElementById('snapshot-notice')!.getAttribute('data-snapshot-kind')).toBe('error');
      expect(inMemory('snapshotsData')).toBe(0);
    });

    it('AC-8 a successful capture reports success only after storage agrees', async () => {
      render(<OverviewPage navigateTo={() => {}} />);
      fireEvent.click(document.getElementById('overview-capture-snapshot')!);

      await waitFor(() => expect(document.getElementById('snapshot-notice')).toBeTruthy());
      expect(document.getElementById('snapshot-notice')!.getAttribute('data-snapshot-kind')).toBe('success');
      expect(await stored('snapshots')).toBe(1);
    });

    it('AC-6 the snapshot buttons are busy in flight, and claim nothing yet', async () => {
      const { release } = gatePersist();
      render(<OverviewPage navigateTo={() => {}} />);
      fireEvent.click(document.getElementById('overview-capture-snapshot')!);

      await waitFor(() =>
        expect(document.getElementById('overview-capture-snapshot')!.getAttribute('data-write-busy')).toBe('true'));
      expect(document.getElementById('overview-capture-snapshot')!.matches(':disabled')).toBe(true);
      expect(document.getElementById('snapshot-notice')).toBeNull();

      release();
      await waitFor(() => expect(document.getElementById('snapshot-notice')).toBeTruthy());
    });
  });

  /* ═══════════════ §7 the profile workspace ══════════════════════════════ */
  describe('§7 FinancialProfileWorkspace', () => {
    const renderProfile = () => {
      const View: React.FC = () => {
        const profile = useCanonicalLedger(s => s.profile);
        return <FinancialProfileWorkspace profile={profile} />;
      };
      return render(<View />);
    };
    const byPlaceholder = (p: string) =>
      document.querySelector(`input[placeholder="${p}"]`) as HTMLInputElement | null;
    const fill = () => {
      const income = byPlaceholder('e.g. 150000');
      const expenses = byPlaceholder('e.g. 75000');
      if (income) setValue(income, '100000');
      if (expenses) setValue(expenses, '60000');
    };

    it('AC-9 a failed save shows an inline failure and claims no success', async () => {
      renderProfile();
      fill();
      IndexedDBStorageService.simulateFailureOnce = true;
      fireEvent.submit(document.querySelector('form')!);

      await waitFor(() => expect(document.body.textContent)
        .toMatch(/Simulated IndexedDB persistence failure/));
      expect(inMemory('profileData')).toBe(0);
      expect(await stored('profile')).toBe(0);
    });

    it('AC-9 a successful save still reports success', async () => {
      renderProfile();
      fill();
      fireEvent.submit(document.querySelector('form')!);
      await waitFor(async () => expect(await stored('profile')).toBe(1));
    });
  });

  /* ═══════════════ §8 no unhandled rejections · scope ════════════════════ */
  describe('§8 rejections are observable, and scope holds', () => {
    it('AC-10 an ignored rejection produces no unhandled rejection', async () => {
      repo.accountsData = [acct('acc-1', 'HDFC')]; repo.syncStore();
      await persistAll();
      const unhandled: string[] = [];
      const handler = (e: any) => unhandled.push(String(e?.reason ?? e));
      process.on('unhandledRejection', handler);

      IndexedDBStorageService.simulateFailureOnce = true;
      S().addIncome('Pay', 10, 'HDFC', 'Income').catch(() => {});
      await drain(); await drain();
      process.off('unhandledRejection', handler);
      expect(unhandled).toEqual([]);
    });

    it('the transaction write surface is unchanged — D9-A holds', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
    });

    it('the 08A surfaces are untouched by this package', () => {
      const s = S();
      for (const k of ['removeAccount', 'removePolicy', 'removeGoal']) {
        const r = (() => { try { return s[k]('nope'); } catch { return undefined; } })();
        expect(typeof r?.then).toBe('function');
        r?.catch(() => {});
      }
      const outcome = s.commitImportedRows([]);
      expect(outcome).toHaveProperty('appended');       // the 08A admission contract
      expect(outcome.persisted).toBeUndefined();
    });

    it('no new store action was introduced', () => {
      const s = S();
      for (const k of ['undoAddAccount', 'retryLastWrite', 'flushPending', 'archiveProfile']) {
        expect(typeof s[k]).toBe('undefined');
      }
    });
  });
});
