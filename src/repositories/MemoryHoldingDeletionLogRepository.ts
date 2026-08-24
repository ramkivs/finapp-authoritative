/**
 * WP-FB-IMPORT-BROKER-01 — D-06 closed_absent permanent deletion audit log.
 *
 * In-memory implementation of `HoldingDeletionLogRepository`. The port
 * provides `findAll` / `findAllSync` / `findByIdSync` / `add`.
 *
 * The D-06 implementation does NOT call `add` directly. The D-06 path
 * composes the audit-record creation into the atomic `MemoryRepository.write`
 * boundary via `HoldingDeletionService.buildAtomicMutation` and
 * `commitHoldingDeletion` — the audit entry is written in the same
 * synchronous block as the holding removal, and the existing
 * `captureLedger` / `revertDelta` mechanism ensures both succeed or both
 * roll back together.
 *
 * This `add` method is provided for port completeness and for any future
 * single-record audit operations. It is non-atomic (matches the existing
 * `MemoryHoldingRepository.add` shape at line 26 of
 * `MemoryHoldingRepository.ts`); the D-06 path does not use it.
 *
 * The repository itself is NOT lock-aware: it operates inside the parent's
 * `write()` boundary, which holds the IndexedDB lease. When called from
 * `HoldingDeletionService.buildAtomicMutation`, the parent
 * `MemoryRepository.write` boundary provides the atomicity guarantee.
 */

import { HoldingDeletionLogEntry, HoldingDeletionLogRepository } from '../domain/types';

export class MemoryHoldingDeletionLogRepository implements HoldingDeletionLogRepository {
  constructor(private readonly parent: { holdingDeletionLogData: HoldingDeletionLogEntry[]; syncStore: () => void }) {}

  async findAll(): Promise<HoldingDeletionLogEntry[]> {
    return [...this.parent.holdingDeletionLogData];
  }

  findAllSync(): HoldingDeletionLogEntry[] {
    return [...this.parent.holdingDeletionLogData];
  }

  findByIdSync(id: string): HoldingDeletionLogEntry | null {
    return this.parent.holdingDeletionLogData.find(e => e.id === id) ?? null;
  }

  /**
   * Appends a new audit entry. Refuses a duplicate id.
   *
   * Non-atomic. For D-06 the atomicity guarantee is provided by the
   * `MemoryRepository.write` boundary in which `HoldingDeletionService`'s
   * `buildAtomicMutation` runs — see the D-06 implementation authority
   * record §5.6.
   */
  async add(entry: HoldingDeletionLogEntry): Promise<void> {
    if (!entry.id || entry.id.trim() === '') {
      throw new Error('HoldingDeletionLogRepository.add: a non-empty id is required.');
    }
    if (this.parent.holdingDeletionLogData.some(e => e.id === entry.id)) {
      throw new Error(`DUPLICATE_AUDIT_ID: An audit entry with id "${entry.id}" already exists.`);
    }
    this.parent.holdingDeletionLogData.push(entry);
    this.parent.syncStore();
  }
}
