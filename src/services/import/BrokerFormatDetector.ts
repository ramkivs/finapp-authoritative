/**
 * WP-FB-IMPORT-BROKER-01 — Broker format detector.
 *
 * Mirrors the BankStatementAdapter registry pattern from
 * ImportFormatDetector. Registered broker adapters (one per broker
 * export shape — Zerodha for WP-04, plus Dhan and Groww in later
 * work-packages) are tried in order; the first adapter whose
 * structural detection returns a positive match wins.
 *
 * This file is additive. It does not modify ImportFormatDetector or
 * any bank-adapter wiring. Brokers and bank-statements are
 * intentionally separate registries to avoid false cross-detection
 * (a file that incidentally matches both a bank schema and a broker
 * schema must be presented to the user as one or the other, not
 * silently coerced).
 *
 * The detector is content-based: filename MUST NOT be the only
 * signal. Each adapter's `canHandle` / `canHandleRows` performs a
 * structural header-schema check.
 */

import {
  BrokerAdapter,
  BrokerDetectionResult,
} from './BrokerAdapter';
import { ParsedCsvRow, StatementInput } from './ImportTypes';
import { ZerodhaHoldingsAdapter } from './adapters/ZerodhaHoldingsAdapter';

export class BrokerFormatDetector {
  private static adapters: BrokerAdapter[] = [
    new ZerodhaHoldingsAdapter(),
    // Future registrations:
    //   new DhanHoldingsAdapter(),         // WP-05
    //   new GrowwHoldingsAdapter(),        // WP-06
  ];

  /**
   * Text-path detection: evaluates text StatementInput content
   * against registered broker adapters. Returns the first positive
   * match. The text path is the only path meaningful for CSV brokers
   * (Zerodha, Dhan). The binary path is meaningful for XLS/XLSX
   * brokers (Groww) and lives in `detectFromRows`.
   */
  static detect(input: StatementInput): {
    adapter: BrokerAdapter | null;
    detection: BrokerDetectionResult;
  } {
    for (const adapter of this.adapters) {
      const detection = adapter.canHandle(input);
      if (detection.matched && detection.confidence !== 'NONE') {
        return { adapter, detection };
      }
    }

    return { adapter: null, detection: this.unsupportedDetection() };
  }

  /**
   * Binary-path detection: evaluates decoded ParsedCsvRow headers
   * against registered broker adapters. Used after a binary XLS/XLSX
   * workbook has been decoded. Detection operates directly on the
   * decoded column headers via `canHandleRows` (no synthetic text
   * reconstruction).
   */
  static detectFromRows(
    headers: string[],
    rows: ParsedCsvRow[],
    fileName: string,
  ): { adapter: BrokerAdapter | null; detection: BrokerDetectionResult } {
    for (const adapter of this.adapters) {
      const detection = adapter.canHandleRows(headers, rows);
      if (detection.matched && detection.confidence !== 'NONE') {
        return { adapter, detection };
      }
    }

    return { adapter: null, detection: this.unsupportedDetection() };
  }

  /**
   * Look up a registered broker adapter by its stable id (e.g.
   * `"zerodha"`). Returns null when no adapter with that id is
   * registered.
   */
  static getAdapterById(id: string): BrokerAdapter | null {
    return this.adapters.find((a) => a.id === id) || null;
  }

  /**
   * Return all registered broker adapters. The import pipeline can
   * surface this list to the UI for a "choose broker" affordance in
   * the future; for WP-04 the detector is the only consumer.
   */
  static getAllAdapters(): readonly BrokerAdapter[] {
    return this.adapters;
  }

  private static unsupportedDetection(): BrokerDetectionResult {
    return {
      matched: false,
      formatId: 'unsupported',
      displayName: 'Unsupported / Unrecognized Broker Format',
      confidence: 'NONE',
      reason:
        'File content does not match any registered broker header signature.',
    };
  }
}
