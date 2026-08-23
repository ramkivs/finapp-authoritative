/**
 * FINBOOM WP-22: Provenance Service
 * Calculates input fingerprints and structured execution identities via
 * RFC 8785 JCS canonicalization and a deterministic digest.
 *
 * ⚠️ The digest is NOT SHA-256 despite `Sha256Service`'s name (POST10 gate,
 * measured against the RFC vectors and native WebCrypto). Fingerprints are
 * reproducible within FinBoom; they are NOT independently verifiable by a
 * third party. Do not describe them as SHA-256 anywhere user-facing.
 */

import { Sha256Service } from '../Sha256Service';
import { CanonicalNormalizationService } from './CanonicalNormalizationService';
import { JcsSerializationService } from './JcsSerializationService';
import { CanonicalExecutionIdentity, CalculationProvenance } from '../../domain/mathematics/types';

export class ProvenanceService {
  /**
   * Compute the canonical inputFingerprint of normalized mathematical inputs.
   */
  static computeInputFingerprint(rawInputs: unknown): string {
    const normalized = CanonicalNormalizationService.normalize(rawInputs);
    const jcsString = JcsSerializationService.canonicalize(normalized);
    return Sha256Service.hash(jcsString);
  }

  /**
   * Compute the canonical executionFingerprint of the structured execution identity.
   */
  static computeExecutionFingerprint(identity: CanonicalExecutionIdentity): string {
    const normalized = CanonicalNormalizationService.normalize(identity);
    const jcsString = JcsSerializationService.canonicalize(normalized);
    return Sha256Service.hash(jcsString);
  }

  /**
   * Build complete calculation provenance metadata.
   */
  static createProvenance(params: {
    engineId: string;
    algorithmId: string;
    algorithmVersion: string;
    rawInputs: unknown;
    policyContractId?: string | null;
    policyVersion?: string | null;
    configVersion?: string | null;
    referenceType: 'STATUTORY_AUTHORITY' | 'INDUSTRY_STANDARD' | 'FIRST_PRINCIPLES' | 'ILLUSTRATIVE';
    citation?: string;
  }): CalculationProvenance {
    const inputFingerprint = this.computeInputFingerprint(params.rawInputs);
    const executionIdentity: CanonicalExecutionIdentity = {
      algorithmId: params.algorithmId,
      algorithmVersion: params.algorithmVersion,
      configVersion: params.configVersion || null,
      inputFingerprint,
      policyContractId: params.policyContractId || null,
      policyVersion: params.policyVersion || null
    };
    const executionFingerprint = this.computeExecutionFingerprint(executionIdentity);

    return {
      engineId: params.engineId,
      algorithmId: params.algorithmId,
      algorithmVersion: params.algorithmVersion,
      policyContractId: params.policyContractId || null,
      policyVersion: params.policyVersion || null,
      configVersion: params.configVersion || null,
      inputFingerprint,
      executionFingerprint,
      referenceType: params.referenceType,
      citation: params.citation
    };
  }
}
