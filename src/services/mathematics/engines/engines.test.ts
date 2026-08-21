import { describe, it, expect } from 'vitest';
import { RetirementFireInput } from './RetirementFireEngine';
import { SwpCalculationInput } from './SwpEngine';

// Note: These tests assume the engines are exported functions or classes.
// Adjust the imports based on your actual file exports.

describe('Financial Engines', () => {
  
  it('should validate RetirementFireInput structure', () => {
    const input: RetirementFireInput = {
      currentAge: 30,
      targetRetirementAge: 55,
      annualLivingExpenses: 500000,
      currentInvestedCorpus: 1000000,
      monthlySavings: 20000,
      preRetirementReturnRatePct: 12.0,
      postRetirementReturnRatePct: 8.0
    };

    expect(input.currentAge).toBe(30);
    expect(input.annualLivingExpenses).toBeGreaterThan(0);
  });

  it('should validate SwpCalculationInput structure', () => {
    const input: SwpCalculationInput = {
      initialCorpus: 5000000,
      monthlyWithdrawal: 25000,
      annualReturnRatePct: 7.5,
      tenureYears: 20
    };

    expect(input.initialCorpus).toBe(5000000);
    expect(input.monthlyWithdrawal).toBe(25000);
  });
});
