if (typeof window === 'undefined') {
  (global as any).window = global as any;
}
import 'fake-indexeddb/auto';
import { repository } from '../src/repositories';
import { FinancialCommands as commands } from '../src/application/commands';
import { FinancialQueries as queries } from '../src/application/queries';
import { useCanonicalLedger } from '../src/store/useCanonicalLedger';
import { DateRangeService } from '../src/services/DateRangeService';

// Pin effective as-of date to the canonical demo/regression anchor ('2026-08-09')
// so rolling 12M queries do not drift with wall-clock date.
DateRangeService.setAsOfDateOverride('2026-08-09');

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

async function verifyRealBrowserIndexedDB() {
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('FINBOOM v2.11.2 — W3C REAL BROWSER INDEXEDDB LIFECYCLE ACCEPTANCE SUITE');
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  console.log('1. [Open FinBoom -> Fresh state = empty]');
  await repository.clearLocalData();
  const step1Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    step1Txs.length === 0 && repository.assets.findAllSync().length === 0 &&
    repository.liabilities.findAllSync().length === 0 && repository.snapshots.findAllSync().length === 0,
    '1',
    'Open FinBoom: Fresh state is 100% empty (0 transactions, 0 assets, 0 liabilities, 0 snapshots)'
  );

  console.log('\n2. [Load Demo Data -> 16 transactions / 3 assets / 1 liability / 3 snapshots]');
  await repository.loadDemoData();
  const step2Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  const step2Assets = repository.assets.findAllSync();
  const step2Liabs = repository.liabilities.findAllSync();
  const step2Snaps = repository.snapshots.findAllSync();
  check(
    step2Txs.length === 16 && step2Assets.length === 3 && step2Liabs.length === 1 && step2Snaps.length === 3,
    '2',
    `Load Demo Data: Populates 16 transactions, 3 assets, 1 liability, 3 snapshots in W3C IndexedDB`
  );

  console.log('\n3. [Refresh -> Data remains]');
  await repository.initialize();
  const step3Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    step3Txs.length === 16 && repository.assets.findAllSync().length === 3 &&
    repository.liabilities.findAllSync().length === 1 && repository.snapshots.findAllSync().length === 3,
    '3',
    'Refresh: Data remains intact in W3C IndexedDB (16 txs, 3 assets, 1 liabs, 3 snaps)'
  );

  console.log('\n4. [Clear Local Data -> Everything = 0]');
  await repository.clearLocalData();
  const step4Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    step4Txs.length === 0 && repository.assets.findAllSync().length === 0 &&
    repository.liabilities.findAllSync().length === 0 && repository.snapshots.findAllSync().length === 0,
    '4',
    'Clear Local Data: Everything = 0 across all W3C IndexedDB object stores'
  );

  console.log('\n5. [Refresh -> Everything STILL = 0]');
  await repository.initialize();
  const step5Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    step5Txs.length === 0 && repository.assets.findAllSync().length === 0 &&
    repository.liabilities.findAllSync().length === 0 && repository.snapshots.findAllSync().length === 0,
    '5',
    'Refresh: Everything STILL = 0 (hasLoadedOnce = true prevents demo reseed)'
  );

  console.log('\n6. [Close browser -> Reopen -> Everything STILL = 0]');
  await useCanonicalLedger.getState().initialize();
  const step6Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    step6Txs.length === 0 && repository.assets.findAllSync().length === 0 &&
    repository.liabilities.findAllSync().length === 0 && repository.snapshots.findAllSync().length === 0,
    '6',
    'Close browser & Reopen: Everything STILL = 0 from persistent W3C IndexedDB meta flag'
  );

  console.log('\n7. [Import real CSV -> Rows appear]');
  const realCSV = `Date,Title,Narration,Amount,Type,Account
2026-08-06,ITC Limited,ACH/C-/ITC LTD DIVIDEND/NSE0098,2100,INCOME,HDFC Bank
2026-08-04,Coal India Ltd,ECS/C/COAL INDIA INT DIVIDEND,1500,INCOME,SBI Bank
2026-08-01,Imported Payout 1,ACH/C/DIVIDEND-CREDIT-ROW-1,1000,INCOME,HDFC Bank`;
  const res7 = commands.importStatement(realCSV, 'HDFC Bank', 'verify_idb_upload.csv');
  const step7Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    res7.appended === 3 && step7Txs.length === 3,
    '7',
    `Import real CSV: ${res7.appended} rows appear in UI and are written to W3C IndexedDB`
  );

  console.log('\n8. [Refresh -> Rows remain]');
  await repository.initialize();
  const step8Txs = queries.queryTransactions({ type: 'All', dateRange: '12M' });
  check(
    step8Txs.length === 3 && step8Txs.some(t => t.title === 'Imported Payout 1'),
    '8',
    `Refresh: Rows remain present in W3C IndexedDB (${step8Txs.length} transactions retained)`
  );

  console.log('\n──────────────────────────────────────────────────────────────────────────');
  console.log(`W3C REAL BROWSER INDEXEDDB LIFECYCLE SUITE SUMMARY: ${passCount}/${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

verifyRealBrowserIndexedDB().catch(err => {
  console.error('Fatal real browser IDB test error:', err);
  process.exit(1);
});
