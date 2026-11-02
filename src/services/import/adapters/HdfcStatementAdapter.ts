import { BankStatementAdapter, StatementInput, DetectionResult, BankStatementRecord, NormalizedBankTransaction, ParsedCsvRow } from '../ImportTypes';
import { FixedWidthStatementParser } from '../parsers/FixedWidthStatementParser';
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

export class HdfcStatementAdapter implements BankStatementAdapter {
  readonly id = 'hdfc';
  readonly displayName = 'HDFC Bank Statement';

  canHandle(input: StatementInput): DetectionResult {
    const text = input.kind === 'text' ? input.content : '';
    const upper = text.toUpperCase();

    const hasHdfcName = upper.includes('HDFC BANK') || upper.includes('HDFC PPF');
    const hasWithdrawal = upper.includes('WITHDRAWAL AMT');
    const hasDeposit = upper.includes('DEPOSIT AMT');
    const hasClosing = upper.includes('CLOSING BALANCE');
    const hasChqRef = upper.includes('CHQ./REF.NO') || upper.includes('CHQ/REF');
    const hasDrCrAmount = upper.includes('DEBIT / CREDIT') && upper.includes('AMOUNT');

    if (
      (hasWithdrawal && hasDeposit && (hasClosing || hasChqRef)) ||
      (hasHdfcName && (hasWithdrawal || hasDeposit || hasDrCrAmount))
    ) {
      return {
        matched: true,
        formatId: 'hdfc',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched multi-indicator HDFC statement signature'
      };
    }

    return {
      matched: false,
      formatId: 'hdfc',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match HDFC multi-indicator signature'
    };
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[], preambleText?: string): DetectionResult {
    const headerStr = headers.join(' ').toUpperCase();
    const preambleUpper = (preambleText || '').toUpperCase();

    const hasWithdrawal = headerStr.includes('WITHDRAWAL AMT');
    const hasDeposit = headerStr.includes('DEPOSIT AMT');
    const hasClosing = headerStr.includes('CLOSING BALANCE');
    const hasChqRef = headerStr.includes('CHQ./REF.NO') || headerStr.includes('CHQ/REF');
    const hasHdfcPreamble = preambleUpper.includes('HDFC BANK') || preambleUpper.includes('HDFC PPF');
    const hasDrCrAmount = (headerStr.includes('DEBIT / CREDIT') || headerStr.includes('DR / CR')) && headerStr.includes('AMOUNT');

    if (
      (hasWithdrawal && hasDeposit && (hasClosing || hasChqRef)) ||
      (hasHdfcPreamble && (hasWithdrawal || hasDeposit || hasDrCrAmount))
    ) {
      return {
        matched: true,
        formatId: 'hdfc',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched multi-indicator HDFC statement header signature'
      };
    }

    return {
      matched: false,
      formatId: 'hdfc',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match HDFC header signature'
    };
  }

  parse(input: StatementInput): BankStatementRecord[] {
    if (input.kind !== 'text') return [];
    const text = input.content;

    // Check if comma-delimited HDFC CSV or HTML spreadsheet vs fixed-width text statement
    const firstLines = text.split(/\r?\n/).slice(0, 25);
    const isStructuredTable = /<table[^>]*>/i.test(text) || firstLines.some(l => l.includes(',') && /date/i.test(l));

    if (isStructuredTable) {
      const { rows, preambleText } = SpreadsheetStatementParser.parse(text);
      return this.parseRows(rows, input.fileName, input.selectedProvider, preambleText);
    }

    // Text / ASCII fixed-width statement parsing: extract only preamble lines BEFORE header
    const allLines = text.split(/\r?\n/);
    const headerLineIdx = allLines.findIndex(l => /\bdate\b/i.test(l) && /\bnarration\b/i.test(l));
    const fixedPreamble = headerLineIdx > 0 ? allLines.slice(0, headerLineIdx).join('\n') : '';
    const isPpf = PPF_CONTEXT_PATTERN.test([fixedPreamble, input.selectedProvider, input.fileName].filter(Boolean).join(' '));
    const sourceBank = isPpf ? 'HDFC PPF' : 'HDFC Bank';

    const parsedRecords = FixedWidthStatementParser.parseHdfcText(text);

    const out: BankStatementRecord[] = [];
    for (const rec of parsedRecords) {
      const amounts = AmountNormalizer.resolveBankRowAmounts({
        debitRaw: rec.withdrawalStr,
        creditRaw: rec.depositStr,
        balanceRaw: rec.balanceStr
      });

      if (!amounts.amountError && amounts.debitAmount === 0 && amounts.creditAmount === 0 && NON_TX_BALANCE_LINE.test(rec.narration.trim())) {
        continue;
      }

      out.push({
        sourceBank,
        transactionDate: rec.dateStr,
        valueDate: rec.valueDateStr,
        narration: rec.narration,
        referenceNumber: rec.refNumber,
        debitAmount: amounts.debitAmount,
        creditAmount: amounts.creditAmount,
        closingBalance: amounts.closingBalance,
        amountError: amounts.amountError,
        rawAmountText: amounts.rawAmountText,
        isPpfAccount: isPpf,
        sourceRowNumber: rec.sourceRowNumber,
        sourceFile: input.fileName
      });
    }
    return out;
  }

  parseRows(rows: ParsedCsvRow[], fileName: string, selectedProvider?: string, preambleText?: string): BankStatementRecord[] {
    const records: BankStatementRecord[] = [];
    const isPpf = PPF_CONTEXT_PATTERN.test([preambleText, selectedProvider, fileName].filter(Boolean).join(' '));
    const sourceBank = isPpf ? 'HDFC PPF' : 'HDFC Bank';

    rows.forEach(r => {
      const d = r.data;
      const dateStr = pickField(d, ['date', 'tx date', 'txn date', 'transaction date', 'value dt']);
      const narration = pickField(d, ['narration', 'description', 'particulars']);
      const refNo = pickField(d, ['chq./ref.no.', 'chq/ref.no', 'chq/ref number', 'ref no', 'reference no']);
      const valueDt = pickField(d, ['value dt', 'value date']);
      const withdrawalStr = pickField(d, ['withdrawal amt.', 'withdrawal amt', 'withdrawal', 'debit']);
      const depositStr = pickField(d, ['deposit amt.', 'deposit amt', 'deposit', 'credit']);
      const amountStr = pickField(d, ['amount', 'transaction amount', 'amount (inr)']);
      const drCrStr = pickField(d, ['debit / credit', 'dr / cr', 'dr/cr', 'cr/dr', 'type']);
      const closingStr = pickField(d, ['closing balance', 'balance']);

      if (!dateStr || !/\d/.test(dateStr)) return;

      const amounts = AmountNormalizer.resolveBankRowAmounts({
        debitRaw: withdrawalStr,
        creditRaw: depositStr,
        amountRaw: amountStr,
        drCrRaw: drCrStr,
        balanceRaw: closingStr
      });

      if (!amounts.amountError && amounts.debitAmount === 0 && amounts.creditAmount === 0 && NON_TX_BALANCE_LINE.test(narration.trim())) {
        return;
      }

      records.push({
        sourceBank,
        transactionDate: dateStr,
        valueDate: valueDt,
        narration,
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
      provider: record.sourceBank || 'HDFC Bank',
      fileName: context.fileName,
      batchId: context.batchId
    });
  }
}
