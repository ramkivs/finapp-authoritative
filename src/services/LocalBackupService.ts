import {
  Account,
  Asset,
  FinancialGoal,
  FinancialProfile,
  Holding,
  HoldingDeletionLogEntry,
  InsurancePolicy,
  Liability,
  MonthlyBudget,
  NetWorthSnapshot,
  Transaction,
} from '../domain/types';
import { AssetIdentityService } from './AssetIdentityService';
import { LiabilityIdentityService } from './LiabilityIdentityService';
import { JcsSerializationService } from './mathematics/JcsSerializationService';

export const BACKUP_FORMAT_ID = 'finboom.local-backup' as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;
export const BACKUP_DB_VERSION = 7 as const;
export const BACKUP_APP_VERSION = '3.0.0' as const;
export const BACKUP_HASH_ALGORITHM = 'SHA-256' as const; // FIPS 180-4 digest via Web Crypto crypto.subtle
export const BACKUP_CANONICALIZATION = 'RFC-8785-JCS' as const;
export const LAST_BACKUP_RECEIPT_STORAGE_KEY = 'finapp.backup.lastReceipt' as const;

export type BackupValidationErrorCode =
  | 'STORAGE_UNREADABLE'
  | 'EMPTY_INPUT'
  | 'INVALID_JSON'
  | 'PROTOTYPE_POLLUTION_DETECTED'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_BACKUP_FORMAT'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INCOMPLETE_BACKUP_DATA'
  | 'RECORD_COUNT_MISMATCH'
  | 'UNSUPPORTED_HASH_ALGORITHM'
  | 'INTEGRITY_HASH_MISSING'
  | 'INTEGRITY_MISMATCH'
  | 'INVALID_RECORD_SCHEMA'
  | 'DUPLICATE_RECORD_ID';

export class BackupValidationError extends Error {
  public readonly code: BackupValidationErrorCode;

  constructor(code: BackupValidationErrorCode, message: string) {
    super(message);
    this.name = 'BackupValidationError';
    this.code = code;
  }
}

export interface LocalBackupData {
  transactions: Transaction[];
  assets: Asset[];
  liabilities: Liability[];
  holdings: Holding[];
  holdingDeletionLog: HoldingDeletionLogEntry[];
  snapshots: NetWorthSnapshot[];
  accounts: Account[];
  budgets: MonthlyBudget[];
  policies: InsurancePolicy[];
  goals: FinancialGoal[];
  profile: FinancialProfile | null;
}

export interface LocalBackupRecordCounts {
  transactions: number;
  assets: number;
  liabilities: number;
  holdings: number;
  holdingDeletionLog: number;
  snapshots: number;
  accounts: number;
  budgets: number;
  policies: number;
  goals: number;
  hasProfile: boolean;
}

export interface LocalBackupManifest {
  format: typeof BACKUP_FORMAT_ID;
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  dbVersion: number;
  appVersion: string;
  createdAt: string;
  recordCounts: LocalBackupRecordCounts;
}

export interface LocalBackupIntegrity {
  algorithm: typeof BACKUP_HASH_ALGORITHM;
  canonicalization: typeof BACKUP_CANONICALIZATION;
  digest: string;
}

export interface LocalBackupEnvelope {
  manifest: LocalBackupManifest;
  integrity: LocalBackupIntegrity;
  data: LocalBackupData;
}

export interface LocalBackupReceipt {
  format: typeof BACKUP_FORMAT_ID;
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  dbVersion: number;
  createdAt: string;
  fileName: string;
  algorithm: typeof BACKUP_HASH_ALGORITHM;
  digest: string;
  recordCounts: LocalBackupRecordCounts;
}

export interface LocalBackupExportResult {
  envelope: LocalBackupEnvelope;
  json: string;
  fileName: string;
  receipt: LocalBackupReceipt;
}

export interface LocalBackupRestoreResult {
  manifest: LocalBackupManifest;
  digest: string;
  restoredAt: string;
  recordCounts: LocalBackupRecordCounts;
}

const ARRAY_COLLECTION_KEYS: ReadonlyArray<Exclude<keyof LocalBackupData, 'profile'>> = [
  'transactions',
  'assets',
  'liabilities',
  'holdings',
  'holdingDeletionLog',
  'snapshots',
  'accounts',
  'budgets',
  'policies',
  'goals',
];

const K_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Pure RFC 6234 / FIPS 180-4 256-bit digest fallback used only when an
 * environment lacks Web Crypto `crypto.subtle`. Produces bit-identical output
 * to `crypto.subtle.digest('SHA-256', bytes)`.
 */
export function computeRfc6234DigestHex(bytes: Uint8Array): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const byteLen = bytes.length;
  const totalBits = byteLen * 8;
  const highBits = Math.floor(totalBits / 0x100000000) >>> 0;
  const lowBits = totalBits >>> 0;

  const rem = (byteLen + 9) % 64;
  const padZeroBytes = rem === 0 ? 0 : 64 - rem;
  const paddedLen = byteLen + 1 + padZeroBytes + 8;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes, 0);
  padded[byteLen] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K_CONSTANTS[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Computes a genuine 64-character lowercase hexadecimal digest using Web Crypto
 * `crypto.subtle` (FIPS 180-4 SHA-256 via `crypto.subtle.digest`) with an exact
 * RFC 6234 fallback if `crypto.subtle` is unavailable in the host runtime.
 */
export async function computeIntegrityDigestHex(canonicalInput: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalInput);
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    const buffer = await subtle.digest('SHA-256', bytes); // Web Crypto crypto.subtle digest
    const out = new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < out.length; i++) {
      hex += out[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
  return computeRfc6234DigestHex(bytes);
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoForbiddenKeys(value: unknown, path = 'root'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new BackupValidationError(
        'PROTOTYPE_POLLUTION_DETECTED',
        `Rejected backup file: forbidden property key "${key}" found at ${path}.`
      );
    }
    assertNoForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

function assertNonEmptyString(
  value: unknown,
  collection: string,
  index: number | null,
  field: string
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const loc = index === null ? collection : `${collection}[${index}]`;
    throw new BackupValidationError(
      'INVALID_RECORD_SCHEMA',
      `Invalid backup structure: ${loc}.${field} must be a non-empty string.`
    );
  }
}

function assertFiniteNumber(
  value: unknown,
  collection: string,
  index: number | null,
  field: string
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const loc = index === null ? collection : `${collection}[${index}]`;
    throw new BackupValidationError(
      'INVALID_RECORD_SCHEMA',
      `Invalid backup structure: ${loc}.${field} must be a finite number.`
    );
  }
}

function assertOptionalFiniteNumber(
  value: unknown,
  collection: string,
  index: number | null,
  field: string
): void {
  if (value === undefined) return;
  assertFiniteNumber(value, collection, index, field);
}

function assertAllNumbersFiniteDeep(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid numeric value at ${path}: backup numbers must be finite.`
      );
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertAllNumbersFiniteDeep(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    assertAllNumbersFiniteDeep((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

function validateUniqueKeyedCollection(
  rows: unknown[],
  collectionName: string,
  validateRow: (row: Record<string, unknown>, index: number) => void
): void {
  const seenIds = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    if (!isPlainObject(item)) {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid backup structure: ${collectionName}[${i}] must be a JSON object.`
      );
    }
    assertNonEmptyString(item.id, collectionName, i, 'id');
    if (seenIds.has(item.id)) {
      throw new BackupValidationError(
        'DUPLICATE_RECORD_ID',
        `Invalid backup structure: duplicate id "${item.id}" in "${collectionName}" at index ${i}.`
      );
    }
    seenIds.add(item.id);
    assertAllNumbersFiniteDeep(item, `${collectionName}[${i}]`);
    validateRow(item, i);
  }
}

function validateBackupDataSchema(raw: unknown): LocalBackupData {
  if (!isPlainObject(raw)) {
    throw new BackupValidationError(
      'INCOMPLETE_BACKUP_DATA',
      'Invalid backup file: "data" payload must be a JSON object containing all canonical collections.'
    );
  }

  for (const key of ARRAY_COLLECTION_KEYS) {
    if (!Array.isArray(raw[key])) {
      throw new BackupValidationError(
        'INCOMPLETE_BACKUP_DATA',
        `Incomplete backup file: canonical collection "${key}" is missing or is not an array.`
      );
    }
  }

  if (!('profile' in raw) || (raw.profile !== null && !isPlainObject(raw.profile))) {
    throw new BackupValidationError(
      'INCOMPLETE_BACKUP_DATA',
      'Incomplete backup file: "profile" must be explicitly present as null or an object.'
    );
  }

  validateUniqueKeyedCollection(raw.transactions as unknown[], 'transactions', (row, i) => {
    assertNonEmptyString(row.date, 'transactions', i, 'date');
    assertNonEmptyString(row.type, 'transactions', i, 'type');
    if (typeof row.account !== 'string') {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid backup structure: transactions[${i}].account must be a string.`
      );
    }
    if (typeof row.narration !== 'string') {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid backup structure: transactions[${i}].narration must be a string.`
      );
    }
    assertFiniteNumber(row.amount, 'transactions', i, 'amount');
    assertOptionalFiniteNumber(row.closingBalance, 'transactions', i, 'closingBalance');
    if (
      row.excludedReason !== undefined &&
      row.excludedReason !== 'IMPORT_ROLLBACK' &&
      row.excludedReason !== 'SUPERSEDED'
    ) {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid backup structure: transactions[${i}].excludedReason "${String(row.excludedReason)}" is not recognised.`
      );
    }
  });

  validateUniqueKeyedCollection(raw.assets as unknown[], 'assets', (row, i) => {
    assertNonEmptyString(row.name, 'assets', i, 'name');
    assertFiniteNumber(row.amount, 'assets', i, 'amount');
  });

  validateUniqueKeyedCollection(raw.liabilities as unknown[], 'liabilities', (row, i) => {
    assertNonEmptyString(row.name, 'liabilities', i, 'name');
    assertFiniteNumber(row.amount, 'liabilities', i, 'amount');
  });

  validateUniqueKeyedCollection(raw.holdings as unknown[], 'holdings', (row, i) => {
    assertNonEmptyString(row.broker, 'holdings', i, 'broker');
    assertNonEmptyString(row.instrumentName, 'holdings', i, 'instrumentName');
    assertNonEmptyString(row.status, 'holdings', i, 'status');
    if (row.status !== 'active' && row.status !== 'closed_absent') {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid backup structure: holdings[${i}].status "${String(row.status)}" must be "active" or "closed_absent".`
      );
    }
    assertNonEmptyString(row.sourceFile, 'holdings', i, 'sourceFile');
    assertNonEmptyString(row.importedAt, 'holdings', i, 'importedAt');
    assertFiniteNumber(row.quantity, 'holdings', i, 'quantity');
    assertFiniteNumber(row.averageCost, 'holdings', i, 'averageCost');
    assertFiniteNumber(row.investedValue, 'holdings', i, 'investedValue');
    assertFiniteNumber(row.currentPrice, 'holdings', i, 'currentPrice');
    assertFiniteNumber(row.currentValue, 'holdings', i, 'currentValue');
    assertFiniteNumber(row.unrealisedPnL, 'holdings', i, 'unrealisedPnL');
  });

  validateUniqueKeyedCollection(
    raw.holdingDeletionLog as unknown[],
    'holdingDeletionLog',
    (row, i) => {
      assertNonEmptyString(row.holdingId, 'holdingDeletionLog', i, 'holdingId');
      assertNonEmptyString(row.broker, 'holdingDeletionLog', i, 'broker');
      assertNonEmptyString(row.instrumentName, 'holdingDeletionLog', i, 'instrumentName');
      assertFiniteNumber(
        row.currentValueAtDeletion,
        'holdingDeletionLog',
        i,
        'currentValueAtDeletion'
      );
      assertNonEmptyString(row.sourceFile, 'holdingDeletionLog', i, 'sourceFile');
      assertNonEmptyString(row.importedAt, 'holdingDeletionLog', i, 'importedAt');
      assertNonEmptyString(row.deletedAt, 'holdingDeletionLog', i, 'deletedAt');
    }
  );

  validateUniqueKeyedCollection(raw.snapshots as unknown[], 'snapshots', (row, i) => {
    assertNonEmptyString(row.dateStr, 'snapshots', i, 'dateStr');
    assertFiniteNumber(row.totalAssets, 'snapshots', i, 'totalAssets');
    assertFiniteNumber(row.totalLiabilities, 'snapshots', i, 'totalLiabilities');
    assertFiniteNumber(row.netWorth, 'snapshots', i, 'netWorth');
    assertNonEmptyString(row.status, 'snapshots', i, 'status');
  });

  validateUniqueKeyedCollection(raw.accounts as unknown[], 'accounts', (row, i) => {
    assertNonEmptyString(row.name, 'accounts', i, 'name');
    assertNonEmptyString(row.type, 'accounts', i, 'type');
    assertFiniteNumber(row.openingBalance, 'accounts', i, 'openingBalance');
  });

  validateUniqueKeyedCollection(raw.budgets as unknown[], 'budgets', (row, i) => {
    assertNonEmptyString(row.monthStr, 'budgets', i, 'monthStr');
    assertFiniteNumber(row.totalBudget, 'budgets', i, 'totalBudget');
    if (!isPlainObject(row.allocations)) {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Invalid backup structure: budgets[${i}].allocations must be an object.`
      );
    }
    for (const [cat, val] of Object.entries(row.allocations)) {
      assertFiniteNumber(val, 'budgets', i, `allocations.${cat}`);
    }
  });

  validateUniqueKeyedCollection(raw.policies as unknown[], 'policies', (row, i) => {
    assertNonEmptyString(row.type, 'policies', i, 'type');
    assertNonEmptyString(row.provider, 'policies', i, 'provider');
    assertFiniteNumber(row.coverAmount, 'policies', i, 'coverAmount');
    assertFiniteNumber(row.premiumAmount, 'policies', i, 'premiumAmount');
    assertNonEmptyString(row.status, 'policies', i, 'status');
  });

  validateUniqueKeyedCollection(raw.goals as unknown[], 'goals', (row, i) => {
    assertNonEmptyString(row.name, 'goals', i, 'name');
    assertNonEmptyString(row.template, 'goals', i, 'template');
    assertFiniteNumber(row.targetAmount, 'goals', i, 'targetAmount');
    assertFiniteNumber(row.currentSavedAmount, 'goals', i, 'currentSavedAmount');
    assertFiniteNumber(row.monthlyContribution, 'goals', i, 'monthlyContribution');
    assertNonEmptyString(row.status, 'goals', i, 'status');
  });

  if (raw.profile !== null) {
    const profileObj = raw.profile as Record<string, unknown>;
    assertAllNumbersFiniteDeep(profileObj, 'profile');
    assertNonEmptyString(profileObj.id, 'profile', null, 'id');
    assertFiniteNumber(profileObj.monthlyIncome, 'profile', null, 'monthlyIncome');
    assertFiniteNumber(profileObj.monthlyExpenses, 'profile', null, 'monthlyExpenses');
    assertFiniteNumber(profileObj.savingsRate, 'profile', null, 'savingsRate');
    assertNonEmptyString(profileObj.updatedAt, 'profile', null, 'updatedAt');
  }

  return JSON.parse(
    JSON.stringify({
      transactions: raw.transactions,
      assets: raw.assets,
      liabilities: raw.liabilities,
      holdings: raw.holdings,
      holdingDeletionLog: raw.holdingDeletionLog,
      snapshots: raw.snapshots,
      accounts: raw.accounts,
      budgets: raw.budgets,
      policies: raw.policies,
      goals: raw.goals,
      profile: raw.profile,
    })
  ) as LocalBackupData;
}

function computeRecordCounts(data: LocalBackupData): LocalBackupRecordCounts {
  return {
    transactions: data.transactions.length,
    assets: data.assets.length,
    liabilities: data.liabilities.length,
    holdings: data.holdings.length,
    holdingDeletionLog: data.holdingDeletionLog.length,
    snapshots: data.snapshots.length,
    accounts: data.accounts.length,
    budgets: data.budgets.length,
    policies: data.policies.length,
    goals: data.goals.length,
    hasProfile: data.profile !== null,
  };
}

function validateManifestAndCounts(
  rawManifest: unknown,
  actualCounts: LocalBackupRecordCounts
): LocalBackupManifest {
  if (!isPlainObject(rawManifest)) {
    throw new BackupValidationError(
      'INVALID_ENVELOPE',
      'Invalid backup file: missing or malformed "manifest" header.'
    );
  }

  if (rawManifest.format !== BACKUP_FORMAT_ID) {
    throw new BackupValidationError(
      'UNSUPPORTED_BACKUP_FORMAT',
      `Unsupported backup format "${String(rawManifest.format ?? '')}". Expected "${BACKUP_FORMAT_ID}".`
    );
  }

  if (
    typeof rawManifest.schemaVersion !== 'number' ||
    !Number.isInteger(rawManifest.schemaVersion) ||
    rawManifest.schemaVersion !== BACKUP_SCHEMA_VERSION
  ) {
    throw new BackupValidationError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Incompatible backup schemaVersion "${String(rawManifest.schemaVersion)}". Supported schemaVersion is ${BACKUP_SCHEMA_VERSION}.`
    );
  }

  if (
    typeof rawManifest.dbVersion !== 'number' ||
    !Number.isInteger(rawManifest.dbVersion) ||
    rawManifest.dbVersion < 1 ||
    rawManifest.dbVersion > BACKUP_DB_VERSION
  ) {
    throw new BackupValidationError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Incompatible backup dbVersion "${String(rawManifest.dbVersion)}". Supported dbVersion range is 1..${BACKUP_DB_VERSION}.`
    );
  }

  if (typeof rawManifest.appVersion !== 'string' || rawManifest.appVersion.trim().length === 0) {
    throw new BackupValidationError(
      'UNSUPPORTED_SCHEMA_VERSION',
      'Invalid backup manifest: "appVersion" must be a non-empty string.'
    );
  }

  if (
    typeof rawManifest.createdAt !== 'string' ||
    rawManifest.createdAt.trim().length === 0 ||
    Number.isNaN(Date.parse(rawManifest.createdAt))
  ) {
    throw new BackupValidationError(
      'UNSUPPORTED_SCHEMA_VERSION',
      'Invalid backup manifest: "createdAt" must be a valid ISO-8601 timestamp.'
    );
  }

  if (!isPlainObject(rawManifest.recordCounts)) {
    throw new BackupValidationError(
      'INCOMPLETE_BACKUP_DATA',
      'Invalid backup manifest: "recordCounts" summary is missing.'
    );
  }

  const declared = rawManifest.recordCounts;
  for (const key of ARRAY_COLLECTION_KEYS) {
    if (
      typeof declared[key] !== 'number' ||
      !Number.isInteger(declared[key]) ||
      declared[key] !== actualCounts[key]
    ) {
      throw new BackupValidationError(
        'RECORD_COUNT_MISMATCH',
        `Backup record count mismatch for "${key}": manifest declares ${String(declared[key])}, payload contains ${actualCounts[key]}.`
      );
    }
  }

  if (typeof declared.hasProfile !== 'boolean' || declared.hasProfile !== actualCounts.hasProfile) {
    throw new BackupValidationError(
      'RECORD_COUNT_MISMATCH',
      `Backup profile presence mismatch: manifest declares hasProfile=${String(declared.hasProfile)}, payload hasProfile=${actualCounts.hasProfile}.`
    );
  }

  return rawManifest as unknown as LocalBackupManifest;
}

export class LocalBackupService {
  /**
   * Builds the deterministic RFC 8785 canonical payload string covered by the
   * backup's cryptographic digest. Covers BOTH `manifest` and `data` so neither
   * version metadata, record counts, nor any record field can be altered
   * without invalidating the digest.
   */
  static canonicalizeForHashing(manifest: unknown, data: unknown): string {
    return JcsSerializationService.canonicalize({ manifest, data });
  }

  /**
   * Formats a deterministic local filename for a backup timestamp.
   */
  static formatBackupFileName(createdAtIso: string): string {
    const safeStamp = createdAtIso.replace(/[:.]/g, '-');
    return `arthavault-backup-${safeStamp}.json`;
  }

  /**
   * Reads the most recently retained local backup receipt (non-PII digest &
   * counts metadata only) from browser storage, if available.
   */
  static getLastBackupReceipt(): LocalBackupReceipt | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      const raw = window.localStorage.getItem(LAST_BACKUP_RECEIPT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        !isPlainObject(parsed) ||
        parsed.format !== BACKUP_FORMAT_ID ||
        typeof parsed.digest !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(parsed.digest)
      ) {
        return null;
      }
      return parsed as unknown as LocalBackupReceipt;
    } catch {
      return null;
    }
  }

  private static saveLastBackupReceipt(receipt: LocalBackupReceipt): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(LAST_BACKUP_RECEIPT_STORAGE_KEY, JSON.stringify(receipt));
      }
    } catch {
      // Non-fatal in private-browsing or quota-restricted environments; the
      // backup file itself always carries the authoritative integrity block.
    }
  }

  /**
   * Exports the complete canonical financial dataset into a verified local JSON
   * backup envelope with a genuine 256-bit digest (`crypto.subtle` FIPS 180-4).
   */
  static async createBackup(
    ledger: LocalBackupData,
    options?: { createdAt?: string }
  ): Promise<LocalBackupExportResult> {
    const normalizedAssets = AssetIdentityService.migrate(
      (ledger.assets ?? []).map((a) => ({ ...a }))
    ).assets;
    const normalizedLiabilities = LiabilityIdentityService.migrate(
      (ledger.liabilities ?? []).map((l) => ({ ...l }))
    ).liabilities;

    const candidateData: LocalBackupData = {
      transactions: (ledger.transactions ?? []).map((t) => ({ ...t })),
      assets: normalizedAssets,
      liabilities: normalizedLiabilities,
      holdings: (ledger.holdings ?? []).map((h) => ({ ...h })),
      holdingDeletionLog: (ledger.holdingDeletionLog ?? []).map((e) => ({ ...e })),
      snapshots: (ledger.snapshots ?? []).map((s) => ({ ...s })),
      accounts: (ledger.accounts ?? []).map((a) => ({ ...a })),
      budgets: (ledger.budgets ?? []).map((b) => ({
        ...b,
        allocations: b.allocations ? { ...b.allocations } : {},
      })),
      policies: (ledger.policies ?? []).map((p) => ({ ...p })),
      goals: (ledger.goals ?? []).map((g) => ({ ...g })),
      profile: ledger.profile ? { ...ledger.profile } : null,
    };

    const validatedData = validateBackupDataSchema(candidateData);
    const createdAt = options?.createdAt ?? new Date().toISOString();
    const recordCounts = computeRecordCounts(validatedData);

    const manifest: LocalBackupManifest = {
      format: BACKUP_FORMAT_ID,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      dbVersion: BACKUP_DB_VERSION,
      appVersion: BACKUP_APP_VERSION,
      createdAt,
      recordCounts,
    };

    const canonicalPayload = this.canonicalizeForHashing(manifest, validatedData);
    const digest = await computeIntegrityDigestHex(canonicalPayload);

    const envelope: LocalBackupEnvelope = {
      manifest,
      integrity: {
        algorithm: BACKUP_HASH_ALGORITHM,
        canonicalization: BACKUP_CANONICALIZATION,
        digest,
      },
      data: validatedData,
    };

    const json = JSON.stringify(envelope, null, 2);
    const fileName = this.formatBackupFileName(createdAt);
    const receipt: LocalBackupReceipt = {
      format: BACKUP_FORMAT_ID,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      dbVersion: BACKUP_DB_VERSION,
      createdAt,
      fileName,
      algorithm: BACKUP_HASH_ALGORITHM,
      digest,
      recordCounts,
    };

    this.saveLastBackupReceipt(receipt);

    return {
      envelope,
      json,
      fileName,
      receipt,
    };
  }

  /**
   * Parses and strictly validates a raw JSON string or object BEFORE any
   * state or IndexedDB mutation is permitted.
   *
   * Verification order:
   *   1. Non-empty JSON syntax & prototype-pollution check
   *   2. Envelope top-level structure (`manifest`, `integrity`, `data`)
   *   3. Format & schema/DB version compatibility check
   *   4. Cryptographic digest algorithm, canonicalization & 64-hex format check
   *   5. Recomputed digest comparison over `JcsSerializationService.canonicalize({ manifest, data })`
   *   6. Complete 11-collection presence, record-count reconciliation, unique-ID,
   *      and per-record field/number schema validation
   */
  static async verifyAndParseBackup(input: string | unknown): Promise<LocalBackupEnvelope> {
    let parsed: unknown;
    if (typeof input === 'string') {
      if (input.trim().length === 0) {
        throw new BackupValidationError('EMPTY_INPUT', 'Backup file is empty.');
      }
      try {
        parsed = JSON.parse(input);
      } catch {
        throw new BackupValidationError(
          'INVALID_JSON',
          'Backup file is not valid JSON and cannot be restored.'
        );
      }
    } else if (input !== null && typeof input === 'object') {
      parsed = input;
    } else {
      throw new BackupValidationError(
        'EMPTY_INPUT',
        'Backup input must be a non-empty JSON string or backup envelope object.'
      );
    }

    assertNoForbiddenKeys(parsed);

    if (!isPlainObject(parsed)) {
      throw new BackupValidationError(
        'INVALID_ENVELOPE',
        'Backup root must be a JSON object containing "manifest", "integrity", and "data".'
      );
    }

    if (
      !isPlainObject(parsed.manifest) ||
      !isPlainObject(parsed.integrity) ||
      !isPlainObject(parsed.data)
    ) {
      throw new BackupValidationError(
        'INVALID_ENVELOPE',
        'Backup envelope is missing required "manifest", "integrity", or "data" sections.'
      );
    }

    // Step 1: Validate format & version header upfront so incompatible formats
    // and future schema versions fail with clear version diagnostics before
    // record-level parsing.
    const rawManifest = parsed.manifest;
    if (rawManifest.format !== BACKUP_FORMAT_ID) {
      throw new BackupValidationError(
        'UNSUPPORTED_BACKUP_FORMAT',
        `Unsupported backup format "${String(rawManifest.format ?? '')}". Expected "${BACKUP_FORMAT_ID}".`
      );
    }
    if (
      typeof rawManifest.schemaVersion !== 'number' ||
      !Number.isInteger(rawManifest.schemaVersion) ||
      rawManifest.schemaVersion !== BACKUP_SCHEMA_VERSION
    ) {
      throw new BackupValidationError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Incompatible backup schemaVersion "${String(rawManifest.schemaVersion)}". Supported schemaVersion is ${BACKUP_SCHEMA_VERSION}.`
      );
    }
    if (
      typeof rawManifest.dbVersion !== 'number' ||
      !Number.isInteger(rawManifest.dbVersion) ||
      rawManifest.dbVersion < 1 ||
      rawManifest.dbVersion > BACKUP_DB_VERSION
    ) {
      throw new BackupValidationError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Incompatible backup dbVersion "${String(rawManifest.dbVersion)}". Supported dbVersion range is 1..${BACKUP_DB_VERSION}.`
      );
    }

    // Step 1b: Ensure all 11 canonical collections are present at the container
    // level before digest evaluation so truncated/incomplete backups report
    // INCOMPLETE_BACKUP_DATA deterministically.
    for (const key of ARRAY_COLLECTION_KEYS) {
      if (!Array.isArray(parsed.data[key])) {
        throw new BackupValidationError(
          'INCOMPLETE_BACKUP_DATA',
          `Incomplete backup file: canonical collection "${key}" is missing or is not an array.`
        );
      }
    }
    if (
      !('profile' in parsed.data) ||
      (parsed.data.profile !== null && !isPlainObject(parsed.data.profile))
    ) {
      throw new BackupValidationError(
        'INCOMPLETE_BACKUP_DATA',
        'Incomplete backup file: "profile" must be explicitly present as null or an object.'
      );
    }

    // Step 2: Validate integrity block metadata & cryptographic digest BEFORE
    // accepting any payload contents. Any modification or corruption to
    // `manifest` or `data` is caught immediately here.
    const rawIntegrity = parsed.integrity;
    if (
      rawIntegrity.algorithm !== BACKUP_HASH_ALGORITHM ||
      rawIntegrity.canonicalization !== BACKUP_CANONICALIZATION
    ) {
      throw new BackupValidationError(
        'UNSUPPORTED_HASH_ALGORITHM',
        `Unsupported backup integrity parameters (algorithm="${String(rawIntegrity.algorithm)}", canonicalization="${String(rawIntegrity.canonicalization)}").`
      );
    }
    if (typeof rawIntegrity.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(rawIntegrity.digest)) {
      throw new BackupValidationError(
        'INTEGRITY_HASH_MISSING',
        'Backup integrity digest is missing or is not a valid 64-character hexadecimal string.'
      );
    }

    let canonicalPayload: string;
    try {
      canonicalPayload = this.canonicalizeForHashing(parsed.manifest, parsed.data);
    } catch (err) {
      throw new BackupValidationError(
        'INVALID_RECORD_SCHEMA',
        `Backup payload could not be canonicalized: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const computedDigest = await computeIntegrityDigestHex(canonicalPayload);
    const declaredDigest = rawIntegrity.digest.toLowerCase();
    if (!constantTimeHexEquals(computedDigest, declaredDigest)) {
      throw new BackupValidationError(
        'INTEGRITY_MISMATCH',
        'Backup integrity verification failed: computed digest does not match the backup hash. The file may be modified or corrupted.'
      );
    }

    // Step 3: Even with a matching digest (e.g. a hand-crafted file that
    // recomputed its own hash over an incomplete or malformed payload), enforce
    // full canonical collection presence, per-record schema & finite numbers,
    // unique primary keys, and manifest record-count reconciliation.
    const validatedData = validateBackupDataSchema(parsed.data);
    const actualCounts = computeRecordCounts(validatedData);
    const validatedManifest = validateManifestAndCounts(parsed.manifest, actualCounts);

    return {
      manifest: JSON.parse(JSON.stringify(validatedManifest)) as LocalBackupManifest,
      integrity: {
        algorithm: BACKUP_HASH_ALGORITHM,
        canonicalization: BACKUP_CANONICALIZATION,
        digest: declaredDigest,
      },
      data: validatedData,
    };
  }
}
