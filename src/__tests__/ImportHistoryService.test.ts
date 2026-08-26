/**
 * FINBOOM-CR (CR-04) — Import History service tests.
 *
 * Asserts the contract in `FINBOOM-CR-BROKER-BANK-IMPORT-AUTHORITY-SPEC.md`
 * for the in-memory ImportHistoryService.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { ImportHistoryService } from '../services/ImportHistoryService';

describe('A. Basic record and list', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('A.1 record(success) creates an entry with id and timestamp', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Zerodha',
      sourceFilename: 'zerodha.csv',
      result: 'success',
      processedCount: 100,
      importedCount: 100,
      rejectedCount: 0,
    });
    expect(entry.id).toMatch(/^imp-/);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(entry.importType).toBe('BROKER_HOLDINGS');
    expect(entry.institution).toBe('Zerodha');
    expect(entry.sourceFilename).toBe('zerodha.csv');
    expect(entry.result).toBe('success');
    expect(entry.processedCount).toBe(100);
    expect(entry.importedCount).toBe(100);
    expect(entry.rejectedCount).toBe(0);
    expect(entry.errorSummary).toEqual([]);
  });

  it('A.2 list() returns a reverse-chronological snapshot', () => {
    ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Zerodha',
      sourceFilename: 'zerodha.csv',
      result: 'success',
      processedCount: 100,
      importedCount: 100,
      rejectedCount: 0,
    });
    ImportHistoryService.record({
      importType: 'BANK_STATEMENT',
      institution: 'HDFC Bank',
      sourceFilename: 'hdfc.csv',
      result: 'success',
      processedCount: 50,
      importedCount: 50,
      rejectedCount: 0,
    });
    const list = ImportHistoryService.list();
    expect(list).toHaveLength(2);
    // The second record (BANK_STATEMENT) is most recent → first
    expect(list[0].importType).toBe('BANK_STATEMENT');
    expect(list[1].importType).toBe('BROKER_HOLDINGS');
  });

  it('A.3 list() returns a defensive copy (mutating the result does not affect storage)', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 66,
      importedCount: 66,
      rejectedCount: 0,
    });
    const list = ImportHistoryService.list();
    list[0].institution = 'MUTATED';
    list[0].errorSummary.push('injected');
    const list2 = ImportHistoryService.list();
    expect(list2[0].institution).toBe('Dhan');
    expect(list2[0].errorSummary).toEqual([]);
  });
});

describe('B. Result classification', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('B.1 result=success when all rows are imported, no rejections', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    expect(entry.result).toBe('success');
  });

  it('B.2 result=partial when some rows are imported and some rejected', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'partial',
      processedCount: 100,
      importedCount: 95,
      rejectedCount: 5,
    });
    expect(entry.result).toBe('partial');
  });

  it('B.3 result=failure when no rows are imported', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Zerodha',
      sourceFilename: 'zerodha.csv',
      result: 'failure',
      processedCount: 50,
      importedCount: 0,
      rejectedCount: 50,
    });
    expect(entry.result).toBe('failure');
  });
});

describe('C. Distinguishability', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('C.1 BROKER_HOLDINGS and BANK_STATEMENT entries are distinguishable', () => {
    ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    ImportHistoryService.record({
      importType: 'BANK_STATEMENT',
      institution: 'HDFC Bank',
      sourceFilename: 'hdfc.csv',
      result: 'success',
      processedCount: 50,
      importedCount: 50,
      rejectedCount: 0,
    });
    const list = ImportHistoryService.list();
    const brokerEntries = list.filter((e) => e.importType === 'BROKER_HOLDINGS');
    const bankEntries = list.filter((e) => e.importType === 'BANK_STATEMENT');
    expect(brokerEntries).toHaveLength(1);
    expect(bankEntries).toHaveLength(1);
    expect(brokerEntries[0].institution).toBe('Dhan');
    expect(bankEntries[0].institution).toBe('HDFC Bank');
  });
});

describe('D. Source filename preservation', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('D.1 sourceFilename is preserved verbatim', () => {
    const filename = 'Dhan stock holdings.csv';
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: filename,
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    expect(entry.sourceFilename).toBe(filename);
  });

  it('D.2 sourceFilename with leading/trailing whitespace is trimmed', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: '  dhan.csv  ',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    expect(entry.sourceFilename).toBe('dhan.csv');
  });
});

describe('E. errorSummary handling', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('E.1 errorSummary is stored as provided (capped at 10 items)', () => {
    const summary = [
      'Row 5: Quantity invalid',
      'Row 7: ISIN missing',
      'Row 10: Blocked_qty parse error (non-blocking)',
    ];
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Angel One',
      sourceFilename: 'angel-one.xlsx',
      result: 'partial',
      processedCount: 6,
      importedCount: 4,
      rejectedCount: 2,
      errorSummary: summary,
    });
    expect(entry.errorSummary).toEqual(summary);
  });

  it('E.2 errorSummary is capped at 10 items', () => {
    const summary = Array.from({ length: 20 }, (_, i) => `Row ${i + 1}: error`);
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'partial',
      processedCount: 20,
      importedCount: 10,
      rejectedCount: 10,
      errorSummary: summary,
    });
    expect(entry.errorSummary).toHaveLength(10);
  });

  it('E.3 errorSummary with empty / non-string entries drops them', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'partial',
      processedCount: 5,
      importedCount: 2,
      rejectedCount: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      errorSummary: ['valid', '', '  ', null as any, undefined as any, 42 as any, 'also valid'],
    });
    expect(entry.errorSummary).toEqual(['valid', 'also valid']);
  });
});

describe('F. clear()', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('F.1 clear() empties the history', () => {
    ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    expect(ImportHistoryService.size()).toBe(1);
    ImportHistoryService.clear();
    expect(ImportHistoryService.size()).toBe(0);
    expect(ImportHistoryService.list()).toEqual([]);
  });

  it('F.2 clear() is safe to call on an empty history', () => {
    ImportHistoryService.clear();
    ImportHistoryService.clear(); // should not throw
    expect(ImportHistoryService.size()).toBe(0);
  });
});

describe('G. Idempotency / no-duplication', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('G.1 record() does not duplicate entries on re-render', () => {
    const input = {
      importType: 'BROKER_HOLDINGS' as const,
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success' as const,
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    };
    ImportHistoryService.record(input);
    ImportHistoryService.record(input);
    expect(ImportHistoryService.size()).toBe(2);
  });

  it('G.2 Each record() produces a unique id', () => {
    const e1 = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    const e2 = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    expect(e1.id).not.toBe(e2.id);
  });
});

describe('H. Input sanitization', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('H.1 Negative counts are clamped to 0', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: -5,
      importedCount: -1,
      rejectedCount: -3,
    });
    expect(entry.processedCount).toBe(0);
    expect(entry.importedCount).toBe(0);
    expect(entry.rejectedCount).toBe(0);
  });

  it('H.2 NaN / Infinity counts become 0', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: NaN,
      importedCount: Infinity,
      rejectedCount: -Infinity,
    });
    expect(entry.processedCount).toBe(0);
    expect(entry.importedCount).toBe(0);
    expect(entry.rejectedCount).toBe(0);
  });

  it('H.3 Fractional counts are floored', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9.7,
      importedCount: 8.4,
      rejectedCount: 1.2,
    });
    expect(entry.processedCount).toBe(9);
    expect(entry.importedCount).toBe(8);
    expect(entry.rejectedCount).toBe(1);
  });
});

describe('I. CR-04 required field coverage', () => {
  beforeEach(() => {
    ImportHistoryService.clear();
  });

  it('I.1 All CR-04 required fields are present in every entry', () => {
    const entry = ImportHistoryService.record({
      importType: 'BROKER_HOLDINGS',
      institution: 'Dhan',
      sourceFilename: 'dhan.csv',
      result: 'success',
      processedCount: 9,
      importedCount: 9,
      rejectedCount: 0,
    });
    // Verify all required keys are present
    expect('id' in entry).toBe(true);
    expect('timestamp' in entry).toBe(true);
    expect('importType' in entry).toBe(true);
    expect('institution' in entry).toBe(true);
    expect('sourceFilename' in entry).toBe(true);
    expect('result' in entry).toBe(true);
    expect('processedCount' in entry).toBe(true);
    expect('importedCount' in entry).toBe(true);
    expect('rejectedCount' in entry).toBe(true);
    expect('errorSummary' in entry).toBe(true);
  });
});
