import { BankStatementAdapter, StatementInput, DetectionResult, BankStatementRecord, NormalizedBankTransaction, ImportRowIssue, ParsedCsvRow } from '../ImportTypes';
import { CsvRecordParser } from '../parsers/CsvRecordParser';
import { DateNormalizer } from '../normalization/DateNormalizer';
import { AmountNormalizer } from '../normalization/AmountNormalizer';
import { NarrationNormalizer } from '../normalization/NarrationNormalizer';
import { Transaction } from '../../../domain/types';
import { TransactionIdentityService } from '../../TransactionIdentityService';

export class GenericCsvAdapter implements BankStatementAdapter {
  readonly id = 'generic_csv';
  readonly displayName = 'Generic CSV Statement';

  canHandle(input: StatementInput): DetectionResult {
    if (input.kind !== 'text') {
      return { matched: false, formatId: 'generic_csv', displayName: this.displayName, confidence: 'NONE', reason: 'Generic CSV adapter does not handle binary inputs' };
    }
    const { headers } = CsvRecordParser.parse(input.content.slice(0, 1000));
    const lowerHeaders = headers.map(h => h.toLowerCase());

    const hasDate = lowerHeaders.some(h => h.includes('date') || h.includes('tx_date'));
    const hasAmount = lowerHeaders.some(h => h.includes('amount') || h === 'val' || h === 'value');

    if (hasDate && hasAmount) {
      return {
        matched: true,
        formatId: 'generic_csv',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched generic CSV header signature (Date + Amount)'
      };
    }

    return {
      matched: false,
      formatId: 'generic_csv',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match generic CSV header signature'
    };
  }

  canHandleRows(headers: string[], rows: ParsedCsvRow[]): DetectionResult {
    return {
      matched: false,
      formatId: 'generic_csv',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Generic CSV adapter does not handle binary inputs'
    };
  }

  parse(input: StatementInput): BankStatementRecord[] {
    if (input.kind !== 'text') return [];
    const { rows } = CsvRecordParser.parse(input.content);
    return this.parseRows(rows, input.fileName, input.selectedProvider);
  }

  parseRows(rows: ParsedCsvRow[], fileName: string, selectedProvider?: string): BankStatementRecord[] {
    const records: BankStatementRecord[] = [];

    rows.forEach(r => {
      const row = r.data;
      const dateVal = row['date'] || row['tx_date'] || row['transaction date'] || '';
      const titleVal = row['title'] || row['description'] || row['name'] || row['payee'] || '';
      const narrationVal = row['narration'] || row['memo'] || row['details'] || titleVal || 'Imported Transaction';
      const amountRaw = row['amount'] || row['val'] || row['value'] || '0';
      const typeValRaw = (row['type'] || row['tx_type'] || '').toUpperCase();
      const accountVal = row['account'] || row['bank'] || selectedProvider || 'Bank Account';

      const parsedNum = AmountNormalizer.parseAmount(amountRaw);
      let debitAmount = 0;
      let creditAmount = 0;

      // Handle generic CSV negative/positive amounts and explicit type columns
      if (typeValRaw.includes('EXPENSE') || typeValRaw.includes('DEBIT') || parsedNum < 0) {
        debitAmount = Math.abs(parsedNum);
      } else {
        creditAmount = Math.abs(parsedNum);
      }

      records.push({
        sourceBank: accountVal,
        transactionDate: dateVal,
        narration: narrationVal,
        debitAmount,
        creditAmount,
        sourceRowNumber: r.rowNumber,
        sourceFile: fileName,
        rawRecord: row
      });
    });

    return records;
  }

  normalize(
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

    const debit = record.debitAmount || 0;
    const credit = record.creditAmount || 0;

    if (debit === 0 && credit === 0) {
      const issue: ImportRowIssue = {
        rowNumber: record.sourceRowNumber,
        severity: 'INVALID',
        code: 'ZERO_TRANSACTION',
        message: `Transaction on row ${record.sourceRowNumber} has zero amount.`,
        field: 'Amount',
        rawValue: '0'
      };
      return { candidate: null, issue };
    }

    let type: 'Income' | 'Expense' = 'Income';
    let amount = 0;

    if (debit > 0) {
      type = 'Expense';
      amount = debit;
    } else {
      type = 'Income';
      amount = credit;
    }

    const titleRaw = record.rawRecord?.['title'] || record.rawRecord?.['description'] || record.rawRecord?.['payee'] || record.narration;
    const sanitizedTitle = NarrationNormalizer.normalize(titleRaw);
    const sanitizedNarration = NarrationNormalizer.normalize(record.narration);
    const accountVal = record.sourceBank || context.provider;

    const candidate: Transaction = {
      id: `tx-import-${context.batchId}-${record.sourceRowNumber}`,
      date: normDate,
      dateStr: normDate,
      title: sanitizedTitle,
      narration: sanitizedNarration,
      account: accountVal,
      type,
      // WP-FB-DATA-06a: the generic-CSV path was the ONLY construction site that
      // omitted `direction`, while the bank-statement normalizer set it. Sign was
      // therefore recovered by TransactionSignService's type fallback rather than
      // being stated. The value assigned here is exactly what that fallback already
      // derived, so no sign, balance or total changes — the row simply now states
      // its direction instead of leaving it to be re-derived.
      direction: type === 'Income' ? 'CREDIT' : 'DEBIT',
      category: record.rawRecord?.['category'] || 'GENERAL',
      amount,
      status: 'CLEARED',
      notes: `Imported from ${context.fileName}`,
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
