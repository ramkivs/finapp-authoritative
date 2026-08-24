/**
 * WP-FB-IMPORT-BROKER-01 — In-memory implementation of HoldingRepository.
 *
 * Mirrors the MemoryAssetRepository / MemoryLiabilityRepository pattern.
 * Holds a reference to the parent MemoryRepository so that mutations can
 * call `parent.syncStore()` and so that the atomicity boundary
 * (parent.write) is honoured.
 *
 * The repository itself is NOT lock-aware: it operates inside the
 * parent's `write()` boundary, which holds the IndexedDB lease.
 */

import { Holding, HoldingRepository, HoldingStatus } from '../domain/types';
import { HoldingIdentityService } from '../services/HoldingIdentityService';
import { HoldingLifecycleService, HoldingLifecycleError } from '../services/HoldingLifecycleService';

export class MemoryHoldingRepository implements HoldingRepository {
  constructor(private readonly parent: { holdingsData: Holding[]; syncStore: () => void }) {}

  async findAll(): Promise<Holding[]> {
    return [...this.parent.holdingsData];
  }

  findAllSync(): Holding[] {
    return [...this.parent.holdingsData];
  }

  async add(holding: Holding): Promise<void> {
    const plan = HoldingLifecycleService.planCreate(holding, this.parent.holdingsData);
    this.parent.holdingsData.length = 0;
    this.parent.holdingsData.push(...plan.next);
    this.parent.syncStore();
  }

  async update(holding: Holding): Promise<void> {
    const plan = HoldingLifecycleService.planUpdate(holding, this.parent.holdingsData);
    this.parent.holdingsData.length = 0;
    this.parent.holdingsData.push(...plan.next);
    this.parent.syncStore();
  }

  findByIdSync(id: string): Holding | null {
    return this.parent.holdingsData.find(h => h.id === id) ?? null;
  }

  findByIdentitySync(h: Holding): Holding | null {
    return (
      this.parent.holdingsData.find(existing => HoldingIdentityService.sameIdentity(existing, h)) ??
      null
    );
  }

  async saveMany(holdings: Holding[]): Promise<void> {
    // Validate every record against the existing set AND within the batch.
    // A duplicate within the batch or against existing holdings refuses
    // the whole batch (the import pipeline must deduplicate first).
    let next = [...this.parent.holdingsData];
    for (const candidateRaw of holdings) {
      const plan = HoldingLifecycleService.planCreate(candidateRaw, next);
      next = plan.next;
    }
    this.parent.holdingsData.length = 0;
    this.parent.holdingsData.push(...next);
    this.parent.syncStore();
  }

  async remove(id: string): Promise<void> {
    const index = this.parent.holdingsData.findIndex(h => h.id === id);
    if (index < 0) {
      throw new HoldingLifecycleError('NOT_FOUND', `Holding with id "${id}" does not exist.`);
    }
    this.parent.holdingsData.splice(index, 1);
    this.parent.syncStore();
  }
}

/**
 * Status transition helper exposed for tests / import pipeline.
 * Re-exported here to keep the import surface tight.
 */
export function isHoldingStatus(value: string): value is HoldingStatus {
  return value === 'active' || value === 'closed_absent';
}
