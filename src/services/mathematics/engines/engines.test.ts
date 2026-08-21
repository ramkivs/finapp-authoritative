import { describe, it, expect } from 'vitest';
import { RetirementFireEngine } from './RetirementFireEngine';
import { SwpEngine } from './SwpEngine';

describe('Financial Engines', () => {
  
  it('should calculate Retirement FIRE metrics correctly', () => {
    const input = {
      currentAge: 30,
      targetRetirementAge: 55,
      annualLivingExpenses: 500000,
      currentInvestedCorpus: 1000000,
      monthlySavings: 20000,
      preRetirementReturnRatePct: 12.0,
      postRetirementReturnRatePct: 8.0
    };

    const result = RetirementFireEngine.calculate(input);

    expect(result.state).toBe('VALID');
    expect(result.data).not.toBeNull();
    if (result.data) {
      expect(result.data.yearsToRetirement).toBe(25);
      expect(result.data.targetRetirementCorpus).toBeGreaterThan(0);
    }
  });

  it('should calculate SWP schedule correctly', () => {
    const input = {
      initialCorpus: 5000000,
      monthlyWithdrawal: 25000,
      annualReturnRatePct: 7.5,
      tenureYears: 20
    };

    const result = SwpEngine.calculate(input);

    expect(result.state).toBe('VALID');
    expect(result.data).not.toBeNull();
    if (result.data) {
      expect(result.data.initialCorpus).toBe(5000000);
      expect(result.data.yearlySchedule.length).toBe(20);
      expect(result.data.totalWithdrawn).toBeGreaterThan(0);
    }
  });
});
