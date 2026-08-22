import { Transaction } from './types';
import { formatDisplayDate, getEffectiveAsOfDate } from '../services/DateRangeService';
import { TransactionIdentityService } from '../services/TransactionIdentityService';

/**
 * WP-FB-DATA-06a — the single construction authority for manually recorded
 * transactions.
 *
 * Before this factory, income/expense/transfer rows were built by TWO
 * independent literal-object sites (WP-FB-DATA-06 discovery, finding L-08):
 *
 *   1. `src/store/useCanonicalLedger.ts`  — `addIncome` / `addExpense` / `addTransfer`
 *   2. `src/application/commands.ts`      — `recordIncome` / `recordExpense` / `recordTransfer`
 *
 * The UI reaches the ledger only through the store path, so the commands path
 * had quietly drifted: its transfer ids used a different prefix (`tr-cmd-`
 * vs `tr-`). Nothing caught it, because nothing compared them. Every field
 * added to a transaction since — `accountId` (DATA-04), `direction` (DATA-04b) —
 * had to be remembered twice, and any future lifecycle field would have to be
 * remembered twice again. That is the defect this factory closes: there is now
 * one place where a manual transaction comes into existence.
 *
 * Scope discipline: the rows produced here are field-for-field identical to the
 * pre-06a store output, plus the two new provenance fields (`origin`,
 * `recordedAt`) and a persisted `fingerprint`. No amount, sign, date, category
 * or account resolution behaviour changes.
 */

/** Short random suffix, matching the pre-06a id shape exactly. */
function idSuffix(): string {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * Stamps the provenance fields every newly recorded row must carry, then seals
 * the row with its fingerprint.
 *
 * The fingerprint is computed LAST, from the finished row, so it can never be
 * computed from a half-built object — and it is persisted rather than left to
 * be recomputed on demand. Manual rows previously carried no fingerprint at all
 * (discovery §6 scenario I / §11), which meant their identity was recomputed
 * ad hoc at every comparison site. Note this does NOT change dedup behaviour:
 * the store already fell back to computing a fingerprint for rows that lacked
 * one, so a manual row already participated in duplicate detection. 06a only
 * makes the identity explicit and inspectable at rest.
 */
function seal(tx: Transaction): Transaction {
  const sealed: Transaction = {
    ...tx,
    origin: 'MANUAL',
    recordedAt: TransactionIdentityService.recordedAt()
  };
  sealed.fingerprint = TransactionIdentityService.fingerprint({
    account: sealed.account,
    date: sealed.date,
    amount: sealed.amount,
    narration: sealed.narration
  });
  return sealed;
}

export interface ManualEntryInput {
  title: string;
  amount: number;
  account: string;
  /** Resolved by the caller via AccountResolutionService; `null` = explicitly unmapped. */
  accountId: string | null;
  category: string;
  notes?: string;
}

export interface TransferInput {
  source: string;
  destination: string;
  amount: number;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
}

export class TransactionFactory {
  static createIncome(input: ManualEntryInput): Transaction {
    const date = getEffectiveAsOfDate();
    return seal({
      id: 'tx-inc-' + idSuffix(),
      date,
      dateStr: formatDisplayDate(date),
      title: input.title,
      narration: 'MANUAL/' + input.title.toUpperCase(),
      account: input.account,
      accountId: input.accountId,
      direction: 'CREDIT',
      type: 'Income',
      category: input.category,
      amount: input.amount,
      status: 'CLEARED',
      notes: input.notes
    });
  }

  static createExpense(input: ManualEntryInput): Transaction {
    const date = getEffectiveAsOfDate();
    return seal({
      id: 'tx-exp-' + idSuffix(),
      date,
      dateStr: formatDisplayDate(date),
      title: input.title,
      narration: 'MANUAL/' + input.title.toUpperCase(),
      account: input.account,
      accountId: input.accountId,
      direction: 'DEBIT',
      type: 'Expense',
      category: input.category,
      amount: input.amount,
      status: 'CLEARED',
      notes: input.notes || 'Manual expense entry'
    });
  }

  /**
   * Both legs of a transfer, constructed together and returned together.
   *
   * ⚠️ SCOPE BOUNDARY — this is NOT transfer atomicity.
   *
   * Returning a pair from one function guarantees only that a transfer is
   * CREATED balanced. WP-FB-DATA-06 finding L-01 is that a transfer can later
   * BECOME unbalanced — a leg removed leaves ₹2,000 vanished, a leg re-amounted
   * creates or destroys money — and `transferId` is a label with no enforcement
   * behind it. Closing that requires an invariant enforced on every write, which
   * is WP-FB-DATA-06b. Nothing here should be read as having closed L-01.
   */
  static createTransferPair(input: TransferInput): [Transaction, Transaction] {
    const transferId = 'tr-' + idSuffix();
    const date = getEffectiveAsOfDate();
    const dateStr = formatDisplayDate(date);

    const debitLeg = seal({
      id: transferId + '-debit',
      transferId,
      date,
      dateStr,
      title: 'Transfer to ' + input.destination,
      narration: 'TRANSFER-DEBIT/' + transferId,
      account: input.source,
      accountId: input.sourceAccountId,
      direction: 'DEBIT',
      type: 'Transfer',
      category: 'TRANSFER',
      amount: input.amount,
      status: 'CLEARED',
      notes: 'Bank-to-Bank Transfer (Debit)'
    });

    const creditLeg = seal({
      id: transferId + '-credit',
      transferId,
      date,
      dateStr,
      title: 'Transfer from ' + input.source,
      narration: 'TRANSFER-CREDIT/' + transferId,
      account: input.destination,
      accountId: input.destinationAccountId,
      direction: 'CREDIT',
      type: 'Transfer',
      category: 'TRANSFER',
      amount: input.amount,
      status: 'CLEARED',
      notes: 'Bank-to-Bank Transfer (Credit)'
    });

    return [debitLeg, creditLeg];
  }
}
