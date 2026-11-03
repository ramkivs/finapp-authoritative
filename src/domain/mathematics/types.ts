/**
 * ARTHAVAULT WP-22: Canonical Mathematical Intelligence Engine
 * Core Domain Types & Schema Contracts
 */

export type CanonicalUnit =
  // Currency Units
  | 'CURRENCY_INR'              // Indian Rupee (₹)
  | 'CURRENCY_USD'              // United States Dollar ($)
  // Percentage & Rate Units (Decimal Fractions)
  | 'PERCENTAGE_NOMINAL_ANNUAL' // e.g. 0.085 for 8.50% p.a. nominal
  | 'PERCENTAGE_EFFECTIVE_ANNUAL'// e.g. 0.08839 for 8.839% p.a. compounded
  | 'PERCENTAGE_MONTHLY'        // e.g. 0.010 for 1.00% monthly
  | 'DECIMAL_RATIO'             // Base-1 decimal ratio (e.g. 0.20 for 20%)
  | 'BASIS_POINTS'              // e.g. 850 bps = 0.085
  // Time & Duration Units
  | 'DURATION_YEARS'            // Whole or fractional calendar years
  | 'DURATION_MONTHS'           // Integer monthly tenure
  | 'DURATION_DAYS'             // Integer calendar days
  | 'CALENDAR_DATE'             // Timezone-independent date 'YYYY-MM-DD'
  | 'TIMESTAMP_INSTANT'         // ISO-8601 UTC Instant
  // Dimensionless Units
  | 'DIMENSIONLESS_COUNT'       // Discrete integer count
  | 'GROWTH_MULTIPLE'           // e.g. 2.50x
  | 'PROBABILITY_FRACTION'      // [0.0, 1.0]
  | 'SCORE_INTEGER';            // e.g. 752 (0 to 900)

export type InputProvenanceType =
  | 'USER_DIRECT'
  | 'CANONICAL_LEDGER'
  | 'HISTORICAL_SNAPSHOT'
  | 'STATUTORY_POLICY'
  | 'APPLICATION_DEFAULT';

export interface TypedInputValue<T = number> {
  value: T;
  unit: CanonicalUnit;
  provenance: InputProvenanceType;
  label?: string;
}

export type CalculationState =
  | 'VALID'               // Normal mathematical convergence to a valid root/result
  | 'ZERO'                // Legitimate, deterministic mathematical zero output
  | 'NOT_CONFIGURED'      // Essential source inputs missing or uninitialized
  | 'INSUFFICIENT_DATA'   // Cardinality too low (e.g. fewer than 2 cash flows for XIRR)
  | 'INVALID_INPUT'       // Input parameter violates domain constraints (e.g. principal < 0)
  | 'NO_SOLUTION'         // Mathematical analysis proves no real solution exists in domain
  | 'CONVERGENCE_FAILURE' // Numerical solver exhausted iterations without reaching tolerance
  | 'NUMERIC_FAILURE'     // Unrecoverable floating-point exception (NaN, Infinity, overflow)
  | 'OUT_OF_DOMAIN'       // Parameters reside outside valid analytical domain
  | 'AMBIGUOUS_SOLUTION'; // Multiple mathematically valid roots detected in domain

export type DataFreshness =
  | 'CURRENT'  // Synchronized with latest ledger state
  | 'STALE'    // Underlying anchor state is historic/uncalibrated
  | 'UNKNOWN'; // Freshness provenance cannot be determined

export type CalculationErrorCode =
  | 'ERR_INPUT_REQUIRED'
  | 'ERR_INPUT_INVALID'
  | 'ERR_INPUT_OUT_OF_RANGE'
  | 'ERR_UNIT_MISMATCH'
  | 'ERR_DATE_INVALID'
  | 'ERR_DATE_ORDER_INVALID'
  | 'ERR_INSUFFICIENT_DATA'
  | 'ERR_NO_SOLUTION'
  | 'ERR_CONVERGENCE_FAILURE'
  | 'ERR_AMBIGUOUS_SOLUTION'
  | 'ERR_NUMERIC_OVERFLOW'
  | 'ERR_NUMERIC_UNDERFLOW'
  | 'ERR_DIVISION_BY_ZERO'
  | 'ERR_OUT_OF_DOMAIN'
  | 'ERR_NUMERIC_FAILURE'
  | 'ERR_UNSUPPORTED_CONFIGURATION'
  | 'ERR_POLICY_NOT_FOUND'
  | 'ERR_POLICY_EXPIRED'
  | 'ERR_PROVENANCE_MISSING';

export interface CalculationError {
  code: CalculationErrorCode;
  message: string;
  field?: string;
  invalidValue?: unknown;
  remediation?: string;
}

export interface CalculationDiagnostics {
  iterationsUsed?: number;
  residualNpv?: number;
  relativeResidual?: number;
  convergenceRate?: number;
  detectedCandidateRoots?: number[];
  executionTimeMs?: number;
  warnings?: string[];
}

export interface CanonicalExecutionIdentity {
  algorithmId: string;
  algorithmVersion: string;
  configVersion: string | null;
  inputFingerprint: string;
  policyContractId: string | null;
  policyVersion: string | null;
}

export interface CalculationProvenance {
  engineId: string;
  algorithmId: string;
  algorithmVersion: string;
  policyContractId?: string | null;
  policyVersion?: string | null;
  configVersion?: string | null;
  inputFingerprint: string;
  executionFingerprint: string;
  referenceType: 'STATUTORY_AUTHORITY' | 'INDUSTRY_STANDARD' | 'FIRST_PRINCIPLES' | 'ILLUSTRATIVE';
  citation?: string;
}

export interface CalculationRequest<TInputs, TConfig = Record<string, unknown>> {
  requestId: string;
  calculationId: string;
  targetAlgorithmVersion?: string;
  inputs: TInputs;
  configuration?: TConfig;
  policyVersionRef?: string;
  requestTimestamp: string;
}

export interface CalculationResult<TOutput> {
  calculationId: string;
  state: CalculationState;
  freshness: DataFreshness;
  data: TOutput | null;
  unit?: CanonicalUnit;
  diagnostics: CalculationDiagnostics;
  provenance: CalculationProvenance;
  error?: CalculationError;
}

export interface GoldenVectorOutputField<T = number> {
  exactExpectedValue: T;
  canonicalUnit: CanonicalUnit;
  permissibleTolerance: number;
  displayExpectedValue: string;
}

export interface StatutoryPolicyContract {
  policyId: string;
  policyVersion: string;
  governingAuthority: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  parameters: Record<string, TypedInputValue<unknown>>;
  roundingRules?: Record<string, string>;
  citation?: string;
}
