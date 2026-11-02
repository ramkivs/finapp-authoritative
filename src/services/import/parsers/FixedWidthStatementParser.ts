export interface FixedWidthParsedRecord {
  sourceRowNumber: number;
  dateStr: string;
  narration: string;
  refNumber?: string;
  valueDateStr?: string;
  withdrawalStr?: string;
  depositStr?: string;
  balanceStr?: string;
  rawText: string;
}

export class FixedWidthStatementParser {
  /**
   * Parses text/ASCII/tab statement downloads (e.g. HDFC text exports).
   * Uses midpoint column classification to deterministically extract Withdrawal, Deposit, and Balance amounts,
   * handles multi-line transaction continuation rows, and strips preambles & postambles.
   */
  static parseHdfcText(text: string): FixedWidthParsedRecord[] {
    const rawLines = text.split(/\r?\n/);
    const records: FixedWidthParsedRecord[] = [];

    let inTable = false;
    let currentRecord: FixedWidthParsedRecord | null = null;

    // Column position defaults
    let colWithdrawal = 65;
    let colDeposit = 85;

    const dateRegex = /^(\d{1,2}[/-](?:\d{1,2}|[A-Za-z]{3})[/-]\d{2,4})/;

    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const line = rawLine.trim();
      if (!line) continue;

      const upperLine = line.toUpperCase();

      // Check for table header line
      if (
        (upperLine.includes('DATE') && upperLine.includes('NARRATION') && upperLine.includes('WITHDRAWAL')) ||
        (upperLine.includes('DATE') && upperLine.includes('NARRATION') && upperLine.includes('DEPOSIT'))
      ) {
        inTable = true;
        colWithdrawal = upperLine.indexOf('WITHDRAWAL') !== -1 ? upperLine.indexOf('WITHDRAWAL') : 65;
        colDeposit = upperLine.indexOf('DEPOSIT') !== -1 ? upperLine.indexOf('DEPOSIT') : 85;
        continue;
      }

      // Check for postamble start
      if (
        inTable &&
        (upperLine.startsWith('STATEMENT SUMMARY') ||
          upperLine.startsWith('TOTAL DEPOSITS') ||
          upperLine.startsWith('CLOSING BALANCE') ||
          upperLine.startsWith('TRANSACTION TOTAL') ||
          upperLine.startsWith('END OF STATEMENT'))
      ) {
        if (currentRecord) {
          records.push(currentRecord);
          currentRecord = null;
        }
        break; // Stop parsing postamble
      }

      if (!inTable) continue;

      const dateMatch = line.match(dateRegex);

      if (dateMatch) {
        // We found a transaction-start row!
        if (currentRecord) {
          records.push(currentRecord);
        }

        const dateStr = dateMatch[1];
        const parsedLine = this.extractTokensFromLine(rawLine, line, colWithdrawal, colDeposit, true);

        currentRecord = {
          sourceRowNumber: i + 1,
          dateStr,
          narration: parsedLine.narration,
          refNumber: parsedLine.refNumber,
          valueDateStr: parsedLine.valueDateStr,
          withdrawalStr: parsedLine.withdrawalStr,
          depositStr: parsedLine.depositStr,
          balanceStr: parsedLine.balanceStr,
          rawText: line
        };
      } else if (currentRecord) {
        // Continuation line!
        const parsedCont = this.extractTokensFromLine(rawLine, line, colWithdrawal, colDeposit, false);

        if (parsedCont.withdrawalStr && !currentRecord.withdrawalStr) {
          currentRecord.withdrawalStr = parsedCont.withdrawalStr;
        }
        if (parsedCont.depositStr && !currentRecord.depositStr) {
          currentRecord.depositStr = parsedCont.depositStr;
        }
        if (parsedCont.balanceStr && !currentRecord.balanceStr) {
          currentRecord.balanceStr = parsedCont.balanceStr;
        }
        if (parsedCont.refNumber && !currentRecord.refNumber) {
          currentRecord.refNumber = parsedCont.refNumber;
        }
        if (parsedCont.valueDateStr && !currentRecord.valueDateStr) {
          currentRecord.valueDateStr = parsedCont.valueDateStr;
        }

        if (parsedCont.narration) {
          currentRecord.narration = (currentRecord.narration + ' ' + parsedCont.narration).trim();
        }
        currentRecord.rawText += ' ' + line;
      }
    }

    if (currentRecord) {
      records.push(currentRecord);
    }

    return records;
  }

  private static extractTokensFromLine(
    rawLine: string,
    line: string,
    colWithdrawal: number,
    colDeposit: number,
    isStartLine: boolean
  ) {
    const rawTokens = line.split(/\t+|\s{2,}/).map(t => t.trim()).filter(t => t.length > 0);
    const tokens: { text: string; pos: number }[] = [];
    let searchIndex = 0;

    for (const t of rawTokens) {
      const pos = rawLine.indexOf(t, searchIndex);
      tokens.push({ text: t, pos: pos !== -1 ? pos : searchIndex });
      if (pos !== -1) searchIndex = pos + t.length;
    }

    const startIdx = isStartLine ? 1 : 0;
    const availableTokens = tokens.slice(startIdx);

    let narrationParts: string[] = [];
    let refNumber = '';
    let valueDateStr = '';
    let withdrawalStr = '';
    let depositStr = '';
    let balanceStr = '';

    // Identify numeric amount tokens
    const amountTokens: { text: string; pos: number }[] = [];
    const nonAmountTokens: { text: string; pos: number }[] = [];

    availableTokens.forEach(tok => {
      const isAmount = /^[0-9,]+\.[0-9]{2}$/.test(tok.text);
      if (isAmount) {
        amountTokens.push(tok);
      } else {
        nonAmountTokens.push(tok);
      }
    });

    if (amountTokens.length >= 2) {
      // Last amount token is balance
      balanceStr = amountTokens[amountTokens.length - 1].text;
      const priorAmounts = amountTokens.slice(0, amountTokens.length - 1);

      if (priorAmounts.length >= 2) {
        withdrawalStr = priorAmounts[0].text;
        depositStr = priorAmounts[1].text;
      } else if (priorAmounts.length === 1) {
        const singleAmt = priorAmounts[0];
        const midpoint = (colWithdrawal + colDeposit) / 2;
        if (singleAmt.pos < midpoint) {
          withdrawalStr = singleAmt.text;
        } else {
          depositStr = singleAmt.text;
        }
      }
    } else if (amountTokens.length === 1) {
      // Single amount token could be balance or deposit/withdrawal
      const singleAmt = amountTokens[0];
      const midpoint = (colWithdrawal + colDeposit) / 2;
      if (singleAmt.pos < midpoint) {
        withdrawalStr = singleAmt.text;
      } else {
        depositStr = singleAmt.text;
      }
    }

    // Process non-amount tokens for date, ref, and narration
    nonAmountTokens.forEach(tok => {
      if (/^\d{1,2}[/-](?:\d{1,2}|[A-Za-z]{3})[/-]\d{2,4}$/.test(tok.text)) {
        valueDateStr = tok.text;
      } else if (/^\d{6,}$/.test(tok.text)) {
        refNumber = tok.text;
      } else {
        narrationParts.push(tok.text);
      }
    });

    return {
      narration: narrationParts.join(' '),
      refNumber,
      valueDateStr,
      withdrawalStr,
      depositStr,
      balanceStr
    };
  }
}
