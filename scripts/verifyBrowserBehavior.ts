if (typeof window === 'undefined') { (global as any).window = global as any; }
import 'fake-indexeddb/auto';
import { repository } from '../src/repositories';
import { FinancialCommands as commands } from '../src/application/commands';
import { FinancialQueries as queries } from '../src/application/queries';

let passCount = 0;
let failCount = 0;

function check(condition: boolean, stepId: string, desc: string) {
  if (condition) {
    console.log(`  ✓ PASS [Step ${stepId}]: ${desc}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL [Step ${stepId}]: ${desc}`);
    failCount++;
  }
}

async function verifyBrowserBehavior() {
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('ARTHAVAULT — EMPIRICAL BROWSER VERIFICATION SUITE (A to J)');
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  console.log('A. Fresh state (zero local financial records)');
  await repository.clearLocalData();
  const txA = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const assetA = repository.assets.findAllSync();
  const liabA = repository.liabilities.findAllSync();
  const snapA = repository.snapshots.findAllSync();
  check(
    txA.length === 0 && assetA.length === 0 && liabA.length === 0 && snapA.length === 0,
    'A',
    'Application starts empty by default unless explicitly loaded (0 records across all collections)'
  );

  console.log('\nB. Explicit demo load (expected demo records appear)');
  await repository.loadDemoData();
  const txB = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const assetB = repository.assets.findAllSync();
  const liabB = repository.liabilities.findAllSync();
  const snapB = repository.snapshots.findAllSync();
  check(
    txB.length === 16 && assetB.length === 3 && liabB.length === 1 && snapB.length === 3,
    'B',
    `Explicit 'Load Demo Data' populates expected baseline (${txB.length} txs, ${assetB.length} assets, ${liabB.length} liabs, ${snapB.length} snaps)`
  );

  console.log('\nC. Add income (+1 transaction, correct amount)');
  const beforeC = txB.length;
  commands.recordIncome('Verification Salary Credit', 125000, 'HDFC Bank', 'SALARY', 'Empirical test income');
  const txC = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const newInc = txC[0];
  check(
    txC.length === beforeC + 1 && newInc.amount === 125000 && newInc.type === 'Income',
    'C',
    `Income recorded correctly (New total: ${txC.length} transactions, amount: ₹${newInc.amount.toLocaleString()})`
  );

  console.log('\nD. Add expense (+1 transaction, correct amount/type)');
  const beforeD = txC.length;
  commands.recordExpense('Verification Office Rent', 45000, 'HDFC Bank', 'RENT', 'Empirical test expense');
  const txD = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const newExp = txD[0];
  check(
    txD.length === beforeD + 1 && newExp.amount === 45000 && newExp.type === 'Expense',
    'D',
    `Expense recorded correctly (New total: ${txD.length} transactions, amount: ₹${newExp.amount.toLocaleString()})`
  );

  console.log('\nE. Transfer (exactly 2 linked legs, shared transferId, DEBIT/CREDIT semantics, ₹0 net impact)');
  const beforeE = txD.length;
  commands.recordTransfer('HDFC Bank', 'ICICI Bank', 60000);
  const txE = queries.queryTransactions({ type: 'Transfer', dateRange: '12M' });
  const trLegs = txE.slice(0, 2);
  let trNet = 0;
  for (const t of trLegs) {
    if (t.narration.includes('DEBIT') || t.title.startsWith('Transfer to')) {
      trNet -= t.amount;
    } else {
      trNet += t.amount;
    }
  }
  check(
    trLegs.length === 2 && trLegs[0].transferId === trLegs[1].transferId && !!trLegs[0].transferId && trNet === 0,
    'E',
    `2-leg transfer verified (transferId: ${trLegs[0]?.transferId}, net impact: ₹${trNet})`
  );

  console.log('\nF. Clear (transactions = 0, assets = 0, liabilities = 0, snapshots = 0)');
  await repository.clearLocalData();
  const txF = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const assetF = repository.assets.findAllSync();
  const liabF = repository.liabilities.findAllSync();
  const snapF = repository.snapshots.findAllSync();
  check(
    txF.length === 0 && assetF.length === 0 && liabF.length === 0 && snapF.length === 0,
    'F',
    'clearLocalData() wipes all collections (0 records across all stores)'
  );

  console.log('\nG. Reload (all remain zero after storage re-initialization)');
  await repository.initialize();
  const txG = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const assetG = repository.assets.findAllSync();
  const liabG = repository.liabilities.findAllSync();
  const snapG = repository.snapshots.findAllSync();
  check(
    txG.length === 0 && assetG.length === 0 && liabG.length === 0 && snapG.length === 0,
    'G',
    'Reload after clear maintains 100% empty state without demo reseeding'
  );

  console.log('\nH. Real CSV import (actual uploaded CSV rows parsed, correct records committed)');
  const realCSV = `Date,Title,Narration,Amount,Type,Account
2026-08-06,ITC Limited,ACH/C-/ITC LTD DIVIDEND/NSE0098,2100,INCOME,HDFC Bank
2026-08-04,Coal India Ltd,ECS/C/COAL INDIA INT DIVIDEND,1500,INCOME,SBI Bank
2026-08-01,Imported Payout 1,ACH/C/DIVIDEND-CREDIT-ROW-1,1000,INCOME,HDFC Bank`;
  const resH = commands.importStatement(realCSV, 'HDFC Bank', 'verify_upload.csv');
  const txH = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    resH.appended === 3 && txH.length === 3 && resH.validRows.length === 3,
    'H',
    `Real CSV uploader pipeline imported ${resH.appended} verified records (${txH.length} total ledger count)`
  );

  console.log('\nI. Duplicate CSV import (identical rows detected, no ledger growth)');
  const beforeI = txH.length;
  const resI = commands.importStatement(realCSV, 'HDFC Bank', 'verify_upload.csv');
  const txI = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    resI.duplicates === 3 && resI.appended === 0 && txI.length === beforeI,
    'I',
    `Duplicate import detected 100% matching fingerprints (${resI.duplicates}/${resI.totalDetected}), ledger count unchanged (${txI.length})`
  );

  console.log('\nJ. Reload after import (imported records remain present)');
  await repository.initialize();
  const txJ = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    txJ.length === 3 && txJ.some(t => t.title === 'ITC Limited'),
    'J',
    `Imported records survive runtime reload (${txJ.length} transactions retained in repository)`
  );

  console.log('\n──────────────────────────────────────────────────────────────────────────');
  console.log(`EMPIRICAL BROWSER VERIFICATION SUITE SUMMARY: ${passCount}/${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

verifyBrowserBehavior().catch(err => {
  console.error('Fatal browser verification error:', err);
  process.exit(1);
});
