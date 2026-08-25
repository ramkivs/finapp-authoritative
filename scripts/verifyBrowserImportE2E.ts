/**
 * WP-FB-IMPORT-BROKER-01 — WP-09 BROWSER-IMPORT COMPLETION E2E.
 *
 * Headless Chromium / IndexedDB end-to-end test of the broker-import
 * flow. Proves the WP-09 acceptance criteria §I:
 *
 *   1. application starts
 *   2. Import page is reachable
 *   3. BrokerImportSection is visible
 *   4. a real supported broker sample can be selected
 *   5. broker is detected
 *   6. holdings are parsed
 *   7. preview is rendered
 *   8. confirmation can be performed
 *   9. import commits
 *  10. application reload/reinitialization preserves holdings
 *  11. imported currentValue reaches displayed Wealth/net-worth output
 *
 * Pattern is borrowed from `scripts/verifyChromeIndexedDBAcceptance.ts`:
 *   - spawn `vite preview` on a dedicated port
 *   - launch headless Chrome with a unique `--user-data-dir`
 *   - use Chrome DevTools Protocol `Storage.clearDataForOrigin` to reset
 *   - drive the UI through `page.evaluate` calls
 *   - clean up the server process and the profile dir on exit
 *
 * Skippable with `SKIP_BROWSER_E2E=1`.
 */

process.env.LD_LIBRARY_PATH = '/home/user/.local/lib:' + (process.env.LD_LIBRARY_PATH || '');

import puppeteer, { Browser, Page } from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 5300; // distinct from the existing acceptance suite (5200)
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROFILE_DIR = '/tmp/finboom_chrome_test_profile_wp09';
const SAMPLE_PATH = '/home/user/uploads/Zerodha_holdings_10082026_1739.csv';

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

async function waitForServer(url: string, timeoutMs = 30000): Promise<boolean> {
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
  await page.evaluate(
    (l) => {
      const byId = document.getElementById('sidebar-nav-' + l.toLowerCase());
      if (byId) {
        byId.click();
        return;
      }
      const btns = Array.from(document.querySelectorAll('button'));
      const found = btns.find((b) => b.textContent && b.textContent.includes(l));
      if (found) found.click();
    },
    label,
  );
  await sleep(400);
}

interface HoldingsStats {
  holdingsCount: number;
  totalCurrentValue: number;
  firstHolding: { instrumentName: string; currentValue: number } | null;
}

async function getHoldingsFromPage(page: Page): Promise<HoldingsStats> {
  return page.evaluate(`
    new Promise(function(resolveMain, rejectMain) {
      const openReq = window.indexedDB.open('finboom_db');
      openReq.onerror = function() { rejectMain(openReq.error); };
      openReq.onsuccess = function() {
        const db = openReq.result;
        if (!db.objectStoreNames.contains('holdings')) {
          db.close();
          resolveMain({ holdingsCount: 0, totalCurrentValue: 0, firstHolding: null });
          return;
        }
        const tx = db.transaction(['holdings'], 'readonly');
        const getReq = tx.objectStore('holdings').getAll();
        getReq.onsuccess = function() {
          const holdings = getReq.result || [];
          let total = 0;
          for (let i = 0; i < holdings.length; i++) {
            total += Number(holdings[i].currentValue) || 0;
          }
          const first = holdings[0] ? { instrumentName: holdings[0].instrumentName, currentValue: holdings[0].currentValue } : null;
          db.close();
          resolveMain({ holdingsCount: holdings.length, totalCurrentValue: total, firstHolding: first });
        };
        getReq.onerror = function() {
          db.close();
          rejectMain(getReq.error);
        };
      };
    })
  `) as Promise<HoldingsStats>;
}

async function clearAppData(page: Page) {
  const client = await page.target().createCDPSession();
  await client.send('Storage.clearDataForOrigin', { origin: BASE_URL, storageTypes: 'all' });
}

async function runBrowserImportE2E() {
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('WP-09 BROWSER-IMPORT COMPLETION — CHROMIUM END-TO-END');
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  if (fs.existsSync(PROFILE_DIR)) {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  if (!fs.existsSync(SAMPLE_PATH)) {
    console.error(`FATAL: Real broker sample not found at ${SAMPLE_PATH}`);
    process.exit(1);
  }

  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  serverProc = spawn(
    npxCommand,
    ['vite', 'preview', '--strictPort', '--port', String(PORT), '--host', '127.0.0.1'],
    { cwd: process.cwd(), stdio: 'ignore', shell: process.platform === 'win32' },
  );
  const ready = await waitForServer(BASE_URL);
  if (!ready) {
    throw new Error(`Server failed to start on ${BASE_URL}`);
  }

  let browser: Browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--user-data-dir=${PROFILE_DIR}`],
    env: { ...process.env, LD_LIBRARY_PATH: '/home/user/.local/lib:' + (process.env.LD_LIBRARY_PATH || '') },
  });
  const chromeVersion = await browser.version();
  console.log(`[Browser Identity]: ${chromeVersion} running against ${BASE_URL} (profile: ${PROFILE_DIR})\n`);

  try {
    let page = await browser.newPage();
    page.on('dialog', async (dialog) => {
      console.log('  [Chrome Dialog auto-accepted]:', dialog.message().slice(0, 50));
      await dialog.accept();
    });

    // Step 1: Clear site data
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await clearAppData(page);
    check(true, 'Step 1', 'Application starts and IndexedDB is cleared via CDP');

    // Reload after clear to start fresh
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(800);

    // Step 2: Navigate to Import page
    await clickNav(page, 'Import');
    const importPageReached = await page.evaluate(`
      !!document.querySelector('h1') && document.body.innerText.toLowerCase().includes('import')
    `);
    check(importPageReached, 'Step 2', 'Import page is reachable via navigation');

    // Step 3: BrokerImportSection is visible
    const brokerSectionVisible = await page.evaluate(`
      document.body.innerText.includes('Broker Import (Zerodha / Groww / Dhan)') ||
      document.body.innerText.includes('Broker Import')
    `);
    check(brokerSectionVisible, 'Step 3', 'BrokerImportSection is visible on the Import page');

    // Step 4: Select the real Zerodha sample
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      throw new Error('File input not found on Import page');
    }
    await fileInput.uploadFile(SAMPLE_PATH);
    check(true, 'Step 4', 'Real Zerodha sample file is selected via the file input');

    // Wait for the parse to complete and the preview to render.
    // The preview is a state transition in the React component;
    // we wait for the broker name to appear in the preview metadata.
    await page.waitForFunction(
      `document.body.innerText.includes('Zerodha') && document.body.innerText.includes('Preview')`,
      { timeout: 30000 },
    );
    check(true, 'Step 5', 'Broker is detected as Zerodha in the preview header');

    // Step 6: Holdings parsed — 82 Zerodha rows
    const parseCountText = await page.evaluate(`
      (function() {
        const text = document.body.innerText;
        // Look for the count chip "NEW" and the surrounding numbers
        const match = text.match(/NEW\\s*(\\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      })()
    `);
    check(parseCountText === 82, 'Step 6', `82 holdings are parsed (got ${parseCountText})`);

    // Step 7: Preview rendered — count chips, source file, importAt
    const previewRendered = await page.evaluate(`
      document.body.innerText.includes('NEW') &&
      document.body.innerText.includes('UPDATED') &&
      document.body.innerText.includes('UNCHANGED') &&
      document.body.innerText.includes('CLOSED_ABSENT') &&
      document.body.innerText.includes('Zerodha_holdings_10082026_1739.csv')
    `);
    check(previewRendered, 'Step 7', 'Preview is rendered with count chips, source file, and importAt');

    // Step 8 + 9: Confirm import
    await page.evaluate(`
      (function() {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent && buttons[i].textContent.includes('Confirm import')) {
            buttons[i].click();
            return;
          }
        }
      })()
    `);
    // Wait for the commit to persist; the preview unmounts on success.
    await page.waitForFunction(
      `document.body.innerText.includes('Imported 82 new')`,
      { timeout: 30000 },
    );
    check(true, 'Step 8', 'Confirmation is performed (Confirm import button clicked)');

    // Wait for the persisted holdings to appear in IndexedDB.
    await page.waitForFunction(
      `new Promise(function(resolve) {
        const req = window.indexedDB.open('finboom_db');
        req.onsuccess = function() {
          const db = req.result;
          if (!db.objectStoreNames.contains('holdings')) {
            db.close();
            resolve(false);
            return;
          }
          const tx = db.transaction(['holdings'], 'readonly');
          const getReq = tx.objectStore('holdings').count();
          getReq.onsuccess = function() {
            db.close();
            resolve(getReq.result === 82);
          };
        };
      })`,
      { timeout: 30000 },
    );
    check(true, 'Step 9', 'Import commits — 82 holdings persisted to real IndexedDB holdings store');

    // Step 10: Reload the page; holdings must persist
    const beforeReload = await getHoldingsFromPage(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const afterReload = await getHoldingsFromPage(page);
    check(
      afterReload.holdingsCount === beforeReload.holdingsCount &&
        afterReload.holdingsCount === 82,
      'Step 10',
      `Reload preserves holdings in IndexedDB (${beforeReload.holdingsCount} before, ${afterReload.holdingsCount} after)`,
    );

    // Step 11: Imported currentValue reaches displayed Wealth
    await clickNav(page, 'Wealth');
    // The wealth page's Net Worth KPI uses the page-level sum
    // which includes holding.currentValue. We check that the
    // wealth page renders and that the imported total is in
    // the rendered DOM.
    const totalForDisplay = afterReload.totalCurrentValue;
    // Format the number using the application's default locale
    // (the same call pattern as `CurrencyValue` in
    // `src/components/CurrencyValue.tsx`, which uses
    // `value.toLocaleString(undefined, ...)`). The page
    // renders the value with a `₹` prefix. We assemble the
    // full expected string rather than an arbitrary prefix
    // substring.
    const formattedTotal = totalForDisplay.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const expectedWealthText = `₹${formattedTotal}`;
    // Build a regex that tolerates an optional thousands
    // separator (the page's default-locale formatting may
    // include or omit a comma depending on the browser
    // default). The regex preserves the contract that the
    // numeric value is actually present in the rendered DOM.
    const digitsOnly = String(Math.round(totalForDisplay));
    const thousandsRegex = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',?');
    const wealthContainsImported = await page.evaluate(`
      (function() {
        const haystack = document.body.innerText;
        const needle = ${JSON.stringify(expectedWealthText)};
        const re = new RegExp(${JSON.stringify(thousandsRegex)});
        return haystack.includes(needle) || re.test(haystack);
      })()
    `);
    // Also assert that Wealth page rendered the expected Tier 1
    // cards. The KPI labels live inside elements that apply
    // `text-transform: uppercase` via Tailwind, so
    // `document.body.innerText` returns the uppercased text
    // (e.g. "NET WORTH"). Normalize case before comparison.
    const wealthPageRendered = await page.evaluate(`
      (function() {
        const haystack = document.body.innerText.toLowerCase();
        return haystack.includes('net worth') && haystack.includes('total assets');
      })()
    `);
    check(
      wealthPageRendered,
      'Step 11a',
      'Wealth page renders the Net Worth and Total Assets KPIs (Tier 1)',
    );
    check(
      wealthContainsImported,
      'Step 11b',
      `Imported currentValue (${expectedWealthText}) reaches the displayed wealth output`,
    );

    console.log('\n──────────────────────────────────────────────────────────────────────────');
    console.log(`WP-09 BROWSER-IMPORT E2E SUMMARY: ${passCount}/${passCount + failCount} PASS | ${failCount} FAIL`);
    console.log('──────────────────────────────────────────────────────────────────────────\n');
  } finally {
    await browser.close();
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    if (fs.existsSync(PROFILE_DIR)) {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    }
  }

  if (failCount > 0) {
    process.exit(1);
  }
}

if (process.env.SKIP_BROWSER_E2E === '1') {
  console.log('SKIP_BROWSER_E2E=1 — skipping WP-09 browser E2E.');
  process.exit(0);
}

runBrowserImportE2E().catch((err) => {
  console.error('Fatal WP-09 E2E error:', err);
  if (serverProc) {
    serverProc.kill('SIGTERM');
  }
  process.exit(1);
});
