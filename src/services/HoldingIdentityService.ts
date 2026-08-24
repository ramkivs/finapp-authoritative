/**
 * WP-FB-IMPORT-BROKER-01 — D-02 identity.
 *
 * Authority-mandated identity rule:
 *
 *   if account exists:  (broker, account, instrument)
 *   else:                (broker, instrument)
 *
 * Instrument precedence: ISIN > TICKER > normalized NAME.
 *
 * The identity function is pure. The (broker, account?, instrument) tuple
 * is canonical; the (broker, account?, instrumentKind) payload in
 * HoldingIdentity is for diagnostics and tests.
 *
 * Normalisation re-uses AssetIdentityService.normalizeName so that the
 * canonical Holding identity model shares the existing project convention.
 */

import { AssetIdentityService } from './AssetIdentityService';
import { Holding } from '../domain/types';

export type InstrumentKind = 'ISIN' | 'TICKER' | 'NAME';

export interface HoldingIdentity {
  broker: string;
  account?: string;
  /** Strongest available instrument identifier, normalised. */
  instrument: string;
  /** Which kind of identifier was used. */
  instrumentKind: InstrumentKind;
}

export class HoldingIdentityService {
  /**
   * Returns the canonical identity of a Holding.
   *
   * Precedence: ISIN > TICKER > normalized NAME.
   * `account === undefined` is preserved as `undefined` (it is a distinct
   * identity from any non-undefined value).
   */
  static identityOf(h: Holding): HoldingIdentity {
    const broker = (h.broker ?? '').trim();
    if (!broker) {
      throw new Error('HoldingIdentityService.identityOf: broker is required');
    }
    const account = h.account === undefined ? undefined
                  : h.account === '' ? undefined
                  : h.account;

    if (h.isin && h.isin.trim() !== '') {
      return {
        broker,
        account,
        instrument: h.isin.trim(),
        instrumentKind: 'ISIN',
      };
    }
    if (h.ticker && h.ticker.trim() !== '') {
      return {
        broker,
        account,
        instrument: AssetIdentityService.normalizeName(h.ticker),
        instrumentKind: 'TICKER',
      };
    }
    return {
      broker,
      account,
      instrument: AssetIdentityService.normalizeName(h.instrumentName ?? ''),
      instrumentKind: 'NAME',
    };
  }

  /**
   * Returns true iff two holdings share the same business identity, per the
   * authority decision (broker-conditional):
   *
   *   if account exists:  (broker, account, instrument) match
   *   else:                (broker, instrument) match
   *
   * "account exists" means: not undefined and not empty.
   * "instrument" means: the strongest available identifier, normalised.
   */
  static sameIdentity(a: Holding, b: Holding): boolean {
    const ia = HoldingIdentityService.identityOf(a);
    const ib = HoldingIdentityService.identityOf(b);
    if (ia.broker !== ib.broker) return false;
    // undefined-vs-explicit-account is a distinct identity.
    if ((ia.account ?? '__UNDEFINED__') !== (ib.account ?? '__UNDEFINED__')) return false;
    return ia.instrument === ib.instrument;
  }

  /**
   * Stable, unique, non-user-editable id. Prefers dependency-free
   * `crypto.randomUUID()`; falls back to `<prefix>-<timestamp>-<random>`.
   * Mirrors the existing AssetIdentityService.generateId convention.
   */
  static generateId(): string {
    const c: any = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return `hld-${c.randomUUID()}`;
    return `hld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
