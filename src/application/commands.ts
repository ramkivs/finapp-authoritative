import { repository } from '../repositories';
import { useCanonicalLedger } from '../store/useCanonicalLedger';
import { ImportPipelineService } from '../services/ImportPipelineService';
import {
  Transaction,
  AssetType,
  LiabilityType,
  GeographyType,
  NetWorthSnapshot,
  Account,
  ControlledAccountType,
  MonthlyBudget,
  mapTransactionCategoryToBudget,
  BUDGET_CATEGORY_FAMILIES,
  InsurancePolicy,
  PolicyType,
  FinancialGoal,
  GoalTemplateType,
  GOAL_TEMPLATES,
  FinancialProfile
} from '../domain/types';
import { formatDisplayDate, getEffectiveAsOfDate } from '../services/DateRangeService';
import { AccountResolutionService } from '../services/AccountResolutionService';
import { TransactionFactory } from '../domain/TransactionFactory';
import { TransactionSignService } from '../services/TransactionSignService';

const SAMPLE_DEFAULT_CSV = `Date,Title,Narration,Amount,Type,Account
2026-08-06,ITC Limited,ACH/C-/ITC LTD DIVIDEND/NSE0098,2100,INCOME,HDFC Bank
2026-08-04,Coal India Ltd,ECS/C/COAL INDIA INT DIVIDEND,1500,INCOME,SBI Bank
2026-08-01,Imported Payout 1,ACH/C/DIVIDEND-CREDIT-ROW-1,1000,INCOME,HDFC Bank (...4921)
2026-08-01,Imported Payout 2,ACH/C/DIVIDEND-CREDIT-ROW-2,1000,INCOME,HDFC Bank (...4921)`;

export class FinancialCommands {
  /**
   * WP-FB-DATA-06a: these three commands previously duplicated the store's
   * transaction literals field-for-field, and had already drifted (the transfer
   * id prefix here was `tr-cmd-` while the store used `tr-`). Both paths now
   * construct through the single TransactionFactory authority, so the drift is
   * gone and any future field is added in exactly one place.
   */
  static recordIncome(title: string, amount: number, account: string, category: string, notes?: string): void {
    repository.transactions.append(TransactionFactory.createIncome({
      title,
      amount,
      account,
      accountId: AccountResolutionService.resolveId(account, repository.accounts.findAllSync()),
      category,
      notes
    }));
  }

  static recordExpense(title: string, amount: number, account: string, category: string, notes?: string): void {
    repository.transactions.append(TransactionFactory.createExpense({
      title,
      amount,
      account,
      accountId: AccountResolutionService.resolveId(account, repository.accounts.findAllSync()),
      category,
      notes
    }));
  }

  /** WP-FB-DATA-06b: returns the promise so an integrity rejection is visible. */
  static recordTransfer(source: string, destination: string, amount: number): Promise<void> {
    const accounts = repository.accounts.findAllSync();
    return repository.transactions.appendMany(TransactionFactory.createTransferPair({
      source,
      destination,
      amount,
      sourceAccountId: AccountResolutionService.resolveId(source, accounts),
      destinationAccountId: AccountResolutionService.resolveId(destination, accounts)
    }));
  }

  /**
   * WP-FB-DATA-07b: the promise is RETURNED, not discarded.
   *
   * A rejection is a refusal or a persistence failure — either way the user's
   * holding was NOT recorded, and a caller that cannot see it shows a UI that
   * disagrees with storage. The 07b gate measured exactly that: a failing asset
   * create closed the modal as if it had worked.
   */
  static recordAsset(name: string, amount: number): Promise<void> {
    return repository.assets.add({ name, amount });
  }

  /**
   * WP-FB-DATA-07a: the promise is RETURNED, not discarded.
   *
   * A rejection here is either a refusal (duplicate name) or a persistence
   * failure — in both cases the user's figure was NOT recorded, and a caller
   * that cannot see the rejection shows a UI that disagrees with storage.
   */
  static recordLiability(name: string, amount: number): Promise<void> {
    return repository.liabilities.add({ name, amount });
  }

  static recordAssetWithMetadata(params: { name: string; amount: number; type?: AssetType; tag?: string; currency?: string; geography?: GeographyType }): Promise<void> {
    return repository.assets.add(params);
  }

  /**
   * WP-FB-DATA-07b — Edit. Addressed by `id`, never by name; the complete
   * record is submitted so no field is silently blanked (hazard H2).
   */
  static updateAsset(params: { id: string; name: string; amount: number; type?: AssetType; tag?: string; currency?: string; geography?: GeographyType }): Promise<void> {
    return repository.assets.update(params);
  }

  /** WP-FB-DATA-07b — Delete by `id` (Q-D07b-1b = (b)). Irreversible. */
  static removeAsset(id: string): Promise<void> {
    return repository.assets.remove(id);
  }

  static recordLiabilityWithMetadata(params: { name: string; amount: number; type?: LiabilityType; currency?: string }): Promise<void> {
    return repository.liabilities.add(params);
  }

  /**
   * WP-FB-DATA-07a — Edit. Addressed by `id`, never by name; the complete
   * record is submitted so no field is silently blanked (Q-D07a-1 = (c)).
   */
  static updateLiability(params: { id: string; name: string; amount: number; type?: LiabilityType; currency?: string }): Promise<void> {
    return repository.liabilities.update(params);
  }

  /** WP-FB-DATA-07a — Delete by `id` (Q-D07a-3 = (b)). Irreversible. */
  static removeLiability(id: string): Promise<void> {
    return repository.liabilities.remove(id);
  }

  static addPastSnapshot(params: { dateStr: string; totalAssets: number; totalLiabilities: number; label?: string }): Promise<void> {
    const { dateStr, totalAssets, totalLiabilities, label } = params;
    // Future date validation against the effective as-of date
    const parts = dateStr.split("-");
    let targetDate = new Date(dateStr);
    if (parts.length === 3 && parts[0].length === 2) {
      // DD-MM-YYYY
      targetDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }
    const today = new Date(getEffectiveAsOfDate());
    if (!isNaN(targetDate.getTime()) && targetDate > today) {
      throw new Error("Cannot record a net worth snapshot for a future date.");
    }
    const netWorth = totalAssets - totalLiabilities;
    const snap: NetWorthSnapshot = {
      id: "snap-past-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      dateStr,
      totalAssets,
      totalLiabilities,
      netWorth,
      status: "Anchored Permanent",
      label
    };
    return repository.snapshots.create(snap);
  }

  static createSnapshot(label?: string): Promise<void> {
    if (label) {
      const totalAssets = repository.assets.findAllSync().reduce((sum, a) => sum + a.amount, 0);
      const totalLiabilities = repository.liabilities.findAllSync().reduce((sum, l) => sum + l.amount, 0);
      const netWorth = totalAssets - totalLiabilities;
      return repository.snapshots.create({
        id: "snap-" + Date.now(),
        dateStr: formatDisplayDate(getEffectiveAsOfDate()) + " (Today)",
        totalAssets,
        totalLiabilities,
        netWorth,
        status: "Anchored Permanent",
        label
      });
    }
    return repository.snapshots.create();
  }

  static importStatement(
    csvText?: string,
    provider: string = 'CSV Upload',
    fileName: string = 'upload.csv'
  ): {
    appended: number;
    duplicates: number;
    totalDetected: number;
    batchId: string;
    validRows: Transaction[];
    invalidCount: number;
    ambiguousCount: number;
    detectedFormatId: string;
    formatDisplayName: string;
    invalidRows: import('../services/ImportPipelineService').ImportRowIssue[];
    ambiguousRows: import('../services/ImportPipelineService').ImportRowIssue[];
    unsupportedFormat?: boolean;
  } {
    const textToParse = csvText || SAMPLE_DEFAULT_CSV;
    const existing = repository.transactions.findAllSync();
    const result = ImportPipelineService.processCSV(textToParse, existing, provider, fileName);

    // Commit the unique valid rows to the store and repository
    const storeResult = useCanonicalLedger.getState().commitImportedRows(result.validRows);

    return {
      appended: storeResult.appended,
      duplicates: result.duplicateCount,
      totalDetected: result.totalDetected,
      batchId: result.batchId,
      validRows: result.validRows,
      invalidCount: result.invalidCount,
      ambiguousCount: result.ambiguousCount,
      detectedFormatId: result.detectedFormatId,
      formatDisplayName: result.formatDisplayName,
      invalidRows: result.invalidRows,
      ambiguousRows: result.ambiguousRows,
      unsupportedFormat: result.unsupportedFormat
    };
  }

  /* =========================================================================
   * WP-18: Account Commands
   * ========================================================================= */

  static recordAccount(params: {
    name: string;
    type: ControlledAccountType;
    institution?: string;
    lastFourDigits?: string;
    openingBalance: number;
    currency?: string;
    asOfDate?: string;
    notes?: string;
  }): Promise<Account> {
    if (!params.name || !params.name.trim()) {
      throw new Error('Account name is required.');
    }

    const account: Account = {
      id: 'acc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: params.name.trim(),
      type: params.type,
      institution: params.institution?.trim() || undefined,
      lastFourDigits: params.lastFourDigits?.trim() || undefined,
      openingBalance: Number(params.openingBalance) || 0,
      currency: params.currency?.trim() || undefined,
      asOfDate: params.asOfDate || getEffectiveAsOfDate(),
      notes: params.notes?.trim() || undefined
    };

    // WP-FB-DATA-08B: the persistence promise is RETURNED. The constructed
    // record is still handed back, but only once storage has agreed - no
    // caller may claim success from it before that.
    return repository.accounts.add(account).then(() => account);
  }

  /**
   * WP-FB-DATA-08A: the promise is RETURNED, not discarded.
   *
   * This is a destructive operation behind a confirmation. The 08 gate
   * measured what a discarded rejection looked like: the user confirmed the
   * deletion, the write failed, the row stayed on screen and NOTHING was
   * said - the rejection escaped as an unhandled page error instead.
   */
  static deleteAccount(id: string): Promise<void> {
    return repository.accounts.remove(id);
  }

  /* =========================================================================
   * WP-18: Monthly Budget Commands
   * ========================================================================= */

  static saveMonthlyBudget(monthStr: string, allocations: Record<string, number>): Promise<MonthlyBudget> {
    const cleanedAllocations: Record<string, number> = {};
    let totalBudget = 0;

    for (const [cat, amt] of Object.entries(allocations)) {
      const num = Number(amt) || 0;
      if (num > 0) {
        cleanedAllocations[cat] = num;
        totalBudget += num;
      }
    }

    const budget: MonthlyBudget = {
      id: 'budget-' + monthStr,
      monthStr,
      allocations: cleanedAllocations,
      totalBudget,
      updatedAt: new Date().toISOString()
    };

    // WP-FB-DATA-08B: the persistence promise is RETURNED. The constructed
    // record is still handed back, but only once storage has agreed - no
    // caller may claim success from it before that.
    return repository.budgets.save(budget).then(() => budget);
  }

  /**
   * Deterministic Trailing-3-Full-Month Expense Average Auto-Suggest.
   * SuggestedBudget(C) = round((Expense_M1 + Expense_M2 + Expense_M3) / 3)
   */
  static autoSuggestBudget(targetMonthStr: string): { allocations: Record<string, number>; totalBudget: number } {
    const [yearStr, monthStr] = targetMonthStr.split('-');
    const targetYear = parseInt(yearStr, 10);
    const targetMonth = parseInt(monthStr, 10);

    // Compute the 3 preceding calendar months (M-1, M-2, M-3)
    const precedingMonths: string[] = [];
    for (let i = 1; i <= 3; i++) {
      let m = targetMonth - i;
      let y = targetYear;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      precedingMonths.push(`${y}-${String(m).padStart(2, '0')}`);
    }

    const allTxs = repository.transactions.findAllSync();
    const categoryTotals: Record<string, number> = {};

    for (const tx of allTxs) {
      if (tx.type !== 'Expense') continue;
      const txMonth = tx.date.slice(0, 7); // "YYYY-MM"
      if (precedingMonths.includes(txMonth)) {
        const budgetCat = mapTransactionCategoryToBudget(tx.category);
        categoryTotals[budgetCat] = (categoryTotals[budgetCat] || 0) + tx.amount;
      }
    }

    const allocations: Record<string, number> = {};
    let totalBudget = 0;

    for (const [cat, totalAmt] of Object.entries(categoryTotals)) {
      const avg = Math.round(totalAmt / 3);
      if (avg > 0) {
        allocations[cat] = avg;
        totalBudget += avg;
      }
    }

    return { allocations, totalBudget };
  }

  /**
   * Copy Budget Allocations from Previous Month ($M-1$).
   */
  /**
   * WP-FB-DATA-08B: awaits the underlying save.
   *
   * The 08B gate measured this returning a truthy budget while persistence had
   * failed, which fired BudgetWorkspace's toast: "Copied budget allocations
   * from previous month (Total: 900)" for a month that was never stored.
   */
  static copyBudgetFromPreviousMonth(targetMonthStr: string, sourceMonthStr?: string): Promise<MonthlyBudget | null> {
    let srcMonth = sourceMonthStr;
    if (!srcMonth) {
      const [yearStr, monthStr] = targetMonthStr.split('-');
      let m = parseInt(monthStr, 10) - 1;
      let y = parseInt(yearStr, 10);
      if (m <= 0) {
        m = 12;
        y -= 1;
      }
      srcMonth = `${y}-${String(m).padStart(2, '0')}`;
    }

    const srcBudget = repository.budgets.findForMonthSync(srcMonth);
    if (!srcBudget) return Promise.resolve(null);

    return this.saveMonthlyBudget(targetMonthStr, { ...srcBudget.allocations });
  }

  /* =========================================================================
   * WP-19: Essentials Commands (Insurance Policies, Goals, Financial Profile)
   * ========================================================================= */

  static recordPolicy(params: {
    type: PolicyType;
    provider: string;
    policyNumber?: string;
    coverAmount: number;
    premiumAmount: number;
    renewalDate?: string;
    status?: 'Active' | 'Lapsed' | 'Pending';
    currency?: string;
    notes?: string;
  }): Promise<InsurancePolicy> {
    if (!params.provider || !params.provider.trim()) {
      throw new Error('Insurance provider name is required.');
    }
    const coverNum = Number(params.coverAmount);
    if (isNaN(coverNum) || coverNum <= 0) {
      throw new Error('Cover amount must be greater than zero.');
    }
    const premiumNum = Number(params.premiumAmount);
    if (isNaN(premiumNum) || premiumNum < 0) {
      throw new Error('Premium amount cannot be negative.');
    }
    const validTypes: PolicyType[] = ['Term Life', 'Health', 'Motor', 'Home', 'Other'];
    if (!validTypes.includes(params.type)) {
      throw new Error(`Invalid policy type "${params.type}".`);
    }
    const validStatuses = ['Active', 'Lapsed', 'Pending'];
    if (params.status && !validStatuses.includes(params.status)) {
      throw new Error(`Invalid policy status "${params.status}".`);
    }

    const policy: InsurancePolicy = {
      id: 'pol-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type: params.type,
      provider: params.provider.trim(),
      policyNumber: params.policyNumber?.trim() || undefined,
      coverAmount: coverNum,
      premiumAmount: premiumNum,
      renewalDate: params.renewalDate?.trim() || undefined,
      status: params.status || 'Active',
      currency: params.currency?.trim() || undefined, // No default INR; preserves Not Specified
      notes: params.notes?.trim() || undefined
    };

    // WP-FB-DATA-08B: the persistence promise is RETURNED. The constructed
    // record is still handed back, but only once storage has agreed - no
    // caller may claim success from it before that.
    return repository.policies.add(policy).then(() => policy);
  }

  /**
   * WP-FB-DATA-08A: the promise is RETURNED, not discarded.
   *
   * This is a destructive operation behind a confirmation. The 08 gate
   * measured what a discarded rejection looked like: the user confirmed the
   * deletion, the write failed, the row stayed on screen and NOTHING was
   * said - the rejection escaped as an unhandled page error instead.
   */
  static deletePolicy(id: string): Promise<void> {
    return repository.policies.remove(id);
  }

  static recordGoal(params: {
    name: string;
    template: GoalTemplateType;
    targetAmount: number;
    targetDate?: string;
    currentSavedAmount?: number;
    monthlyContribution?: number;
    linkedCategory?: string;
    status?: 'In Progress' | 'Achieved' | 'Paused';
    currency?: string;
    notes?: string;
  }): Promise<FinancialGoal> {
    if (!params.name || !params.name.trim()) {
      throw new Error('Goal name is required.');
    }
    const targetNum = Number(params.targetAmount);
    if (isNaN(targetNum) || targetNum <= 0) {
      throw new Error('Target corpus amount must be greater than zero.');
    }
    if (!GOAL_TEMPLATES.includes(params.template)) {
      throw new Error(`Invalid goal template "${params.template}".`);
    }
    const savedNum = params.currentSavedAmount !== undefined ? Number(params.currentSavedAmount) : 0;
    if (isNaN(savedNum) || savedNum < 0) {
      throw new Error('Current saved amount cannot be negative.');
    }
    const monthlyNum = params.monthlyContribution !== undefined ? Number(params.monthlyContribution) : 0;
    if (isNaN(monthlyNum) || monthlyNum < 0) {
      throw new Error('Monthly contribution cannot be negative.');
    }
    const validStatuses = ['In Progress', 'Achieved', 'Paused'];
    if (params.status && !validStatuses.includes(params.status)) {
      throw new Error(`Invalid goal status "${params.status}".`);
    }

    const goal: FinancialGoal = {
      id: 'goal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: params.name.trim(),
      template: params.template,
      targetAmount: targetNum,
      targetDate: params.targetDate?.trim() || undefined,
      currentSavedAmount: savedNum,
      monthlyContribution: monthlyNum,
      linkedCategory: params.linkedCategory?.trim() || undefined,
      status: params.status || 'In Progress',
      currency: params.currency?.trim() || undefined,
      notes: params.notes?.trim() || undefined
    };

    // WP-FB-DATA-08B: the persistence promise is RETURNED. The constructed
    // record is still handed back, but only once storage has agreed - no
    // caller may claim success from it before that.
    return repository.goals.add(goal).then(() => goal);
  }

  /**
   * WP-FB-DATA-08A: the promise is RETURNED, not discarded.
   *
   * This is a destructive operation behind a confirmation. The 08 gate
   * measured what a discarded rejection looked like: the user confirmed the
   * deletion, the write failed, the row stayed on screen and NOTHING was
   * said - the rejection escaped as an unhandled page error instead.
   */
  static deleteGoal(id: string): Promise<void> {
    return repository.goals.remove(id);
  }

  static saveProfile(profile: FinancialProfile): Promise<void> {
    const inc = Number(profile.monthlyIncome);
    if (isNaN(inc) || inc < 0) {
      throw new Error('Monthly income cannot be negative.');
    }
    const exp = Number(profile.monthlyExpenses);
    if (isNaN(exp) || exp < 0) {
      throw new Error('Monthly expenses cannot be negative.');
    }
    if (profile.dependents !== undefined && (isNaN(Number(profile.dependents)) || Number(profile.dependents) < 0)) {
      throw new Error('Dependents count cannot be negative.');
    }
    if (profile.age !== undefined && (isNaN(Number(profile.age)) || Number(profile.age) <= 0 || Number(profile.age) > 120)) {
      throw new Error('Age must be a valid positive number between 1 and 120.');
    }
    if (profile.targetEmergencyMonths !== undefined && (isNaN(Number(profile.targetEmergencyMonths)) || Number(profile.targetEmergencyMonths) < 0)) {
      throw new Error('Target emergency months cannot be negative.');
    }

    const computedSavings = Math.max(0, inc - exp);
    const savingsRate = inc > 0 ? Math.round((computedSavings / inc) * 100) : 0;

    return repository.profile.save({
      ...profile,
      id: 'default-profile',
      monthlyIncome: inc,
      monthlyExpenses: exp,
      savingsRate: profile.savingsRate !== undefined && !isNaN(Number(profile.savingsRate)) && Number(profile.savingsRate) >= 0 ? Number(profile.savingsRate) : savingsRate,
      dependents: profile.dependents !== undefined ? Number(profile.dependents) : undefined,
      age: profile.age !== undefined ? Number(profile.age) : undefined,
      targetEmergencyMonths: profile.targetEmergencyMonths !== undefined ? Number(profile.targetEmergencyMonths) : undefined,
      updatedAt: new Date().toISOString()
    });
  }

  static async clearLocalDevelopmentData(): Promise<void> {
    await repository.clearLocalData();
  }

  static async loadDemoData(): Promise<void> {
    await repository.loadDemoData();
  }

  static togglePrivacy(): void {
    if (typeof window !== 'undefined' && (window as any).useCanonicalLedger) {
      (window as any).useCanonicalLedger.getState().togglePrivacy();
    }
  }
}

if (typeof window !== 'undefined') {
  (window as any).FinancialCommands = FinancialCommands;
}
