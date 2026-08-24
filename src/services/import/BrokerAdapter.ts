/**
 * WP-FB-IMPORT-BROKER-01 — Broker adapter contract.
 *
 * Mirrors the BankStatementAdapter shape (id, displayName, canHandle,
 * canHandleRows, parse) but produces canonical `Holding[]` instead of
 * `BankStatementRecord[]`. The two adapter families are intentionally
 * separate: brokers emit first-class Holdings (D-01); bank statements
 * emit Transactions. The shared infrastructure is the detect / parse /
 * normalize shape, not the type system.
 *
 * This file is additive. It does not modify BankStatementAdapter or any
 * other existing import infrastructure. It introduces the minimum surface
 * required for WP-04 (Zerodha) and is shaped to be re-used by WP-05
 * (Dhan) and WP-06 (Groww) without modification.
 *
 * Parser/lifecycle boundary (per the WP-04 authority record §12):
 *   The broker adapter does NOT query existing holdings, does NOT compute
 *   new/updated/unchanged/closed_absent, does NOT persist, and does NOT
 *   call HoldingAssetCollisionGuard. It produces Holding candidates
 *   with `status: "active"` and a parser-generated id. Lifecycle
 *   reconciliation is the import-service's responsibility (WP-08).
 */

import { Holding, HoldingStatus } from '../../domain/types';
import { ImportRowIssue, ParsedCsvRow, StatementInput } from './ImportTypes';

/**
 * Broker-specific error codes. Extends the bank-adapter taxonomy
 * (`UNSUPPORTED_SCHEMA`, `MALFORMED_ROW`, ...) with broker-parse
 * vocabulary. Uses the same `ImportRowIssue` shape (severity, code,
 * message, field?, rawValue?).
 *
 * These are CHARACTERISATION codes (per the WP-04 / WP-05 / WP-06
 * sequencing report §11). UI copy is a WP-08 concern.
 */
export type BrokerIssueCode =
  | 'BROKER_UNSUPPORTED'
  | 'BROKER_HEADER_MISSING'
  | 'BROKER_ROW_MALFORMED'
  | 'BROKER_NUMERIC_INVALID'
  | 'BROKER_IDENTITY_MISSING'
  | 'BROKER_DUPLICATE_INSIDE_BATCH'
  | 'BROKER_HEADER_ONLY'
  | 'BROKER_EMPTY'
  | 'BROKER_QUANTITY_NON_POSITIVE';

/**
 * Result of broker detection. Mirrors the bank-adapter DetectionResult
 * shape (`matched`, `formatId`, `displayName`, `confidence`, `reason`)
 * but uses the broker format id namespace.
 */
export interface BrokerDetectionResult {
  matched: boolean;
  formatId: 'zerodha' | 'dhan' | 'groww' | 'unsupported';
  displayName: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  reason: string;
}

/**
 * Output of a broker adapter's parseHoldings call. The parser
 * (broker adapter) produces this; the import service (WP-08)
 * consumes it.
 *
 *   broker       — always the broker's canonical name (e.g. "Zerodha")
 *   account?     — only present if the source file provides one
 *                  (Zerodha: never; Dhan MF: yes; Groww stocks: yes)
 *   holdings     — canonical Holding[] candidates, all `status: "active"`
 *   sourceFile   — the actual filename supplied to the parser
 *   importedAt   — parser execution time, ISO 8601
 *   issues       — characterisation issues (invalid rows, header
 *                  mismatches, etc.). UI surfaces these in the preview
 *                  (WP-08), not in the parser.
 */
export interface BrokerParseOutput {
  broker: string;
  account?: string;
  holdings: Holding[];
  sourceFile: string;
  importedAt: string;
  issues: ImportRowIssue[];
}

/**
 * The broker adapter contract. Implementations are registered with
 * BrokerFormatDetector and invoked by the import pipeline.
 *
 * `id` is a stable, lowercase, underscore-free identifier. The
 * authority record requires `formatId === "zerodha"` for WP-04.
 * `displayName` is the user-facing label.
 *
 * `canHandle` / `canHandleRows` perform STRUCTURAL detection against
 * the file's header schema (not the filename). Both must agree.
 *
 * `parseHoldings` decodes the file, normalises values, and emits
 * canonical Holding candidates. It does not persist, does not query
 * the existing repository, and does not perform lifecycle work.
 */
export interface BrokerAdapter {
  readonly id: string;
  readonly displayName: string;

  /**
   * Detect if this adapter can handle the given text-kind StatementInput.
   * Structural header-schema check. Filename MUST NOT be the only signal.
   */
  canHandle(input: StatementInput): BrokerDetectionResult;

  /**
   * Detect if this adapter can handle pre-decoded rows (binary
   * XLS/XLSX path). Same structural header-schema check applied to
   * the decoded header row.
   */
  canHandleRows(headers: string[], rows: ParsedCsvRow[]): BrokerDetectionResult;

  /**
   * Parse a text-kind StatementInput into canonical Holding candidates
   * plus characterisation issues. Always returns an object (never
   * throws for ordinary parse problems — they are surfaced as issues).
   *
   * Lifecycle reconciliation and persistence are NOT performed here.
   */
  parseHoldings(input: StatementInput): BrokerParseOutput;

  /**
   * Parse pre-decoded ParsedCsvRow[] (binary workbook path) into
   * canonical Holding candidates plus characterisation issues. The
   * binary path is only meaningful for broker exports that arrive as
   * XLS/XLSX; Zerodha's V1 scope is text-only, but the interface
   * accepts the binary shape for symmetry with the bank adapters.
   */
  parseHoldingsFromRows(rows: ParsedCsvRow[], fileName: string): BrokerParseOutput;
}

/**
 * Status constant exported for adapter convenience. Every Holding
 * candidate produced by a parser has `status = ACTIVE_HOLDING_STATUS`
 * (`'active'`). The 'closed_absent' transition is the import-service's
 * responsibility (WP-08).
 */
export const ACTIVE_HOLDING_STATUS: HoldingStatus = 'active';
