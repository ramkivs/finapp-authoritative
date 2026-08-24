/**
 * WP-FB-IMPORT-BROKER-01 — D-02 lifecycle planner.
 *
 * Pure functions for create / update / close. No persistence, no UI.
 * Mirrors the AssetLifecycleService shape but WITHOUT a `compose()`
 * whitelist — every Holding field is round-tripped by construction.
 *
 * Authority decisions honoured:
 *   - identity is computed, not stored;
 *   - re-import is idempotent (the import pipeline uses `findByIdentitySync`
 *     and dispatches create vs update accordingly);
 *   - no automatic destructive deletion (`close` is a status change, not a
 *     remove);
 *   - no Lot entity.
 */

import { Holding, HoldingStatus } from '../domain/types';
import { HoldingIdentityService } from './HoldingIdentityService';

export class HoldingLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HoldingLifecycleError';
  }
}

export interface HoldingCreatePlan {
  holding: Holding;
  next: Holding[];
}

export interface HoldingUpdatePlan {
  holding: Holding;
  next: Holding[];
}

export interface HoldingClosePlan {
  holding: Holding;
  next: Holding[];
}

/**
 * Defensive validation: rejects NaN / Infinity in numeric fields and negative
 * quantity. The repository should also enforce these, but the lifecycle layer
 * rejects them at the planning stage so the import pipeline never produces
 * a record that the repository would reject.
 */
function requireFiniteNonNegativeNumber(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HoldingLifecycleError(
      'INVALID_NUMERIC',
      `Holding field "${field}" must be a finite number; received ${String(value)}`,
    );
  }
  if (value < 0) {
    throw new HoldingLifecycleError(
      'INVALID_NUMERIC',
      `Holding field "${field}" must be non-negative; received ${value}`,
    );
  }
  return value;
}

function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HoldingLifecycleError(
      'INVALID_STRING',
      `Holding field "${field}" must be a non-empty string; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function normaliseHolding(h: Holding): Holding {
  return {
    ...h,
    broker: requireNonEmptyString(h.broker, 'broker').trim(),
    instrumentName: requireNonEmptyString(h.instrumentName, 'instrumentName'),
    account: h.account === '' ? undefined : h.account,
    isin: h.isin && h.isin.trim() !== '' ? h.isin.trim() : undefined,
    ticker: h.ticker && h.ticker.trim() !== '' ? h.ticker.trim() : undefined,
    securityClassification:
      h.securityClassification && h.securityClassification.trim() !== ''
        ? h.securityClassification
        : undefined,
    quantity: requireFiniteNonNegativeNumber(h.quantity, 'quantity'),
    averageCost: requireFiniteNonNegativeNumber(h.averageCost, 'averageCost'),
    investedValue: requireFiniteNonNegativeNumber(h.investedValue, 'investedValue'),
    currentPrice: requireFiniteNonNegativeNumber(h.currentPrice, 'currentPrice'),
    currentValue: requireFiniteNonNegativeNumber(h.currentValue, 'currentValue'),
    unrealisedPnL: (() => {
      if (typeof h.unrealisedPnL !== 'number' || !Number.isFinite(h.unrealisedPnL)) {
        throw new HoldingLifecycleError(
          'INVALID_NUMERIC',
          `Holding field "unrealisedPnL" must be a finite number; received ${String(h.unrealisedPnL)}`,
        );
      }
      return h.unrealisedPnL;
    })(),
    sourceFile: requireNonEmptyString(h.sourceFile, 'sourceFile'),
    importedAt: requireNonEmptyString(h.importedAt, 'importedAt'),
    status: h.status,
  };
}

export class HoldingLifecycleService {
  /**
   * CREATE. Always appends. Refuses a duplicate identity against the
   * existing set. Caller is responsible for generating the id via
   * HoldingIdentityService.generateId (or supplying one for deterministic
   * imports).
   */
  static planCreate(request: Holding, existing: Holding[]): HoldingCreatePlan {
    if (!request.id || request.id.trim() === '') {
      throw new HoldingLifecycleError(
        'MISSING_ID',
        'HoldingLifecycleService.planCreate requires a non-empty id. Use HoldingIdentityService.generateId.',
      );
    }
    if (existing.some(h => h.id === request.id)) {
      throw new HoldingLifecycleError(
        'DUPLICATE_ID',
        `A holding with id "${request.id}" already exists. Edit it instead of creating a second one.`,
      );
    }
    const candidate = normaliseHolding(request);
    const conflict = existing.find(h => HoldingIdentityService.sameIdentity(h, candidate));
    if (conflict) {
      throw new HoldingLifecycleError(
        'DUPLICATE_IDENTITY',
        `A holding with the same (broker, account, instrument) identity already exists (id="${conflict.id}"). Update it instead of creating a second one.`,
      );
    }
    return { holding: candidate, next: [...existing, candidate] };
  }

  /**
   * UPDATE. Replaces the complete record addressed by `id`. Refuses an id
   * that is not present. Refuses an identity change.
   */
  static planUpdate(request: Holding, existing: Holding[]): HoldingUpdatePlan {
    if (!request.id || request.id.trim() === '') {
      throw new HoldingLifecycleError(
        'MISSING_ID',
        'HoldingLifecycleService.planUpdate requires a non-empty id.',
      );
    }
    const index = existing.findIndex(h => h.id === request.id);
    if (index < 0) {
      throw new HoldingLifecycleError(
        'NOT_FOUND',
        `Holding with id "${request.id}" does not exist.`,
      );
    }
    const candidate = normaliseHolding(request);
    const identityChanged = !HoldingIdentityService.sameIdentity(existing[index], candidate);
    if (identityChanged) {
      throw new HoldingLifecycleError(
        'IDENTITY_CHANGE_FORBIDDEN',
        `Holding identity cannot change across an update. To move a holding to a new (broker, account, instrument), remove the old and add the new explicitly.`,
      );
    }
    const next = [...existing];
    next[index] = candidate;
    return { holding: candidate, next };
  }

  /**
   * CLOSE. Marks the holding as `closed_absent`. This is NOT a remove; the
   * record stays in the canonical collection. The "disappeared holdings"
   * policy (D-02) requires user-confirmed destructive removal, which is a
   * WP-08 / UI concern. This planner provides the `closed_absent` transition.
   */
  static planClose(id: string, existing: Holding[], asOf: string): HoldingClosePlan {
    if (!id || id.trim() === '') {
      throw new HoldingLifecycleError('MISSING_ID', 'HoldingLifecycleService.planClose requires a non-empty id.');
    }
    const index = existing.findIndex(h => h.id === id);
    if (index < 0) {
      throw new HoldingLifecycleError('NOT_FOUND', `Holding with id "${id}" does not exist.`);
    }
    if (existing[index].status === 'closed_absent') {
      throw new HoldingLifecycleError(
        'ALREADY_CLOSED',
        `Holding "${id}" is already closed_absent.`,
      );
    }
    const closed: Holding = {
      ...existing[index],
      status: 'closed_absent' as HoldingStatus,
      importedAt: asOf,
    };
    const next = [...existing];
    next[index] = closed;
    return { holding: closed, next };
  }
}
