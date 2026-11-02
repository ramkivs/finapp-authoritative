import { StatementInput, DetectionResult, BankStatementAdapter, ParsedCsvRow } from './ImportTypes';
import { HdfcStatementAdapter } from './adapters/HdfcStatementAdapter';
import { IciciStatementAdapter } from './adapters/IciciStatementAdapter';
import { SbiStatementAdapter } from './adapters/SbiStatementAdapter';
import { GenericCsvAdapter } from './adapters/GenericCsvAdapter';

export class ImportFormatDetector {
  private static adapters: BankStatementAdapter[] = [
    new HdfcStatementAdapter(),
    new IciciStatementAdapter(),
    new SbiStatementAdapter(),
    new GenericCsvAdapter()
  ];

  /**
   * Text-path detection: evaluates text StatementInput content against registered adapters.
   * Performs deterministic content-based multi-indicator signature matching.
   */
  static detect(input: StatementInput): { adapter: BankStatementAdapter | null; detection: DetectionResult } {
    for (const adapter of this.adapters) {
      const detection = adapter.canHandle(input);
      if (detection.matched && detection.confidence !== 'NONE') {
        return { adapter, detection };
      }
    }

    return { adapter: null, detection: this.unsupportedDetection() };
  }

  /**
   * Binary-path detection: evaluates decoded ParsedCsvRow headers against registered adapters.
   * Used after SpreadsheetStatementParser.parseBytes() decodes a native XLS/XLSX binary.
   * Detection operates directly on the decoded column headers via canHandleRows()
   * (no synthetic text reconstruction). Falls back to GenericCsvAdapter if the binary
   * workbook uses canonical Date + Amount headers.
   */
  static detectFromRows(
    headers: string[],
    rows: ParsedCsvRow[],
    _fileName: string,
    _selectedProvider?: string,
    preambleText?: string
  ): { adapter: BankStatementAdapter | null; detection: DetectionResult } {
    for (const adapter of this.adapters) {
      if (adapter.id === 'generic_csv') continue;

      const detection = adapter.canHandleRows(headers, rows, preambleText);
      if (detection.matched && detection.confidence !== 'NONE') {
        return { adapter, detection };
      }
    }

    const genericAdapter = this.getAdapterById('generic_csv');
    if (genericAdapter) {
      const fallback = genericAdapter.canHandleRows(headers, rows, preambleText);
      if (fallback.matched && fallback.confidence !== 'NONE') {
        return { adapter: genericAdapter, detection: fallback };
      }
    }

    return { adapter: null, detection: this.unsupportedDetection() };
  }

  static getAdapterById(id: string): BankStatementAdapter | null {
    return this.adapters.find(a => a.id === id) || null;
  }

  private static unsupportedDetection(): DetectionResult {
    return {
      matched: false,
      formatId: 'unsupported',
      displayName: 'Unsupported / Unrecognized Statement Format',
      confidence: 'NONE',
      reason: 'File content does not match any recognized bank or generic CSV header signature.'
    };
  }
}
