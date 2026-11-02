import { BankStatementAdapter, StatementInput, DetectionResult, BankStatementRecord, NormalizedBankTransaction, ParsedCsvRow } from '../ImportTypes';
import { SpreadsheetStatementParser } from '../parsers/SpreadsheetStatementParser';
import { AmountNormalizer } from '../normalization/AmountNormalizer';
import { BankTransactionNormalizer } from '../normalization/BankTransactionNormalizer';

const NON_TX_BALANCE_LINE = /^(?:opening\s+balance|closing\s+balance|brought\s+forward|carried\s+forward|b\/f|c\/f|statement\s+summary|transaction\s+total|total\b)/i;
const PPF_CONTEXT_PATTERN = /\bppf\b|public\s+provident\s+fund/i;

function pickField(d: Record<string, string>, exact: string[], partial: string[] = []): string {
  for (const key of exact) {
    if (d[key] !== undefined && d[key] !== '') return d[key];
  }
  if (partial.length > 0) {
    for (const [k, v] of Object.entries(d)) {
      if (v && partial.some(p => k.includes(p))) return v;
    }
  }
  return '';
}

export class SbiStatementAdapter implements BankStatementAdapter {
  readonly id = 'sbi';
  readonly displayName = 'State Bank of India (SBI)';

  canHandle(input: StatementInput): DetectionResult {
    const content = input.kind === 'text' ? input.content : '';
    const upper = content.toUpperCase();

    const hasDetails = upper.includes('DETAILS') || upper.includes('DESCRIPTION') || upper.includes('PARTICULARS');
    const hasRefNo = upper.includes('REF NO/CHEQUE NO') || upper.includes('REF NO') || upper.includes('CHEQUE NO');
    const hasBalance = upper.includes('BALANCE');
    const hasDebit = upper.includes('DEBIT') || upper.includes('WITHDRAWAL');
    const hasCredit = upper.includes('CREDIT') || upper.includes('DEPOSIT');
    const hasSbi = upper.includes('STATE BANK OF INDIA') || upper.includes('SBI') || upper.includes('PPF ACCOUNT');

    if (
      (hasDetails && hasRefNo && hasDebit && hasCredit) ||
      (hasSbi && hasDetails && (hasDebit || hasCredit)) ||
      (hasDetails && hasDebit && hasCredit && hasBalance && !upper.includes('WITHDRAWAL AMT') && !upper.includes('TRANSACTION REMARKS'))
    ) {
      return {
        matched: true,
        formatId: 'sbi',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched multi-indicator SBI statement signature'
      };
    }

    return {
      matched: false,
      formatId: 'sbi',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match SBI multi-indicator signature'
    };
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[], preambleText?: string): DetectionResult {
    const headerStr = headers.join(' ').toUpperCase();
    const preambleUpper = (preambleText || '').toUpperCase();

    const hasDetails = headerStr.includes('DETAILS') || headerStr.includes('DESCRIPTION') || headerStr.includes('PARTICULARS');
    const hasRefNo = headerStr.includes('REF NO/CHEQUE NO') || headerStr.includes('REF NO') || headerStr.includes('CHEQUE NO');
    const hasBalance = headerStr.includes('BALANCE');
    const hasDebit = headerStr.includes('DEBIT') || headerStr.includes('WITHDRAWAL');
    const hasCredit = headerStr.includes('CREDIT') || headerStr.includes('DEPOSIT');
    const hasDrCrAmount = (headerStr.includes('DR/CR') || headerStr.includes('CR/DR')) && headerStr.includes('AMOUNT');
    const hasSbiPreamble = preambleUpper.includes('STATE BANK OF INDIA') || preambleUpper.includes('SBI') || preambleUpper.includes('PPF');

    if (
      (hasDetails && hasRefNo && hasDebit && hasCredit) ||
      (hasDetails && hasDebit && hasCredit && (hasBalance || hasSbiPreamble)) ||
      (hasSbiPreamble && hasDetails && hasDrCrAmount)
    ) {
      return {
        matched: true,
        formatId: 'sbi',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched multi-indicator SBI statement header signature'
      };
    }

    return {
      matched: false,
      formatId: 'sbi',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match SBI header signature'
    };
  }

  parse(input: StatementInput): BankStatementRecord[] {
    if (input.kind !== 'text') return [];
    const { rows, preambleText } = SpreadsheetStatementParser.parse(input.content);
    return this.parseRows(rows, input.fileName, input.selectedProvider, preambleText);
  }

  parseRows(rows: ParsedCsvRow[], fileName: string, selectedProvider?: string, preambleText?: string): BankStatementRecord[] {
    const records: BankStatementRecord[] = [];
    const isPpf = PPF_CONTEXT_PATTERN.test([preambleText, selectedProvider, fileName].filter(Boolean).join(' '));
    const sourceBank = isPpf ? 'SBI PPF' : 'SBI Bank';

    rows.forEach(r => {
      const d = r.data;
      const txDateStr = pickField(d, ['date', 'txn date', 'tx date', 'transaction date', 'posting date', 'value date']);
      const valueDateStr = pickField(d, ['value date', 'value dt']);
      const details = pickField(d, ['details', 'description', 'particulars', 'narration']);
      const refNo = pickField(d, ['ref no/cheque no', 'ref no./cheque no.', 'ref no', 'cheque no', 'reference no']);
      const debitStr = pickField(d, ['debit', 'debit (dr)', 'debit amount', 'withdrawal', 'withdrawal (dr)'], ['debit']);
      const creditStr = pickField(d, ['credit', 'credit (cr)', 'credit amount', 'deposit', 'deposit (cr)'], ['credit']);
      const amountStr = pickField(d, ['amount', 'amount (inr)', 'transaction amount']);
      const drCrStr = pickField(d, ['dr/cr', 'cr/dr', 'type']);
      const balanceStr = pickField(d, ['balance', 'closing balance', 'balance (inr)'], ['balance']);

      if (!txDateStr || !/\d/.test(txDateStr)) return;

      const amounts = AmountNormalizer.resolveBankRowAmounts({
        debitRaw: debitStr,
        creditRaw: creditStr,
        amountRaw: amountStr,
        drCrRaw: drCrStr,
        balanceRaw: balanceStr
      });

      if (!amounts.amountError && amounts.debitAmount === 0 && amounts.creditAmount === 0 && NON_TX_BALANCE_LINE.test(details.trim())) {
        return;
      }

      records.push({
        sourceBank,
        transactionDate: txDateStr,
        valueDate: valueDateStr || undefined,
        narration: details,
        referenceNumber: refNo,
        debitAmount: amounts.debitAmount,
        creditAmount: amounts.creditAmount,
        closingBalance: amounts.closingBalance,
        amountError: amounts.amountError,
        rawAmountText: amounts.rawAmountText,
        isPpfAccount: isPpf,
        sourceRowNumber: r.rowNumber,
        sourceFile: fileName,
        rawRecord: d
      });
    });

    return records;
  }

  normalize(
    record: BankStatementRecord,
    context: { provider: string; fileName: string; batchId: string }
  ): NormalizedBankTransaction {
    return BankTransactionNormalizer.normalize(record, {
      provider: record.sourceBank || 'SBI Bank',
      fileName: context.fileName,
      batchId: context.batchId
    });
  }
}
