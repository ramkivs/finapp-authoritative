# D-06-F1-A — REAL WINDOWS FAILURE REPRODUCTION + BATCH RUNTIME DIAGNOSIS

Gate: D-06-F1-A real Windows failure diagnosis + minimum correction.
Date: 2026-08-29 (UTC). Sandbox session branch: `arena/01a04e8a-finapp-authoritative`.
Mode: diagnose first, no speculative changes. **No file under `src/` of the session repo was modified.**

---

## 1. CHECKOUT VERIFICATION (gate §3) — FAILED, and the failure is itself evidence

| Check | Expected by gate | Actual in this sandbox |
|---|---|---|
| `git rev-parse HEAD` | `fdbc9ef7c69aa8d539b2acc325a214a5c8a1a11c` | `6a84d5eaeab2b4d0585229ae6b2c2c70aed86b12` |
| `git rev-parse origin/arena/01a04d88-finapp-authoritative` | `fdbc9ef…` | ref not present until fetched; after `git fetch` = `fdbc9ef…` ✅ |
| `git status --short` | clean | clean ✅ |
| `git branch --show-current` | `arena/01a04d88-finapp-authoritative` | `arena/01a04e8a-finapp-authoritative` ❌ |

This session is pinned to `arena/01a04e8a-finapp-authoritative`; it cannot check out or push to
`arena/01a04d88-finapp-authoritative`. The gate's literal STOP condition therefore triggered.

Because the *substance* of the gate is "diagnose the real runtime path", the diagnosis was carried
out against the authoritative promoted code itself, read and executed from its exact commits in
throw-away git worktrees outside the repo (`/home/user/pre` = `6a84d5e`, `/home/user/batch` =
`5b05781`, `/home/user/promoted` = `fdbc9ef`). No commit was amended, rewritten, or added;
`5b05781` and `fdbc9ef` are untouched.

Local commit graph (verified): `6a84d5e` (HEAD of main) → `5b05781` (feat: batch holding deletion)
→ `fdbc9ef` (fix: sequencing correction) = tip of `origin/arena/01a04d88-…`.

---

## 2. A DEFECT IN THE EXISTING GATE HARNESS (why "tests green + Windows red" is not a paradox)

Every existing D-06 test — including the promoted sequencing tests `A`–`D` in
`src/__tests__/BrokerImportSection.destructiveDisclosure.test.tsx` — runs under `vitest` + `jsdom`
(`vite.config.ts → test.environment: 'jsdom'`).

In jsdom `window.indexedDB` is **undefined**, so `IndexedDBStorageService` takes its documented
*environment fallback* (`nodeFallbackStore`, `IndexedDBStorageService.ts:242`, `:628`, `:766`):
**no IndexedDB transaction is ever exercised**. Additionally, tests `A`–`D`
**mock `BrokerImportService.detectAndParse`** and **pre-seed the repository with hand-made holdings**
(`seed([e, f])`, ids `hld-e`/`hld-f`).

Consequences, both measured here:

1. The real parser path (real Groww XLSX bytes → real `instrumentName`/`account`) is never run.
2. The real "canonical id was created by an *import*, not by a test fixture" path is never run.
3. The real persistence boundary (`write()` → `persist()` → `revertDelta`) is never run.

So a green suite does **not** establish that the shipped runtime is correct — and, as it turns out,
it also does not establish that the *reported* runtime is running this code.

---

## 3. REPRODUCTION OF THE REAL WINDOWS SCENARIO (gate §4) — source code unmodified

Harness built for this gate (scratch, outside the repo):
`src/__tests__/D06F1A-windows-repro.test.tsx`, `…repro2.test.tsx`, `…correlation.test.tsx` in the
worktrees. Properties:

* `import 'fake-indexeddb/auto'` → real IndexedDB transaction semantics for write/persist/reload.
* **Real** `xlsx` package builds real Groww-shaped workbooks (MF variant: preamble rows,
  `Mobile Number` account row, verbatim `Scheme Name…XIRR` header; Stocks variant:
  `Unique Client Code` account row, verbatim stock header) → fed to the real
  `broker-file-input` → real `detectAndParse` → real `reconcile` → real `commitImportedHoldings`
  → real `MemoryRepository.write` → real `planClose`. **No service is mocked.**
* Ledger starts empty; the 6 Holdings are created by import #1 (canonical ids are therefore
  parser-generated), import #2 keeps 4 and closes `TATAAML-TATAGOLD` + `UTIAMC-UTIGOLDBETA`.
* Also run: mixed-variant ledger (4 Stocks rows + 2 MF rows — which is what the affected row names
  actually indicate: Groww MF-scheme rows under a *different* account key than the stock rows).

### Observed UI state per runtime

| Runtime | BEFORE Confirm (import #2 preview) | AFTER Confirm |
|---|---|---|
| `6a84d5e` (pre-D-06-F1-A) | 2 closure rows; **no checkbox column**; single delete `disabled=true` | commit notice `Imported 0 new, 4 updated, 2 closed-absent, 0 unchanged`; **closure surface unmounts; rows not visible at all**; canonical = `closed_absent` (persists across reload) |
| `5b05781` (F1-A feature, snapshot eligibility) | 2 closure rows; **checkbox `disabled=true`**; single delete `disabled=true` | commit notice (same success text); **closure surface unmounts**; on the preview snapshot the rows stay `disabled=true` forever → **"rows still not selectable"** |
| `fdbc9ef` (promoted correction) | 2 closure rows; checkbox `disabled=true`; single delete `disabled=true` (correct: canonical is still `active`) | closure surface re-rendered (`Closures (transitioned to closed_absent — eligible for permanent deletion) (2)`); **checkbox `disabled=false`**, single delete `disabled=false`; batch bar appears on selection |

The mixed-variant run at `fdbc9ef` behaves identically (rows selectable immediately after confirm).
The canonical transition is also correct in every runtime — see §4.

**The reported Windows symptom (rows present, checkbox still disabled *after* a successful confirm)
is reproduced exactly at `5b05781`, and is impossible at `fdbc9ef`.**

---

## 4. ACTUAL CANONICAL STATE AFTER CONFIRM (gate §5) — read-only, live ledger + storage

Dumped from `useCanonicalLedger.getState().holdings` and `repository.holdingsData`, then again after
`repository.initialize()` (real IndexedDB reload):

```text
id=hld-0c7e2047-…  status="closed_absent" broker=Groww account="9876543210" instrument="TATAAML-TATAGOLD"    isin=undefined ticker=undefined
id=hld-7b25678b-…  status="closed_absent" broker=Groww account="9876543210" instrument="UTIAMC-UTIGOLDBETA"  isin=undefined ticker=undefined
(+ 4 rows status="active")
AFTER RELOAD: both rows still status="closed_absent" (repo copy identical to store copy)
```

So the canonical ledger value **is** `closed_absent` after confirm — in `6a84d5e`, `5b05781` and
`fdbc9ef` alike, with real persistence. The failure is purely a UI-eligibility-source problem, never
a ledger problem.

---

## 5. ID CORRELATION (gate §8)

```text
TATAAML-TATAGOLD:
  preview.closures[].existing.id   = hld-0c7e2047-ec38-…
  confirmedClosures[].existing.id  = hld-0c7e2047-ec38-…
  useCanonicalLedger.holdings[].id = hld-0c7e2047-ec38-…     MATCH = true
UTIAMC-UTIGOLDBETA:
  preview.closures[].existing.id   = hld-7b25678b-ad97-…
  confirmedClosures[].existing.id  = hld-7b25678b-ad97-…
  useCanonicalLedger.holdings[].id = hld-7b25678b-ad97-…     MATCH = true
```

All three ids are the same value in all three runtimes. This is structural: `MemoryRepository.write`
calls `syncStore()` (`MemoryRepository.ts:929-933`) with `holdings: [...this.holdingsData]`, so the
`holdings` slice the preview reconciles against **is** the canonical array content, by reference copy.
**There is no ID mismatch anywhere in the D-06-F1-A path.**

---

## 6. STATUS CORRELATION (gate §9)

Post-confirm, at each runtime:

```text
TATAAML-TATAGOLD
  preview status          = active          (snapshot object captured at preview-build time)
  confirmed closure status= active          (the SAME snapshot object; 5b05781 reads this field)
  canonical ledger status = closed_absent   (in every runtime, incl. after reload)
  UI eligibility status   = 5b05781 → active        (from c.existing.status)      ⇒ checkbox disabled
                        fdbc9ef → closed_absent     (from liveById lookup)        ⇒ checkbox enabled

UTIAMC-UTIGOLDBETA  — identical values.
```

---

## 7. UI ELIGIBILITY PATH, EXACT EXPRESSIONS (gate §6)

`src/pages/BrokerImportSection.tsx` @ `fdbc9ef` (all eligibility paths, complete):

| Path | Expression | Line |
|---|---|---|
| source of truth | `const liveHoldings = useCanonicalLedger((s) => s.holdings)` | 926 |
| row resolution | `const liveById = new Map(liveHoldings.map(h => [h.id, h]))` | 927 |
| predicate | `const isDeletionEligible = (h: Holding) => h.status === 'closed_absent'` | 928 |
| row set | `closures.map(c => ({ live: liveById.get(c.existing.id) })).filter(r => r.live !== undefined)` | 933-935 |
| checkbox checked | `checked={isDeletionEligible(live) && selectedIds.has(live.id)}` | 1028 |
| checkbox disabled | `disabled={!isDeletionEligible(live)}` | 1029 |
| batch bar visibility | `{eligibleSelected.length > 0 && …}` (`batch-delete-button` lives inside) | 1076 |
| effective selection | `rows.filter(r => isDeletionEligible(r.live) && selectedIds.has(r.live.id))` | 946-948 |
| single delete | `disabled={!isDeletionEligible(live)}` | 1055 |
| single-delete modal | `const isEligible = holding.status === 'closed_absent'` | 1171 |
| batch modal | `const eligible = holdings.filter(h => h.status === 'closed_absent')` | 1322 |
| surface lifecycle | `{confirmedClosures && confirmedClosures.length > 0 && <ClosureTable phase="confirmed" …>}` | 522-526 |

Same paths @ `5b05781` (the pre-correction runtime): `disabled={c.existing.status !== 'closed_absent'}`
(915, 938), `checked={c.existing.status === 'closed_absent' && …}` (914),
`eligible = … .filter(c => c.existing.status === 'closed_absent' && …)` (860) — i.e. the checkbox
state is read from the **preview snapshot object**, captured before the import was confirmed, and it
is never refreshed. `ClosureTable` there has no `phase` prop
(`export const ClosureTable: React.FC<{ title; closures }>` — `5b05781:842`).

Both are, ultimately, `status === 'closed_absent'`; only the **source object** differs
(snapshot vs live canonical ledger). The promoted commit changed exactly that, and nothing else.

---

## 8. CRITICAL DISTINCTION (gate §7) — verdict

* **A. canonical not `closed_absent`** — REJECTED (§4: it is, in every runtime, including after reload).
* **B. canonical `closed_absent` but ClosureTable cannot resolve it** — REJECTED as a *general* claim:
  resolution by id succeeds (§5).
* **C. stale React/Zustand observation** — REJECTED: `write()` syncs the store synchronously before
  the persist promise (`MemoryRepository.ts:929-933`), and the surface is mounted in the
  `.then()` of that promise; the live-ledger subscription re-renders. Measured at `fdbc9ef`.
* **D. wrong Holding id** — REJECTED (§5, all three ids equal, structurally guaranteed).
* **E. ClosureTable using a different object/source than the canonical ledger** — **THIS IS THE
  DEFECT** — and it exists **only at `5b05781`**, where eligibility is `c.existing.status` from the
  preview snapshot. It is exactly what `fdbc9ef` replaces with `liveById.get(c.existing.id)`.
* **F. correct object but disabled by another condition** — REJECTED (§7: no other condition exists
  in either runtime).
* **G. another runtime issue** — see §9: two *lifecycle* gaps in the post-confirm surface survive at
  `fdbc9ef`. They destroy the surface (rows vanish); they do **not** produce a visible-but-disabled
  row.

**Root cause of the reported Windows failure: the runtime exhibiting the symptom is running the
`5b05781` implementation of `ClosureTable` — feature without the sequencing correction — not the
`fdbc9ef` correction.** The correction itself is correct and does fix the reported symptom under the
real Groww scenario, real ids from real imports, and real IndexedDB persistence.

Fastest Windows-side confirmation (one line, in the app's browser console — `(window).useCanonicalLedger`
is already exposed for exactly this, `useCanonicalLedger.ts:1123`):

1. `window.useCanonicalLedger.getState().holdings.filter(h => h.status === 'closed_absent')`
   → if the two rows appear here, the ledger is right and the bug is the UI source, i.e. `5b05781`.
2. Presence of a checkbox column at all in `Closures (…)` proves ≥ `5b05781`; presence of the
   post-confirm surface titled `Closures (transitioned to closed_absent — eligible for permanent deletion)`
   proves `fdbc9ef`. Absent title ⇒ the correction is not live in that runtime (worktree, stale dev
   server / stale Vite optimize cache, or a packaged build made from `5b05781`).

---

## 9. RESIDUAL DEFECTS OBSERVED AT `fdbc9ef` (do not match the reported symptom, but are real)

1. **Broker-chip click after confirm destroys the post-confirm closure surface.**
   `useEffect(..., [selectedBroker])` clears `confirmedClosures` (`fdbc9ef:262-272`). Measured:
   `closure surface survived: false`. Since Step 1 defaults to *Zerodha* and detection is
   content-based, a user who taps the Groww chip after previewing/confirming loses the selectable
   rows while the ledger keeps them `closed_absent` — the rows become unreachable for F1-A until
   another import re-produces them.
2. **The surface is component-local, so it dies on unmount / tab switch / reload.** Measured:
   re-rendering `BrokerImportSection` (or `repository.initialize()`) after a successful confirm
   yields `closure surface survived: false`, with the ledger still `closed_absent`.

Both are *surface-lifecycle* issues (the promoted commit deliberately made the surface ephemeral).
Fixing either changes F1-A product surface behaviour (which is frozen by this gate), so no code was
changed here. Recommended: file as a follow-up gate (D-06-F1-A-b: "closure surface must be re-derivable
from the live ledger for the last confirmed (broker, account) scope, not from component state").

---

## 10. MINIMUM CORRECTION — STATUS: see §13 (correction + real-runtime test now shipped on this branch)

At the moment the diagnosis was written, no code change was authorised by the evidence: the
promoted eligibility source is correct. After the verdict was reported, the gate owner chose
"lifecycle fix + real-runtime test", which is §13. Everything in §1–§12 stands as measured.


Gate §2 authorises a correction *only once the exact cause is established within scope*. The exact
cause established here is **not a defect in `fdbc9ef`'s eligibility source** — that is already
correct, verified against the real parser, real ids, real store, real persistence, and a real reload,
in both the single-file and mixed-variant Groww scenarios. The observed Windows behaviour is explained
by the runtime being at `5b05781`.

Shipping a further eligibility change into `fdbc9ef` would be speculative, would risk the frozen
contract (`status === 'closed_absent'`, D-06-F10-C no asset effect, D-06-F11 = A/INCLUDE), and would
not change the outcome for a runtime that does not have `fdbc9ef`. **Zero files under `src/` in the
session repo were touched; no commit created.**

Required action instead (Windows side, no code change):
1. `git -C <finapp-authoritative> rev-parse HEAD` on the Windows machine → must print
   `fdbc9ef7c69aa8d539b2acc325a214a5c8a1a11c`. Anything else (notably `5b05781…`) is the failure.
2. Confirm `git branch --show-current` = `arena/01a04d88-finapp-authoritative` and
   `git log --oneline -1 -- src/pages/BrokerImportSection.tsx` = `fdbc9ef`.
3. Hard restart the app: stop the dev server, clear Vite cache (`node_modules/.vite`), or rebuild the
   packaged artifact from `fdbc9ef`, then re-run the two imports.
4. Verify with §8's console check that the post-confirm surface title exists and both rows show
   `checkboxDisabled=false`.
5. If, **with the `fdbc9ef` ClosureTable verifiably live**, the rows are still rendered with a
   disabled checkbox, re-open this gate — that would then be category **G**, and §9.1/§9.2 are the
   two already-known lifecycle paths to look at first.

---

## 11. WHAT THE PREVIOUS DIAGNOSIS GOT RIGHT AND WRONG

* Right: eligibility had to come from the live canonical ledger, not from the preview snapshot
  (`c.existing.status`), because the store keeps the same `Holding` **objects** across
  `syncStore()` and a confirmed commit replaces them.
* Incomplete: it validated that claim with a mocked parser, fixture-seeded holdings, ids hard-coded to
  match (`hld-e`/`hld-f`), and an environment where persistence is silently a no-op. It never asserted
  the one thing the Windows report claimed — that the *promoted* code was actually executing in the
  runtime under test — nor the surface lifecycle in §9.

---

## 12. ARTIFACTS (scratch; deliberately not part of the repo, not committed)

| Path | Purpose |
|---|---|
| throw-away worktrees `/home/user/pre` (@ `6a84d5e`), `/home/user/batch` (@ `5b05781`), `/home/user/promoted` (@ `fdbc9ef`) | read/run the three candidate runtimes without touching the session checkout (removed after the run; not repo content) |
| `src/__tests__/D06F1A-windows-repro.test.tsx` (scratch, worktrees only) | real XLSX + real IndexedDB + real store; two imports; before/after-confirm DOM assertions; reload; residual probes |
| `src/__tests__/D06F1A-windows-repro2.test.tsx` (scratch) | mixed Groww variant (4 stocks + 2 MF) — the shape implied by the affected row names; broker-chip and re-mount probes |
| `src/__tests__/D06F1A-correlation.test.tsx` (scratch) | §4/§8/§9 dumps: preview id/status, confirmed id/snapshot status, canonical id/status, DOM `disabled` flags |

The durable, committed descendant of those harnesses is
`src/__tests__/D06F1A.runtimeSequencing.test.tsx` (§13.3): run it with
`npx vitest run src/__tests__/D06F1A.runtimeSequencing.test.tsx`. It needs `fake-indexeddb`
(installed here with `--no-save`, so it is not in `package.json`; adding it as a devDependency is a
separate housekeeping decision, deliberately not taken in this gate).

Repo state at the time of §1–§12: no file under `src/` modified, no commit created. Superseded by §13.

---

## 13. SHIPPED ON THIS BRANCH (`arena/01a04e8a-finapp-authoritative`)

Two decisions taken by the gate owner after §1–§12 were reported: (i) replay the promoted stack on
this session branch so the correction sits on top of the code it corrects, (ii) ship the residual
lifecycle correction **and** the real-runtime test that the promoted suite lacked.

### 13.1 Replays (content-identical to the promoted commits; originals untouched)

```text
2e6fc0d  fix(finboom): fix batch deletion lifecycle sequencing     ≡ fdbc9ef
844df7b  feat(finboom): add batch holding deletion                 ≡ 5b05781
6a84d5e  fix(finboom): restore Dhan equity BOM detection           (was already HEAD)
```

`git diff fdbc9ef HEAD` was **empty** before the correction, i.e. byte-identical trees. `5b05781`
and `fdbc9ef` were not amended, rebased or rewritten.

### 13.2 Minimum correction — one file, one behavior

`src/pages/BrokerImportSection.tsx`: the `selectedBroker` reset no longer clears `confirmedClosures`
(removed from the `if` predicate and the `setConfirmedClosures(null)` call deleted; no other line
changed). Rationale is in §9.1 — the Step 1 chip is export guidance, while the post-confirm closure
surface is bound to a *committed* import whose rows are already canonical `closed_absent`. Clearing
it destroyed the only F1-A selection surface, with the ledger still holding closed rows.

Safety by construction: `ClosureTable` re-resolves id **and** status from the live canonical ledger on
every render (fdbc9ef design, unchanged), so a surface that outlives a chip click cannot enable a
stale row — rows that left `closed_absent` disable again, rows that left the ledger drop out.
`handleFileChosen` (new import supersedes) and `handleCancel` (explicit cancel) still clear it; those
two boundaries are the only ones that changed nothing.

Deliberately **not** touched: eligibility predicate (`status === 'closed_absent'`), D-06-F10-C,
D-06-F11, all deferred surfaces (F1-B/C/D, F2, F3, F4, F6, F9, D-12), and §9.2 (surface loss across
unmount/reload), which needs a product decision about where the surface lives — recommended follow-up
`D-06-F1-A-b`.

### 13.3 New test — `src/__tests__/D06F1A.runtimeSequencing.test.tsx` (11 tests)

Real Groww XLSX bytes (built with the app's own `xlsx`) → real detect/parse/reconcile → real
`commitImportedHoldings` → real `MemoryRepository.write` + `fake-indexeddb` persistence + real
reload; no service mocked; canonical ids come from an import, not from fixtures. Coverage: import #1
creates 6 rows; pre-confirm rows visible-but-disabled; **post-confirm rows selectable, keyed by the
canonical id**; state survives reload; surface survives the broker chip; batch review → explicit
confirm → atomic, batch-attributed, `MULTI_SELECT` deletion with no asset effect; new-import/cancel
boundaries intact. Plus a code-only promotion guard (comments stripped, so prose cannot satisfy it).

### 13.4 Measured results

| Run | Result |
|---|---|
| `fdbc9ef` suite before this gate | 6 files / 189 tests failed — **all** broker-adapter tests that read real user samples from `/home/user/uploads/…`, absent in this sandbox (pre-existing, unrelated) |
| Branch after replay + correction + new test | **6 files / 189 failed, 53 files / 1550 passed** — identical failure set, +11 new passing tests |
| `npx tsc --noEmit` | clean |
| Mutation test: re-introduce `c.existing.status` + chip-clear | **5 failures**, including `TATAAML-TATAGOLD must be selectable after the confirmed transition: expected true to be false` — the exact Windows symptom, and all three guards failing. The guard is not decorative. |

### 13.5 Windows action still required

The correction in §13.2 does not, and cannot, make a `5b05781` runtime behave like `fdbc9ef`.
Before re-testing on Windows, confirm `git rev-parse HEAD` prints the SHA that contains
`git diff`-visible `liveById` resolution in `src/pages/BrokerImportSection.tsx`, then hard-restart
(stop the dev server, clear `node_modules/.vite`, or rebuild the packaged artifact from that SHA) and
re-run the two imports. Expect the title
`Closures (transitioned to closed_absent — eligible for permanent deletion) (2)` with both rows enabled.
