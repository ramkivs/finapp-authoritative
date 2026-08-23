/**
 * WP-FB-DATA-07b — Asset lifecycle parity.
 *
 * Decisions implemented (FINBOOM-DECISION-LEDGER.md):
 *   Q-D07b-1a = (c)  duplicate asset names are PERMITTED; create always
 *                    appends; the silent name-upsert is retired; duplicates
 *                    must be DISTINGUISHABLE wherever they are shown.
 *   Q-D07b-1b = (b)  physical delete by id, with confirmation, busy state,
 *                    failure disclosure, and disclosure that the account link
 *                    will be cleared.
 *
 * WHAT THIS PACKAGE IS
 *
 * WP-FB-DATA-04c-1 gave assets a stable id and changed nothing a user could
 * see. The Assets table had five columns, zero edit controls, zero delete
 * controls, no notice of any kind, and the only way to correct a valuation was
 * to re-add it under the same name and hope.
 *
 * The 07b gate measured what "hope" cost. Through the real Add Asset modal, in
 * a real browser: "Gold ₹5,00,000" then "Gold ₹3,00,000" left ONE row at
 * ₹3,00,000 — ₹5,00,000 destroyed, silently, with no notice. It also measured
 * four hazards latent in the bare primitive that an Edit UI would have shipped
 * straight to users: a partial edit blanked type/currency/geography/tag; a
 * padded id created a phantom row; a stale id appended instead of refusing;
 * identity was taken from the caller rather than from storage.
 *
 * ⚠️ ASSETS DIVERGE FROM LIABILITIES ON PURPOSE. Q-D07a-2 refused duplicate
 * liability names; Q-D07b-1a permits duplicate asset names. Two SGB tranches
 * and two flats are real. The obligation that creates is on the UI, and §5
 * is where that obligation is enforced.
 *
 *   §1  the lifecycle authority
 *   §2  create appends — both paths
 *   §3  edit is id-addressed, complete and atomic
 *   §4  delete, and what it does to the account link
 *   §5  duplicates are permitted AND distinguishable
 *   §6  failure is disclosed, never swallowed
 *   §7  overlapping writes (the third collection)
 *   §8  scope boundary
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import {
  AssetLifecycleService, AssetLifecycleError, ASSET_EDITABLE_FIELDS
} from '../services/AssetLifecycleService';
import { AssetIdentityService } from '../services/AssetIdentityService';
import { IndexedDBStorageService } from '../services/IndexedDBStorageService';
import { AssetsWorkspace } from '../components/wealth/AssetsWorkspace';
import { OverviewPage } from '../pages/OverviewPage';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { repository } from '../repositories';
import { Asset, Account } from '../domain/types';

const repo = repository as any;
const S = () => useCanonicalLedger.getState() as any;
const assets = (): Asset[] => repo.assetsData;
const total = () => assets().reduce((s, a) => s + a.amount, 0);
const idOf = (name: string) => assets().find(a => a.name === name)?.id as string;
const memoryMap = () => assets().map(a => `${a.id}:${a.amount}`).sort();
const storedMap = async () =>
  (await IndexedDBStorageService.loadAll()).assets.map(a => `${a.id}:${a.amount}`).sort();
const drain = () => new Promise(r => setTimeout(r, 30));
const settle = (p: any) => Promise.resolve(p).then(() => 'ok' as const).catch(() => 'rejected' as const);

function reset() {
  repo.transactionsData = []; repo.assetsData = []; repo.liabilitiesData = [];
  repo.snapshotsData = []; repo.accountsData = []; repo.syncStore();
  useCanonicalLedger.setState({
    transactions: [], assets: [], liabilities: [], snapshots: [], accounts: []
  } as any);
}
function force(rows: Asset[], accounts: Account[] = []) {
  repo.assetsData = rows;
  repo.accountsData = accounts;
  repo.syncStore();
  useCanonicalLedger.setState({ assets: rows, accounts } as any);
}
async function seedPersisted(rows: Asset[], accounts: Account[] = []) {
  force(rows, accounts);
  await IndexedDBStorageService.saveAll({
    transactions: [], assets: rows, liabilities: [], snapshots: [],
    accounts, budgets: [], policies: [], goals: [], profile: null
  });
}
function setValue(el: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function attempt(fn: () => Promise<any>) {
  try { await fn(); return { ok: true, code: null as any, message: '' }; }
  catch (e: any) { return { ok: false, code: e?.code, message: String(e?.message) }; }
}

/** Live view of the workspace, so writes are reflected without re-rendering. */
const Workspace: React.FC = () => {
  const list = useCanonicalLedger(s => s.assets);
  return <AssetsWorkspace assets={list} />;
};

const editBtn = (id: string) => document.querySelector(`[data-asset-edit="${id}"]`) as HTMLButtonElement;
const delBtn = (id: string) => document.querySelector(`[data-asset-delete="${id}"]`) as HTMLButtonElement;
const notice = () => document.getElementById('asset-notice');
const rowIds = () =>
  [...document.querySelectorAll('[data-asset-id]')].map(e => e.getAttribute('data-asset-id'));

/** Holds `persist` open so the pending state can be observed. */
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

describe('WP-FB-DATA-07b — asset lifecycle parity', () => {
  beforeEach(reset);
  afterEach(async () => {
    cleanup();
    await drainWriteQueue();
    IndexedDBStorageService.simulateFailureOnce = false;
    IndexedDBStorageService.simulateReadFailureOnce = false;
    vi.restoreAllMocks();
    await IndexedDBStorageService.loadAll().catch(() => {});
    reset();
  });

  /* ═══════════════ §1 the authority ══════════════════════════════════════ */
  describe('§1 AssetLifecycleService', () => {
    const existing: Asset[] = [
      { id: 'ast-1', name: 'Gold', amount: 500000, type: 'Commodities', currency: 'INR', geography: 'India' },
      { id: 'ast-2', name: 'Flat', amount: 9000000, type: 'Real Estate', currency: 'INR', geography: 'India' }
    ];

    it('planCreate appends — it never upserts on name', () => {
      const plan = AssetLifecycleService.planCreate({ name: 'Gold', amount: 300000 }, existing);
      expect(plan.next).toHaveLength(3);
      expect(plan.next.slice(0, 2)).toEqual(existing);
      expect(AssetIdentityService.isValidId(plan.asset.id)).toBe(true);
    });

    it('Q-D07b-1a: a duplicate NAME is permitted and is NOT a refusal', () => {
      const plan = AssetLifecycleService.planCreate(
        { name: 'Gold', amount: 300000, type: 'Commodities', currency: 'INR', geography: 'India' },
        existing
      );
      expect(plan.next).toHaveLength(3);
      expect(plan.next.filter(a => a.name === 'Gold')).toHaveLength(2);
      // and no DUPLICATE_NAME code exists on this service at all
      expect(Object.keys(AssetLifecycleService)).not.toContain('DUPLICATE_NAME');
    });

    it('planCreate refuses a blank name, a non-numeric amount and a used id', () => {
      expect(() => AssetLifecycleService.planCreate({ name: '  ', amount: 1 }, existing)).toThrowError(/needs a name/);
      expect(() => AssetLifecycleService.planCreate({ name: 'X', amount: NaN }, existing)).toThrowError(/numeric/);
      try {
        AssetLifecycleService.planCreate({ id: 'ast-1', name: 'X', amount: 1 }, existing);
        throw new Error('should have refused');
      } catch (e: any) {
        expect(e).toBeInstanceOf(AssetLifecycleError);
        expect(e.code).toBe('DUPLICATE_ID');
      }
    });

    it('planUpdate refuses an empty id and a missing target', () => {
      for (const [id, code] of [['   ', 'EMPTY_ID'], ['ast-gone', 'ASSET_NOT_FOUND']] as const) {
        try {
          AssetLifecycleService.planUpdate({ id, name: 'A', amount: 1 }, existing);
          throw new Error('should have refused');
        } catch (e: any) { expect(e.code).toBe(code); }
      }
    });

    it('H3 a PADDED id resolves to the stored record — it never appends', () => {
      const plan = AssetLifecycleService.planUpdate(
        { id: '  ast-1  ', name: 'Gold', amount: 7, type: 'Commodities' }, existing
      );
      expect(plan.next).toHaveLength(2);
      expect(plan.asset.id).toBe('ast-1');
      expect(plan.next.map(a => a.id)).toEqual(['ast-1', 'ast-2']);
    });

    it('H5 identity comes from STORAGE, so a forged id cannot rewrite it', () => {
      const plan = AssetLifecycleService.planUpdate({ id: 'ast-1', name: 'Renamed', amount: 1 }, existing);
      expect(plan.asset.id).toBe('ast-1');
      expect(plan.next[1]).toEqual(existing[1]);       // neighbour byte-identical
    });

    it('planDelete removes exactly one row and reports the target', () => {
      const plan = AssetLifecycleService.planDelete('ast-1', existing);
      expect(plan.target).toEqual(existing[0]);
      expect(plan.next).toEqual([existing[1]]);
    });

    it('the editable field set is the whole record except id', () => {
      expect([...ASSET_EDITABLE_FIELDS].sort())
        .toEqual(['amount', 'currency', 'geography', 'name', 'tag', 'type']);
      expect(ASSET_EDITABLE_FIELDS as readonly string[]).not.toContain('id');
    });

    it('describeDeletion quotes name and amount, and discloses the link', () => {
      const plain = AssetLifecycleService.describeDeletion(existing[0]);
      expect(plain).toContain('Gold');
      expect(plain).toContain('500000');
      expect(plain.toLowerCase()).toContain('cannot be undone');

      const linked = AssetLifecycleService.describeDeletion(existing[0], 'HDFC Savings');
      expect(linked).toContain('HDFC Savings');
      expect(linked.toLowerCase()).toContain('link');
      expect(linked.toLowerCase()).toContain('not affected');
    });
  });

  /* ═══════════════ §2 create appends ═════════════════════════════════════ */
  describe('§2 create appends on BOTH paths', () => {
    it('the gate scenario no longer destroys ₹5,00,000', async () => {
      await S().addAssetWithMetadata({ name: 'Gold', amount: 500000, type: 'Commodities' });
      await S().addAssetWithMetadata({ name: 'Gold', amount: 300000, type: 'Commodities' });
      await drain();
      expect(assets()).toHaveLength(2);
      expect(total()).toBe(800000);
      expect(total()).not.toBe(300000);
    });

    it('the OverviewPage quick-add path also appends', async () => {
      await S().addAssetWithMetadata({ name: 'Gold', amount: 500000 });
      await S().addAsset('Gold', 300000);
      await drain();
      expect(assets()).toHaveLength(2);
      expect(total()).toBe(800000);
    });

    it('each row gets its own stable id', async () => {
      await S().addAssetWithMetadata({ name: 'Gold', amount: 1 });
      await S().addAssetWithMetadata({ name: 'Gold', amount: 2 });
      await drain();
      const ids = assets().map(a => a.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every(i => String(i).startsWith('ast-'))).toBe(true);
    });

    it('a refused create performs NO write at all', async () => {
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await attempt(() => S().addAssetWithMetadata({ name: '   ', amount: 1 }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════ §3 edit ═══════════════════════════════════════════════ */
  describe('§3 edit is id-addressed, complete and atomic', () => {
    it('with duplicates present, editing one leaves the other byte-identical', async () => {
      await seedPersisted([
        { id: 'ast-A', name: 'Gold', amount: 500000, type: 'Commodities', currency: 'INR' },
        { id: 'ast-B', name: 'Gold', amount: 300000, type: 'Commodities', currency: 'INR' }
      ]);
      const untouched = JSON.parse(JSON.stringify(assets()[1]));
      await S().updateAsset({ id: 'ast-A', name: 'Gold', amount: 450000, type: 'Commodities', currency: 'INR' });
      await drain();
      expect(assets()[0].amount).toBe(450000);
      expect(assets()[1]).toEqual(untouched);
      expect(total()).toBe(750000);
    });

    it('H4 a stale id REFUSES rather than appending a phantom row', async () => {
      force([{ id: 'ast-A', name: 'Only', amount: 100 }]);
      const r = await attempt(() => S().updateAsset({ id: 'ast-gone', name: 'Ghost', amount: 9999 }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('ASSET_NOT_FOUND');
      expect(assets()).toHaveLength(1);
      expect(total()).toBe(100);
    });

    it('H2 every editable field is carried through — nothing is blanked', async () => {
      force([{ id: 'ast-C', name: 'Fund', amount: 10, type: 'Equity', tag: 'core', currency: 'INR', geography: 'India' }]);
      await S().updateAsset({
        id: 'ast-C', name: 'Fund II', amount: 20, type: 'Debt', tag: 'satellite',
        currency: 'USD', geography: 'International'
      });
      await drain();
      expect(assets()[0]).toEqual({
        id: 'ast-C', name: 'Fund II', amount: 20, type: 'Debt', tag: 'satellite',
        currency: 'USD', geography: 'International'
      });
    });

    it('H3 a padded id edits the right row end to end', async () => {
      force([{ id: 'ast-A', name: 'A', amount: 100 }, { id: 'ast-B', name: 'B', amount: 200 }]);
      await S().updateAsset({ id: ' ast-B ', name: 'B', amount: 250 });
      await drain();
      expect(assets()).toHaveLength(2);
      expect(assets()[1]).toEqual({ id: 'ast-B', name: 'B', amount: 250 });
    });

    it('Q-D07b-1a: renaming ONTO another asset\'s name is allowed', async () => {
      await seedPersisted([
        { id: 'ast-A', name: 'Gold', amount: 100 },
        { id: 'ast-B', name: 'Silver', amount: 200 }
      ]);
      const r = await attempt(() => S().updateAsset({ id: 'ast-B', name: 'Gold', amount: 200 }));
      expect(r.ok).toBe(true);
      await drain();
      expect(assets().filter(a => a.name === 'Gold')).toHaveLength(2);
      expect(total()).toBe(300);
    });

    it('an edit is exactly ONE write', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'A', amount: 1 }]);
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      await S().updateAsset({ id: 'ast-A', name: 'A', amount: 2 });
      await drain();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  /* ═══════════════ §4 delete ═════════════════════════════════════════════ */
  describe('§4 delete (Q-D07b-1b = b)', () => {
    const linkedAccount: Account = {
      id: 'acc-1', name: 'HDFC', type: 'Bank', openingBalance: 1000,
      asOfDate: '2026-08-01', linkedAssetId: 'ast-A'
    } as Account;

    it('with duplicates present, exactly ONE row is removed', async () => {
      await seedPersisted([
        { id: 'ast-A', name: 'Gold', amount: 500000 },
        { id: 'ast-B', name: 'Gold', amount: 300000 }
      ]);
      await S().removeAsset('ast-A');
      await drain();
      expect(assets()).toHaveLength(1);
      expect(assets()[0].id).toBe('ast-B');
      expect(total()).toBe(300000);
    });

    it('deleting a LINKED asset clears the link in the same write', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'Savings', amount: 100000 }], [linkedAccount]);
      repo.transactionsData = [{
        id: 'tx-1', date: '2026-08-10', dateStr: '10 Aug 2026', title: 't', narration: 'T',
        account: 'HDFC', accountId: 'acc-1', direction: 'CREDIT', type: 'Income',
        category: 'Income', amount: 500, status: 'CLEARED', origin: 'MANUAL'
      } as any];
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');

      await S().removeAsset('ast-A');
      await drain();

      expect(assets()).toHaveLength(0);
      expect(repo.accountsData[0].linkedAssetId).toBeFalsy();
      // the account, its transactions and its balance are untouched
      expect(repo.accountsData).toHaveLength(1);
      expect(repo.transactionsData).toHaveLength(1);
      expect(repo.transactionsData[0].accountId).toBe('acc-1');
      // one atomic write for both collections
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1].accounts[0].linkedAssetId).toBeFalsy();
    });

    it('deleting an absent id refuses instead of quietly succeeding', async () => {
      force([{ id: 'ast-A', name: 'A', amount: 1 }]);
      const r = await attempt(() => S().removeAsset('ast-nope'));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('ASSET_NOT_FOUND');
      expect(assets()).toHaveLength(1);
    });

    it('unrelated collections are untouched by a delete', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'A', amount: 1 }, { id: 'ast-B', name: 'B', amount: 2 }]);
      repo.liabilitiesData = [{ id: 'lia-1', name: 'Loan', amount: 500 }];
      repo.snapshotsData = [{ id: 'snap-1', dateStr: '01 Aug 2026', totalAssets: 3, totalLiabilities: 500, netWorth: -497, status: 'Anchored Permanent' } as any];
      const liabBefore = JSON.stringify(repo.liabilitiesData);
      const snapBefore = JSON.stringify(repo.snapshotsData);
      await S().removeAsset('ast-A');
      await drain();
      expect(JSON.stringify(repo.liabilitiesData)).toBe(liabBefore);
      expect(JSON.stringify(repo.snapshotsData)).toBe(snapBefore);   // history is a number, not a reference
    });
  });

  /* ═══════════════ §5 duplicates are distinguishable ═════════════════════ */
  describe('§5 duplicates are permitted AND distinguishable', () => {
    it('no distinguisher is shown for an unambiguous asset', () => {
      const list: Asset[] = [{ id: 'ast-1', name: 'Gold', amount: 1, type: 'Commodities' }];
      expect(AssetLifecycleService.describeDistinguishing(list[0], list)).toBeNull();
    });

    it('metadata distinguishes same-named assets when it can', () => {
      const list: Asset[] = [
        { id: 'ast-1', name: 'Gold', amount: 1, type: 'Commodities' },
        { id: 'ast-2', name: 'Gold', amount: 2, type: 'Equity' }
      ];
      expect(AssetLifecycleService.describeDistinguishing(list[0], list)).toBe('Commodities');
      expect(AssetLifecycleService.describeDistinguishing(list[1], list)).toBe('Equity');
    });

    it('the measured hard case: identical metadata falls back to the identity', () => {
      /* The 07b gate found three "Gold" rows producing only TWO distinct
         name|type|currency|geography fingerprints. Metadata cannot separate the
         pair, so the distinguisher must still be unique. */
      const list: Asset[] = [
        { id: 'ast-1', name: 'Gold', amount: 100000, type: 'Commodities', currency: 'INR', geography: 'India' },
        { id: 'ast-2', name: 'Gold', amount: 250000, type: 'Commodities', currency: 'INR', geography: 'India' },
        { id: 'ast-3', name: 'Gold', amount: 60000, type: 'Equity', currency: 'USD', geography: 'International' }
      ];
      const d1 = AssetLifecycleService.describeDistinguishing(list[0], list);
      const d2 = AssetLifecycleService.describeDistinguishing(list[1], list);
      expect(d1).toMatch(/^ref /);
      expect(d2).toMatch(/^ref /);
      expect(d1).not.toBe(d2);
    });

    it('findDuplicateNames reports without merging', () => {
      const list: Asset[] = [
        { id: 'a', name: 'Gold', amount: 1 },
        { id: 'b', name: 'gold', amount: 2 },
        { id: 'c', name: 'Flat', amount: 3 }
      ];
      expect(AssetLifecycleService.findDuplicateNames(list)).toEqual(['gold']);
    });

    it('the TABLE renders a distinguisher on duplicate rows only', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')); });
      force([
        { id: 'ast-A', name: 'Gold', amount: 100000, type: 'Commodities', currency: 'INR', geography: 'India' },
        { id: 'ast-B', name: 'Gold', amount: 250000, type: 'Commodities', currency: 'INR', geography: 'India' },
        { id: 'ast-C', name: 'Flat', amount: 900000, type: 'Real Estate' }
      ]);
      render(<Workspace />);

      expect(rowIds()).toEqual(['ast-A', 'ast-B', 'ast-C']);
      expect(document.querySelector('[data-asset-distinguisher="ast-A"]')).toBeTruthy();
      expect(document.querySelector('[data-asset-distinguisher="ast-B"]')).toBeTruthy();
      expect(document.querySelector('[data-asset-distinguisher="ast-C"]')).toBeNull();
      // the two duplicate badges differ, so the rows are actually separable
      expect(document.querySelector('[data-asset-distinguisher="ast-A"]')!.textContent)
        .not.toBe(document.querySelector('[data-asset-distinguisher="ast-B"]')!.textContent);
      // and keying on id means no React duplicate-key warning
      expect(errors.join('\n')).not.toContain('same key');
    });

    it('ambiguity is judged against the whole portfolio, not the filtered view', async () => {
      force([
        { id: 'ast-A', name: 'Gold', amount: 100, type: 'Commodities' },
        { id: 'ast-B', name: 'Gold', amount: 200, type: 'Equity' }
      ]);
      render(<Workspace />);
      // filter down to one row by searching its distinguishing type
      const search = document.querySelector('input[placeholder*="Search"]') as HTMLInputElement;
      setValue(search, 'Equity');
      await waitFor(() => expect(rowIds()).toEqual(['ast-B']));
      // it must STILL be marked ambiguous — the twin exists behind the filter
      expect(document.querySelector('[data-asset-distinguisher="ast-B"]')).toBeTruthy();
    });
  });

  /* ═══════════════ §6 failure disclosure ═════════════════════════════════ */
  describe('§6 failures are disclosed', () => {
    it('every store asset action RETURNS its promise', () => {
      const s = S();
      for (const k of ['addAsset', 'addAssetWithMetadata', 'updateAsset', 'removeAsset']) {
        const returned = (() => { try { return s[k]('x', 1); } catch { return undefined; } })();
        expect(typeof returned?.then).toBe('function');
        returned?.catch(() => {});
      }
    });

    it('a persistence failure rejects and rolls memory back exactly', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'A', amount: 100 }]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const r = await attempt(() => S().updateAsset({ id: 'ast-A', name: 'A', amount: 999 }));
      expect(r.ok).toBe(false);
      await drain();
      expect(assets()[0].amount).toBe(100);
      expect(memoryMap()).toEqual(await storedMap());
    });

    it('the ADD modal keeps itself open and shows the real message', async () => {
      render(<Workspace />);
      fireEvent.click([...document.querySelectorAll('button')].find(b => /Add Asset/.test(b.textContent || ''))!);
      // step 1 is a category grid, not a form — pick a category to reach step 2
      await waitFor(() => expect(
        [...document.querySelectorAll('button')].find(b => /Stocks, mutual funds/.test(b.textContent || ''))
      ).toBeTruthy());
      fireEvent.click([...document.querySelectorAll('button')].find(b => /Stocks, mutual funds/.test(b.textContent || ''))!);
      await waitFor(() => expect(document.getElementById('add-asset-submit')).toBeTruthy());

      IndexedDBStorageService.simulateFailureOnce = true;
      const form = document.getElementById('add-asset-submit')!.closest('form')!;
      setValue(form.querySelectorAll('input')[0], 'Gold');
      setValue(form.querySelectorAll('input')[1], '500000');
      fireEvent.submit(form);

      await waitFor(() => expect(document.getElementById('add-asset-error')).toBeTruthy());
      expect(document.getElementById('add-asset-error')!.textContent)
        .toContain('Simulated IndexedDB persistence failure');
      expect(document.getElementById('add-asset-submit')).toBeTruthy();   // still open
      expect(assets()).toHaveLength(0);
    });

    it('the EDIT modal keeps itself open and shows the real message', async () => {
      force([{ id: 'ast-A', name: 'Gold', amount: 100, type: 'Commodities', currency: 'INR' }]);
      render(<Workspace />);
      fireEvent.click(editBtn('ast-A'));
      await waitFor(() => expect(document.getElementById('edit-asset-modal')).toBeTruthy());

      IndexedDBStorageService.simulateFailureOnce = true;
      setValue(document.getElementById('edit-asset-amount')!, '250');
      fireEvent.submit(document.getElementById('edit-asset-submit')!.closest('form')!);

      await waitFor(() => expect(document.getElementById('edit-asset-error')).toBeTruthy());
      expect(document.getElementById('edit-asset-error')!.textContent).toContain('Simulated');
      expect(document.getElementById('edit-asset-modal')).toBeTruthy();
      expect(assets()[0].amount).toBe(100);
    });

    it('a failed DELETE tells the user and keeps the row', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'Gold', amount: 500000 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      IndexedDBStorageService.simulateFailureOnce = true;
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));

      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.getAttribute('data-asset-kind')).toBe('error');
      expect(notice()!.querySelector('strong')!.textContent).toBe('Delete refused.');
      expect(notice()!.textContent).not.toContain('undefined');
      expect(assets()).toHaveLength(1);
    });

    it('the OverviewPage asset quick-add surfaces a failure', async () => {
      const { container } = render(<OverviewPage navigateTo={() => {}} />);
      fireEvent.click(document.getElementById('overview-add-asset')!);
      await waitFor(() => expect(document.getElementById('overview-asset-form')).toBeTruthy());

      IndexedDBStorageService.simulateFailureOnce = true;
      const form = document.getElementById('overview-asset-form') as HTMLFormElement;
      setValue(form.querySelector('input[type="text"]')!, 'Gold');
      setValue(form.querySelector('input[type="number"]')!, '1000');
      fireEvent.submit(form);

      await waitFor(() => expect(container.querySelector('#asset-notice')).toBeTruthy());
      expect(container.querySelector('#asset-notice')!.getAttribute('data-asset-kind')).toBe('error');
      expect(assets()).toHaveLength(0);
    });
  });

  /* ═══════════════ §7 delete UI behaviour ════════════════════════════════ */
  describe('§7 the delete affordance', () => {
    it('the confirmation quotes name AND amount', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'Gold', amount: 500000 }]);
      const seen: string[] = [];
      vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { seen.push(String(m)); return true; });
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));
      await waitFor(() => expect(assets()).toHaveLength(0));
      expect(seen[0]).toContain('Gold');
      expect(seen[0]).toContain('500000');
    });

    it('the confirmation DISCLOSES the account link that will be cleared', async () => {
      await seedPersisted(
        [{ id: 'ast-A', name: 'Savings', amount: 100000 }],
        [{ id: 'acc-1', name: 'HDFC', type: 'Bank', openingBalance: 0, asOfDate: '2026-08-01', linkedAssetId: 'ast-A' } as Account]
      );
      const seen: string[] = [];
      vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { seen.push(String(m)); return true; });
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));
      await waitFor(() => expect(assets()).toHaveLength(0));
      expect(seen[0]).toContain('HDFC');
      expect(seen[0].toLowerCase()).toContain('link');
      expect(notice()!.textContent).toContain('HDFC');
    });

    it('declining the confirmation writes NOTHING', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'Gold', amount: 500000 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const spy = vi.spyOn(IndexedDBStorageService, 'persist');
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));
      await drain();
      expect(spy).not.toHaveBeenCalled();
      expect(assets()).toHaveLength(1);
    });

    it('the row STAYS VISIBLE and disabled while its delete is pending', async () => {
      force([{ id: 'ast-A', name: 'A', amount: 100 }, { id: 'ast-B', name: 'B', amount: 200 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { release } = gatePersist();
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));

      await waitFor(() => expect(delBtn('ast-A').matches(':disabled')).toBe(true));
      expect(delBtn('ast-A').getAttribute('data-asset-delete-busy')).toBe('true');
      expect(delBtn('ast-A').textContent).toContain('Deleting');
      expect(rowIds()).toEqual(['ast-A', 'ast-B']);     // still on screen, in place
      expect(notice()).toBeNull();                       // nothing claimed yet
      expect(delBtn('ast-B').matches(':disabled')).toBe(false);   // only the pending row

      release();
      await waitFor(() => expect(assets().map(a => a.id)).toEqual(['ast-B']));
    });

    it('a second delete is REFUSED, out loud, while one is in flight', async () => {
      force([{ id: 'ast-A', name: 'A', amount: 100 }, { id: 'ast-B', name: 'B', amount: 200 }]);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { release } = gatePersist();
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));
      await waitFor(() => expect(delBtn('ast-A').matches(':disabled')).toBe(true));

      fireEvent.click(delBtn('ast-B'));
      await waitFor(() => expect(notice()).toBeTruthy());
      expect(notice()!.querySelector('strong')!.textContent).toBe('One delete at a time.');
      expect(confirmSpy).toHaveBeenCalledTimes(1);

      release();
      await waitFor(() => expect(assets().map(a => a.id)).toEqual(['ast-B']));
    });

    it('the control re-enables after success and after failure', async () => {
      await seedPersisted([{ id: 'ast-A', name: 'A', amount: 100 }, { id: 'ast-B', name: 'B', amount: 200 }]);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      IndexedDBStorageService.simulateFailureOnce = true;
      render(<Workspace />);
      fireEvent.click(delBtn('ast-A'));

      await waitFor(() => expect(notice()!.getAttribute('data-asset-kind')).toBe('error'));
      await waitFor(() => expect(delBtn('ast-A').matches(':disabled')).toBe(false));
      expect(delBtn('ast-A').textContent).not.toContain('Deleting');

      fireEvent.click(delBtn('ast-A'));
      await waitFor(() => expect(assets().map(a => a.id)).toEqual(['ast-B']));
      await waitFor(() => expect(delBtn('ast-B').matches(':disabled')).toBe(false));
    });
  });

  /* ═══════════════ §8 overlap + scope ════════════════════════════════════ */
  describe('§8 overlapping writes and scope boundary', () => {
    it('a failed asset write does not erase a concurrent successful one', async () => {
      await seedPersisted([
        { id: 'ast-X', name: 'X', amount: 100 },
        { id: 'ast-Y', name: 'Y', amount: 200 },
        { id: 'ast-Z', name: 'Z', amount: 300 }
      ]);
      IndexedDBStorageService.simulateFailureOnce = true;
      const first = settle(S().removeAsset('ast-X'));
      const second = settle(S().removeAsset('ast-Y'));
      expect({ x: await first, y: await second }).toEqual({ x: 'rejected', y: 'ok' });
      await drain();

      const memory = memoryMap();
      expect(memory).toEqual(await storedMap());
      expect(memory).toContain('ast-X:100');       // the failed delete was undone
      expect(memory).not.toContain('ast-Y:200');   // the successful one stands
      expect(memory).toContain('ast-Z:300');
    });

    it('no soft-delete vocabulary was introduced on Asset', async () => {
      await S().addAssetWithMetadata({ name: 'A', amount: 1, type: 'Equity', currency: 'INR' });
      await drain();
      expect(Object.keys(assets()[0]).sort()).toEqual(['amount', 'currency', 'id', 'name', 'type']);
      for (const forbidden of ['excludedAt', 'excludedReason', 'archived', 'status', 'restoredAt', 'supersedes']) {
        expect(assets()[0]).not.toHaveProperty(forbidden);
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

    it('the asset store surface is exactly the authorised one', () => {
      const s = S();
      expect(Object.keys(s).filter(k => /^(add|update|remove).*Asset/i.test(k)).sort())
        .toEqual(['addAsset', 'addAssetWithMetadata', 'removeAsset', 'updateAsset']);
      for (const k of ['editAsset', 'renameAsset', 'archiveAsset', 'restoreAsset', 'undoAsset']) {
        expect(typeof s[k]).toBe('undefined');
      }
    });

    it('liability duplicate-name policy is untouched by the asset decision', async () => {
      await S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 100 });
      await drain();
      const r = await attempt(() => S().addLiabilityWithMetadata({ name: 'Home Loan', amount: 200 }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DUPLICATE_NAME');     // liabilities still REFUSE
    });

    it('the Prisma adapter mirrors the asset lifecycle policy', async () => {
      const { PrismaAssetRepository } = await import('../repositories/PrismaRepository');
      const p = new PrismaAssetRepository();
      const spy = vi.spyOn(AssetLifecycleService, 'planCreate');
      await p.add({ name: 'Gold', amount: 1 } as Asset);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
