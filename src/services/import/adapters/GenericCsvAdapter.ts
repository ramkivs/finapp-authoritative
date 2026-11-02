import { BankStatementAdapter, StatementInput, DetectionResult, BankStatementRecord, NormalizedBankTransaction, ImportRowIssue, ParsedCsvRow } from '../ImportTypes';
import { CsvRecordParser } from '../parsers/CsvRecordParser';
import { DateNormalizer } from '../normalization/DateNormalizer';
import { AmountNormalizer } from '../normalization/AmountNormalizer';
import { NarrationNormalizer } from '../normalization/NarrationNormalizer';
import { BankTransactionNormalizer } from '../normalization/BankTransactionNormalizer';
import { Transaction } from '../../../domain/types';
import { TransactionIdentityService } from '../../TransactionIdentityService';

const PPF_CONTEXT_PATTERN = /\bppf\b|public\s+provident\s+fund/i;

export class GenericCsvAdapter implements BankStatementAdapter {
  readonly id = 'generic_csv';
  readonly displayName = 'Generic CSV Statement';

  canHandle(input: StatementInput): DetectionResult {
    if (input.kind !== 'text') {
      return { matched: false, formatId: 'generic_csv', displayName: this.displayName, confidence: 'NONE', reason: 'Generic CSV adapter does not handle raw binary bytes' };
    }
    const { headers } = CsvRecordParser.parse(input.content.slice(0, 1500));
    const lowerHeaders = headers.map(h => h.toLowerCase());

    const hasDate = lowerHeaders.some(h => h.includes('date') || h.includes('tx_date'));
    const hasAmount = lowerHeaders.some(
      h => h.includes('amount') || h === 'val' || h === 'value' || (lowerHeaders.includes('debit') && lowerHeaders.includes('credit'))
    );

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

  canHandleRows(headers: string[], _rows: ParsedCsvRow[], _preambleText?: string): DetectionResult {
    const lowerHeaders = headers.map(h => h.toLowerCase());
    const hasDate = lowerHeaders.some(h => h.includes('date') || h.includes('tx_date'));
    const hasAmount = lowerHeaders.some(h => h.includes('amount') || h === 'val' || h === 'value');

    if (hasDate && hasAmount) {
      return {
        matched: true,
        formatId: 'generic_csv',
        displayName: this.displayName,
        confidence: 'MEDIUM',
        reason: 'Matched generic spreadsheet header signature (Date + Amount)'
      };
    }

    return {
      matched: false,
      formatId: 'generic_csv',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match generic spreadsheet header signature'
    };
  }

  parse(input: StatementInput): BankStatementRecord[] {
    if (input.kind !== 'text') return [];
    const { rows } = CsvRecordParser.parse(input.content);
    return this.parseRows(rows, input.fileName, input.selectedProvider);
  }

  parseRows(rows: ParsedCsvRow[], fileName: string, selectedProvider?: string, preambleText?: string): BankStatementRecord[] {
    const records: BankStatementRecord[] = [];
    const fileIndicatesPpf = PPF_CONTEXT_PATTERN.test([preambleText, selectedProvider, fileName].filter(Boolean).join(' '));

    rows.forEach(r => {
      const row = r.data;
      const dateVal = row['date'] || row['tx_date'] || row['transaction date'] || row['txn date'] || '';
      const titleVal = row['title'] || row['description'] || row['name'] || row['payee'] || '';
      const narrationVal = row['narration'] || row['memo'] || row['details'] || row['particulars'] || titleVal || 'Imported Transaction';
      const amountRaw = row['amount'] || row['val'] || row['value'] || '';
      const debitRaw = row['debit'] || row['withdrawal'] || '';
      const creditRaw = row['credit'] || row['deposit'] || '';
      const typeValRaw = (row['type'] || row['tx_type'] || row['dr/cr'] || row['cr/dr'] || '').toUpperCase();
      const refRaw = row['reference'] || row['ref'] || row['ref no'] || row['reference no'] || row['cheque no'] || row['utr'] || '';
      const balanceRaw = row['closing balance'] || row['balance'] || '';
      const accountVal = row['account'] || row['bank'] || selectedProvider || (fileIndicatesPpf ? 'PPF Account' : 'Bank Account');
      const isPpfAccount = fileIndicatesPpf || PPF_CONTEXT_PATTERN.test(accountVal);

      let debitAmount = 0;
      let creditAmount = 0;
      let closingBalance: number | undefined = undefined;
      let amountError: string | undefined = undefined;
      let rawAmountText: string | undefined = undefined;

      if (debitRaw.trim() !== '' || creditRaw.trim() !== '') {
        const resolved = AmountNormalizer.resolveBankRowAmounts({
          debitRaw,
          creditRaw,
          balanceRaw
        });
        debitAmount = resolved.debitAmount;
        creditAmount = resolved.creditAmount;
        closingBalance = resolved.closingBalance;
        amountError = resolved.amountError;
        rawAmountText = resolved.rawAmountText;
      } else {
        const parsed = AmountNormalizer.parseStrict(amountRaw === '' ? '0' : amountRaw);
        if (!parsed.valid) {
          amountError = `Invalid numeric value in Amount column: "${amountRaw}"`;
          rawAmountText = amountRaw;
        } else {
          const mag = Math.abs(parsed.value);
          const isDebit =
            typeValRaw.includes('EXPENSE') ||
            typeValRaw.includes('DEBIT') ||
            typeValRaw === 'DR' ||
            typeValRaw === 'D' ||
            parsed.indicator === 'DR' ||
            (parsed.indicator !== 'CR' && !typeValRaw.includes('INCOME') && !typeValRaw.includes('CREDIT') && parsed.value < 0);

          if (isDebit) {
            debitAmount = mag;
          } else {
            creditAmount = mag;
          }
        }

        if (balanceRaw.trim() !== '') {
          const balParsed = AmountNormalizer.parseStrict(balanceRaw);
          if (balParsed.valid && !balParsed.empty) {
            closingBalance = balParsed.value;
          }
        }
      }

      records.push({
        sourceBank: accountVal,
        transactionDate: dateVal,
        narration: narrationVal,
        referenceNumber: refRaw || undefined,
        debitAmount,
        creditAmount,
        closingBalance,
        amountError,
        rawAmountText,
        isPpfAccount,
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
      amount = Math.round(debit * 10000) / 10000;
    } else {
      type = 'Income';
      amount = Math.round(credit * 10000) / 10000;
    }

    const titleRaw = record.rawRecord?.['title'] || record.rawRecord?.['description'] || record.rawRecord?.['payee'] || record.narration;
    const sanitizedTitle = NarrationNormalizer.normalize(titleRaw);
    const sanitizedNarration = NarrationNormalizer.normalize(record.narration);
    const accountVal = record.sourceBank || context.provider;
    const category = BankTransactionNormalizer.resolveCategory({
      type,
      narration: sanitizedNarration,
      explicitCategory: record.rawRecord?.['category'],
      isPpfAccount: record.isPpfAccount
    });
    const normalizedRef = TransactionIdentityService.normalizeReferenceNumber(record.referenceNumber);

    const candidate: Transaction = {
      id: `tx-import-${context.batchId}-${record.sourceRowNumber}`,
      date: normDate,
      dateStr: normDate,
      title: sanitizedTitle,
      narration: sanitizedNarration,
      account: accountVal,
      type,
      direction: type === 'Income' ? 'CREDIT' : 'DEBIT',
      category,
      amount,
      status: 'CLEARED',
      notes: `Imported from ${context.fileName}`,
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
