/**
 * WP-FB-IMPORT-BROKER-01 — D-02 identity tests.
 *
 * Verifies the 8 authority examples and the broker-conditional identity rule.
 */
import { describe, it, expect } from 'vitest';
import { HoldingIdentityService } from '../services/HoldingIdentityService';
import { Holding, HoldingStatus } from '../domain/types';

const base = (overrides: Partial<Holding> = {}): Holding => ({
  id: 'hld-test',
  broker: 'TestBroker',
  instrumentName: 'Test Instrument',
  quantity: 10,
  averageCost: 100,
  investedValue: 1000,
  currentPrice: 110,
  currentValue: 1100,
  unrealisedPnL: 100,
  sourceFile: 'test.csv',
  importedAt: '2026-08-23T10:00:00.000Z',
  status: 'active' as HoldingStatus,
  ...overrides,
});

describe('WP-FB-IMPORT-BROKER-01 — D-02 Holding identity', () => {
  describe('precedence: ISIN > TICKER > NAME', () => {
    it('uses ISIN when present', () => {
      const h = base({ isin: 'INF179KC1981', ticker: 'XYZ', instrumentName: 'Some Fund' });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.instrument).toBe('INF179KC1981');
      expect(id.instrumentKind).toBe('ISIN');
    });

    it('uses TICKER when ISIN absent', () => {
      const h = base({ ticker: 'AIIL', instrumentName: 'AIIL Full Name Ltd' });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.instrument).toBe('aiil');
      expect(id.instrumentKind).toBe('TICKER');
    });

    it('uses normalised NAME when ISIN and TICKER absent', () => {
      const h = base({ instrumentName: '  Some   Fund  Name  ' });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.instrument).toBe('some fund name');
      expect(id.instrumentKind).toBe('NAME');
    });

    it('prefers ISIN over TICKER over NAME when all are present', () => {
      const h = base({
        isin: 'INF179KC1981',
        ticker: 'XYZ',
        instrumentName: 'Yet Another Name',
      });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.instrumentKind).toBe('ISIN');
    });

    it('treats empty ISIN as absent', () => {
      const h = base({ isin: '', ticker: 'AIIL', instrumentName: 'Anything' });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.instrumentKind).toBe('TICKER');
    });
  });

  describe('8 authority example cases', () => {
    it('1. Groww + account + ISIN', () => {
      const h = base({
        broker: 'Groww',
        account: 'UCC-6995348108',
        isin: 'INF179KC1981',
        instrumentName: 'HDFC GOLD ETF',
      });
      const id = HoldingIdentityService.identityOf(h);
      expect(id).toEqual({
        broker: 'Groww',
        account: 'UCC-6995348108',
        instrument: 'INF179KC1981',
        instrumentKind: 'ISIN',
      });
    });

    it('2. Dhan MF + account + instrument name', () => {
      const h = base({
        broker: 'Dhan',
        account: 'IQCX28849K',
        instrumentName: 'Axis Nifty Midcap 50 Index Fund Direct Growth',
      });
      const id = HoldingIdentityService.identityOf(h);
      expect(id).toEqual({
        broker: 'Dhan',
        account: 'IQCX28849K',
        instrument: 'axis nifty midcap 50 index fund direct growth',
        instrumentKind: 'NAME',
      });
    });

    it('3. Dhan Equity without account', () => {
      const h = base({
        broker: 'Dhan',
        account: undefined,
        instrumentName: 'AGI Greenpac',
      });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.account).toBeUndefined();
      expect(id.instrument).toBe('agi greenpac');
    });

    it('4. Zerodha Equity without account + ticker', () => {
      const h = base({
        broker: 'Zerodha',
        account: undefined,
        ticker: 'AIIL',
        instrumentName: 'AIIL Industries',
      });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.broker).toBe('Zerodha');
      expect(id.account).toBeUndefined();
      expect(id.instrument).toBe('aiil');
      expect(id.instrumentKind).toBe('TICKER');
    });

    it('5. same instrument at two brokers → DIFFERENT identities', () => {
      const a = base({ broker: 'Zerodha', ticker: 'AIIL' });
      const b = base({ id: 'hld-test-2', broker: 'Dhan', instrumentName: 'AIIL Industries' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
    });

    it('6. same broker + different explicit accounts → DISTINCT', () => {
      const a = base({ account: 'UCC-A', instrumentName: 'Fund X' });
      const b = base({ id: 'hld-test-2', account: 'UCC-B', instrumentName: 'Fund X' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
    });

    it('7. same broker/instrument + both account undefined → SAME (collapsed)', () => {
      const a = base({ account: undefined, instrumentName: 'Fund X' });
      const b = base({ id: 'hld-test-2', account: undefined, instrumentName: 'Fund X' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(true);
    });

    it('8. undefined account vs explicit account → DIFFERENT (distinct identities)', () => {
      const a = base({ account: undefined, instrumentName: 'Fund X' });
      const b = base({ id: 'hld-test-2', account: 'X', instrumentName: 'Fund X' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
    });
  });

  describe('normalisation', () => {
    it('trims and lowercases broker', () => {
      const h = base({ broker: '  zerodha  ' });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.broker).toBe('zerodha');
    });

    it('preserves undefined account unchanged', () => {
      const h = base({ account: undefined });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.account).toBeUndefined();
    });

    it('normalises empty-string account to undefined', () => {
      const h = base({ account: '' });
      const id = HoldingIdentityService.identityOf(h);
      expect(id.account).toBeUndefined();
    });
  });

  describe('sameIdentity edge cases', () => {
    it('rejects when broker differs', () => {
      const a = base({ broker: 'Zerodha', ticker: 'AIIL' });
      const b = base({ id: 'hld-2', broker: 'Dhan', ticker: 'AIIL' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
    });

    it('rejects when instrument name differs after normalisation', () => {
      const a = base({ instrumentName: 'Fund X' });
      const b = base({ id: 'hld-2', instrumentName: 'Fund Y' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(false);
    });

    it('treats whitespace-different names as same after normalisation', () => {
      const a = base({ instrumentName: 'Fund X' });
      const b = base({ id: 'hld-2', instrumentName: '  FUND   X  ' });
      expect(HoldingIdentityService.sameIdentity(a, b)).toBe(true);
    });
  });

  describe('generateId', () => {
    it('produces a hld-prefixed id', () => {
      const id = HoldingIdentityService.generateId();
      expect(id.startsWith('hld-')).toBe(true);
    });

    it('produces unique ids', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(HoldingIdentityService.generateId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('identityOf requires broker', () => {
    it('throws when broker is empty', () => {
      const h = base({ broker: '' });
      expect(() => HoldingIdentityService.identityOf(h)).toThrow(/broker is required/);
    });
  });
});
