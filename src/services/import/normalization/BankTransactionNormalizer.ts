import { BankStatementRecord, NormalizedBankTransaction, ImportRowIssue } from '../ImportTypes';
import { Transaction } from '../../../domain/types';
import { DateNormalizer } from './DateNormalizer';
import { NarrationNormalizer } from './NarrationNormalizer';
import { TransactionIdentityService } from '../../TransactionIdentityService';

const PPF_NARRATION_PATTERN = /\bppf\b|public\s+provident\s+fund/i;
const PPF_INTEREST_PATTERN = /\b(?:interest|int\.?\s*paid|int\.?\s*credit|credit\s*interest|by\s+interest)\b/i;

export class BankTransactionNormalizer {
  /**
   * Resolves the canonical category for a normalized bank or PPF statement row (`DEF-17`).
   * - Regular bank statement debits to PPF are categorized as `'INVESTMENT'` so they
   *   track under Investments rather than distorting general household expenses.
   * - PPF account statement credits distinguish tax-free `'INTEREST'` from principal
   *   `'PPF_CONTRIBUTION'` deposits.
   * - Explicit categories supplied by Generic CSV rows are always honoured first.
   */
  static resolveCategory(params: {
    type: 'Income' | 'Expense';
    narration: string;
    explicitCategory?: string;
    isPpfAccount?: boolean;
  }): string {
    const explicit = params.explicitCategory?.trim();
    if (explicit) return explicit;

    if (params.isPpfAccount) {
      if (params.type === 'Income') {
        return PPF_INTEREST_PATTERN.test(params.narration) ? 'INTEREST' : 'PPF_CONTRIBUTION';
      }
      return 'GENERAL';
    }

    if (params.type === 'Expense' && PPF_NARRATION_PATTERN.test(params.narration)) {
      return 'INVESTMENT';
    }

    return 'GENERAL';
  }

  /**
   * Transforms an ingestion-layer BankStatementRecord into a canonical FinBoom Transaction.
   * Enforces debit/credit rules, date validation, strict amount validation, narration
   * security sanitization, PPF classification, and deterministic fingerprinting.
   */
  static normalize(
    record: BankStatementRecord,
    context: { provider: string; fileName: string; batchId: string }
  ): NormalizedBankTransaction {
    const normDate = DateNormalizer.normalize(record.transactionDate);
    if (!normDate) {
      const issue: ImportRowIssue = {
        rowNumber: record.sourceRowNumber,
        severity: 'INVALID',
        code: 'INVALID_DATE',
        message: `Invalid or unparseable source date: "${record.transactionDate}"`,
        field: 'Date',
        rawValue: record.transactionDate
      };
      return { candidate: null, issue };
    }

    if (record.amountError) {
      const issue: ImportRowIssue = {
        rowNumber: record.sourceRowNumber,
        severity: 'INVALID',
        code: 'INVALID_AMOUNT',
        message: record.amountError,
        field: 'Amount',
        rawValue: record.rawAmountText || ''
      };
      return { candidate: null, issue };
    }

    const debit = Math.abs(record.debitAmount || 0);
    const credit = Math.abs(record.creditAmount || 0);

    // Rule: Both debit and credit non-zero -> AMBIGUOUS
    if (debit > 0 && credit > 0) {
      const issue: ImportRowIssue = {
        rowNumber: record.sourceRowNumber,
        severity: 'AMBIGUOUS',
        code: 'BOTH_DEBIT_AND_CREDIT_PRESENT',
        message: `Both Debit (${debit}) and Credit (${credit}) are populated on row ${record.sourceRowNumber}.`,
        field: 'Debit/Credit',
        rawValue: `Debit: ${debit}, Credit: ${credit}`
      };
      return { candidate: null, issue };
    }

    // Rule: Both zero -> INVALID (ZERO_TRANSACTION)
    if (debit === 0 && credit === 0) {
      const issue: ImportRowIssue = {
        rowNumber: record.sourceRowNumber,
        severity: 'INVALID',
        code: 'ZERO_TRANSACTION',
        message: `Transaction on row ${record.sourceRowNumber} has zero debit and zero credit.`,
        field: 'Amount',
        rawValue: '0'
      };
      return { candidate: null, issue };
    }

    let type: 'Income' | 'Expense' = 'Income';
    let amount = 0;

    if (credit > 0) {
      type = 'Income';
      amount = Math.round(credit * 10000) / 10000;
    } else {
      type = 'Expense';
      amount = Math.round(debit * 10000) / 10000;
    }

    const sanitizedNarration = NarrationNormalizer.normalize(record.narration);
    const accountVal = record.sourceBank || context.provider;
    const isPpf = Boolean(
      record.isPpfAccount ||
      PPF_NARRATION_PATTERN.test(accountVal) ||
      PPF_NARRATION_PATTERN.test(context.provider)
    );
    const category = this.resolveCategory({
      type,
      narration: sanitizedNarration,
      isPpfAccount: isPpf
    });

    const normalizedRef = TransactionIdentityService.normalizeReferenceNumber(record.referenceNumber);

    const candidate: Transaction = {
      id: `tx-import-${context.batchId}-${record.sourceRowNumber}`,
      date: normDate,
      dateStr: normDate,
      title: sanitizedNarration,
      narration: sanitizedNarration,
      account: accountVal,
      type,
      direction: type === 'Income' ? 'CREDIT' : 'DEBIT',
      category,
      amount,
      status: 'CLEARED',
      notes: `Imported from ${context.fileName}`,
      // WP-FB-DATA-06a: origin is recorded EXPLICITLY at the point the row is
      // created, never inferred later from the presence of importBatchId.
      origin: 'IMPORT',
      recordedAt: TransactionIdentityService.recordedAt(),
      importBatchId: context.batchId,
      sourceProvider: context.provider,
      sourceFile: context.fileName,
      sourceRowNumber: record.sourceRowNumber,
      ...(normalizedRef ? { referenceNumber: normalizedRef } : {}),
      ...(typeof record.closingBalance === 'number' && Number.isFinite(record.closingBalance)
        ? { closingBalance: record.closingBalance }
        : {})
    };

    candidate.fingerprint = TransactionIdentityService.fingerprint({
      account: candidate.account,
      date: candidate.date,
      amount: candidate.amount,
      narration: candidate.narration
    });

    return { candidate };
  }
}
