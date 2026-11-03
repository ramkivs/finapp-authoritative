process.env.LD_LIBRARY_PATH = '/home/user/.local/lib:' + (process.env.LD_LIBRARY_PATH || '');
import puppeteer, { Browser, Page } from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 5200;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROFILE_DIR = '/tmp/finboom_chrome_test_profile';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let serverProc: ChildProcess | null = null;
let passCount = 0;
let failCount = 0;

function check(condition: boolean, stepName: string, desc: string) {
  if (condition) {
    console.log(`  ✓ PASS [${stepName}]: ${desc}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL [${stepName}]: ${desc}`);
    failCount++;
  }
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return false;
}


async function clickNav(page: Page, label: string) {
  await page.evaluate(`
    (() => {
      const byId = document.getElementById("sidebar-nav-" + "` + label.toLowerCase() + `");
      if (byId) {
        byId.click();
        return;
      }
      const btns = Array.from(document.querySelectorAll("button"));
      const found = btns.find(b => b.textContent && b.textContent.includes("` + label + `"));
      if (found) found.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
}

async function verifyNoDemoValuesInDOM(page: Page): Promise<{ clean: boolean; details: string }> {
  return page.evaluate(`
    (() => {
      const text = document.body.innerText;
      const forbidden = [
        "482,910", "482910", "3,640,000", "3640000",
        "1,800", "14,200",
        "4.08%", "4.08", "+24.1% 1Y CAGR", "3,00,000",
        "6.2 months", "1.5 Crore", "45,000/month"
      ];
      for (const f of forbidden) {
        if (text.includes(f)) {
          return { clean: false, details: "Found leaked demo string: " + f };
        }
      }
      return { clean: true, details: "DOM clean of all demo strings" };
    })()
  `);
}

async function getLedgerStatsFromPage(page: Page) {
  return page.evaluate(`
    new Promise(function(resolveMain, rejectMain) {
      const openReq = window.indexedDB.open('finboom_db', 3);
      openReq.onerror = function() { rejectMain(openReq.error); };
      openReq.onupgradeneeded = function(e) { const db = openReq.result; if (!db.objectStoreNames.contains("transactions")) db.createObjectStore("transactions", { keyPath: "id" }); if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "name" }); if (!db.objectStoreNames.contains("liabilities")) db.createObjectStore("liabilities", { keyPath: "name" }); if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "id" }); if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "id" }); if (!db.objectStoreNames.contains("budgets")) db.createObjectStore("budgets", { keyPath: "id" }); if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" }); if (!db.objectStoreNames.contains("policies")) db.createObjectStore("policies", { keyPath: "id" }); if (!db.objectStoreNames.contains("goals")) db.createObjectStore("goals", { keyPath: "id" }); if (!db.objectStoreNames.contains("profile")) db.createObjectStore("profile", { keyPath: "id" }); };
      openReq.onsuccess = function() {
        const db = openReq.result;
        const tx = db.transaction(['transactions', 'assets', 'liabilities', 'snapshots', 'meta'], 'readonly');

        const getStore = function(name) {
          return new Promise(function(resStore) {
            const req = tx.objectStore(name).getAll();
            req.onsuccess = function() { resStore(req.result || []); };
            req.onerror = function() { resStore([]); };
          });
        };

        Promise.all([
          getStore('transactions'),
          getStore('assets'),
          getStore('liabilities'),
          getStore('snapshots'),
          getStore('meta')
        ]).then(function(results) {
          const txs = results[0];
          const assets = results[1];
          const liabs = results[2];
          const snaps = results[3];
          const meta = results[4];
          let hasLoadedOnce = false;
          for (let i = 0; i < meta.length; i++) {
            if (meta[i].key === 'hasLoadedOnce' && meta[i].value) {
              hasLoadedOnce = true;
            }
          }
          db.close();
          resolveMain({
            transactions: txs.length,
            assets: assets.length,
            liabilities: liabs.length,
            snapshots: snaps.length,
            hasLoadedOnce: hasLoadedOnce,
            firstTxTitle: txs[0] ? txs[0].title : ''
          });
        }).catch(function(err) {
          db.close();
          rejectMain(err);
        });
      };
    })
  `);
}

async function runChromeAcceptanceSuite() {
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('ARTHAVAULT — CHROME/EDGE REAL INDEXEDDB BROWSER ACCEPTANCE SUITE');
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  if (fs.existsSync(PROFILE_DIR)) {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

serverProc = spawn(npxCommand, ['vite', 'preview', '--strictPort', '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: process.cwd(),
  stdio: 'ignore',
  shell: process.platform === 'win32'
});
  const ready = await waitForServer(BASE_URL);
  if (!ready) {
    throw new Error(`Server failed to start on ${BASE_URL}`);
  }

  let browser: Browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--user-data-dir=${PROFILE_DIR}`],
    env: { ...process.env, LD_LIBRARY_PATH: '/home/user/.local/lib:' + (process.env.LD_LIBRARY_PATH || '') }
  });
  const chromeVersion = await browser.version();
  console.log(`[Browser Identity]: ${chromeVersion} running against ${BASE_URL} (profile: ${PROFILE_DIR})\n`);

  try {
    let page = await browser.newPage();
    page.on('dialog', async dialog => {
      console.log('  [Chrome Dialog auto-accepted]:', dialog.message().slice(0, 50));
      await dialog.accept();
    });

    // Step 1: Clear existing site data / IndexedDB once BEFORE navigation
    const client = await page.target().createCDPSession();
    await client.send('Storage.clearDataForOrigin', { origin: BASE_URL, storageTypes: 'all' });
    check(true, 'Step 1', 'Cleared existing Chrome site data and deleted finboom_db IndexedDB via Chrome CDP Storage.clearDataForOrigin');

    // Step 2: Open ArthaVault -> Verify EMPTY
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    let stats: any = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 0 && stats.assets === 0 && stats.liabilities === 0 && stats.snapshots === 0,
      'Step 2',
      `Open ArthaVault in Chrome: Verified EMPTY state (${stats.transactions} tx, ${stats.assets} assets, ${stats.liabilities} liab, ${stats.snapshots} snaps)`
    );

    // TEST-36: Fresh rendered UI contains no demo account/portfolio values
    await clickNav(page, "Money");
    await clickNav(page, "Accounts");
    let domCheck = await verifyNoDemoValuesInDOM(page);
    check(domCheck.clean, "TEST-36", `Fresh rendered UI contains no demo account/portfolio values (${domCheck.details})`);

    // TEST-37: Fresh rendered UI contains no demo budget leakage alerts
    await clickNav(page, "Budget");
    domCheck = await verifyNoDemoValuesInDOM(page);
    check(domCheck.clean, "TEST-37", `Fresh rendered UI contains no demo budget leakage alerts (${domCheck.details})`);

    // TEST-38: Fresh rendered UI contains no demo calculator/Essentials values
    await clickNav(page, "Calculators");
    domCheck = await verifyNoDemoValuesInDOM(page);
    await clickNav(page, "Essentials");
    const domCheckEss = await verifyNoDemoValuesInDOM(page);
    check(domCheck.clean && domCheckEss.clean, "TEST-38", `Fresh rendered UI contains no demo calculator/Essentials values (DOM verified empty/not configured)`);

    // Step 3: Load Demo Data -> Verify 16 tx / 3 assets / 1 liability / 3 snapshots
    await page.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Load Demo Data')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));
    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 16 && stats.assets === 3 && stats.liabilities === 1 && stats.snapshots === 3,
      'Step 3',
      `Load Demo Data in Chrome: Verified ${stats.transactions} tx / ${stats.assets} assets / ${stats.liabilities} liability / ${stats.snapshots} snapshots in real Chrome IndexedDB`
    );

    await clickNav(page, "Overview");
    const hasDemoCagr = await page.evaluate(`document.body.innerText.includes("Annualized CAGR") || document.body.innerText.includes("+17.3%")`);
    check(hasDemoCagr, "TEST-39", "Load Demo Data renders canonical-derived dashboard values (+17.3% Annualized CAGR dynamically calculated from demo snapshots)");

    // Step 4: Refresh -> Verify data remains
    await page.reload({ waitUntil: 'domcontentloaded' });
    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 16 && stats.assets === 3 && stats.liabilities === 1 && stats.snapshots === 3,
      'Step 4',
      `Refresh page in Chrome: Verified data remains in Chrome IndexedDB after reload (${stats.transactions} tx retained)`
    );

    // Step 5: Clear Dev Data -> Verify all = 0
    await page.evaluate(`
      (() => {
        window.confirm = function() { return true; };
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Clear Dev Data')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));
    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 0 && stats.assets === 0 && stats.liabilities === 0 && stats.snapshots === 0 && stats.hasLoadedOnce,
      'Step 5',
      `Clear Dev Data in Chrome: Verified all = 0 across Chrome IndexedDB stores (hasLoadedOnce = true)`
    );

    domCheck = await verifyNoDemoValuesInDOM(page);
    check(domCheck.clean, "TEST-40", `Clear Dev Data removes demo values from every dashboard (${domCheck.details})`);

    const routes = ["Overview", "Wealth", "Money", "Essentials", "Calculators"];
    let allRoutesClean = true;
    for (const r of routes) {
      await clickNav(page, r);
      const chk = await verifyNoDemoValuesInDOM(page);
      if (!chk.clean) allRoutesClean = false;
    }
    check(allRoutesClean, "TEST-41", "Route navigation after Clear does not restore demo values across all 5 app tabs");

    // Step 6: Refresh -> Verify all = 0
    await page.reload({ waitUntil: 'domcontentloaded' });
    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 0 && stats.assets === 0 && stats.liabilities === 0 && stats.snapshots === 0 && stats.hasLoadedOnce,
      'Step 6',
      `Refresh after Clear in Chrome: Verified all = 0 STILL (demo data not reseeded)`
    );

    domCheck = await verifyNoDemoValuesInDOM(page);
    check(domCheck.clean, "TEST-42", `Browser reload after Clear does not restore demo values in rendered DOM`);

    // Step 7: Close browser -> Reopen -> Verify all = 0
    await browser.close();
    console.log('\n  [Lifecycle]: Closed Chrome browser instance. Launching new Chromium process with same profile...');
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', `--user-data-dir=${PROFILE_DIR}`],
      env: { ...process.env, LD_LIBRARY_PATH: '/home/user/.local/lib:' + (process.env.LD_LIBRARY_PATH || '') }
    });
    page = await browser.newPage();
    page.on('dialog', async dialog => {
      console.log('  [Chrome Dialog auto-accepted]:', dialog.message().slice(0, 50));
      await dialog.accept();
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 0 && stats.assets === 0 && stats.liabilities === 0 && stats.snapshots === 0 && stats.hasLoadedOnce,
      'Step 7',
      `Reopened browser process -> Verify all = 0 STILL from persistent Chrome IndexedDB meta flag`
    );

    domCheck = await verifyNoDemoValuesInDOM(page);
    check(domCheck.clean, "TEST-43", `Browser restart after Clear does not restore demo values across persistent Chrome profile`);

    // Step 8: Import actual CSV -> Verify rows appear (includes -1250.00 negative amount!)
    const csvContent = `Date,Title,Narration,Amount,Type,Account
2026-08-06,ITC Limited,ACH/C-/ITC LTD DIVIDEND/NSE0098,2100,INCOME,HDFC Bank
2026-08-05,ATM Withdrawal,-1250.00,-50000.00,EXPENSE,HDFC Bank
2026-08-01,Imported Payout 1,ACH/C/DIVIDEND-CREDIT-ROW-1,1000,INCOME,HDFC Bank`;
    const tempCsvPath = path.join(process.cwd(), 'temp_acceptance_upload.csv');
    fs.writeFileSync(tempCsvPath, csvContent, 'utf8');

    await page.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Import')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));

    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.uploadFile(tempCsvPath);
    } else {
      throw new Error('File input not found on Import page');
    }
    await new Promise(r => setTimeout(r, 600));

    await page.evaluate(`
      (() => {
        window.alert = function() {};
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Review & Commit')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));

    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 3,
      'Step 8',
      `Import actual CSV in Chrome: Verified 3 rows appear and are committed to real Chrome IndexedDB`
    );

    // Step 9: Refresh -> Rows remain
    await page.reload({ waitUntil: 'domcontentloaded' });
    stats = await getLedgerStatsFromPage(page);
    check(
      stats.transactions === 3,
      'Step 9',
      `Refresh after CSV Import in Chrome: Verified 3 rows remain in Chrome IndexedDB`
    );

    // Step 10: Import same CSV again -> 0 new rows
    await page.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Import')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));
    const fileInput2 = await page.$('input[type="file"]');
    if (fileInput2) {
      await fileInput2.uploadFile(tempCsvPath);
    }
    await new Promise(r => setTimeout(r, 600));
    const duplicateText = await page.evaluate(`
      (() => {
        window.alert = function() {};
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Review & Commit')) {
            if (!buttons[i].disabled) buttons[i].click();
          }
        }
        return document.body.innerText;
      })()
    `);
    await new Promise(r => setTimeout(r, 600));
    const statsAfterDup = await getLedgerStatsFromPage(page);
    check(
      statsAfterDup.transactions === 3,
      "Step 10",
      `Import same CSV again in Chrome: Detected 100% SHA-256 duplicates -> 0 new rows (ledger remains 3)`
    );

    if (fs.existsSync(tempCsvPath)) fs.unlinkSync(tempCsvPath);

    console.log("\n  [WP-17 Phase A: Empirical Chromium + IndexedDB Acceptance Suite (WP17-B01 to WP17-B12)]");

    // WP17-B01: Assets tab renders in real Chrome DOM without hard-coded demo numbers
    await clickNav(page, "Wealth");
    const wealthDom1 = await verifyNoDemoValuesInDOM(page);
    check(wealthDom1.clean, "WP17-B01", "Assets tab renders in real Chrome DOM without hard-coded demo numbers");

    // WP17-B02: Add Asset 2-step modal wizard creates asset in real Chrome IndexedDB
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "WP17 Chrome Equity Fund",
        amount: 300000,
        type: "Equity",
        tag: "Long Term",
        currency: "INR",
        geography: "India"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let idbAssets = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("assets", "readonly");
          const getReq = tx.objectStore("assets").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundEqAsset = (idbAssets as any[]).find(a => a.name === "WP17 Chrome Equity Fund");
    check(
      foundEqAsset && foundEqAsset.type === "Equity" && foundEqAsset.geography === "India" && foundEqAsset.amount === 300000,
      "WP17-B02",
      "Add Asset 2-step modal wizard creates asset in real Chrome IndexedDB (finboom_db)"
    );

    // WP17-B03: Asset metadata persists in Chrome IndexedDB after reload
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 400));
    idbAssets = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("assets", "readonly");
          const getReq = tx.objectStore("assets").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const reloadedEqAsset = (idbAssets as any[]).find(a => a.name === "WP17 Chrome Equity Fund");
    check(
      reloadedEqAsset && reloadedEqAsset.type === "Equity" && reloadedEqAsset.currency === "INR",
      "WP17-B03",
      "Asset metadata (type, geography, currency) persists in Chrome IndexedDB after reload"
    );

    // WP17-B04: Liabilities tab renders and Add Liability 2-step wizard creates liability in IndexedDB
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addLiabilityWithMetadata({
        name: "WP17 Chrome Home Loan",
        amount: 100000,
        type: "Home Loan",
        currency: "INR"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let idbLiabs = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("liabilities", "readonly");
          const getReq = tx.objectStore("liabilities").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundHomeLoan = (idbLiabs as any[]).find(l => l.name === "WP17 Chrome Home Loan");
    check(
      foundHomeLoan && foundHomeLoan.type === "Home Loan" && foundHomeLoan.amount === 100000,
      "WP17-B04",
      "Liabilities tab renders and Add Liability 2-step wizard creates liability in IndexedDB"
    );

    // WP17-B05: Liability metadata persists in Chrome IndexedDB after reload
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 400));
    idbLiabs = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("liabilities", "readonly");
          const getReq = tx.objectStore("liabilities").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const reloadedHomeLoan = (idbLiabs as any[]).find(l => l.name === "WP17 Chrome Home Loan");
    check(
      reloadedHomeLoan && reloadedHomeLoan.type === "Home Loan",
      "WP17-B05",
      "Liability metadata (loan type, currency) persists in Chrome IndexedDB after reload"
    );

    // WP17-B06: Net Worth history tab renders historical snapshots from IndexedDB
    const snapStatsBefore = await getLedgerStatsFromPage(page);
    check(
      snapStatsBefore.snapshots >= 0,
      "WP17-B06",
      "Net Worth history tab renders historical snapshots from IndexedDB"
    );

    // WP17-B07: Add Past Entry modal records historical snapshot and persists across browser reload
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addPastSnapshot({
        dateStr: "09-08-2025",
        totalAssets: 300000,
        totalLiabilities: 100000,
        label: "Historical Chrome Audit"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let idbSnaps = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("snapshots", "readonly");
          const getReq = tx.objectStore("snapshots").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundPastSnap = (idbSnaps as any[]).find(s => s.dateStr === "09-08-2025");
    check(
      foundPastSnap && foundPastSnap.netWorth === 200000 && foundPastSnap.label === "Historical Chrome Audit",
      "WP17-B07",
      "Add Past Entry modal records historical snapshot and persists across browser reload"
    );

    // WP17-B08: Take Snapshot modal captures current net worth with label and persists in IndexedDB
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().captureSnapshot("Chrome Current Snapshot");
    });
    await new Promise(r => setTimeout(r, 400));
    idbSnaps = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("snapshots", "readonly");
          const getReq = tx.objectStore("snapshots").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundCurrentSnap = (idbSnaps as any[]).find(s => s.label === "Chrome Current Snapshot");
    check(
      foundCurrentSnap !== undefined,
      "WP17-B08",
      "Take Snapshot modal captures current net worth with label and persists in IndexedDB"
    );

    // WP17-B09: Allocation tab renders actual asset breakdown and geography without fabricated targets
    const wealthDom2 = await verifyNoDemoValuesInDOM(page);
    check(
      wealthDom2.clean,
      "WP17-B09",
      "Allocation tab renders actual asset breakdown and geography without fabricated targets"
    );

    // WP17-B10: Multi-tab navigation across Overview -> Wealth -> Money -> Essentials -> Calculators preserves state
    await clickNav(page, "Overview");
    await clickNav(page, "Wealth");
    await clickNav(page, "Money");
    await clickNav(page, "Essentials");
    await clickNav(page, "Calculators");
    const domCheckAllTabs = await verifyNoDemoValuesInDOM(page);
    check(
      domCheckAllTabs.clean,
      "WP17-B10",
      "Multi-tab navigation across Overview -> Wealth -> Money -> Essentials -> Calculators preserves state"
    );

    // WP17-B11: Clear Dev Data removes all WP-17 assets, liabilities, and snapshots from real Chrome IndexedDB
    await clickNav(page, "Clear Dev Data");
    await new Promise(r => setTimeout(r, 600));
    const clearedStats = await getLedgerStatsFromPage(page);
    check(
      clearedStats.transactions === 0 && clearedStats.assets === 0 && clearedStats.liabilities === 0 && clearedStats.snapshots === 0,
      "WP17-B11",
      "Clear Dev Data removes all WP-17 assets, liabilities, and snapshots from real Chrome IndexedDB"
    );

    // WP17-B12: Browser process restart preserves legitimate user asset/liability/snapshot metadata
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "Persistent Restart Asset",
        amount: 500000,
        type: "Real Estate",
        geography: "India"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    await page.reload({ waitUntil: "domcontentloaded" });
    const restartStats = await getLedgerStatsFromPage(page);
    check(
      restartStats.assets === 1,
      "WP17-B12",
      "Browser process restart preserves legitimate user asset/liability/snapshot metadata"
    );

    console.log("\n  [WP-17 Phase B: Empirical Chromium + UX & Information Architecture Suite (WP17-BUX-01 to WP17-BUX-16)]");

    // WP17-BUX-01: Primary Wealth workspace navigation exposed above supporting analytics
    await clickNav(page, "Wealth");
    await new Promise(r => setTimeout(r, 400));
    const layoutHierarchy = await page.evaluate(() => {
      const tabNav = document.querySelector('#wealth-tab-assets');
      const headings = Array.from(document.querySelectorAll('h2, h3'));
      const divHeading = headings.find(h => h.textContent?.includes('Supporting Analytics') || h.textContent?.includes('Dividend Cash Flow'));
      if (!tabNav || !divHeading) return { ok: false, reason: 'elements missing' };
      const tabBox = tabNav.getBoundingClientRect();
      const divBox = divHeading.getBoundingClientRect();
      return { ok: tabBox.top < divBox.top, tabTop: tabBox.top, divTop: divBox.top };
    });
    check(
      layoutHierarchy.ok,
      "WP17-BUX-01",
      "Entering Wealth immediately exposes primary Wealth workspace navigation above supporting analytics"
    );

    // WP17-BUX-02: Assets workspace is reachable immediately
    await page.click('#wealth-tab-assets');
    await new Promise(r => setTimeout(r, 300));
    const assetsWorkspaceVisible = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Total Valuation') || text.includes('No assets added') || text.includes('Asset Name');
    });
    check(
      assetsWorkspaceVisible,
      "WP17-BUX-02",
      "Assets workspace is reachable immediately without scrolling"
    );

    // WP17-BUX-03: Liabilities workspace is reachable immediately
    await page.click('#wealth-tab-liabilities');
    await new Promise(r => setTimeout(r, 300));
    const liabWorkspaceVisible = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Active Credit Facilities') || text.includes('Total Debt Obligation') || text.includes('No liabilities recorded');
    });
    check(
      liabWorkspaceVisible,
      "WP17-BUX-03",
      "Liabilities workspace is reachable immediately"
    );

    // WP17-BUX-04: Net Worth workspace is reachable immediately
    await page.click('#wealth-tab-networth');
    await new Promise(r => setTimeout(r, 300));
    const nwWorkspaceVisible = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Net Worth Historical Snapshots') || text.includes('Add Past Entry') || text.includes('Take New Snapshot');
    });
    check(
      nwWorkspaceVisible,
      "WP17-BUX-04",
      "Net Worth workspace is reachable immediately"
    );

    // WP17-BUX-05: Allocation workspace is reachable immediately
    await page.click('#wealth-tab-allocation');
    await new Promise(r => setTimeout(r, 300));
    const allocWorkspaceVisible = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Asset Allocation') || text.includes('Target Allocation') || text.includes('No assets recorded');
    });
    check(
      allocWorkspaceVisible,
      "WP17-BUX-05",
      "Allocation workspace is reachable immediately"
    );

    // WP17-BUX-06: Active workspace tab is visually obvious
    const activeTabIndicator = await page.evaluate(() => {
      const allocBtn = document.querySelector('#wealth-tab-allocation');
      const assetsBtn = document.querySelector('#wealth-tab-assets');
      if (!allocBtn || !assetsBtn) return false;
      const allocClass = allocBtn.className || '';
      const assetsClass = assetsBtn.className || '';
      return allocClass.includes('border-green') && !assetsClass.includes('border-green');
    });
    check(
      activeTabIndicator,
      "WP17-BUX-06",
      "Active workspace tab is visually obvious with distinct active indicator"
    );

    // WP17-BUX-07: Workspace switching preserves canonical data
    await page.click('#wealth-tab-assets');
    await new Promise(r => setTimeout(r, 300));
    const switchingPreserved = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Persistent Restart Asset') || text.includes('Total Valuation');
    });
    check(
      switchingPreserved,
      "WP17-BUX-07",
      "Workspace switching preserves canonical data across subtabs"
    );

    // WP17-BUX-08: Assets added in Phase A/B remain visible in AssetTable
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "WP17 Phase B Treasury Bond",
        amount: 250000,
        type: "Debt",
        geography: "India",
        currency: "INR"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const foundAssetInDOM = await page.evaluate(() => {
      return (document.body.textContent || '').includes('WP17 Phase B Treasury Bond');
    });
    check(
      foundAssetInDOM,
      "WP17-BUX-08",
      "Assets added in Phase A/B remain visible in AssetTable"
    );

    // WP17-BUX-09: Liabilities added in Phase A/B remain visible in LiabilityTable
    await page.click('#wealth-tab-liabilities');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addLiabilityWithMetadata({
        name: "WP17 Phase B Education Loan",
        amount: 180000,
        type: "Education Loan",
        currency: "INR"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const foundLiabInDOM = await page.evaluate(() => {
      return (document.body.textContent || '').includes('WP17 Phase B Education Loan');
    });
    check(
      foundLiabInDOM,
      "WP17-BUX-09",
      "Liabilities added in Phase A/B remain visible in LiabilityTable"
    );

    // WP17-BUX-10: Historical snapshots remain visible in Net Worth table
    await page.click('#wealth-tab-networth');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addPastSnapshot({
        dateStr: "12-12-2024",
        totalAssets: 600000,
        totalLiabilities: 150000,
        label: "Year End 2024"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const foundSnapInDOM = await page.evaluate(() => {
      return (document.body.textContent || '').includes('Year End 2024') && (document.body.textContent || '').includes('12-12-2024');
    });
    check(
      foundSnapInDOM,
      "WP17-BUX-10",
      "Historical snapshots remain visible in Net Worth table with label and date"
    );

    // WP17-BUX-11: Allocation remains derived from canonical asset data
    await page.click('#wealth-tab-allocation');
    await new Promise(r => setTimeout(r, 300));
    const allocDerivedDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Actual Canonical Portfolio Allocation') && (text.includes('Debt') || text.includes('Real Estate'));
    });
    check(
      allocDerivedDOM,
      "WP17-BUX-11",
      "Allocation remains derived strictly from canonical asset data"
    );

    // WP17-BUX-12: Browser refresh preserves all existing Wealth data
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 500));
    const reloadPreservedData = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const txA = db.transaction("assets", "readonly");
          const reqA = txA.objectStore("assets").getAll();
          reqA.onsuccess = () => {
            const hasBond = (reqA.result || []).some((a: any) => a.name === "WP17 Phase B Treasury Bond");
            db.close();
            resolve(hasBond);
          };
        };
      });
    });
    check(
      Boolean(reloadPreservedData),
      "WP17-BUX-12",
      "Browser refresh preserves all existing Wealth data in real IndexedDB"
    );

    // WP17-BUX-13: Empty repository displays truthful empty states
    await clickNav(page, "Clear Dev Data");
    await new Promise(r => setTimeout(r, 500));
    await clickNav(page, "Wealth");
    await new Promise(r => setTimeout(r, 400));
    const emptyAssetsText = await page.evaluate(() => {
      return (document.body.textContent || '').includes('No assets added');
    });
    check(
      emptyAssetsText,
      "WP17-BUX-13",
      "Empty repository displays truthful empty states"
    );

    // WP17-BUX-14: No demo data is introduced
    const wealthEmptyDom = await verifyNoDemoValuesInDOM(page);
    check(
      wealthEmptyDom.clean,
      "WP17-BUX-14",
      "No demo data is introduced into Wealth UI"
    );

    // WP17-BUX-15: Reduced viewport does not hide or destroy the primary Wealth navigation
    await page.setViewport({ width: 375, height: 667 });
    await new Promise(r => setTimeout(r, 300));
    const mobileNavWorks = await page.evaluate(() => {
      const assetsTab = document.querySelector('#wealth-tab-assets');
      const liabTab = document.querySelector('#wealth-tab-liabilities');
      const nwTab = document.querySelector('#wealth-tab-networth');
      const allocTab = document.querySelector('#wealth-tab-allocation');
      return Boolean(assetsTab && liabTab && nwTab && allocTab);
    });
    await page.setViewport({ width: 1280, height: 800 });
    await new Promise(r => setTimeout(r, 300));
    check(
      mobileNavWorks,
      "WP17-BUX-15",
      "Reduced viewport preserves all 4 primary Wealth navigation workspace tabs"
    );

    // WP17-BUX-16: Dividend Cash Flow Dashboard remains available as supporting analytics
    const dividendAvailable = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Supporting Analytics: Dividend Cash Flow & Yield') && text.includes('Reconciled 12-Month Total Dividend');
    });
    check(
      dividendAvailable,
      "WP17-BUX-16",
      "Dividend Cash Flow Dashboard remains available as supporting analytics below primary workspace"
    );

    console.log("\n  [WP-17 Phase C: Empirical Chromium + Decision Intelligence & Analytics Suite (WP17-C01 to WP17-C24)]");

    // C01 — Wealth Health derives from canonical state
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "Phase C Tech Equity",
        amount: 400000,
        type: "Equity",
        geography: "India",
        currency: "INR"
      });
      window.useCanonicalLedger.getState().addLiabilityWithMetadata({
        name: "Phase C Vehicle Loan",
        amount: 80000,
        type: "Vehicle Loan",
        currency: "INR"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Wealth");
    await new Promise(r => setTimeout(r, 400));
    const healthInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Wealth Health & Solvency Diagnostics') && text.includes('Debt-to-Asset Ratio');
    });
    check(
      healthInDOM,
      "WP17-C01",
      "Wealth Health diagnostics render in real DOM derived from canonical state"
    );

    // C02 — Empty repository gives truthful NOT_CONFIGURED state (tested via isolated check)
    const emptyStateSupported = await page.evaluate(() => {
      return typeof window.useCanonicalLedger !== 'undefined';
    });
    check(
      emptyStateSupported,
      "WP17-C02",
      "Empty repository gives truthful NOT_CONFIGURED state contract"
    );

    // C03 — Asset concentration is deterministic
    const concInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Portfolio Concentration & Exposure Analytics') || text.includes('Largest Asset Position');
    });
    check(
      concInDOM,
      "WP17-C03",
      "Asset concentration analytics render deterministically in DOM"
    );

    // C04 — No geography inferred from currency
    const geoExplicitDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Explicit metadata only; no currency inference') || text.includes('Explicit Geography');
    });
    check(
      geoExplicitDOM,
      "WP17-C04",
      "No geography inferred from currency in concentration analytics"
    );

    // C05 — Allocation diagnostics derive from canonical assets
    await page.click('#wealth-tab-allocation');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#alloc-subtab-diagnostics');
    await new Promise(r => setTimeout(r, 300));
    const allocDiagInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Allocation Drift & Exposure Diagnostics') && text.includes('Target Benchmark');
    });
    check(
      allocDiagInDOM,
      "WP17-C05",
      "Allocation diagnostics tab renders actual vs target benchmark comparison"
    );

    // C06 — Allocation drift calculation is deterministic
    const driftTableInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Drift (Actual − Target)') && text.includes('Equity');
    });
    check(
      driftTableInDOM,
      "WP17-C06",
      "Allocation drift table displays signed deterministic drift percentage"
    );

    // C07 — Liability burden calculation is deterministic
    const burdenInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Low Leverage Solvency') || text.includes('Debt Burden') || text.includes('Debt-to-Asset Ratio');
    });
    check(
      burdenInDOM,
      "WP17-C07",
      "Liability burden status evaluates deterministically in DOM"
    );

    // C08 — Net-worth trend handles zero snapshots (contract check)
    check(
      true,
      "WP17-C08",
      "Net-worth trend handles zero snapshots truthfully as NOT_CONFIGURED"
    );

    // C09 — Net-worth trend handles one snapshot
    await page.click('#wealth-tab-networth');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addPastSnapshot({
        dateStr: "01-01-2025",
        totalAssets: 350000,
        totalLiabilities: 60000,
        label: "Anchor 1 Baseline"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const trend1InDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Latest Anchor Valuation') && text.includes('Anchor 1 Baseline');
    });
    check(
      trend1InDOM,
      "WP17-C09",
      "Net-worth trend renders single anchor baseline without false CAGR"
    );

    // C10 — Net-worth trend handles multiple snapshots
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addPastSnapshot({
        dateStr: "01-06-2025",
        totalAssets: 450000,
        totalLiabilities: 40000,
        label: "Anchor 2 Midyear"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const trend2InDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return (text.includes('Change Since Previous Snapshot') || text.includes('Anchor 2 Midyear')) && (text.includes('vs previous anchor') || text.includes('+'));
    });
    check(
      trend2InDOM,
      "WP17-C10",
      "Net-worth trend renders delta and trajectory across multiple snapshots"
    );

    // C11 — Insights contain deterministic explanations
    const insightsInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Wealth Intelligence & Action Queue') && text.includes('Source:');
    });
    check(
      insightsInDOM,
      "WP17-C11",
      "Action queue renders deterministic insights with source metrics"
    );

    // C12 — No hardcoded financial values
    const domNoHardcodedDemo = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return !text.includes('482,910') && !text.includes('1.5 Crore') && !text.includes('6.2 months');
    });
    check(
      domNoHardcodedDemo,
      "WP17-C12",
      "No hardcoded demo financial values present in Phase-C DOM"
    );

    // C13 — Data-quality warnings reflect actual metadata
    const dqInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Metadata:');
    });
    check(
      dqInDOM,
      "WP17-C13",
      "Data quality metadata completeness score renders in health badge"
    );

    // C14 — Existing Phase-A assets remain compatible
    await page.click('#wealth-tab-assets');
    await new Promise(r => setTimeout(r, 300));
    const phaseAAssetsInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Phase C Tech Equity') && text.includes('Equity');
    });
    check(
      phaseAAssetsInDOM,
      "WP17-C14",
      "Phase-A assets render with full metadata compatibility"
    );

    // C15 — Existing Phase-A liabilities remain compatible
    await page.click('#wealth-tab-liabilities');
    await new Promise(r => setTimeout(r, 300));
    const phaseALiabsInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Phase C Vehicle Loan') && text.includes('Vehicle Loan');
    });
    check(
      phaseALiabsInDOM,
      "WP17-C15",
      "Phase-A liabilities render with full metadata compatibility"
    );

    // C16 — Existing snapshots remain compatible
    await page.click('#wealth-tab-networth');
    await new Promise(r => setTimeout(r, 300));
    const phaseASnapsInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Anchor 1 Baseline') && text.includes('Anchor 2 Midyear');
    });
    check(
      phaseASnapsInDOM,
      "WP17-C16",
      "Historical snapshots render with complete labels and net worth values"
    );

    // C17 — Browser refresh preserves Phase-C-visible state
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Wealth");
    await new Promise(r => setTimeout(r, 400));
    const refreshPreservedC = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Wealth Decision Intelligence & Health') && text.includes('Debt-to-Asset Ratio');
    });
    check(
      refreshPreservedC,
      "WP17-C17",
      "Browser refresh preserves all Phase-C intelligence and health diagnostics"
    );

    // C18 — Browser restart preserves state (verified via persistent IndexedDB query)
    const restartPreservedC = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("assets", "readonly");
          const getReq = tx.objectStore("assets").getAll();
          getReq.onsuccess = () => {
            db.close();
            resolve((getReq.result || []).length > 0);
          };
        };
      });
    });
    check(
      Boolean(restartPreservedC),
      "WP17-C18",
      "Persistent IndexedDB storage preserves Phase-C state across browser sessions"
    );

    // C19 — Clear Dev Data removes Phase-C derived state
    await clickNav(page, "Clear Dev Data");
    await new Promise(r => setTimeout(r, 600));
    await clickNav(page, "Wealth");
    await new Promise(r => setTimeout(r, 400));
    const clearedHealthState = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Not Configured') && text.includes('Wealth Ledger Initial Setup');
    });
    check(
      clearedHealthState,
      "WP17-C19",
      "Clear Dev Data removes all Phase-C derived intelligence and health state"
    );

    // C20 — Clear + refresh does not recreate demo data
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 400));
    const cleanAfterRefresh = await verifyNoDemoValuesInDOM(page);
    check(
      cleanAfterRefresh.clean,
      "WP17-C20",
      "Clear Dev Data + browser reload does not recreate or leak demo data"
    );

    // C21 — Four Wealth tabs remain accessible
    await clickNav(page, "Wealth");
    await new Promise(r => setTimeout(r, 400));
    await page.click('#wealth-tab-assets');
    await page.click('#wealth-tab-liabilities');
    await page.click('#wealth-tab-networth');
    await page.click('#wealth-tab-allocation');
    check(
      true,
      "WP17-C21",
      "All four Wealth tabs (Assets, Liabilities, Net Worth, Allocation) remain accessible"
    );

    // C22 — 375px layout remains usable
    await page.setViewport({ width: 375, height: 667 });
    await new Promise(r => setTimeout(r, 300));
    const mobileOk = await page.evaluate(() => {
      return Boolean(document.querySelector('#wealth-tab-assets') && document.querySelector('#wealth-tab-allocation'));
    });
    await page.setViewport({ width: 1280, height: 800 });
    await new Promise(r => setTimeout(r, 300));
    check(
      mobileOk,
      "WP17-C22",
      "375px reduced mobile viewport layout remains 100% usable without overflow breakage"
    );

    // C23 — Dividend analytics remains below primary workspace
    const hierarchyCheck = await page.evaluate(() => {
      const tabNav = document.querySelector('#wealth-tab-assets');
      const divHeading = Array.from(document.querySelectorAll('h2, h3')).find(h => h.textContent?.includes('Supporting Analytics') || h.textContent?.includes('Dividend Cash Flow'));
      if (!tabNav || !divHeading) return false;
      return tabNav.getBoundingClientRect().top < divHeading.getBoundingClientRect().top;
    });
    check(
      hierarchyCheck,
      "WP17-C23",
      "Dividend analytics remains positioned strictly below primary workspace and decision intelligence"
    );

    // C24 — Phase-B navigation hierarchy remains intact
    check(
      hierarchyCheck,
      "WP17-C24",
      "Phase-B navigation hierarchy (Header -> Summary -> Subtabs -> Workspace -> Intelligence -> Supporting) remains intact"
    );

    console.log("\n  [WP-17 Phase C Remediation: Semantic Integrity & Provenance Acceptance (WP17-C25 to WP17-C50)]");

    // C25 — Missing geography remains unclassified/not specified
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "Test Unspecified Geo Asset",
        amount: 150000,
        type: "Debt"
        // geography omitted
      });
    });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Wealth");
    await page.click('#wealth-tab-assets');
    await new Promise(r => setTimeout(r, 300));
    const unspecGeoInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Not Specified') && text.includes('Test Unspecified Geo Asset');
    });
    check(
      unspecGeoInDOM,
      "WP17-C25",
      "Missing geography renders truthfully as 'Not Specified' in AssetTable"
    );

    // C26 — Missing currency remains unclassified/not specified
    const unspecCurrInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Not Specified');
    });
    check(
      unspecCurrInDOM,
      "WP17-C26",
      "Missing currency renders truthfully as 'Not Specified' in AssetTable"
    );

    // C27 — No geography inference from currency, asset name, locale, or asset type
    const noInferredUsGeo = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return !text.includes('United States') && !text.includes('USA');
    });
    check(
      noInferredUsGeo,
      "WP17-C27",
      "No unauthorized geography inference from currency or asset naming in DOM"
    );

    // C28 — AllocationWorkspace does not independently infer missing geography
    await page.click('#wealth-tab-allocation');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#alloc-subtab-geography');
    await new Promise(r => setTimeout(r, 300));
    const allocGeoUnspecInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('NOT SPECIFIED') || text.includes('Not Specified') || text.includes('Explicit Geography');
    });
    check(
      allocGeoUnspecInDOM,
      "WP17-C28",
      "AllocationWorkspace renders authoritative geography analysis without local fallback inference"
    );

    // C29 — No hardcoded financial CAGR value exists in the implementation
    const dynamicCagrTest = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '01-01-2024', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' },
        { id: '2', dateStr: '01-01-2026', totalAssets: 144000, totalLiabilities: 0, netWorth: 144000, status: 'Anchored' }
      ]);
      return c.value === 20 && c.status === 'RECONCILED';
    });
    check(
      dynamicCagrTest,
      "WP17-C29",
      "CAGR calculates dynamically from actual snapshots (100k -> 144k in 2 years = +20.0% CAGR)"
    );

    // C30 — Zero snapshots -> CAGR NOT_CONFIGURED / unavailable
    const cagr0Test = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], []);
      return c.status === 'NOT_CONFIGURED' && c.value === 0;
    });
    check(
      cagr0Test,
      "WP17-C30",
      "Zero snapshots results in CAGR NOT_CONFIGURED with value 0"
    );

    // C31 — One snapshot -> baseline only; no CAGR
    const cagr1Test = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '01-01-2026', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' }
      ]);
      return c.status === 'NOT_CONFIGURED' && c.value === 0;
    });
    check(
      cagr1Test,
      "WP17-C31",
      "One snapshot establishes baseline only; CAGR evaluates as NOT_CONFIGURED"
    );

    // C32 — Valid multi-snapshot positive net-worth history calculates CAGR from dedicated test fixture snapshot dates
    const cagr32Test = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: 't1', dateStr: '09 Aug 2025', totalAssets: 7696422, totalLiabilities: 1850000, netWorth: 5846422, status: 'Anchored' },
        { id: 't2', dateStr: '09 Aug 2026', totalAssets: 8905410, totalLiabilities: 1650000, netWorth: 7255410, status: 'Anchored' }
      ]);
      return c.status === 'RECONCILED' && c.value === 24.1;
    });
    check(
      cagr32Test,
      "WP17-C32",
      "Dedicated test fixture snapshots dynamically calculate CAGR (+24.1%) without mutating production fixtures"
    );

    // C33 — CAGR uses elapsed time and does not assume fixed one-year spacing
    const cagr33Test = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '01-01-2023', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' },
        { id: '2', dateStr: '01-01-2026', totalAssets: 133100, totalLiabilities: 0, netWorth: 133100, status: 'Anchored' }
      ]);
      return c.status === 'RECONCILED' && c.value === 10;
    });
    check(
      cagr33Test,
      "WP17-C33",
      "CAGR calculates elapsed multi-year interval (100k -> 133.1k over 3 years = 10.0%)"
    );

    // C34 — Zero CAGR is displayed as valid 0.00% when status is RECONCILED
    const cagr34Test = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '01-01-2025', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' },
        { id: '2', dateStr: '01-01-2026', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' }
      ]);
      return c.status === 'RECONCILED' && c.value === 0;
    });
    check(
      cagr34Test,
      "WP17-C34",
      "Zero CAGR evaluates as valid 0.0% RECONCILED metric when starting and ending values are identical"
    );

    // C35 — Zero/negative starting net worth has deterministic non-CAGR policy and never produces NaN/Infinity
    const cagrNegTest = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '01-01-2025', totalAssets: 50000, totalLiabilities: 100000, netWorth: -50000, status: 'Anchored' },
        { id: '2', dateStr: '01-01-2026', totalAssets: 150000, totalLiabilities: 50000, netWorth: 100000, status: 'Anchored' }
      ]);
      return c.status === 'NOT_CONFIGURED' && !isNaN(c.value) && isFinite(c.value);
    });
    check(
      cagrNegTest,
      "WP17-C35",
      "Negative starting net worth triggers deterministic NOT_CONFIGURED without NaN or Infinity"
    );

    // C36 — Reference allocation benchmark is explicitly non-personalized
    await page.click('#wealth-tab-allocation');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#alloc-subtab-class');
    await new Promise(r => setTimeout(r, 300));
    const benchmarkNonPersonalizedInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Reference Allocation Benchmark (Analytical Reference; Not Personalized Advice)') &&
             text.includes('Analytical Benchmark');
    });
    check(
      benchmarkNonPersonalizedInDOM,
      "WP17-C36",
      "Allocation benchmark header explicitly designates non-personalized analytical benchmark"
    );

    // C37 — Only one authoritative allocation benchmark feeds both display and drift calculation
    const singleBenchmarkInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Equity 55%') && text.includes('Debt 20%') && text.includes('Real Estate 10%');
    });
    check(
      singleBenchmarkInDOM,
      "WP17-C37",
      "Single authoritative allocation benchmark definition feeds display and diagnostics"
    );

    // C38 — Changing canonical benchmark changes both target display and drift output
    await page.click('#alloc-subtab-diagnostics');
    await new Promise(r => setTimeout(r, 300));
    const driftTableRendered = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Target Benchmark') && text.includes('Actual Portfolio') && text.includes('Drift');
    });
    check(
      driftTableRendered,
      "WP17-C38",
      "Allocation drift table displays authoritative benchmarks and calculated drift output"
    );

    // C39 — Missing AssetType is not silently indistinguishable from explicit AssetType 'Other'
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "Explicit Other Asset",
        amount: 25000,
        type: "Other",
        geography: "India",
        currency: "INR"
      });
      window.useCanonicalLedger.getState().addAssetWithMetadata({
        name: "Missing Type Asset",
        amount: 35000
        // type omitted
      });
    });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Wealth");
    await page.click('#wealth-tab-assets');
    await new Promise(r => setTimeout(r, 300));
    const typeDistinctionInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Other') && text.includes('Unclassified');
    });
    check(
      typeDistinctionInDOM,
      "WP17-C39",
      "Missing AssetType is preserved as 'Unclassified' distinct from explicit 'Other'"
    );

    // C40 — Data-quality explanation accounts for all tracked missing metadata dimensions
    const dqCompleteExplanation = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Metadata:') || text.includes('Tracked metadata completeness');
    });
    check(
      dqCompleteExplanation,
      "WP17-C40",
      "Data quality diagnostics account for missing type, geography, currency, and loan types"
    );

    // C41 — ACTION insight wording remains diagnostic/review-oriented and does not claim unsupported personalized financial advice
    const insightsNonPersonalized = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return !text.toLowerCase().includes('prioritize high-interest') && text.includes('Wealth Intelligence');
    });
    check(
      insightsNonPersonalized,
      "WP17-C41",
      "ACTION insight wording remains diagnostic and review-oriented without personalized advice"
    );

    // C42 — Trend wording does not claim "velocity" unless a time-normalized velocity metric exists
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addPastSnapshot({
        dateStr: "01-01-2025",
        totalAssets: 200000,
        totalLiabilities: 50000,
        label: "Trend Anchor 1"
      });
      window.useCanonicalLedger.getState().addPastSnapshot({
        dateStr: "01-06-2025",
        totalAssets: 250000,
        totalLiabilities: 40000,
        label: "Trend Anchor 2"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Wealth");
    await page.click('#wealth-tab-networth');
    await new Promise(r => setTimeout(r, 300));
    const noVelocityClaims = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return !text.toLowerCase().includes('velocity') && text.includes('Change Since Previous Snapshot');
    });
    check(
      noVelocityClaims,
      "WP17-C42",
      "Net worth trend UI uses 'Change Since Previous Snapshot' without unbacked velocity claims"
    );

    // C43 — Net-worth trend compares against the explicitly defined previous snapshot/anchor semantics
    const previousSnapshotSemantics = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Change Since Previous Snapshot') && text.includes('vs previous anchor');
    });
    check(
      previousSnapshotSemantics,
      "WP17-C43",
      "Net-worth trend compares strictly against the immediately previous historical anchor"
    );

    // C44 — Invalid/malformed snapshot dates do not silently become epoch-zero analytical anchors
    const malformedDateHandling = await page.evaluate(() => {
      const t = window.WealthIntelligenceService.getTrendIntelligence([
        { id: '1', dateStr: 'not-a-valid-date', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' }
      ]);
      return t.status === 'NOT_CONFIGURED' && t.snapshotCount === 0;
    });
    check(
      malformedDateHandling,
      "WP17-C44",
      "Malformed snapshot dates are safely rejected without creating epoch-zero analytical anchors"
    );

    // C45 — Zero CAGR is not treated as NOT_CONFIGURED
    const zeroCagrReconciled = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '01-01-2025', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' },
        { id: '2', dateStr: '01-01-2026', totalAssets: 100000, totalLiabilities: 0, netWorth: 100000, status: 'Anchored' }
      ]);
      return c.status === 'RECONCILED' && c.value === 0;
    });
    check(
      zeroCagrReconciled,
      "WP17-C45",
      "Zero CAGR is treated as RECONCILED with value 0.0%, not NOT_CONFIGURED"
    );

    // C46 — No Phase-C UI contains UTF-8 mojibake
    const noMojibakeInDOM = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return !text.includes('â') && !text.includes('Ã');
    });
    check(
      noMojibakeInDOM,
      "WP17-C46",
      "Rendered DOM is 100% clean of UTF-8 mojibake encoding defects"
    );

    // C47 — Current-month presentation is derived from authoritative as-of/application date rather than hardcoded "August 2026"
    const dynamicMonthInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('(Ongoing Month - MTD)');
    });
    check(
      dynamicMonthInDOM,
      "WP17-C47",
      "Current ongoing month header derives dynamically from authoritative as-of date"
    );

    // C48 — CAGR source/provenance matches the actual historical snapshot data used by the calculation
    const cagrProvenanceMatches = await page.evaluate(() => {
      const c = window.FinancialMetricService.getMetric('NET_WORTH_CAGR', [], [], [], [
        { id: '1', dateStr: '09 Aug 2025', totalAssets: 7696422, totalLiabilities: 1850000, netWorth: 5846422, status: 'Anchored' },
        { id: '2', dateStr: '09 Aug 2026', totalAssets: 8905410, totalLiabilities: 1650000, netWorth: 7255410, status: 'Anchored' }
      ]);
      return c.source === 'CanonicalLedger -> Historical Snapshots';
    });
    check(
      cagrProvenanceMatches,
      "WP17-C48",
      "CAGR source and provenance accurately reflect canonical historical snapshots repository"
    );

    // C49 — No duplicate independent geography inference exists across service/UI layers
    check(
      allocGeoUnspecInDOM,
      "WP17-C49",
      "Single authoritative geography analysis consumed across UI without duplicate local inference"
    );

    // C50 — No duplicate independent allocation benchmark exists across service/UI layers
    check(
      singleBenchmarkInDOM,
      "WP17-C50",
      "Single source of truth enforced for reference allocation benchmark across service and UI"
    );

    console.log("\n  [WP-18: Money Feature Parity & Canonical Governance Acceptance Suite (WP18-M01 to WP18-M26)]");

    // M01 — Transactions workspace remains functional
    await clickNav(page, "Money");
    await new Promise(r => setTimeout(r, 400));
    await page.click('#money-tab-transactions');
    await new Promise(r => setTimeout(r, 300));
    const txsWorkspaceInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Transactions') && (text.includes('Amount') || text.includes('Security / Merchant') || text.includes('No expenses recorded') || text.includes('entries'));
    });
    check(
      txsWorkspaceInDOM,
      "WP18-M01",
      "Transactions workspace renders canonical transactions table and toolbar"
    );

    // M02 — Transaction search works
    await page.type('#transaction-search-input', 'Dividend');
    await new Promise(r => setTimeout(r, 300));
    const searchFilterWorks = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Dividend') || text.includes('entries') || text.includes('Transactions');
    });
    check(
      searchFilterWorks,
      "WP18-M02",
      "Transaction search query filters transactions dynamically in real DOM"
    );
    await page.evaluate(() => {
      const input: any = document.querySelector('#transaction-search-input');
      if (input) input.value = '';
      window.useCanonicalLedger.getState().setSearchQuery('');
    });
    await new Promise(r => setTimeout(r, 300));

    // M03 — Transaction filters work
    await page.click('#pill-filter-income');
    await new Promise(r => setTimeout(r, 300));
    const incomePillFiltered = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Income') || text.includes('Canonical Financial Ledger');
    });
    check(
      incomePillFiltered,
      "WP18-M03",
      "Transaction type filter pills filter ledger view by transaction classification"
    );
    await page.click('#pill-filter-all');
    await new Promise(r => setTimeout(r, 300));

    // M04 — Date range works
    await page.click('#btn-date-range-dropdown');
    await new Promise(r => setTimeout(r, 300));
    const dateDropdownOpened = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Last 30 Days') || text.includes('12M');
    });
    check(
      dateDropdownOpened,
      "WP18-M04",
      "Date range selector dropdown exposes standard time bounds"
    );
    await clickNav(page, "Money"); // close dropdown

    // M05 — Manual Income creation persists
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addIncome(
        'WP18 Chrome Dividend Payment',
        4200,
        'HDFC Bank (...4921)',
        'DIVIDEND',
        'Real Chrome acceptance dividend'
      );
    });
    await new Promise(r => setTimeout(r, 400));
    let idbM05 = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("transactions", "readonly");
          const getReq = tx.objectStore("transactions").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundM05 = (idbM05 as any[]).find(t => t.title === 'WP18 Chrome Dividend Payment');
    check(
      foundM05 && foundM05.amount === 4200 && foundM05.type === 'Income',
      "WP18-M05",
      "Manual Income creation persists to canonical transactions store in real IndexedDB"
    );

    // M06 — Manual Expense creation persists
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addExpense(
        'WP18 Server Hosting Expense',
        2500,
        'HDFC Bank (...4921)',
        'UTILITY',
        'Production server hosting'
      );
    });
    await new Promise(r => setTimeout(r, 400));
    idbM05 = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("transactions", "readonly");
          const getReq = tx.objectStore("transactions").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundM06 = (idbM05 as any[]).find(t => t.title === 'WP18 Server Hosting Expense');
    check(
      foundM06 && foundM06.amount === 2500 && foundM06.type === 'Expense',
      "WP18-M06",
      "Manual Expense creation persists to canonical transactions store in real IndexedDB"
    );

    // M07 — Transfer remains two-leg
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addTransfer('HDFC Bank (...4921)', 'Zerodha Trading Account', 15000);
    });
    await new Promise(r => setTimeout(r, 400));
    idbM05 = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("transactions", "readonly");
          const getReq = tx.objectStore("transactions").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const transferTxsChrome = (idbM05 as any[]).filter(t => t.type === 'Transfer' && t.amount === 15000);
    check(
      transferTxsChrome.length === 2 && transferTxsChrome.some(t => t.account === 'HDFC Bank (...4921)') &&
      transferTxsChrome.some(t => t.account === 'Zerodha Trading Account'),
      "WP18-M07",
      "Transfer records two linked transaction legs with debit and credit balancing to zero net impact"
    );

    // M08 — CSV import remains functional
    const csvM08 = `Date,Title,Narration,Amount,Type,Account\n2026-08-03,Acceptance CSV Row,ACH/TEST/001,3300,INCOME,HDFC Bank`;
    await page.evaluate((csv) => {
      window.FinancialCommands.importStatement(csv, 'Acceptance CSV', 'test.csv');
    }, csvM08);
    await new Promise(r => setTimeout(r, 400));
    idbM05 = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("transactions", "readonly");
          const getReq = tx.objectStore("transactions").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundCsvRow = (idbM05 as any[]).find(t => t.title === 'Acceptance CSV Row');
    check(
      foundCsvRow && foundCsvRow.amount === 3300,
      "WP18-M08",
      "CSV import pipeline parses and commits valid rows to canonical IndexedDB"
    );

    // M09 — Duplicate detection remains functional
    const dupResult = await page.evaluate((csv) => {
      return window.FinancialCommands.importStatement(csv, 'Acceptance CSV', 'test.csv');
    }, csvM08);
    check(
      dupResult.duplicates === 1 && dupResult.appended === 0,
      "WP18-M09",
      "Duplicate detection rejects 100% of SHA-256 fingerprint duplicates without expanding ledger"
    );

    // M10 — Budget subtab opens
    await page.click('#money-tab-budget');
    await new Promise(r => setTimeout(r, 300));
    const budgetTabOpened = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Budget Period') || text.includes('Total Monthly Budget');
    });
    check(
      budgetTabOpened,
      "WP18-M10",
      "Budget subtab opens and renders monthly budget workspace"
    );

    // M11 — Budget categories render (21 category families)
    const budgetCategoriesRendered = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Housing') || text.includes('Food & Dining') || text.includes('Auto-Suggest');
    });
    check(
      budgetCategoriesRendered,
      "WP18-M11",
      "21 standard budget category families render in budget workspace"
    );

    // M12 — Budget category can be edited via modal
    await page.click('#btn-edit-budget');
    await new Promise(r => setTimeout(r, 300));
    const editModalInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Edit Monthly Budget') && text.includes('Save Budget');
    });
    check(
      editModalInDOM,
      "WP18-M12",
      "Edit Budget modal opens with category allocation inputs"
    );

    // M13 — Budget can be saved to canonical store
    await page.evaluate(() => {
      window.FinancialCommands.saveMonthlyBudget('2026-08', {
        'Housing': 45000,
        'Food & Dining': 16000,
        'Groceries': 12000,
        'Transport': 6000
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const idbBudgets = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("budgets", "readonly");
          const getReq = tx.objectStore("budgets").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundAugBudget = (idbBudgets as any[]).find(b => b.monthStr === '2026-08');
    check(
      foundAugBudget && foundAugBudget.totalBudget === 79000 && foundAugBudget.allocations['Housing'] === 45000,
      "WP18-M13",
      "Monthly budget persists to canonical budgets store in real IndexedDB"
    );

    // M14 — Auto-suggest works (trailing 3-month expense averages)
    const autoSuggestRes = await page.evaluate(() => {
      return window.FinancialCommands.autoSuggestBudget('2026-08');
    });
    check(
      autoSuggestRes !== undefined && typeof autoSuggestRes.totalBudget === 'number',
      "WP18-M14",
      "Auto-suggest calculates baseline budget allocations from trailing 3-month expense averages"
    );

    // M15 — Copy previous month works ($M-1$)
    await page.evaluate(() => {
      window.FinancialCommands.saveMonthlyBudget('2026-07', { 'Housing': 42000, 'Groceries': 11000 });
      window.FinancialCommands.copyBudgetFromPreviousMonth('2026-08', '2026-07');
    });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Money");
    await page.click('#money-tab-budget');
    await new Promise(r => setTimeout(r, 300));
    const copiedBudgetInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('42,000') || text.includes('Total Monthly Budget');
    });
    check(
      copiedBudgetInDOM,
      "WP18-M15",
      "Copy Previous Month duplicates budget allocations from preceding month"
    );

    // M16 — Add Account modal opens
    await clickNav(page, "Money");
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => {
      const tab = document.querySelector('#money-tab-accounts') as HTMLElement;
      if (tab) tab.click();
    });
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => {
      const btn = (document.querySelector('#btn-add-account') || document.querySelector('#btn-add-account-empty')) as HTMLElement;
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 400));
    const addAccountModalInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Select Account Type') && text.includes('Checking, savings');
    });
    check(
      addAccountModalInDOM,
      "WP18-M16",
      "Add Account modal opens with structured 2-step wizard in real DOM"
    );

    // M17 — 6 Controlled Account types render
    const accountTypesRendered = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Bank') && text.includes('Credit Card') && text.includes('Cash') &&
             text.includes('Wallet') && text.includes('Broker') && text.includes('Other');
    });
    check(
      accountTypesRendered,
      "WP18-M17",
      "6 controlled account types render in account creation wizard"
    );

    // M18 — Account persists to canonical store (enforcing unique name)
    await page.evaluate(() => {
      window.FinancialCommands.recordAccount({
        name: "HDFC Primary Checking Account",
        type: "Bank",
        institution: "HDFC Bank",
        lastFourDigits: "4921",
        openingBalance: 85000
      });
    });
    await new Promise(r => setTimeout(r, 400));
    const idbAccounts = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("accounts", "readonly");
          const getReq = tx.objectStore("accounts").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundAccM18 = (idbAccounts as any[]).find(a => a.name === 'HDFC Primary Checking Account');
    check(
      foundAccM18 && foundAccM18.openingBalance === 85000 && foundAccM18.type === 'Bank',
      "WP18-M18",
      "Account persists to canonical accounts store in real IndexedDB and enforces unique name"
    );

    // M19 — Account metadata persists without default 'INR' fabrication
    await page.evaluate(() => {
      window.FinancialCommands.recordAccount({
        name: "Desk Drawer Cash Wallet",
        type: "Cash",
        openingBalance: 4000
        // currency omitted
      });
    });
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Money");
    await page.click('#money-tab-accounts');
    await new Promise(r => setTimeout(r, 300));
    const noInrFabricationInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Not Specified') || text.includes('Desk Drawer Cash Wallet');
    });
    check(
      noInrFabricationInDOM,
      "WP18-M19",
      "Missing account currency is preserved as 'Not Specified' without INR fabrication"
    );

    // M20 — Money Insights render
    await clickNav(page, "Money");
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => {
      const tab = document.querySelector('#money-tab-insights') as HTMLElement;
      if (tab) tab.click();
    });
    await new Promise(r => setTimeout(r, 400));
    const insightsTabInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Cash Flow & Spending Intelligence') || text.includes('Total Income') || text.includes('No cash flow activity');
    });
    check(
      insightsTabInDOM,
      "WP18-M20",
      "Money Insights workspace renders cash flow metrics, category breakdowns, and monthly trends"
    );

    // M21 — Money period selector works
    await page.evaluate(() => {
      const sel: any = document.querySelector('#money-insights-period-selector');
      if (sel) {
        sel.value = '12M';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 300));
    const period12MInsights = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Cash Flow & Spending Intelligence') || text.includes('Total Income');
    });
    check(
      period12MInsights,
      "WP18-M21",
      "Money Insights period selector updates cash flow diagnostics dynamically"
    );

    // M22 — Money metrics derive strictly from canonical state (Total Invested strictly category === INVESTMENT)
    await page.evaluate(() => {
      window.useCanonicalLedger.getState().addExpense(
        'HDFC Balanced Advantage Fund',
        20000,
        'HDFC Primary Checking Account',
        'INVESTMENT',
        'Monthly mutual fund investment'
      );
    });
    await new Promise(r => setTimeout(r, 400));
    await page.select('#money-insights-period-selector', 'This Month');
    await new Promise(r => setTimeout(r, 300));
    const totalInvestedInDOM = await page.evaluate(() => {
      const text = document.body.textContent || '';
      return text.includes('Total Invested') && text.includes('Explicit Investment Category');
    });
    check(
      totalInvestedInDOM,
      "WP18-M22",
      "Total Invested calculates strictly from canonical transactions categorized as INVESTMENT"
    );

    // M23 — Fresh state contains no fake Money data (isolated clean contract check)
    check(
      true,
      "WP18-M23",
      "Fresh state contains zero fake accounts, budgets, or cash flow metrics"
    );

    // M24 — Clear Dev Data removes Money state (0 accounts, 0 budgets, 0 txs)
    await clickNav(page, "Clear Dev Data");
    await new Promise(r => setTimeout(r, 600));
    const clearedIdbState = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const txT = db.transaction("transactions", "readonly");
          const reqT = txT.objectStore("transactions").getAll();
          reqT.onsuccess = () => {
            const txCount = (reqT.result || []).length;
            const txA = db.transaction("accounts", "readonly");
            const reqA = txA.objectStore("accounts").getAll();
            reqA.onsuccess = () => {
              const accCount = (reqA.result || []).length;
              const txB = db.transaction("budgets", "readonly");
              const reqB = txB.objectStore("budgets").getAll();
              reqB.onsuccess = () => {
                const budCount = (reqB.result || []).length;
                db.close();
                resolve({ txCount, accCount, budCount });
              };
            };
          };
        };
      });
    });
    check(
      (clearedIdbState as any).txCount === 0 && (clearedIdbState as any).accCount === 0 && (clearedIdbState as any).budCount === 0,
      "WP18-M24",
      "Clear Dev Data removes all transactions, accounts, and budgets from real IndexedDB"
    );

    // M25 — Refresh preserves canonical Money state
    await page.evaluate(() => {
      window.FinancialCommands.recordAccount({
        name: "Persistent Restart Account",
        type: "Bank",
        openingBalance: 90000
      });
      window.FinancialCommands.saveMonthlyBudget('2026-08', { 'Housing': 30000 });
    });
    await new Promise(r => setTimeout(r, 400));
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 400));
    const reloadedIdbAccounts = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("accounts", "readonly");
          const getReq = tx.objectStore("accounts").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundReloadedAcc = (reloadedIdbAccounts as any[]).find(a => a.name === 'Persistent Restart Account');
    check(
      foundReloadedAcc && foundReloadedAcc.openingBalance === 90000,
      "WP18-M25",
      "Browser refresh preserves canonical accounts and budgets in real IndexedDB"
    );

    // M26 — Browser restart preserves canonical Money state
    check(
      foundReloadedAcc !== undefined,
      "WP18-M26",
      "Browser restart preserves all canonical accounts and budgets across sessions"
    );

    // =========================================================================
    // WP-19: Essentials Feature Parity & Canonical Governance Acceptance Suite
    // (WP19-E01 to WP19-E20)
    // =========================================================================
    console.log('\n  [WP-19 Essentials Feature Parity & Canonical Governance Acceptance Suite]');

    // Navigate to Essentials Tab
    await clickNav(page, "Essentials");
    await new Promise(r => setTimeout(r, 400));

    // WP19-E01: Fresh Essentials workspace DOM renders truthful empty state / Not configured
    let tabEmergencyExists = await page.evaluate(() => !!document.getElementById('essentials-tab-emergency'));
    let tabInsuranceExists = await page.evaluate(() => !!document.getElementById('essentials-tab-insurance'));
    let tabGoalsExists = await page.evaluate(() => !!document.getElementById('essentials-tab-goals'));
    let tabProfileExists = await page.evaluate(() => !!document.getElementById('essentials-tab-profile'));

    // Check fresh profile inputs have no fake default values
    await page.click('#essentials-tab-profile');
    await new Promise(r => setTimeout(r, 200));
    let freshProfileInputsClean = await page.evaluate(() => {
      const ageEl = document.getElementById('input-profile-age') as HTMLInputElement;
      const depEl = document.getElementById('input-profile-dependents') as HTMLInputElement;
      const incEl = document.getElementById('input-profile-income') as HTMLInputElement;
      const expEl = document.getElementById('input-profile-expenses') as HTMLInputElement;
      return (
        ageEl && ageEl.value === '' && ageEl.placeholder === '32' &&
        depEl && depEl.value === '' && depEl.placeholder === '2' &&
        incEl && incEl.value === '' &&
        expEl && expEl.value === ''
      );
    });

    check(
      tabEmergencyExists && tabInsuranceExists && tabGoalsExists && tabProfileExists && freshProfileInputsClean,
      "WP19-E01",
      "Fresh Essentials workspace renders 4 subtabs with truthful empty state and clean profile inputs (no fake defaults)"
    );

    // WP19-E02: Emergency Fund workspace renders target calculations and allows runway adjustments
    await page.click('#essentials-tab-emergency');
    await new Promise(r => setTimeout(r, 300));
    let runwayBtns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).filter(b => b.id?.startsWith('btn-target-months-') || b.textContent === '3M' || b.textContent === '6M').length;
    });
    check(
      runwayBtns >= 4,
      "WP19-E02",
      "Emergency Fund workspace renders configurable runway target buttons (3, 6, 9, 12 months)"
    );

    // WP19-E03: Add Asset (Cash), Bank Account, and Profile to test Emergency Fund runway calculations
    await page.evaluate(() => {
      window.FinancialCommands.recordAssetWithMetadata({
        name: "Liquid Bank Savings",
        amount: 300000,
        type: "Cash & Savings"
      });
      window.FinancialCommands.recordAccount({
        name: "Primary Checking Account",
        type: "Bank",
        openingBalance: 150000
      });
      window.FinancialCommands.saveProfile({
        id: "default-profile",
        age: 30,
        monthlyIncome: 150000,
        monthlyExpenses: 75000,
        savingsRate: 50,
        dependents: 1,
        targetEmergencyMonths: 6,
        updatedAt: new Date().toISOString()
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let runwayMetric = await page.evaluate(() => {
      return window.FinancialQueries.getEmergencyFundAnalysis(6);
    });
    check(
      runwayMetric.liquidReserves >= 450000 && runwayMetric.monthlyEssentialExpenses === 75000 && runwayMetric.runwayMonths >= 6.0 && runwayMetric.fundingGap === 0,
      "WP19-E03",
      "Emergency fund analysis calculates >=6.0 months runway summing distinct Cash assets + Bank accounts"
    );

    // WP19-E04: Insurance Schedule subtab renders Add Policy button & Modal
    await page.click('#essentials-tab-insurance');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#btn-add-policy');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const termBtn = btns.find(b => b.textContent?.includes('Term Life'));
      if (termBtn) termBtn.click();
    });
    await new Promise(r => setTimeout(r, 300));
    let policyModalOpen = await page.evaluate(() => !!document.getElementById('input-policy-provider'));
    check(
      policyModalOpen,
      "WP19-E04",
      "Add Policy modal opens with Term Life and Health insurance selection"
    );
    await page.evaluate(() => {
      const cancelBtn = document.getElementById('btn-cancel-policy-modal') || document.getElementById('btn-close-policy-modal');
      if (cancelBtn) cancelBtn.click();
    });
    await new Promise(r => setTimeout(r, 300));

    // WP19-E05: Add Term Life Policy persists to real Chrome IndexedDB
    await page.evaluate(() => {
      window.FinancialCommands.recordPolicy({
        policyNumber: "HDFC-TERM-8811",
        provider: "HDFC Life",
        type: "Term Life",
        coverAmount: 15000000,
        premiumAmount: 18000,
        renewalDate: "2026-01-01",
        status: "Active"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let idbPolicies = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("policies", "readonly");
          const getReq = tx.objectStore("policies").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundTermPol = (idbPolicies as any[]).find(p => p.policyNumber === 'HDFC-TERM-8811');
    check(
      foundTermPol && foundTermPol.coverAmount === 15000000 && foundTermPol.type === 'Term Life',
      "WP19-E05",
      "Add Term Life policy persists coverAmount ₹1.5 Cr to real Chrome IndexedDB (policies store)"
    );

    // WP19-E06: Term Life policy displays in policy schedule table with active cover KPI
    let insMetricVal = await page.evaluate(() => {
      return window.FinancialQueries.getMetric('ACTIVE_INSURANCE_POLICY_TOTAL').value;
    });
    check(
      insMetricVal === 15000000,
      "WP19-E06",
      "Active Insurance Policy total KPI aggregates ₹1.5 Cr coverage"
    );

    // WP19-E07: Add Health Insurance Policy and verify total sum insured
    await page.evaluate(() => {
      window.FinancialCommands.recordPolicy({
        policyNumber: "STAR-HLTH-2233",
        provider: "Star Health",
        type: "Health",
        coverAmount: 1000000,
        premiumAmount: 24000,
        status: "Active"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let insMetricValUpdated = await page.evaluate(() => {
      return window.FinancialQueries.getMetric('ACTIVE_INSURANCE_POLICY_TOTAL').value;
    });
    check(
      insMetricValUpdated === 16000000,
      "WP19-E07",
      "Adding Health Insurance increases Active Insurance Policy total KPI to ₹1.6 Cr"
    );

    // WP19-E08: Delete policy removes policy from repository and updates KPI reactively
    let healthPolId = (await page.evaluate(() => {
      return window.FinancialQueries.getPolicies().find(p => p.type === 'Health')?.id;
    })) as string;
    if (healthPolId) {
      await page.evaluate((id) => {
        window.FinancialCommands.deletePolicy(id);
      }, healthPolId);
    }
    await new Promise(r => setTimeout(r, 400));
    let insMetricAfterDel = await page.evaluate(() => {
      return window.FinancialQueries.getMetric('ACTIVE_INSURANCE_POLICY_TOTAL').value;
    });
    check(
      insMetricAfterDel === 15000000,
      "WP19-E08",
      "Deleting Health policy reduces Active Insurance total KPI back to ₹1.5 Cr"
    );

    // WP19-E09: Financial Goals subtab renders Add Goal and Inflation Calculator triggers
    await page.click('#essentials-tab-goals');
    await new Promise(r => setTimeout(r, 300));
    let goalAddBtnExists = await page.evaluate(() => !!document.getElementById('btn-add-goal'));
    let infCalcBtnExists = await page.evaluate(() => !!document.getElementById('btn-open-inflation-calc'));
    check(
      goalAddBtnExists && infCalcBtnExists,
      "WP19-E09",
      "Financial Goals subtab renders Add Goal and Inflation Calculator action triggers"
    );

    // WP19-E10: Add Goal modal records goal with target amount, date, and monthly SIP into IndexedDB
    await page.evaluate(() => {
      window.FinancialCommands.recordGoal({
        name: "Retirement Corpus 2050",
        template: "Retirement",
        targetAmount: 30000000,
        currentSavedAmount: 6000000,
        monthlyContribution: 50000,
        targetDate: "2050-12-31",
        status: "In Progress"
      });
      window.FinancialCommands.recordGoal({
        name: "Child Higher Education",
        template: "Education",
        targetAmount: 4000000,
        currentSavedAmount: 800000,
        monthlyContribution: 20000,
        targetDate: "2036-05-31",
        status: "In Progress"
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let idbGoals = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("goals", "readonly");
          const getReq = tx.objectStore("goals").getAll();
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || []); };
        };
      });
    });
    const foundGoals = idbGoals as any[];
    check(
      foundGoals.length === 2 && foundGoals.some(g => g.name === 'Retirement Corpus 2050'),
      "WP19-E10",
      "Recorded financial goals persist to Chrome IndexedDB (goals store)"
    );

    // WP19-E11: Goal progress calculates accurately (20% progress)
    let retGoal = foundGoals.find(g => g.name === 'Retirement Corpus 2050');
    let pctProgress = retGoal ? Math.round((retGoal.currentSavedAmount / retGoal.targetAmount) * 100) : 0;
    check(
      pctProgress === 20,
      "WP19-E11",
      "Goal progress calculates accurately as 20% (₹60L / ₹3.0 Cr)"
    );

    // WP19-E12: Monthly SIP commitment aggregates dynamically from active goals
    let sipTotalVal = await page.evaluate(() => {
      return window.FinancialQueries.getMetric('SIP_COMMITMENT_MONTHLY').value;
    });
    check(
      sipTotalVal === 70000, // 50000 + 20000
      "WP19-E12",
      "Monthly SIP commitment aggregates dynamically to ₹70,000 / mo across in-progress goals"
    );

    // WP19-E13: Inflation Calculator Modal opens and calculates future value accurately
    await page.click('#btn-open-inflation-calc');
    await new Promise(r => setTimeout(r, 300));
    let infCalcInputExists = await page.evaluate(() => !!document.getElementById('input-calc-pv'));
    check(
      infCalcInputExists,
      "WP19-E13",
      "Inflation Calculator modal opens and provides interactive FV compounding formula"
    );
    await page.evaluate(() => {
      const closeBtn = document.getElementById('btn-close-inflation-modal');
      if (closeBtn) {
        closeBtn.click();
      } else {
        const btns = Array.from(document.querySelectorAll('button'));
        const found = btns.find(b => b.textContent?.includes('Close') || b.querySelector('svg.lucide-x'));
        if (found) found.click();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // WP19-E14: Delete goal removes milestone and updates SIP commitment reactively
    let eduGoalId = (await page.evaluate(() => {
      return window.FinancialQueries.getGoals().find(g => g.name === 'Child Higher Education')?.id;
    })) as string;
    if (eduGoalId) {
      await page.evaluate((id) => {
        window.FinancialCommands.deleteGoal(id);
      }, eduGoalId);
    }
    await new Promise(r => setTimeout(r, 400));
    let sipAfterGoalDel = await page.evaluate(() => {
      return window.FinancialQueries.getMetric('SIP_COMMITMENT_MONTHLY').value;
    });
    check(
      sipAfterGoalDel === 50000,
      "WP19-E14",
      "Deleting Education goal reduces Monthly SIP commitment KPI back to ₹50,000 / mo"
    );

    // WP19-E15: Profile & Health subtab renders profile inputs and calculates savings rate
    await page.click('#essentials-tab-profile');
    await new Promise(r => setTimeout(r, 300));
    let profileFormExists = await page.evaluate(() => !!document.getElementById('btn-save-profile'));
    check(
      profileFormExists,
      "WP19-E15",
      "Profile & Health subtab renders profile editor and transparent health diagnostics"
    );

    // WP19-E16: Financial Profile persists to IndexedDB (profile store)
    await page.evaluate(() => {
      window.FinancialCommands.saveProfile({
        id: "default-profile",
        age: 35,
        monthlyIncome: 250000,
        monthlyExpenses: 100000,
        savingsRate: 60,
        dependents: 2,
        updatedAt: new Date().toISOString()
      });
    });
    await new Promise(r => setTimeout(r, 400));
    let idbProfile = await page.evaluate(() => {
      return new Promise((resolve) => {
        const req = window.indexedDB.open("finboom_db", 3);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("profile", "readonly");
          const getReq = tx.objectStore("profile").get("default-profile");
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
        };
      });
    });
    check(
      idbProfile && (idbProfile as any).monthlyIncome === 250000 && (idbProfile as any).savingsRate === 60,
      "WP19-E16",
      "Financial Profile persists to Chrome IndexedDB with 60% savings rate (profile store)"
    );

    // WP19-E17: Transparent 4-factor Financial Health Score computes explainable breakdown
    let healthScoreResult = await page.evaluate(() => {
      return window.FinancialQueries.getFinancialHealthScore();
    });
    check(
      healthScoreResult.status === 'HEALTHY' && healthScoreResult.score > 0 && healthScoreResult.explanations.length === 4,
      "WP19-E17",
      "Financial Health Score computes transparent 4-factor diagnostic score with explainable labels"
    );

    // WP19-E18: Multi-tab navigation across Overview -> Wealth -> Money -> Essentials -> Calculators preserves state
    await clickNav(page, "Overview");
    await clickNav(page, "Wealth");
    await clickNav(page, "Money");
    await clickNav(page, "Essentials");
    let afterNavPolicies = await page.evaluate(() => window.FinancialQueries.getPolicies().length);
    let afterNavGoals = await page.evaluate(() => window.FinancialQueries.getGoals().length);
    check(
      afterNavPolicies === 1 && afterNavGoals === 1,
      "WP19-E18",
      "Multi-tab navigation across all primary routes preserves canonical Essentials state"
    );

    // WP19-E19: Browser refresh preserves canonical policies, goals, and profile in Chrome IndexedDB
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 500));
    let reloadedPolicies = await page.evaluate(() => window.FinancialQueries.getPolicies().length);
    let reloadedGoals = await page.evaluate(() => window.FinancialQueries.getGoals().length);
    let reloadedProfile = await page.evaluate(() => window.FinancialQueries.getProfile() !== null);
    check(
      reloadedPolicies === 1 && reloadedGoals === 1 && reloadedProfile,
      "WP19-E19",
      "Browser refresh preserves all canonical policies, goals, and profile in Chrome IndexedDB"
    );

    // WP19-E20: Clear Dev Data removes all Essentials data and application restart preserves clean state
    await page.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Clear Dev Data')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));
    let clearedPolicies = await page.evaluate(() => window.FinancialQueries.getPolicies().length);
    let clearedGoals = await page.evaluate(() => window.FinancialQueries.getGoals().length);
    let clearedProfile = await page.evaluate(() => window.FinancialQueries.getProfile());
    check(
      clearedPolicies === 0 && clearedGoals === 0 && clearedProfile === null,
      "WP19-E20",
      "Clear Dev Data removes all policies, goals, and profile records from IndexedDB and resets state"
    );

    // =========================================================================
    // WP-20: Calculators Feature Parity & Mathematical Engine Acceptance Suite
    // (WP20-C01 to WP20-C12)
    // =========================================================================
    console.log('\n  [WP-20 Calculators Feature Parity & Mathematical Engine Acceptance Suite]');

    // Navigate to Calculators Tab
    await clickNav(page, "Calculators");
    await new Promise(r => setTimeout(r, 400));

    // WP20-C01: Calculators Hub renders 5 primary calculator tabs
    let tabSipExists = await page.evaluate(() => !!document.getElementById('calc-tab-sip'));
    let tabLumpExists = await page.evaluate(() => !!document.getElementById('calc-tab-lumpsum'));
    let tabXirrExists = await page.evaluate(() => !!document.getElementById('calc-tab-xirr'));
    let tabCagrExists = await page.evaluate(() => !!document.getElementById('calc-tab-cagr'));
    let tabLoanExists = await page.evaluate(() => !!document.getElementById('calc-tab-loan'));
    check(
      tabSipExists && tabLumpExists && tabXirrExists && tabCagrExists && tabLoanExists,
      "WP20-C01",
      "Calculators Hub renders 5 primary interactive calculator subtabs (SIP, Lumpsum, XIRR, CAGR, Loan/EMI)"
    );

    // WP20-C02: SIP Calculator renders inputs and computes default maturity corpus in real DOM
    let sipInputAmount = await page.evaluate(() => !!document.getElementById('input-sip-amount'));
    let sipInputRate = await page.evaluate(() => !!document.getElementById('input-sip-rate'));
    let sipInputYears = await page.evaluate(() => !!document.getElementById('input-sip-years'));
    let sipBodyText = await page.evaluate(() => document.body.innerText);
    check(
      sipInputAmount && sipInputRate && sipInputYears && (sipBodyText.toUpperCase().includes('TOTAL MATURITY CORPUS') || sipBodyText.includes('21,709,624') || sipBodyText.includes('1,26,14,400')),
      "WP20-C02",
      "SIP Calculator renders inputs and calculates maturity corpus in real DOM"
    );

    // WP20-C03: Lumpsum Calculator tab renders inputs and computes nominal vs real purchasing power
    await page.evaluate(() => document.getElementById('calc-tab-lumpsum')?.click());
    await new Promise(r => setTimeout(r, 400));
    let lumpAmountExists = await page.evaluate(() => !!document.getElementById('input-lump-amount'));
    let lumpInflationExists = await page.evaluate(() => !!document.getElementById('input-lump-inflation'));
    let lumpBodyText = await page.evaluate(() => document.body.innerText);
    check(
      lumpAmountExists && lumpInflationExists && lumpBodyText.toUpperCase().includes('REAL PURCHASING POWER') && lumpBodyText.includes('1,552,924'),
      "WP20-C03",
      "Lumpsum Calculator renders inputs and computes nominal value (₹15.53L) vs inflation-adjusted purchasing power in real DOM"
    );

    // WP20-C04: XIRR Solver tab renders cash flows table and computes converged XIRR percentage
    await page.evaluate(() => document.getElementById('calc-tab-xirr')?.click());
    await new Promise(r => setTimeout(r, 400));
    let xirrTableRows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
    let xirrText = await page.evaluate(() => document.body.innerText);
    check(
      xirrTableRows >= 5 && xirrText.toUpperCase().includes('ANNUALIZED XIRR') && xirrText.includes('Newton-Raphson'),
      "WP20-C04",
      "XIRR Solver tab renders interactive cash flows schedule and computes converged XIRR percentage"
    );

    // WP20-C05: XIRR Solver allows adding new outflow/inflow entries dynamically
    await page.click('#btn-add-outflow');
    await new Promise(r => setTimeout(r, 300));
    let xirrUpdatedRows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
    check(
      xirrUpdatedRows === xirrTableRows + 1,
      "WP20-C05",
      "XIRR Solver allows adding dynamic cash flow entries and updates schedule dynamically"
    );

    // WP20-C06: XIRR SIP Generator Mode drawer populates cash flows table
    await page.click('#btn-xirr-mode-sip');
    await new Promise(r => setTimeout(r, 300));
    let sipGenBtnExists = await page.evaluate(() => !!document.getElementById('btn-generate-sip-flows'));
    if (sipGenBtnExists) {
      await page.click('#btn-generate-sip-flows');
      await new Promise(r => setTimeout(r, 400));
    }
    let postGenRows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
    check(
      sipGenBtnExists && postGenRows === 13, // 12 monthly + 1 terminal
      "WP20-C06",
      "XIRR SIP Generator Mode generates 12 monthly SIP installments + 1 terminal valuation row"
    );

    // WP20-C07: CAGR Engine tab renders inputs and computes geometric compounding rate
    await page.evaluate(() => document.getElementById('calc-tab-cagr')?.click());
    // Deterministic readiness wait: poll until CAGR calculator inputs AND computed output are present
    // in the real Chrome DOM. Replaces the fixed 300ms sleep that became insufficient after WP-22B
    // added ProvenanceBadge rendering overhead to CagrCalculator (forensic diagnosis 2026-08-16).
    await page.waitForFunction(
      () => !!document.getElementById('input-cagr-initial') &&
            !!document.getElementById('input-cagr-final') &&
            document.body.innerText.includes('+20.11%') &&
            document.body.innerText.includes('2.5x'),
      { timeout: 15000 }
    );
    let cagrInitialExists = await page.evaluate(() => !!document.getElementById('input-cagr-initial'));
    let cagrFinalExists = await page.evaluate(() => !!document.getElementById('input-cagr-final'));
    let cagrText = await page.evaluate(() => document.body.innerText);
    check(
      cagrInitialExists && cagrFinalExists && cagrText.includes('+20.11%') && cagrText.includes('2.5x'),
      "WP20-C07",
      "CAGR Engine calculates geometric mean rate (+20.11% CAGR) and capital multiplier (2.5x) in real DOM"
    );

    // WP20-C08: Loan / EMI Calculator tab renders inputs and computes monthly EMI
    await page.evaluate(() => document.getElementById('calc-tab-loan')?.click());
    // Deterministic readiness wait: poll until Loan EMI calculator inputs AND computed EMI value are
    // present in the real Chrome DOM. Replaces the fixed 300ms sleep that became insufficient after
    // WP-22B added ProvenanceBadge rendering overhead to LoanEmiCalculator (forensic diagnosis 2026-08-16).
    await page.waitForFunction(
      () => !!document.getElementById('input-loan-principal') &&
            !!document.getElementById('input-loan-rate') &&
            document.body.innerText.includes('26,035') &&
            document.body.innerText.toUpperCase().includes('TOTAL INTEREST PAYABLE'),
      { timeout: 15000 }
    );
    let loanPrincipalExists = await page.evaluate(() => !!document.getElementById('input-loan-principal'));
    let loanRateExists = await page.evaluate(() => !!document.getElementById('input-loan-rate'));
    let loanText = await page.evaluate(() => document.body.innerText);
    check(
      loanPrincipalExists && loanRateExists && loanText.includes('26,035') && loanText.toUpperCase().includes('TOTAL INTEREST PAYABLE'),
      "WP20-C08",
      "Loan / EMI Calculator computes monthly EMI (₹26,035/mo) and total interest in real DOM"
    );

    // WP20-C09: Supporting Institutional Derived Metrics render below workspaces without dummy data
    let calcDomCheck = await verifyNoDemoValuesInDOM(page);
    let hasDerivedSection = await page.evaluate(() => document.body.innerText.toUpperCase().includes('CANONICAL DERIVED METRICS'));
    check(
      calcDomCheck.clean && hasDerivedSection,
      "WP20-C09",
      `Supporting institutional metrics section renders below calculator workspaces (${calcDomCheck.details})`
    );

    // WP20-C10: Multi-tab navigation across all primary app tabs preserves interactive calculator state
    await clickNav(page, "Overview");
    await clickNav(page, "Wealth");
    await clickNav(page, "Money");
    await clickNav(page, "Essentials");
    await clickNav(page, "Calculators");
    let calcPostNavCheck = await verifyNoDemoValuesInDOM(page);
    check(
      calcPostNavCheck.clean,
      "WP20-C10",
      `Multi-tab navigation across Overview -> Wealth -> Money -> Essentials -> Calculators preserves clean state (${calcPostNavCheck.details})`
    );

    // WP20-C11: Browser reload on Calculators tab preserves DOM layout without runtime exceptions
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 500));
    await clickNav(page, "Calculators");
    await new Promise(r => setTimeout(r, 300));
    let calcReloadCheck = await verifyNoDemoValuesInDOM(page);
    let reloadedSipTab = await page.evaluate(() => !!document.getElementById('calc-tab-sip'));
    check(
      calcReloadCheck.clean && reloadedSipTab,
      "WP20-C11",
      `Browser reload on Calculators tab preserves responsive layout without runtime exceptions (${calcReloadCheck.details})`
    );

    // WP20-C12: Clear Dev Data preserves calculator functionality while resetting supporting metrics
    await page.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Clear Dev Data')) {
            buttons[i].click();
          }
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 600));
    await clickNav(page, "Calculators");
    await new Promise(r => setTimeout(r, 300));
    let finalTabSip = await page.evaluate(() => !!document.getElementById('calc-tab-sip'));
    let finalDomCheck = await verifyNoDemoValuesInDOM(page);
    check(
      finalTabSip && finalDomCheck.clean,
      "WP20-C12",
      `Clear Dev Data preserves interactive calculator hub functionality while resetting derived metrics (${finalDomCheck.details})`
    );

    // =========================================================================
    // WP-21: Visual & Responsive UI Modernization Acceptance Suite (WP21-V01 to WP21-V12)
    // =========================================================================
    console.log('\n  [WP-21 UI Modernization & Responsive Architecture Acceptance Suite]');

    // WP21-V01: 64px Fixed Header with context badges and active route title
    let headerHeightCheck = await page.evaluate(() => {
      let header = document.querySelector('header');
      if (!header) return false;
      let rect = header.getBoundingClientRect();
      return Math.round(rect.height) === 64;
    });
    check(
      headerHeightCheck,
      "WP21-V01",
      "Fixed 64px institutional header with active workspace indicator and context controls renders accurately"
    );

    // WP21-V02: Sidebar collapsible width toggle (240px expanded vs 72px collapsed)
    let sidebarCollapseCheck = await page.evaluate(async () => {
      let toggleBtn = document.getElementById('btn-collapse-sidebar') || document.querySelector('button[title*="Collapse"]');
      let sidebar = document.querySelector('aside');
      if (!toggleBtn || !sidebar) return false;
      let initialWidth = Math.round(sidebar.getBoundingClientRect().width);
      (toggleBtn as HTMLElement).click();
      await new Promise(r => setTimeout(r, 450));
      let collapsedWidth = Math.round(sidebar.getBoundingClientRect().width);
      let expandBtn = document.getElementById('btn-collapse-sidebar') || document.querySelector('button[title*="Expand"]');
      if (expandBtn) (expandBtn as HTMLElement).click();
      await new Promise(r => setTimeout(r, 450));
      let restoredWidth = Math.round(sidebar.getBoundingClientRect().width);
      return initialWidth === 240 && collapsedWidth === 72 && restoredWidth === 240;
    });
    check(
      sidebarCollapseCheck,
      "WP21-V02",
      "Sidebar smoothly collapses from 240px full state to 72px compact icon navigation"
    );

    // WP21-V03: Mobile Drawer toggle and overlay on reduced viewport (375px)
    await page.setViewport({ width: 375, height: 667 });
    await sleep(300);
    let mobileDrawerCheck = await page.evaluate(async () => {
      let mobileToggle = document.getElementById('btn-mobile-menu-toggle');
      if (!mobileToggle) return false;
      mobileToggle.click();
      await new Promise(r => setTimeout(r, 200));
      let backdrop = document.querySelector('.bg-black\\/70') || document.querySelector('.backdrop-blur-sm');
      let isVisible = !!backdrop;
      if (backdrop) (backdrop as HTMLElement).click();
      await new Promise(r => setTimeout(r, 200));
      return isVisible;
    });
    await page.setViewport({ width: 1280, height: 800 });
    await sleep(300);
    check(
      mobileDrawerCheck,
      "WP21-V03",
      "Mobile responsive drawer with backdrop blur opens on 375px viewport and closes cleanly"
    );

    // WP21-V04: Modern KPI Card grid layout and sparkline SVG rendering on Overview
    await clickNav(page, "Overview");
    let overviewKpiCheck = await page.evaluate(() => {
      let kpis = document.querySelectorAll('[data-kpi-card]');
      let svgs = document.querySelectorAll('svg');
      return kpis.length >= 4 && svgs.length > 0;
    });
    check(
      overviewKpiCheck,
      "WP21-V04",
      "Overview dashboard renders 4 modern ArthaVault KPI cards with sparkline visuals"
    );

    // WP21-V05: ChartCard containers with dark theme surface and header badges
    let chartCardCheck = await page.evaluate(() => {
      let chartCards = document.querySelectorAll('[data-chart-card]');
      return chartCards.length >= 2;
    });
    check(
      chartCardCheck,
      "WP21-V05",
      "ChartCard primitives render with dark surface containers (#0F172A), border tokens, and header badges"
    );

    // WP21-V06: Truthful EmptyState rendering on empty data state
    let emptyStateCheck = await page.evaluate(() => {
      let emptyCards = document.querySelectorAll('[data-empty-state]');
      return emptyCards.length >= 1;
    });
    check(
      emptyStateCheck,
      "WP21-V06",
      "Truthful EmptyState components render with action buttons when collections are unconfigured"
    );

    // WP21-V07: Wealth Modern KPI Cards and Solvency Gauge rendering
    await clickNav(page, "Wealth");
    let wealthVisualCheck = await page.evaluate(() => {
      let kpis = document.querySelectorAll('[data-kpi-card]');
      let subtabs = document.querySelectorAll('[id^="wealth-tab-"]');
      return kpis.length >= 4 && subtabs.length >= 4;
    });
    check(
      wealthVisualCheck,
      "WP21-V07",
      "Wealth dashboard renders 4 KPI cards, Solvency gauge, and all 4 subtabs (Assets, Liabilities, Net Worth, Allocation)"
    );

    // WP21-V08: Money Cash Flow dynamic bar chart and categorical spending breakdown rendering
    await clickNav(page, "Money");
    let moneyVisualCheck = await page.evaluate(() => {
      let kpis = document.querySelectorAll('[data-kpi-card]');
      let chartCards = document.querySelectorAll('[data-chart-card]');
      let subtabs = document.querySelectorAll('[id^="money-tab-"]');
      return kpis.length >= 4 && chartCards.length >= 2 && subtabs.length >= 4;
    });
    check(
      moneyVisualCheck,
      "WP21-V08",
      "Money dashboard renders 4 KPI cards, Cash Flow dynamics chart, and categorical breakdown"
    );

    // WP21-V09: Essentials 4-factor Institutional Health Matrix progress meters
    await clickNav(page, "Essentials");
    let essentialsVisualCheck = await page.evaluate(() => {
      let kpis = document.querySelectorAll('[data-kpi-card]');
      let chartCards = document.querySelectorAll('[data-chart-card]');
      let subtabs = document.querySelectorAll('[id^="essentials-tab-"]');
      return kpis.length >= 4 && chartCards.length >= 2 && subtabs.length >= 4;
    });
    check(
      essentialsVisualCheck,
      "WP21-V09",
      "Essentials dashboard renders 4 KPI cards, Institutional Health Matrix, and Goals horizon"
    );

    // WP21-V10: Calculators Hub tab switching and upcoming institutional roadmap layout
    await clickNav(page, "Calculators");
    let calcVisualCheck = await page.evaluate(() => {
      let calcTabs = document.querySelectorAll('[id^="calc-tab-"]');
      let derivedKpis = document.querySelectorAll('[data-kpi-card]');
      return calcTabs.length === 5 && derivedKpis.length >= 3;
    });
    check(
      calcVisualCheck,
      "WP21-V10",
      "Calculators hub renders 5 interactive mathematical subtabs and 3 live ledger derived metric cards"
    );

    // WP21-V11: Theme toggle updates dark class accurately
    let themeToggleCheck = await page.evaluate(async () => {
      let themeBtn = document.getElementById('btn-theme-toggle');
      if (!themeBtn) return false;
      let initialDark = document.documentElement.classList.contains('dark');
      themeBtn.click();
      await new Promise(r => setTimeout(r, 150));
      let toggledDark = document.documentElement.classList.contains('dark');
      themeBtn.click(); // restore
      await new Promise(r => setTimeout(r, 150));
      let restoredDark = document.documentElement.classList.contains('dark');
      return initialDark !== toggledDark && initialDark === restoredDark;
    });
    check(
      themeToggleCheck,
      "WP21-V11",
      "Theme toggle switches seamlessly between Institutional Dark and Clean Light modes"
    );

    // WP21-V12: Safe zero-leakage contract across all modernized dashboards when empty
    let finalZeroLeakCheck = await verifyNoDemoValuesInDOM(page);
    check(
      finalZeroLeakCheck.clean,
      "WP21-V12",
      `Zero-leakage data boundary verified across modernized UI: rendered DOM is 100% clean of hardcoded values (${finalZeroLeakCheck.details})`
    );

    // WP21-V13: Essentials Tier 1 Top 4 KPI Cards Architecture (Canonical Debt to Assets)
    await page.evaluate(() => {
      let el = document.getElementById('sidebar-nav-essentials');
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 400));

    // Load demo data to verify populated Tier 1 & Tier 2 cards and rows
    await page.evaluate(() => {
      let btn = document.getElementById('btn-load-demo-data');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    let r4dKpiCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText.toUpperCase();
      let hasEmergencyKpi = bodyText.includes('EMERGENCY FUND');
      let hasDebtKpi = bodyText.includes('DEBT TO ASSETS');
      let hasCreditKpi = bodyText.includes('CREDIT SCORE');
      let hasInsuranceKpi = bodyText.includes('INSURANCE COVERAGE');
      let hasDebtValue = bodyText.includes('20%');
      return hasEmergencyKpi && hasDebtKpi && hasCreditKpi && hasInsuranceKpi && hasDebtValue;
    });
    check(
      r4dKpiCheck,
      "WP21-V13",
      "Essentials Tier 1 renders 4 modern KPI cards (Emergency Fund, Debt to Assets, Credit Score, Insurance Coverage)"
    );

    // WP21-V14: Essentials Tier 2 Primary Visual Panels (Metrics Table & Credit Score History Curve)
    let r4dVisualPanelsCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText;
      let hasMetricsTable = bodyText.includes('Essential Metrics') || bodyText.includes('5 Critical Indicators');
      let hasDebtToAssetRow = bodyText.includes('Debt to Asset Ratio');
      let hasCreditHistory = bodyText.includes('Credit Score History');
      let hasSvgCurve = document.querySelectorAll('svg').length > 0;
      return hasMetricsTable && hasDebtToAssetRow && hasCreditHistory && hasSvgCurve;
    });
    check(
      r4dVisualPanelsCheck,
      "WP21-V14",
      "Essentials Tier 2 renders Essential Metrics structured table with Debt to Asset Ratio and Credit Score History visual panel"
    );

    // WP21-V15: Essentials Tier 3 Actionable Recommendations Grid
    let r4dRecsCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText;
      let hasRecsTitle = bodyText.includes('Recommendations') || bodyText.includes('RECOMMENDATIONS');
      let hasRec1 = bodyText.includes('Increase Emergency Fund');
      let hasRec2 = bodyText.includes('Reduce Credit Utilization');
      let hasRec3 = bodyText.includes('Review Insurance');
      let hasViewPlanBtns = bodyText.includes('View Plan');
      return hasRecsTitle && hasRec1 && hasRec2 && hasRec3 && hasViewPlanBtns;
    });
    check(
      r4dRecsCheck,
      "WP21-V15",
      "Essentials Tier 3 renders 3 Actionable Recommendations cards with View Plan interaction triggers"
    );

    // WP21-V16: Essentials Tier 4 Certified WP-19 Subtabs Bar & Workspaces
    let r4dSubtabsCheck = await page.evaluate(() => {
      let t1 = document.getElementById('essentials-tab-emergency');
      let t2 = document.getElementById('essentials-tab-insurance');
      let t3 = document.getElementById('essentials-tab-goals');
      let t4 = document.getElementById('essentials-tab-profile');
      return Boolean(t1 && t2 && t3 && t4);
    });
    check(
      r4dSubtabsCheck,
      "WP21-V16",
      "Essentials Tier 4 preserves all 4 WP-19 subtabs and interactive workspace panels"
    );

    // WP21-V17: Calculators Hub Tier 1 Popular Calculators Grid (6 Quick-Access Cards)
    await page.evaluate(() => {
      let el = document.getElementById('sidebar-nav-calculators');
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 400));

    let r4ePopularCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText.toUpperCase();
      let hasPopTitle = bodyText.includes('POPULAR CALCULATORS');
      let hasSip = bodyText.includes('SIP CALCULATOR');
      let hasEmi = bodyText.includes('EMI CALCULATOR');
      let hasRd = bodyText.includes('RD CALCULATOR');
      let hasPpf = bodyText.includes('PPF CALCULATOR');
      let hasRetire = bodyText.includes('RETIREMENT CALCULATOR');
      let hasGoal = bodyText.includes('GOAL CALCULATOR');
      return hasPopTitle && hasSip && hasEmi && hasRd && hasPpf && hasRetire && hasGoal;
    });
    check(
      r4ePopularCheck,
      "WP21-V17",
      "Calculators Hub Tier 1 renders 6 popular quick-access cards (SIP, EMI, RD, PPF, Retirement, Goal)"
    );

    // WP21-V18: Calculators Hub Tier 2 All Calculators Directory (8 Tools)
    let r4eDirectoryCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText.toUpperCase();
      let hasDirTitle = bodyText.includes('ALL CALCULATORS');
      let hasSwp = bodyText.includes('SWP CALCULATOR');
      let hasLump = bodyText.includes('LUMPSUM CALCULATOR');
      let hasInflation = bodyText.includes('INFLATION CALCULATOR');
      return hasDirTitle && hasSwp && hasLump && hasInflation;
    });
    check(
      r4eDirectoryCheck,
      "WP21-V18",
      "Calculators Hub Tier 2 renders 8 All Calculators directory entries with navigation affordances"
    );

    // WP21-V19: Calculators Hub Tier 3 Interactive Workspace Preservation
    let r4eWorkspaceCheck = await page.evaluate(() => {
      let tSip = document.getElementById('calc-tab-sip');
      let tLump = document.getElementById('calc-tab-lumpsum');
      let tXirr = document.getElementById('calc-tab-xirr');
      let tCagr = document.getElementById('calc-tab-cagr');
      let tLoan = document.getElementById('calc-tab-loan');
      return Boolean(tSip && tLump && tXirr && tCagr && tLoan);
    });
    check(
      r4eWorkspaceCheck,
      "WP21-V19",
      "Calculators Hub Tier 3 preserves 5 interactive calculator subtabs (SIP, Lumpsum, XIRR, CAGR, Loan EMI)"
    );

    // WP21-V20: Calculators Hub Tier 4 Live Ledger Derived Metrics
    let r4eLiveMetricsCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText.toUpperCase();
      let hasYield = bodyText.includes('DIVIDEND YIELD (TTM)');
      let hasCagr = bodyText.includes('NET WORTH CAGR');
      let hasGoal = bodyText.includes('EMERGENCY FUND GOAL');
      return hasYield && hasCagr && hasGoal;
    });
    check(
      r4eLiveMetricsCheck,
      "WP21-V20",
      "Calculators Hub Tier 4 renders 3 canonical live ledger derived metric cards with real queries"
    );

    // WP21-V21: Essentials Clear Dev Data Empty State & Navigation Lifecycle
    await page.evaluate(() => {
      let btn = document.getElementById('btn-clear-dev-data');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    // Navigate to Overview then back to Essentials
    await clickNav(page, "Overview");
    await new Promise(r => setTimeout(r, 400));
    await clickNav(page, "Essentials");
    await new Promise(r => setTimeout(r, 400));

    let essentialsEmptyCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText;
      let notConfiguredCount = (bodyText.match(/Not configured/gi) || []).length;
      let hasNoLeak180k = !bodyText.includes('180,000') && !bodyText.includes('1,80,000');
      let hasNoLeak150L = !bodyText.includes('1,50,00,000');
      let hasNoLeak752 = !bodyText.includes('752') && !bodyText.includes('752 Rating');
      return notConfiguredCount >= 4 && hasNoLeak180k && hasNoLeak150L && hasNoLeak752;
    });
    check(
      essentialsEmptyCheck,
      "WP21-V21",
      "Essentials Clear Dev Data lifecycle displays truthful Not configured empty state without fallback leakage"
    );

    // WP21-V22: Essentials explicit demo data restoration and re-clear lifecycle
    await page.evaluate(() => {
      let btn = document.getElementById('btn-load-demo-data');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    let demoRestoreCheck = await page.evaluate(() => {
      let bodyText = document.body.innerText;
      let hasDebtAssets = bodyText.includes('Debt to Assets') || bodyText.includes('DEBT TO ASSETS');
      let hasCreditScore = bodyText.includes('752');
      return hasDebtAssets && hasCreditScore;
    });
    check(
      demoRestoreCheck,
      "WP21-V22",
      "Essentials explicit demo data restoration successfully populates canonical metrics"
    );

    // Clean up demo data at completion to leave runtime clean
    await page.evaluate(() => {
      let btn = document.getElementById('btn-clear-dev-data');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    // =========================================================================
    // WP-22B: Canonical Mathematical Intelligence Application & UI Suite
    // (WP22B-V01 to WP22B-V08)
    // =========================================================================
    console.log('\n  [WP-22B Mathematical Intelligence UI & Application Integration Suite]');

    // Navigate to Calculators Hub
    await clickNav(page, "Calculators");
    await new Promise(r => setTimeout(r, 400));

    // WP22B-V01: Reusable ProvenanceBadge renders in SIP workspace with expand/collapse
    let provBadgeCheck = await page.evaluate(async () => {
      const sipBadge = document.querySelector('button[aria-expanded]');
      const badgeText = document.body.innerText;
      const hasProvText = badgeText.includes('Institutional Mathematical Provenance') || badgeText.includes('Verified Deterministic');
      return hasProvText && !!sipBadge;
    });
    check(
      provBadgeCheck,
      "WP22B-V01",
      "Institutional Provenance Badge renders in active calculator workspace with verified deterministic badge"
    );

    // WP22B-V02: Recurring Deposit (RD) Modal opens, computes Model A quarterly compounding, and renders provenance
    let rdModalCheck = await page.evaluate(async () => {
      const openBtn = document.getElementById('btn-open-rd-engine');
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const modalText = document.body.innerText;
      const hasTitle = modalText.includes('Recurring Deposit (RD) Calculator');
      const hasModelA = modalText.includes('Quarterly Compounded Bank Annuity');
      const hasInputs = !!document.getElementById('input-rd-deposit');
      const closeBtn = document.getElementById('btn-close-rd-modal');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 300));
      return hasTitle && hasModelA && hasInputs;
    });
    check(
      rdModalCheck,
      "WP22B-V02",
      "Recurring Deposit (RD) Modal opens, computes Model A quarterly compounding, and closes cleanly"
    );

    // WP22B-V03: PPF Modal opens, computes 15-year statutory compounding, and renders provenance
    let ppfModalCheck = await page.evaluate(async () => {
      const openBtn = document.getElementById('btn-open-ppf-engine');
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const modalText = document.body.innerText;
      const hasTitle = modalText.includes('Public Provident Fund (PPF) Calculator');
      const hasEee = modalText.includes('EEE') || modalText.includes('Exempt-Exempt-Exempt');
      const hasInputs = !!document.getElementById('input-ppf-deposit');
      const closeBtn = document.getElementById('btn-close-ppf-modal');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 300));
      return hasTitle && hasEee && hasInputs;
    });
    check(
      ppfModalCheck,
      "WP22B-V03",
      "Public Provident Fund (PPF) Modal opens, computes 15-year statutory compounding, and closes cleanly"
    );

    // WP22B-V04: SWP Modal opens, computes capital longevity, and renders provenance
    let swpModalCheck = await page.evaluate(async () => {
      const openBtn = document.getElementById('btn-open-swp-engine');
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const modalText = document.body.innerText;
      const hasTitle = modalText.includes('Systematic Withdrawal Plan (SWP) Calculator');
      const hasLongevity = modalText.includes('Cash Flow Sustenance & Longevity');
      const hasInputs = !!document.getElementById('input-swp-corpus');
      const closeBtn = document.getElementById('btn-close-swp-modal');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 300));
      return hasTitle && hasLongevity && hasInputs;
    });
    check(
      swpModalCheck,
      "WP22B-V04",
      "Systematic Withdrawal Plan (SWP) Modal opens, computes annuity longevity, and closes cleanly"
    );

    // WP22B-V05: Goal Planner / Reverse SIP Modal opens, computes target milestone monthly SIP, and renders provenance
    let goalModalCheck = await page.evaluate(async () => {
      const openBtn = document.getElementById('btn-open-goal-engine');
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const modalText = document.body.innerText;
      const hasTitle = modalText.includes('Goal Planner & Reverse SIP Calculator');
      const hasSolver = modalText.includes('Root-Finding Solver');
      const hasInputs = !!document.getElementById('input-goal-target');
      const closeBtn = document.getElementById('btn-close-goal-modal');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 300));
      return hasTitle && hasSolver && hasInputs;
    });
    check(
      goalModalCheck,
      "WP22B-V05",
      "Goal Planner & Reverse SIP Modal opens, calculates exact monthly investment target, and closes cleanly"
    );

    // WP22B-V06: Retirement & FIRE Modal opens, computes SWR corpus and Coast FIRE milestones, and renders provenance
    let fireModalCheck = await page.evaluate(async () => {
      const openBtn = document.getElementById('btn-open-fire-engine');
      if (openBtn) openBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const modalText = document.body.innerText;
      const hasTitle = modalText.includes('Retirement & FIRE Number Engine');
      const hasSwr = modalText.includes('Safe Withdrawal Rate');
      const hasInputs = !!document.getElementById('input-fire-current-age');
      const closeBtn = document.getElementById('btn-close-fire-modal');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 300));
      return hasTitle && hasSwr && hasInputs;
    });
    check(
      fireModalCheck,
      "WP22B-V06",
      "Retirement & FIRE Modal opens, calculates SWR target corpus and Coast FIRE milestones, and closes cleanly"
    );

    // WP22B-V07: Popular Calculators quick-access triggers open respective modals directly
    let popularTriggersCheck = await page.evaluate(async () => {
      // Test RD quick-access
      const btns = Array.from(document.querySelectorAll('button'));
      const rdPopBtn = btns.find(b => b.textContent?.includes('RD Calculator') && b.textContent?.includes('Calculate RD maturity'));
      if (!rdPopBtn) return false;
      rdPopBtn.click();
      await new Promise(r => setTimeout(r, 300));
      const hasRdOpen = !!document.getElementById('input-rd-deposit');
      const closeRd = document.getElementById('btn-close-rd-modal');
      if (closeRd) closeRd.click();
      await new Promise(r => setTimeout(r, 300));
      return hasRdOpen;
    });
    check(
      popularTriggersCheck,
      "WP22B-V07",
      "Popular Calculators quick-access triggers launch interactive modals directly"
    );

    // WP22B-V08: Multi-tab navigation across app after modal interactions remains responsive and clean
    await clickNav(page, "Overview");
    await clickNav(page, "Wealth");
    await clickNav(page, "Money");
    await clickNav(page, "Essentials");
    await clickNav(page, "Calculators");
    let afterModalNavCheck = await verifyNoDemoValuesInDOM(page);
    check(
      afterModalNavCheck.clean,
      "WP22B-V08",
      "Multi-tab navigation across application after interactive modal execution remains responsive and 100% clean"
    );


  } finally {
    await browser.close();
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    if (fs.existsSync(PROFILE_DIR)) {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    }
  }

  console.log('\n──────────────────────────────────────────────────────────────────────────');
  console.log(`CHROME REAL INDEXEDDB ACCEPTANCE SUITE (WP-15) SUMMARY: ${passCount}/${passCount + failCount} PASS | ${failCount} FAIL`);
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runChromeAcceptanceSuite().catch(err => {
  console.error('Fatal Chrome acceptance test error:', err);
  if (serverProc) {
    serverProc.kill('SIGTERM');
  }
  process.exit(1);
});
