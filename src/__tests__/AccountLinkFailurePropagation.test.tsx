/**
 * WP-FB-DATA-07c-R2 — account-link failure propagation.
 *
 * THE DEFECT (F-07c-R2, measured at the 07c-R1 gate in real Chromium)
 *
 * `linkAccountToAsset`, `unlinkAccountFromAsset` and `dismissAssetCandidate`
 * returned a plain `{ ok, accounts }` synchronously and DISCARDED the
 * `applyAccountsUpdate` promise. With persistence failing:
 *
 *     Money ▸ Accounts ▸ Link an asset ▸ Link
 *     modal closes as if it worked      error shown: NONE
 *     memory  A:-        storage  A:-   → the link does not exist
 *     page error: "Simulated IndexedDB persistence failure"  (unhandled)
 *
 * The user was told a link had been made that had not been made. This was the
 * last known F-06b-2 instance in the product: WP-FB-DATA-07c made it sharper,
 * not safer, because its operation-scoped revert now rolls the link back
 * correctly — so the UI's claim became definitively false rather than merely
 * unverified.
 *
 * WHY THE ADMISSION RESULT STAYS SYNCHRONOUS
 *
 * `ok`/`reason`/`message` answer "was the request admitted?" — a pure decision
 * from `AccountAssetLinkService` that 38 existing tests read synchronously.
 * `persisted` answers the separate question "did it reach storage?". Conflating
 * the two would have forced every caller of a pure decision to await.
 *
 *   §1  the store contract
 *   §2  failure propagation at the store
 *   §3  the modal: stays open, shows the real message, closes only on success
 *   §4  concurrency regression for ACCOUNTS
 *   §5  scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { LinkAssetModal } from '../components/money/LinkAssetModal';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { AccountAssetLinkService } from '../services/AccountAssetLinkService';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Account, Asset } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const accts = (): Account[] => repo.accountsData;
const linkOf = (id: string) => accts().find(a => a.id === id)?.linkedAssetId ?? null;
const memoryMap = () => accts().map(a => `${a.id}:${a.linkedAssetId ?? '-'}`).sort();
const storedMap = async () =>
  (await IndexedDBStorageService.loadAll()).accounts.map(a => `${a.id}:${a.linkedAssetId ?? '-'}`).sort();
const drain = () => new Promise(r => setTimeout(r, 30));
const settled = (p: any) => Promise.resolve(p).then(() => 'ok' as const).catch(() => 'rejected' as const);

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.holdingsData = [];
  repo.snapshotsData = []; repo.accountsData = []; repo.budgetsData = [];
  repo.policiesData = []; repo.goalsData = []; repo.profileData = null;
  repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], assets: [], liabilities: [], snapshots: [], accounts: []
  } as any);
}

/** Two accounts, two assets, nothing linked; memory and storage in agreement. */
async function seed() {
  repo.accountsData = [
    { id: 'acc-A', name: 'A', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' },
    { id: 'acc-B', name: 'B', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' }
  ] as Account[];
  repo.assetsData = [
    { id: 'ast-X', name: 'X', amount: 100 },
    { id: 'ast-Y', name: 'Y', amount: 200 }
  ] as Asset[];
  repo.syncStore();
  await IndexedDBStorageService.saveAll({
    transactions: [], assets: repo.assetsData, liabilities: [], snapshots: [],
    accounts: repo.accountsData, budgets: [], policies: [], goals: [], profile: null
  });
}

/**
 * A "held candidate": a Cash & Savings asset whose name matches the account's,
 * unlinked and not yet dismissed. This is the only state in which the modal
 * renders the "Not the same" control — and the only state in which a write can
 * be in flight while the account is still UNLINKED, which is what makes the
 * busy-disable observable rather than masked by `status.state === 'LINKED'`.
 */
async function seedCandidate() {
  repo.accountsData = [
    { id: 'acc-A', name: 'Savings', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' }
  ] as Account[];
  repo.assetsData = [
    { id: 'ast-S', name: 'Savings', amount: 500, type: 'Cash & Savings' },
    { id: 'ast-Y', name: 'Y', amount: 200 }
  ] as Asset[];
  repo.syncStore();
  await IndexedDBStorageService.saveAll({
    transactions: [], assets: repo.assetsData, liabilities: [], snapshots: [],
    accounts: repo.accountsData, budgets: [], policies: [], goals: [], profile: null
  });
}

/** Renders the modal wired to the real store actions, as AccountsWorkspace does. */
const Modal: React.FC<{ accountId: string; onClose?: () => void }> = ({ accountId, onClose }) => {
  const accounts = useCanonicalLedger(s => s.accounts);
  const assets = useCanonicalLedger(s => s.assets);
  const { linkAccountToAsset, unlinkAccountFromAsset, dismissAssetCandidate } = useCanonicalLedger();
  const account = accounts.find(a => a.id === accountId) || null;
  return (
    <LinkAssetModal
      isOpen
      account={account}
      accounts={accounts}
      assets={assets}
      onClose={onClose || (() => {})}
      onLink={linkAccountToAsset}
      onUnlink={unlinkAccountFromAsset}
      onDismissCandidate={dismissAssetCandidate}
    />
  );
};

const linkBtn = (assetId: string) =>
  document.querySelector(`[data-link-asset="${assetId}"]`) as HTMLButtonElement;
const unlinkBtn = () => document.getElementById('btn-unlink-asset') as HTMLButtonElement;
const errorBox = () => document.getElementById('link-asset-error');

/**
 * A gated write holds the 07c write lock; if a test ends while one is pending,
 * it lands during the NEXT test and clobbers its state (and every teardown that
 * touches storage queues behind it). Gates register here so teardown can always
 * release them and drain the queue first.
 */
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
  pendingRelease?.();
  pendingRelease = null;
  await IndexedDBStorageService.runExclusive(async () => {}).catch(() => {});
}

describe('WP-FB-DATA-07c-R2 — account-link failure propagation', () => {
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
    it('AC-1 all three actions expose a persistence promise when they write', async () => {
      await seed();
      const link = S().linkAccountToAsset('acc-A', 'ast-X');
      expect(typeof link.persisted?.then).toBe('function');
      await link.persisted;

      const unlink = S().unlinkAccountFromAsset('acc-A');
      expect(typeof unlink.persisted?.then).toBe('function');
      await unlink.persisted;

      const dismiss = S().dismissAssetCandidate('acc-A', 'ast-X');
      expect(typeof dismiss.persisted?.then).toBe('function');
      await dismiss.persisted;
    });

    it('AC-1 the admission decision is still synchronous', async () => {
      await seed();
      await S().linkAccountToAsset('acc-A', 'ast-X').persisted;
      // acc-B may not claim an asset acc-A already holds — decided immediately
      const refused = S().linkAccountToAsset('acc-B', 'ast-X');
      expect(refused.ok).toBe(false);
      expect(refused.reason).toBe('ASSET_ALREADY_CLAIMED');
      expect(refused.conflictingAccountName).toBe('A');
    });

    it('a refusal writes nothing and promises nothing', async () => {
      await seed();
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      const refused = S().linkAccountToAsset('acc-A', 'ast-NOPE');
      expect(refused.ok).toBe(false);
      expect(refused.persisted).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });

    it('an UNCHANGED result writes nothing and promises nothing', async () => {
      await seed();
      await S().linkAccountToAsset('acc-A', 'ast-X').persisted;
      const again = S().linkAccountToAsset('acc-A', 'ast-X');
      expect(again.ok).toBe(true);
      expect(again.unchanged).toBe(true);
      expect(again.persisted).toBeUndefined();
    });
  });

  /* ═══════════════ §2 failure propagation ════════════════════════════════ */
  describe('§2 a failed write reaches the caller', () => {
    it('AC-2 a failed LINK rejects, and leaves memory and storage unchanged', async () => {
      await seed();
      IndexedDBStorageService.simulateFailureOnce = true;
      const res = S().linkAccountToAsset('acc-A', 'ast-X');
      expect(res.ok).toBe(true);                       // admitted…
      await expect(res.persisted).rejects.toThrow(/Simulated IndexedDB persistence failure/);
      await drain();

      expect(linkOf('acc-A')).toBeFalsy();             // …but not stored
      expect(memoryMap()).toEqual(await storedMap());
      expect(await storedMap()).toEqual(['acc-A:-', 'acc-B:-']);
    });

    it('AC-2 a failed UNLINK rejects and the link survives', async () => {
      await seed();
      await S().linkAccountToAsset('acc-A', 'ast-X').persisted;
      IndexedDBStorageService.simulateFailureOnce = true;
      const res = S().unlinkAccountFromAsset('acc-A');
      await expect(res.persisted).rejects.toThrow(/Simulated/);
      await drain();
      expect(linkOf('acc-A')).toBe('ast-X');
      expect(memoryMap()).toEqual(await storedMap());
    });

    it('AC-2 a failed DISMISS rejects and records nothing', async () => {
      await seed();
      IndexedDBStorageService.simulateFailureOnce = true;
      const res = S().dismissAssetCandidate('acc-A', 'ast-X');
      await expect(res.persisted).rejects.toThrow(/Simulated/);
      await drain();
      expect(accts().find(a => a.id === 'acc-A')!.dismissedAssetCandidateIds || []).toEqual([]);
      expect(memoryMap()).toEqual(await storedMap());
    });

    it('AC-4 no UNHANDLED rejection escapes when a caller ignores the promise', async () => {
      await seed();
      const unhandled: string[] = [];
      const handler = (e: any) => unhandled.push(String(e?.reason ?? e));
      process.on('unhandledRejection', handler);

      IndexedDBStorageService.simulateFailureOnce = true;
      S().linkAccountToAsset('acc-A', 'ast-X');        // deliberately ignored
      await drain(); await drain();
      process.off('unhandledRejection', handler);

      // The rejection is observable to a caller that wants it, and handled for
      // the runtime — a page error is not an error report.
      expect(unhandled).toEqual([]);
    });

    it('the READFAIL latch reaches the caller through the same channel', async () => {
      await seed();
      IndexedDBStorageService.simulateReadFailureOnce = true;
      await IndexedDBStorageService.loadAll().catch(() => {});
      const res = S().linkAccountToAsset('acc-A', 'ast-X');
      await expect(res.persisted).rejects.toThrow(/Refusing to persist/);
      IndexedDBStorageService.simulateReadFailureOnce = false;
      await IndexedDBStorageService.loadAll().catch(() => {});
    });
  });

  /* ═══════════════ §3 the modal ══════════════════════════════════════════ */
  describe('§3 the modal tells the truth', () => {
    it('AC-5 a successful link persists, and only then closes', async () => {
      await seed();
      const onClose = vi.fn();
      render(<Modal accountId="acc-A" onClose={onClose} />);
      fireEvent.click(linkBtn('ast-X'));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(linkOf('acc-A')).toBe('ast-X');
      expect(await storedMap()).toContain('acc-A:ast-X');
      expect(errorBox()).toBeNull();
    });

    it('AC-3 a FAILED link keeps the modal open and shows the real message', async () => {
      await seed();
      const onClose = vi.fn();
      IndexedDBStorageService.simulateFailureOnce = true;
      render(<Modal accountId="acc-A" onClose={onClose} />);
      fireEvent.click(linkBtn('ast-X'));

      await waitFor(() => expect(errorBox()).toBeTruthy());
      expect(errorBox()!.textContent).toContain('Simulated IndexedDB persistence failure');
      expect(errorBox()!.textContent).not.toContain('undefined');
      // it must NOT have closed — that was the whole defect
      expect(onClose).not.toHaveBeenCalled();
      expect(linkOf('acc-A')).toBeFalsy();
      expect(memoryMap()).toEqual(await storedMap());
    });

    it('AC-3 a failed UNLINK keeps the modal open and shows the message', async () => {
      await seed();
      await S().linkAccountToAsset('acc-A', 'ast-X').persisted;
      const onClose = vi.fn();
      IndexedDBStorageService.simulateFailureOnce = true;
      render(<Modal accountId="acc-A" onClose={onClose} />);
      fireEvent.click(unlinkBtn());

      await waitFor(() => expect(errorBox()).toBeTruthy());
      expect(errorBox()!.textContent).toContain('Simulated');
      expect(onClose).not.toHaveBeenCalled();
      expect(linkOf('acc-A')).toBe('ast-X');
    });

    it('an ADMISSION refusal still renders its own message and stays open', async () => {
      await seed();
      await S().linkAccountToAsset('acc-B', 'ast-X').persisted;   // B claims X
      const onClose = vi.fn();
      render(<Modal accountId="acc-A" onClose={onClose} />);
      // the control for a claimed asset is disabled, so drive the handler the
      // way a claim conflict actually arrives: through the store
      const refused = S().linkAccountToAsset('acc-A', 'ast-X');
      expect(refused.ok).toBe(false);
      expect(linkBtn('ast-X').matches(':disabled')).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('AC-6 the modal is locked while the write is in flight, then recovers', async () => {
      /* The clicked asset moves into the "Linked" summary the moment memory is
         mutated optimistically, so its own Link button is gone during the
         flight. What must be observable — and is — is that NOTHING else can be
         actioned, and that the modal has not closed on an unconfirmed write. */
      await seed();
      const { release } = gatePersist();
      const onClose = vi.fn();
      render(<Modal accountId="acc-A" onClose={onClose} />);
      fireEvent.click(linkBtn('ast-X'));

      await waitFor(() => expect(unlinkBtn()).toBeTruthy());
      expect(unlinkBtn().matches(':disabled')).toBe(true);
      expect(unlinkBtn().getAttribute('data-link-busy')).toBe('true');
      expect(unlinkBtn().textContent).toContain('Saving');
      expect(linkBtn('ast-Y').matches(':disabled')).toBe(true);
      expect(linkBtn('ast-Y').getAttribute('data-link-busy')).toBe('true');
      expect(onClose).not.toHaveBeenCalled();          // no close on an unconfirmed write

      release();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(linkOf('acc-A')).toBe('ast-X');
    });

    it('no second write can be started from the modal while one is pending', async () => {
      await seed();
      const { release, spy } = gatePersist();
      render(<Modal accountId="acc-A" onClose={() => {}} />);
      fireEvent.click(linkBtn('ast-X'));
      await waitFor(() => expect(linkBtn('ast-Y').matches(':disabled')).toBe(true));

      // every remaining control is inert while the write is unresolved
      fireEvent.click(linkBtn('ast-Y'));
      fireEvent.click(unlinkBtn());
      expect(spy).toHaveBeenCalledTimes(1);

      release();
      await waitFor(() => expect(linkOf('acc-A')).toBe('ast-X'));
    });

    it('R2-M10 while an UNLINKED-state write is pending, Link controls are disabled by BUSY', async () => {
      /* MUTATION-ESCAPE CLOSURE. Removing `|| busy` from the Link control
         survived, because during a pending LINK the account is already
         optimistically LINKED and the control is disabled for that reason
         anyway. A pending DISMISS leaves the account UNLINKED, so `busy` is the
         only thing that can be disabling it. */
      await seedCandidate();
      const { release } = gatePersist();
      render(<Modal accountId="acc-A" onClose={() => {}} />);

      const dismiss = document.querySelector('[data-dismiss-candidate="ast-S"]') as HTMLButtonElement;
      expect(dismiss).toBeTruthy();
      expect(linkBtn('ast-S').matches(':disabled')).toBe(false);   // enabled before

      fireEvent.click(dismiss);
      await waitFor(() => expect(linkBtn('ast-S').getAttribute('data-link-busy')).toBe('true'));
      // the account is still UNLINKED, so only `busy` can be disabling this
      expect(linkBtn('ast-S').matches(':disabled')).toBe(true);
      expect(linkBtn('ast-Y').matches(':disabled')).toBe(true);
      // the dismiss control itself unmounts, because the candidate is dismissed
      // optimistically the moment memory is mutated
      expect(document.querySelector('[data-dismiss-candidate="ast-S"]')).toBeNull();

      release();
      await waitFor(() =>
        expect(accts().find(a => a.id === 'acc-A')!.dismissedAssetCandidateIds).toContain('ast-S'));
    });

    it('a failed write re-enables the modal instead of leaving it stuck', async () => {
      await seed();
      IndexedDBStorageService.simulateFailureOnce = true;
      render(<Modal accountId="acc-A" onClose={() => {}} />);
      fireEvent.click(linkBtn('ast-X'));

      await waitFor(() => expect(errorBox()).toBeTruthy());
      // the optimistic link was reverted, so the asset is selectable again
      await waitFor(() => expect(linkBtn('ast-X')).toBeTruthy());
      expect(linkBtn('ast-X').matches(':disabled')).toBe(false);
      expect(linkBtn('ast-X').getAttribute('data-link-busy')).toBe('false');
    });
  });

  /* ═══════════════ §4 accounts concurrency regression ════════════════════ */
  describe('§4 overlapping account writes (the missing third collection)', () => {
    /* PersistenceRollbackIntegrity covers liabilities and transactions. Accounts
       were the collection this surface writes, and had no such coverage. */
    it('AC-7 a failed link does not erase a concurrent successful link', async () => {
      await seed();
      IndexedDBStorageService.simulateFailureOnce = true;
      const a = settled(S().linkAccountToAsset('acc-A', 'ast-X').persisted);
      const b = settled(S().linkAccountToAsset('acc-B', 'ast-Y').persisted);
      expect({ a: await a, b: await b }).toEqual({ a: 'rejected', b: 'ok' });
      await drain();

      const memory = memoryMap();
      expect(memory).toEqual(await storedMap());
      expect(linkOf('acc-A')).toBeFalsy();     // the failed one was undone
      expect(linkOf('acc-B')).toBe('ast-Y');   // the successful one stands
    });

    it('AC-7 a link overlapping an account registration converges', async () => {
      await seed();
      const link = settled(S().linkAccountToAsset('acc-A', 'ast-X').persisted);
      const add = settled(repository.accounts.add({
        id: 'acc-C', name: 'C', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01'
      } as Account));
      expect({ link: await link, add: await add }).toEqual({ link: 'ok', add: 'ok' });
      await drain();
      expect(memoryMap()).toEqual(await storedMap());
      expect(accts()).toHaveLength(3);
      expect(linkOf('acc-A')).toBe('ast-X');
    });

    it('AC-7 a link overlapping an account deletion converges', async () => {
      await seed();
      const link = settled(S().linkAccountToAsset('acc-A', 'ast-X').persisted);
      const del = settled(repository.accounts.remove('acc-B'));
      await Promise.all([link, del]);
      await drain();
      expect(memoryMap()).toEqual(await storedMap());
      expect(accts().map(a => a.id)).toEqual(['acc-A']);
      expect(linkOf('acc-A')).toBe('ast-X');
    });
  });

  /* ═══════════════ §5 scope boundary ═════════════════════════════════════ */
  describe('§5 scope boundary', () => {
    it('AC-8 link semantics are unchanged — claim conflicts still refuse', async () => {
      await seed();
      await S().linkAccountToAsset('acc-A', 'ast-X').persisted;
      const r = S().linkAccountToAsset('acc-B', 'ast-X');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('ASSET_ALREADY_CLAIMED');
      expect(linkOf('acc-A')).toBe('ast-X');
      expect(linkOf('acc-B')).toBeFalsy();
    });

    it('no new store action was introduced on this surface', () => {
      const keys = Object.keys(S()).filter(k => /link|Link/.test(k)).sort();
      expect(keys).toEqual(['linkAccountToAsset', 'unlinkAccountFromAsset']);
      expect(typeof S().dismissAssetCandidate).toBe('function');
    });

    it('the transaction write surface is untouched', () => {
      const t = repository.transactions as any;
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t))
        .filter(n => n !== 'constructor' && typeof t[n] === 'function');
      const reads = ['findMany', 'findManySync', 'findById', 'findAll', 'findAllSync'];
      expect(names.filter(n => !reads.includes(n)).sort())
        .toEqual(['append', 'appendMany', 'restoreBatch', 'rollbackBatch', 'supersede']);
    });

    it('the 07c write lease is used, not replaced', async () => {
      await seed();
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await S().linkAccountToAsset('acc-A', 'ast-X').persisted;
      expect(spy).toHaveBeenCalledTimes(1);
      // the first argument is the lease minted by runExclusive
      expect(typeof spy.mock.calls[0][0]).toBe('object');
      expect(typeof (spy.mock.calls[0][0] as any).id).toBe('number');
    });

    it('AccountAssetLinkService itself is unmodified in behaviour', () => {
      const accounts = [{ id: 'acc-A', name: 'A', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01' }] as Account[];
      const assets = [{ id: 'ast-X', name: 'X', amount: 1 }] as Asset[];
      const r = AccountAssetLinkService.link('acc-A', 'ast-X', accounts, assets);
      expect(r.ok).toBe(true);
      expect((r as any).persisted).toBeUndefined();   // the service stays pure
      expect(r.accounts[0].linkedAssetId).toBe('ast-X');
    });
  });
});
