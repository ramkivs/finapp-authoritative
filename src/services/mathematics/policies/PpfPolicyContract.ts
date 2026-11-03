/**
 * ARTHAVAULT WP-22: Public Provident Fund (PPF) Policy Schema & Contracts
 * Externalizes statutory government rules from the pure mathematical compounding engine.
 */

import { StatutoryPolicyContract } from '../../../domain/mathematics/types';

export interface PpfPolicyParameters {
  annualInterestRatePct: number;      // e.g. 7.10%
  minAnnualDeposit: number;           // ₹500
  maxAnnualDeposit: number;           // ₹150,000
  mandatoryTenureYears: number;       // 15 years
  compoundingFrequency: 'ANNUAL';
  interestCreditMonth: number;        // 3 (March)
  interestDayRule: 'LOWEST_BALANCE_5TH_TO_MONTH_END';
}

export const STATUTORY_PPF_SCHEME_2019: StatutoryPolicyContract = {
  policyId: 'IN_PPF_SCHEME_2019',
  policyVersion: '2019.1',
  governingAuthority: 'Ministry of Finance (DEA), Government of India',
  effectiveFrom: '2019-12-12',
  effectiveTo: null,
  citation: 'Public Provident Fund Scheme 2019, G.S.R. 915(E)',
  parameters: {
    annualInterestRatePct: { value: 0.071, unit: 'PERCENTAGE_NOMINAL_ANNUAL', provenance: 'STATUTORY_POLICY' },
    minAnnualDeposit: { value: 500, unit: 'CURRENCY_INR', provenance: 'STATUTORY_POLICY' },
    maxAnnualDeposit: { value: 150000, unit: 'CURRENCY_INR', provenance: 'STATUTORY_POLICY' },
    mandatoryTenureYears: { value: 15, unit: 'DURATION_YEARS', provenance: 'STATUTORY_POLICY' }
  }
};
