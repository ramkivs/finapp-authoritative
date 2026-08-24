/**
 * WP-FB-IMPORT-BROKER-01 — D-04 collision guard.
 *
 * Authority decision:
 *   A manual Asset representing the same broker/account/instrument economic
 *   position as an imported Holding must be BLOCKED to prevent double counting.
 *
 * Implementation rules:
 *   - The existing Asset type is NOT modified.
 *   - AssetLifecycleService.compose() is NOT modified.
 *   - Manual non-broker Assets (no broker?/account?/instrument? in the
 *     request) are NEVER blocked. "My house" Assets pass.
 *   - A broker/account/instrument candidate can be checked against Holdings.
 *   - Matching identity is blocked.
 *   - Different broker / account / instrument is allowed.
 *   - undefined vs explicit account follows the approved identity semantics.
 *
 * The candidate carries broker?/account?/instrument? as OPTIONAL DTO fields
 * on AssetWriteRequest. These are NOT part of the Asset interface; they are
 * only on the request DTO consumed by the guard.
 */

import { Holding } from '../domain/types';
import { HoldingIdentityService } from './HoldingIdentityService';
import type { AssetWriteRequest } from './AssetLifecycleService';

/**
 * Extended AssetWriteRequest with optional collision-identity DTO fields.
 * These are NOT persisted on the Asset; they are consumed by the guard.
 */
export interface AssetWriteRequestWithCollisionIdentity extends AssetWriteRequest {
  broker?: string;
  account?: string;
  instrument?: string;
}

export interface HoldingCollision {
  holding: Holding;
  reason: string;
}

export class HoldingAssetCollisionGuard {
  /**
   * Returns a non-null collision if the candidate request would create or
   * update a manual Asset that collides with an imported Holding. Returns
   * null if no collision.
   *
   * A request without `broker?` is treated as a non-broker manual Asset
   * and is never blocked. A request WITH `broker?` but without
   * `account?` is treated as account-undefined (per D-02 broker-conditional
   * identity: identity = (broker, instrument) when account is absent).
   */
  static detect(
    request: AssetWriteRequestWithCollisionIdentity,
    holdings: readonly Holding[],
  ): HoldingCollision | null {
    if (!request.broker || request.broker.trim() === '') {
      // Non-broker manual Asset: never blocked.
      return null;
    }

    const candidateBroker = request.broker.trim();
    const candidateAccount = request.account === '' ? undefined : request.account;

    // Build a synthetic Holding identity basis from the request. We do NOT
    // need the full Holding — we only need the (broker, account?, instrument)
    // tuple. We do not require an ISIN or ticker here because the request
    // DTO does not carry them. The identity is the broker-scoped normalised
    // instrument name supplied by the request, or, if absent, the request's
    // `name` (mirroring the manual Asset display label).
    const instrumentName = request.instrument && request.instrument.trim() !== ''
      ? request.instrument
      : (typeof request.name === 'string' ? request.name : '');

    if (!instrumentName) {
      // Without an instrument identity, we cannot perform a meaningful
      // collision check. We do NOT block the operation; this is the
      // conservative financial-integrity decision (failing to block a
      // collision is worse than false-negatives, but failing to allow a
      // legitimate manual Asset is also bad). The UI is responsible for
      // supplying `instrument?` when the Asset is broker-aggregated.
      return null;
    }

    const syntheticHolding: Holding = {
      id: '__candidate__',
      broker: candidateBroker,
      account: candidateAccount,
      instrumentName,
      quantity: 0,
      averageCost: 0,
      investedValue: 0,
      currentPrice: 0,
      currentValue: 0,
      unrealisedPnL: 0,
      sourceFile: '__candidate__',
      importedAt: '',
      status: 'active',
    };

    for (const h of holdings) {
      if (HoldingIdentityService.sameIdentity(syntheticHolding, h)) {
        return {
          holding: h,
          reason:
            `A manual Asset with the same (broker="${candidateBroker}", ` +
            `account=${JSON.stringify(candidateAccount)}, instrument="${instrumentName}") ` +
            `identity is blocked because an imported Holding (id="${h.id}") ` +
            `already represents the same economic position. The imported ` +
            `Holding is authoritative for the current value.`,
        };
      }
    }
    return null;
  }
}
