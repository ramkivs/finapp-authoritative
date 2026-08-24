/**
 * WP-FB-IMPORT-BROKER-01 — D-04 Wealth integration tests.
 *
 * Verifies:
 *  - Holding.currentValue contributes to wealth;
 *  - Holding.investedValue does NOT contribute;
 *  - Asset-only wealth is unchanged;
 *  - Holding-only wealth works;
 *  - Mixed Asset + Holding wealth is the sum.
 */
import { describe, it, expect } from 'vitest';
import { HoldingWealthBridge } from '../services/HoldingWealthBridge';
import { Asset, Holding, HoldingStatus } from '../domain/types';

const holding = (overrides: Partial<Holding> = {}): Holding => ({
  id: 'hld-1',
  broker: 'TestBroker',
  instrumentName: 'Test',
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

const asset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'ast-1',
  name: 'Manual',
  amount: 1000,
  ...overrides,
});

describe('WP-FB-IMPORT-BROKER-01 — D-04 Wealth integration', () => {
  it('Asset-only wealth is the sum of asset.amount', () => {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(
      [asset({ amount: 1000 }), asset({ id: 'ast-2', amount: 2000 })],
      [],
    );
    expect(total).toBe(3000);
  });

  it('Holding-only wealth is the sum of holding.currentValue', () => {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(
      [],
      [holding({ currentValue: 500 }), holding({ id: 'hld-2', currentValue: 1500 })],
    );
    expect(total).toBe(2000);
  });

  it('mixed Asset + Holding wealth is the sum of both', () => {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(
      [asset({ amount: 1000 })],
      [holding({ currentValue: 2500 })],
    );
    expect(total).toBe(3500);
  });

  it('Holding.investedValue does NOT contribute', () => {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(
      [],
      [holding({ currentValue: 1000, investedValue: 9999 })],
    );
    // If investedValue had been included, the total would be 10999.
    expect(total).toBe(1000);
  });

  it('empty arrays produce 0', () => {
    expect(HoldingWealthBridge.aggregateAssetsAndHoldings([], [])).toBe(0);
  });

  it('treats non-numeric amount as 0 (defensive)', () => {
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(
      [asset({ amount: 'NaN' as any })],
      [],
    );
    expect(total).toBe(0);
  });

  it('closed_absent holdings still contribute currentValue (D-02 lifecycle, not D-04)', () => {
    // D-04 says: imported Holdings contribute their currentValue to Wealth.
    // D-02 lifecycle says: closed_absent is the disappeared state.
    // The collision of the two is a future product decision. For V1, the
    // simplest, most-conservative rule is: include all Holdings, regardless
    // of status, because their currentValue is a financial fact.
    // Documented here so the future gate can revisit.
    const total = HoldingWealthBridge.aggregateAssetsAndHoldings(
      [],
      [holding({ status: 'closed_absent' as HoldingStatus, currentValue: 500 })],
    );
    expect(total).toBe(500);
  });
});
