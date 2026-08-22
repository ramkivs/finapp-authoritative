import { BankStatementRecord, NormalizedBankTransaction, ImportRowIssue } from '../ImportTypes';
import { Transaction } from '../../../domain/types';
import { DateNormalizer } from './DateNormalizer';
import { NarrationNormalizer } from './NarrationNormalizer';
import { TransactionIdentityService } from '../../TransactionIdentityService';

export class BankTransactionNormalizer {
  /**
   * Transforms an ingestion-layer BankStatementRecord into a canonical FinBoom Transaction.
   * Enforces debit/credit rules, date validation, narration security sanitization, and SHA-256 fingerprinting.
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
      amount = credit;
    } else {
      type = 'Expense';
      amount = debit;
    }

    const sanitizedNarration = NarrationNormalizer.normalize(record.narration);
    const accountVal = record.sourceBank || context.provider;

    const candidate: Transaction = {
      id: `tx-import-${context.batchId}-${record.sourceRowNumber}`,
      date: normDate,
      dateStr: normDate,
      title: sanitizedNarration,
      narration: sanitizedNarration,
      account: accountVal,
      type,
      direction: type === 'Income' ? 'CREDIT' : 'DEBIT',
      category: 'GENERAL',
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
      sourceRowNumber: record.sourceRowNumber
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
