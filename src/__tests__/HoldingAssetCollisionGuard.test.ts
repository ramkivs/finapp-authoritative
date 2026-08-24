/**
 * WP-FB-IMPORT-BROKER-01 — D-04 collision guard tests.
 */
import { describe, it, expect } from 'vitest';
import {
  HoldingAssetCollisionGuard,
  AssetWriteRequestWithCollisionIdentity,
} from '../services/HoldingAssetCollisionGuard';
import { Holding, HoldingStatus } from '../domain/types';
import { AssetLifecycleService } from '../services/AssetLifecycleService';

const baseHolding = (overrides: Partial<Holding> = {}): Holding => ({
  id: 'hld-1',
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

const baseRequest = (overrides: Partial<AssetWriteRequestWithCollisionIdentity> = {}): AssetWriteRequestWithCollisionIdentity => ({
  name: 'Manual',
  amount: 1000,
  ...overrides,
});

describe('WP-FB-IMPORT-BROKER-01 — D-04 HoldingAssetCollisionGuard', () => {
  it('returns null when no broker is supplied (non-broker manual Asset)', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest(),
      [baseHolding()],
    );
    expect(collision).toBeNull();
  });

  it('returns null when broker is empty string', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: '' }),
      [baseHolding()],
    );
    expect(collision).toBeNull();
  });

  it('returns null when no holdings exist', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Zerodha', account: 'X', instrument: 'AIIL' }),
      [],
    );
    expect(collision).toBeNull();
  });

  it('blocks when (broker, account, instrument) matches an imported Holding', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Zerodha', account: 'UCC-A', instrument: 'AIIL' }),
      [baseHolding({ broker: 'Zerodha', account: 'UCC-A', ticker: 'AIIL' })],
    );
    expect(collision).not.toBeNull();
    expect(collision?.holding.id).toBe('hld-1');
  });

  it('blocks when broker and instrument match and account is undefined on both', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Dhan', account: undefined, instrument: 'AGI Greenpac' }),
      [baseHolding({ broker: 'Dhan', account: undefined, instrumentName: 'AGI Greenpac' })],
    );
    expect(collision).not.toBeNull();
  });

  it('allows when broker differs', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Zerodha', instrument: 'AIIL' }),
      [baseHolding({ broker: 'Dhan', instrumentName: 'AIIL Industries' })],
    );
    expect(collision).toBeNull();
  });

  it('allows when account differs', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Dhan', account: 'UCC-A', instrument: 'Fund X' }),
      [baseHolding({ broker: 'Dhan', account: 'UCC-B', instrumentName: 'Fund X' })],
    );
    expect(collision).toBeNull();
  });

  it('allows when instrument differs', () => {
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Zerodha', instrument: 'AIIL' }),
      [baseHolding({ broker: 'Zerodha', instrumentName: 'BHEL' })],
    );
    expect(collision).toBeNull();
  });

  it('preserves undefined-vs-explicit account semantics (D-02)', () => {
    // Holding with explicit account.
    const holding = baseHolding({ broker: 'Z', account: 'X', instrumentName: 'Fund' });
    // Request with no account — D-02 says undefined != explicit.
    const collision = HoldingAssetCollisionGuard.detect(
      baseRequest({ broker: 'Z', account: undefined, instrument: 'Fund' }),
      [holding],
    );
    expect(collision).toBeNull();
  });

  it('integrates with AssetLifecycleService.planCreate', () => {
    const existing = baseHolding({ broker: 'Z', account: 'A', ticker: 'X' });
    try {
      AssetLifecycleService.planCreate(
        { name: 'Manual', amount: 100, broker: 'Z', account: 'A', instrument: 'X' } as any,
        [],
        [existing],
      );
      expect.fail('expected to throw');
    } catch (e: any) {
      expect(e.code).toBe('HOLDING_COLLISION');
    }
  });

  it('integrates with AssetLifecycleService.planUpdate', () => {
    const existing = baseHolding({ broker: 'Z', account: 'A', ticker: 'X' });
    const existingAsset = { id: 'ast-1', name: 'Pre', amount: 100 };
    try {
      AssetLifecycleService.planUpdate(
        { id: 'ast-1', name: 'New', amount: 200, broker: 'Z', account: 'A', instrument: 'X' } as any,
        [existingAsset],
        [existing],
      );
      expect.fail('expected to throw');
    } catch (e: any) {
      expect(e.code).toBe('HOLDING_COLLISION');
    }
  });
});
