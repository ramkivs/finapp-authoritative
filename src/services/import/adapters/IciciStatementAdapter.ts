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

export class IciciStatementAdapter implements BankStatementAdapter {
  readonly id = 'icici';
  readonly displayName = 'ICICI Bank Statement';

  canHandle(input: StatementInput): DetectionResult {
    const content = input.kind === 'text' ? input.content : '';
    const upper = content.toUpperCase();

    const hasRemarks = upper.includes('TRANSACTION REMARKS') || upper.includes('REMARKS');
    const hasParticulars = upper.includes('PARTICULARS');
    const hasWithdrawal = upper.includes('WITHDRAWAL AMOUNT') || upper.includes('WITHDRAWAL (DR)') || upper.includes('WITHDRAWAL(INR)');
    const hasDeposit = upper.includes('DEPOSIT AMOUNT') || upper.includes('DEPOSIT (CR)') || upper.includes('DEPOSIT(INR)');
    const hasDrCrAmount = (upper.includes('TYPE (DR/CR)') || upper.includes('CR/DR') || upper.includes('DR/CR')) && upper.includes('AMOUNT');
    const hasIcici = upper.includes('ICICI');

    if (
      (hasRemarks && hasWithdrawal && hasDeposit) ||
      (hasIcici && (hasWithdrawal || hasDeposit || (hasParticulars && hasDrCrAmount) || (hasRemarks && hasDrCrAmount)))
    ) {
      return {
        matched: true,
        formatId: 'icici',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched multi-indicator ICICI statement signature'
      };
    }

    return {
      matched: false,
      formatId: 'icici',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match ICICI multi-indicator signature'
    };
  }

  canHandleRows(headers: string[], _rows: ParsedCsvRow[], preambleText?: string): DetectionResult {
    const headerStr = headers.join(' ').toUpperCase();
    const preambleUpper = (preambleText || '').toUpperCase();

    const hasRemarks = headerStr.includes('TRANSACTION REMARKS') || headerStr.includes('REMARKS');
    const hasParticulars = headerStr.includes('PARTICULARS');
    const hasWithdrawal = headerStr.includes('WITHDRAWAL AMOUNT') || headerStr.includes('WITHDRAWAL (DR)') || headerStr.includes('WITHDRAWAL(INR)');
    const hasDeposit = headerStr.includes('DEPOSIT AMOUNT') || headerStr.includes('DEPOSIT (CR)') || headerStr.includes('DEPOSIT(INR)');
    const hasDrCrAmount = (headerStr.includes('DR/CR') || headerStr.includes('CR/DR')) && headerStr.includes('AMOUNT');
    const hasIciciPreamble = preambleUpper.includes('ICICI');

    if (
      (hasRemarks && hasWithdrawal && hasDeposit) ||
      (hasIciciPreamble && ((hasWithdrawal && hasDeposit) || ((hasRemarks || hasParticulars) && hasDrCrAmount)))
    ) {
      return {
        matched: true,
        formatId: 'icici',
        displayName: this.displayName,
        confidence: 'HIGH',
        reason: 'Matched multi-indicator ICICI statement header signature'
      };
    }

    return {
      matched: false,
      formatId: 'icici',
      displayName: this.displayName,
      confidence: 'NONE',
      reason: 'Does not match ICICI header signature'
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
    const sourceBank = isPpf ? 'ICICI PPF' : 'ICICI Bank';

    rows.forEach(r => {
      const d = r.data;
      const txDateStr = pickField(d, ['transaction date', 'tx date', 'txn date', 'value date', 'date']);
      const valDateStr = pickField(d, ['value date', 'value dt']);
      const narration = pickField(d, ['transaction remarks', 'remarks', 'particulars', 'narration', 'description']);
      const chequeNo = pickField(d, ['cheque number', 'cheque no', 'cheque no.', 'ref no', 'reference number']);
      const withdrawalStr = pickField(
        d,
        ['withdrawal amount(inr)', 'withdrawal amount (inr)', 'withdrawal amount', 'withdrawal (inr)', 'withdrawal (dr)', 'withdrawal'],
        ['withdrawal']
      );
      const depositStr = pickField(
        d,
        ['deposit amount(inr)', 'deposit amount (inr)', 'deposit amount', 'deposit (inr)', 'deposit (cr)', 'deposit'],
        ['deposit']
      );
      const amountStr = pickField(d, ['transaction amount(inr)', 'amount(inr)', 'amount (inr)', 'amount']);
      const drCrStr = pickField(d, ['cr/dr', 'dr/cr', 'type (dr/cr)', 'type']);
      const balanceStr = pickField(d, ['balance(inr)', 'balance (inr)', 'closing balance', 'balance'], ['balance']);

      if (!txDateStr || !/\d/.test(txDateStr)) return;

      const amounts = AmountNormalizer.resolveBankRowAmounts({
        debitRaw: withdrawalStr,
        creditRaw: depositStr,
        amountRaw: amountStr,
        drCrRaw: drCrStr,
        balanceRaw: balanceStr
      });

      if (!amounts.amountError && amounts.debitAmount === 0 && amounts.creditAmount === 0 && NON_TX_BALANCE_LINE.test(narration.trim())) {
        return;
      }

      records.push({
        sourceBank,
        transactionDate: txDateStr,
        valueDate: valDateStr,
        narration,
        referenceNumber: chequeNo,
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
      provider: record.sourceBank || 'ICICI Bank',
      fileName: context.fileName,
      batchId: context.batchId
    });
  }
}
