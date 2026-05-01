// Source-scan regression test for the silent-update-drift fix (2026-05-01).
//
// Live incident the day this test was written: Ryan's own Merlin install
// reported v1.21.0 in the title bar, but `app/` had only 19 of the 70 files
// listed in `version.json.updatable[]`. Every MCP module was missing —
// `app/mcp-server.js`, `app/mcp-tools.js`, `app/merlin-mcp-shim.js`, and
// 11 others — so `main.js`'s `require('./mcp-server.js')` threw at boot,
// the SDK never registered tools, and Claude Code reported zero
// `mcp__merlin__*` tools. The non-MCP files that DID exist were all
// dramatically smaller than source (main.js 53KB vs 582KB, renderer.js
// 65KB vs 502KB) — they were leftovers from a much earlier release.
//
// Root cause was a single 5-line block in `downloadAndApplyUpdate` (Phase
// 1 fetch loop). When ANY individual updatable file fetch failed (AV
// quarantining `mcp-*.js` files, raw.githubusercontent.com rate-limiting
// on a hot release, transient network blip during the long fetch loop),
// the catch block `console.warn`'d and continued — Phase 2 then wrote
// only the surviving subset to disk, and version.json got bumped to the
// new version regardless. Every subsequent `/update` saw "currentVersion
// === latestVersion", short-circuited at the top of
// `downloadAndApplyUpdate`, and never retried. The gap froze in place
// across many releases, silently growing larger with every new file the
// release added.
//
// This test locks two invariants in source so the fix can never silently
// regress:
//
//   1. The Phase 1 catch block on individual file fetches must populate a
//      `fetchFailures` collection rather than just `console.warn`. After
//      the loop, the function MUST throw an error mentioning "Update
//      aborted" / "files failed to download" if any failures occurred.
//      This guarantees Phase 2 + version bump cannot run on a partial
//      Phase 1.
//
//   2. The same-version short-circuit at the top of
//      `downloadAndApplyUpdate` must be paired with an integrity check
//      that re-runs the update as a self-heal when local
//      version.json.updatable[] entries are missing on disk. Without
//      this, every install already in the bad state stays stuck because
//      the version field is correct but the contents are not.
//
//   3. `humanizeUpdateError` in renderer.js must recognize the new
//      "Update aborted" / "files failed to download" error format and
//      surface a friendly toast that includes the failure count + an
//      "install unchanged" reassurance. Falling through to the generic
//      "Update couldn't install" message strips the actionable signal.
//
// Run with: node app/update-silent-drift.test.js

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const MAIN_JS = path.join(APP_DIR, 'main.js');
const RENDERER_JS = path.join(APP_DIR, 'renderer.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.log('  ✗', name);
    console.log('   ', err.message);
    failed++;
  }
}

function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx < 0) return line;
    const before = line.slice(0, idx);
    const sq = (before.match(/'/g) || []).length;
    const dq = (before.match(/"/g) || []).length;
    const bt = (before.match(/`/g) || []).length;
    if (sq % 2 === 1 || dq % 2 === 1 || bt % 2 === 1) return line;
    return before;
  }).join('\n');
  return out;
}

if (!fs.existsSync(MAIN_JS)) { console.error('main.js missing at', MAIN_JS); process.exit(1); }
if (!fs.existsSync(RENDERER_JS)) { console.error('renderer.js missing at', RENDERER_JS); process.exit(1); }

const MAIN_RAW = fs.readFileSync(MAIN_JS, 'utf8');
const MAIN_SRC = stripComments(MAIN_RAW);
const RENDERER_RAW = fs.readFileSync(RENDERER_JS, 'utf8');
const RENDERER_SRC = stripComments(RENDERER_RAW);

test('main.js keeps the silent-update-drift REGRESSION GUARD marker', () => {
  if (!MAIN_RAW.includes('REGRESSION GUARD (2026-05-01, silent-update-drift fix)')) {
    throw new Error(
      'main.js lost the "REGRESSION GUARD (2026-05-01, silent-update-drift fix)" ' +
      'comment block in the Phase 1 fetch loop. Do not delete it — it documents ' +
      'the live incident where Ryan\'s install drifted to a fake "latest" ' +
      'version with 57 of 70 files missing because Phase 1 silently swallowed ' +
      'fetch failures. Restore the block or add a new dated guard explaining ' +
      'why the rule changed.',
    );
  }
});

test('main.js keeps the silent-update-drift self-heal REGRESSION GUARD marker', () => {
  if (!MAIN_RAW.includes('REGRESSION GUARD (2026-05-01, silent-update-drift self-heal)')) {
    throw new Error(
      'main.js lost the "REGRESSION GUARD (2026-05-01, silent-update-drift self-heal)" ' +
      'comment block guarding the same-version integrity check. Without that ' +
      'block, installs already in the bad state never re-fetch missing files ' +
      'because isNewerVersion short-circuits.',
    );
  }
});

test('Phase 1 fetch loop tracks failures in a fetchFailures array', () => {
  // The catch block must push to a collection, not just console.warn.
  // Find the downloadAndApplyUpdate function's body.
  const fnStart = MAIN_SRC.indexOf('async function downloadAndApplyUpdate');
  if (fnStart < 0) throw new Error('downloadAndApplyUpdate function not found in main.js');
  // Crude bounded scan: take 20000 chars from the function start. The whole
  // function fits well under that.
  const fnBody = MAIN_SRC.slice(fnStart, fnStart + 20000);
  if (!/const\s+fetchFailures\s*=\s*\[\s*\]/.test(fnBody)) {
    throw new Error(
      'downloadAndApplyUpdate must declare `const fetchFailures = []` to ' +
      'track per-file fetch errors. Without this collection, partial Phase 1 ' +
      'failures are invisible to the post-loop hard-fail check.',
    );
  }
  if (!/fetchFailures\.push\s*\(/.test(fnBody)) {
    throw new Error(
      'The Phase 1 catch block must push failures into `fetchFailures`. The ' +
      'pre-fix bug was a bare `console.warn` that lost the failure entirely.',
    );
  }
});

test('Phase 1 throws on any fetch failure before Phase 2 / version bump', () => {
  const fnStart = MAIN_SRC.indexOf('async function downloadAndApplyUpdate');
  const fnBody = MAIN_SRC.slice(fnStart, fnStart + 20000);
  // After the fetch loop, we expect a guard like:
  //   if (fetchFailures.length > 0) { ... throw new Error('Update aborted: ...') }
  // The throw message must say "Update aborted" or "files failed to download"
  // so renderer's humanizeUpdateError can match the friendly branch.
  const hasGuard = /if\s*\(\s*fetchFailures\.length\s*>\s*0\s*\)/.test(fnBody);
  if (!hasGuard) {
    throw new Error(
      'After the Phase 1 fetch loop, an `if (fetchFailures.length > 0)` guard ' +
      'must throw before Phase 2 runs. Without it, Phase 2 will write the ' +
      'partial subset that succeeded — the exact bug this fix retires.',
    );
  }
  if (!/Update aborted|files failed to download/.test(fnBody)) {
    throw new Error(
      'The Phase 1 hard-fail throw must mention "Update aborted" or "files ' +
      'failed to download" so renderer.js humanizeUpdateError can match it ' +
      'and surface the failure-count + reassurance. Otherwise users see the ' +
      'generic fallback toast and lose actionable signal.',
    );
  }
});

test('Phase 1 hard-fail throw runs BEFORE Phase 2 writes', () => {
  // The order must be: fetch loop → fetchFailures guard throw → Phase 2 writes.
  // We assert this by index ordering of three sentinels.
  const fnStart = MAIN_SRC.indexOf('async function downloadAndApplyUpdate');
  const fnBody = MAIN_SRC.slice(fnStart, fnStart + 20000);
  const guardIdx = fnBody.search(/if\s*\(\s*fetchFailures\.length\s*>\s*0\s*\)/);
  // Phase 2 sentinel: the existing code writes `for (const { filePath, content } of stagedUpdatables)`.
  const phase2Idx = fnBody.indexOf('of stagedUpdatables');
  // version bump sentinel: `vj.version = latestVersion`.
  const versionBumpIdx = fnBody.indexOf('vj.version = latestVersion');
  if (guardIdx < 0 || phase2Idx < 0 || versionBumpIdx < 0) {
    throw new Error('Could not locate one of: fetchFailures guard, Phase 2 loop, version bump');
  }
  if (!(guardIdx < phase2Idx && phase2Idx < versionBumpIdx)) {
    throw new Error(
      'Order invariant broken: the fetchFailures guard MUST come before the ' +
      'Phase 2 stagedUpdatables write loop, which MUST come before the ' +
      'version.json bump. Reordering risks reintroducing the silent-drift bug.',
    );
  }
});

test('self-heal: same-version path runs an integrity check on local updatable[]', () => {
  const fnStart = MAIN_SRC.indexOf('async function downloadAndApplyUpdate');
  const fnBody = MAIN_SRC.slice(fnStart, fnStart + 20000);
  // Self-heal must declare a `needsSelfHeal` flag (any name is fine in
  // theory, but locking the name keeps the test readable; if you rename
  // it, update this test in the same PR).
  if (!/let\s+needsSelfHeal\s*=\s*false/.test(fnBody)) {
    throw new Error(
      'Self-heal block must declare `let needsSelfHeal = false` before the ' +
      'short-circuit return. Without a self-heal path, installs already in ' +
      'the bad state stay stuck — every /update sees same-version and bails.',
    );
  }
  // The integrity check must read the local version.json and check
  // fs.existsSync on each entry.
  if (!/version\.json/.test(fnBody) || !/fs\.existsSync\s*\(/.test(fnBody)) {
    throw new Error(
      'Self-heal must read local version.json and use fs.existsSync to detect ' +
      'missing updatable files. The current implementation appears to skip ' +
      'one of those steps.',
    );
  }
});

test('self-heal: short-circuit return considers needsSelfHeal flag', () => {
  const fnStart = MAIN_SRC.indexOf('async function downloadAndApplyUpdate');
  const fnBody = MAIN_SRC.slice(fnStart, fnStart + 20000);
  // The amended return must look like:
  //   if (!latestVersion || (!isNewerVersion(...) && !needsSelfHeal)) return;
  // The early-return regex needs to be greedy enough to span nested parens
  // (the original had `[^)]*` which truncated at the first `)` and missed
  // the trailing `&& !needsSelfHeal)` clause).
  const earlyReturnRe = /if\s*\([^{;]*isNewerVersion[^{;]*\)\s*return\s*;/g;
  const earlyReturn = fnBody.match(earlyReturnRe) || [];
  const ok = earlyReturn.some(line => /needsSelfHeal/.test(line));
  if (!ok) {
    throw new Error(
      'The same-version short-circuit `if (!latestVersion || !isNewerVersion(...)) return;` ' +
      'must be amended to also check `needsSelfHeal`. Without it, the ' +
      'integrity check fires but the function still returns early.\n' +
      'Found early returns: ' + JSON.stringify(earlyReturn),
    );
  }
});

test('renderer humanizeUpdateError surfaces the new "Update aborted" branch', () => {
  const fnStart = RENDERER_SRC.indexOf('function humanizeUpdateError(');
  if (fnStart < 0) throw new Error('humanizeUpdateError not found in renderer.js');
  // Use the next top-level function as the end marker. humanizeTranscriptionError
  // immediately follows humanizeUpdateError in renderer.js.
  const fnEnd = RENDERER_SRC.indexOf('function humanizeTranscriptionError', fnStart);
  if (fnEnd <= fnStart) throw new Error('Could not find end of humanizeUpdateError (humanizeTranscriptionError marker missing)');
  const body = RENDERER_SRC.slice(fnStart, fnEnd);
  if (!/Update aborted|files failed to download/i.test(body)) {
    throw new Error(
      'humanizeUpdateError must include a branch that matches "Update ' +
      'aborted" or "files failed to download" — otherwise the new Phase 1 ' +
      'hard-fail error falls through to the generic toast and the user ' +
      'never sees the failure count or the "install unchanged" reassurance.',
    );
  }
  // The friendly message must include reassurance that the install is
  // unchanged so users know retry is safe.
  if (!/install is unchanged|install unchanged/i.test(body)) {
    throw new Error(
      'The "Update aborted" branch must reassure the user that their install ' +
      'is unchanged — that\'s the load-bearing UX signal. Retry is safe ' +
      'because Phase 1 hard-fails before any disk write.',
    );
  }
});

test('renderer humanizeUpdateError "Update aborted" branch fires before generic /network/', () => {
  // Ordering matters: "files failed to download" contains the word "download"
  // which is innocuous, but the original /network/ branch also matches
  // generic strings. We want the specific branch to win.
  const fnStart = RENDERER_SRC.indexOf('function humanizeUpdateError(');
  const fnEnd = RENDERER_SRC.indexOf('\n}\n', fnStart);
  const body = RENDERER_SRC.slice(fnStart, fnEnd);
  const abortedIdx = body.search(/Update aborted|files failed to download/i);
  const networkIdx = body.search(/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|network/);
  if (abortedIdx < 0 || networkIdx < 0) {
    throw new Error('Either the "Update aborted" branch or the network branch is missing');
  }
  if (abortedIdx >= networkIdx) {
    throw new Error(
      'The "Update aborted" branch must appear BEFORE the generic /network/ ' +
      'branch in humanizeUpdateError. Otherwise an "Update aborted" message ' +
      'that mentions "network" in its detail would route to the generic ' +
      '"Can\'t reach the update server" toast instead of the count + ' +
      'reassurance branch.',
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
