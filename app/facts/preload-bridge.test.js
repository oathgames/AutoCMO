// preload-bridge.test.js — regression guard for the fact-binding IPC bridge.
//
// Before v1.12.1 the HMAC session key (vaultKeyHex) flowed from main.js
// to the renderer via `win.webContents.executeJavaScript(js)` where `js`
// was a template string that interpolated the hex via JSON.stringify.
// That placed the hex into the renderer's JS source eval stream, making
// it readable from DevTools and any renderer-process memory dump, which
// contradicted the "NEVER log vaultKey" comment guarding the same block.
//
// The current architecture keeps the hex in Node-context the whole way:
//
//   main.js (Node)
//     → win.webContents.send('fact-binding:init', { vaultKeyHex, … })   // native IPC
//     → preload.js (Node)
//         Buffer.from(vaultKeyHex, 'hex')
//         cb({ vaultKey: <Buffer>, … })   // contextBridge structured clone → Uint8Array
//     → renderer.js initFactBinding({ vaultKey: <Uint8Array>, … })
//
// These source-scans lock the shape so a future refactor can't silently
// regress to the old executeJavaScript path or smuggle the hex onto a
// named window property via exposeInMainWorld.
//
// If this test fires, read the REGRESSION GUARD (2026-04-18) block in
// the referenced file before changing the code. Rolling back to
// executeJavaScript is a security incident, not a simplification.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const MAIN_JS = path.join(APP_DIR, 'main.js');
const PRELOAD_JS = path.join(APP_DIR, 'preload.js');
const RENDERER_JS = path.join(APP_DIR, 'renderer.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Strip line comments (`// …`) and block comments (`/* … */`) so the
// guard scans against live code only. Keeps commentary like "don't do
// executeJavaScript(js)" from tripping the guard.
function stripComments(src) {
  // Block comments first (non-greedy, multi-line).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Normalise line endings so the per-line strip works on CRLF files.
  const lf = noBlock.replace(/\r\n/g, '\n');
  // Then line comments. JavaScript strings can contain `//` so this is
  // a conservative cut — but there are no string literals in these
  // files containing // that we care about guarding. Use [^\n]* (not
  // `.*`) since JS regex's `.` doesn't match `\r` or `\n`.
  return lf.split('\n').map((line) => line.replace(/(^|[^:])\/\/[^\n]*/, '$1')).join('\n');
}

test('main.js no longer passes vaultKey through executeJavaScript', () => {
  const src = stripComments(read(MAIN_JS));
  // The fact-binding block must not combine `executeJavaScript` with
  // any vaultKey reference. Search for either token on the same line
  // OR within a small window (template literal straddle), whichever
  // is stricter.
  const execJS = /executeJavaScript\s*\(/g;
  let m;
  while ((m = execJS.exec(src)) !== null) {
    const start = Math.max(0, m.index - 200);
    const end = Math.min(src.length, m.index + 600);
    const window = src.slice(start, end);
    assert.ok(!/vaultKey|__merlinInitFactBinding/i.test(window),
      `main.js executeJavaScript window near offset ${m.index} references vaultKey / __merlinInitFactBinding — ` +
      'this is the pre-v1.12.1 hex-leak pattern. Deliver via webContents.send(\'fact-binding:init\', …) instead.');
  }
});

test('main.js delivers fact-binding init via webContents.send', () => {
  const src = stripComments(read(MAIN_JS));
  assert.ok(/webContents\.send\(\s*['"]fact-binding:init['"]/.test(src),
    'main.js must send fact-binding init over the `fact-binding:init` IPC channel');
  // And the vaultKeyHex must appear in a send-payload shape, not in an
  // executeJavaScript snippet.
  const sendMatch = src.match(/webContents\.send\(\s*['"]fact-binding:init['"][\s\S]{0,400}?\)\s*;/);
  assert.ok(sendMatch, 'fact-binding:init send call not found or malformed');
  assert.ok(/vaultKeyHex/.test(sendMatch[0]),
    'fact-binding:init payload must carry vaultKeyHex (preload converts to Buffer)');
});

test('preload.js registers fact-binding:init listener + converts hex in Node context', () => {
  const src = stripComments(read(PRELOAD_JS));
  assert.ok(/ipcRenderer\.on\(\s*['"]fact-binding:init['"]/.test(src),
    'preload.js must listen on `fact-binding:init`');
  assert.ok(/Buffer\.from\([^,]*vaultKeyHex[^,]*,\s*['"]hex['"]\s*\)/.test(src),
    'preload.js must convert vaultKeyHex → Buffer via Buffer.from(hex, "hex")');
  // The bridge must expose merlinFactBinding with onInit.
  assert.ok(/exposeInMainWorld\(\s*['"]merlinFactBinding['"][\s\S]{0,400}onInit/.test(src),
    'preload.js must expose `merlinFactBinding` with an `onInit` method');
});

test('preload.js never re-serialises the Buffer back to hex', () => {
  const src = stripComments(read(PRELOAD_JS));
  // Scan the fact-binding bridge block specifically, then assert it
  // contains no `.toString('hex')` or bare `.toString()` on the
  // vaultKey path.
  const bridgeMatch = src.match(/merlinFactBinding[\s\S]*?ipcRenderer\.removeListener[^\n]*\n[\s\S]{0,120}\}/);
  assert.ok(bridgeMatch, 'could not locate merlinFactBinding bridge block in preload.js');
  const bridgeBlock = bridgeMatch[0];
  assert.ok(!/vaultKey[\s\S]{0,40}\.toString\(/.test(bridgeBlock),
    'preload.js bridge must not call .toString() on vaultKey — that would reconstitute the hex mid-flight');
});

test('preload.js force-on flag is set pre-renderer via exposeInMainWorld', () => {
  const src = stripComments(read(PRELOAD_JS));
  assert.ok(/exposeInMainWorld\(\s*['"]__merlinFactBindingForceOn['"]\s*,\s*true\s*\)/.test(src),
    'preload.js must set __merlinFactBindingForceOn via contextBridge BEFORE renderer.js evaluates ' +
    '(old pattern set it from main.js via executeJavaScript which fires AFTER renderer load — flag never flipped)');
  // And the gate logic that decides to call exposeInMainWorld must read
  // both version.json AND the MERLIN_FACT_BINDING env var.
  assert.ok(/version\.json/.test(src) && /MERLIN_FACT_BINDING/.test(src),
    'preload.js gate must check both version.json and MERLIN_FACT_BINDING env');
});

test('preload.js accepts Uint8Array vaultKey (contextBridge structured-clone shape)', () => {
  const src = stripComments(read(PRELOAD_JS));
  // Before the opaque-handle bridge refactor, the renderer received the
  // raw Uint8Array and normalised it to Buffer locally. Now the renderer
  // only holds an integer handle, and preload does the Uint8Array → Buffer
  // conversion inside `createCache`. The invariant the old test locked
  // (Uint8Array must be a recognised shape) still matters — it just moves
  // from renderer.js to preload.js. Uint8Array arrives when the renderer
  // forwards a typed array through contextBridge's structured clone.
  assert.ok(/vaultKey[\s\S]{0,120}instanceof\s+Uint8Array/.test(src),
    'preload.js createCache must handle Uint8Array vaultKey (renderer-forwarded structured-clone shape). ' +
    'Renderer is no longer responsible for the conversion — preload owns it.');
});

test('renderer.js subscribes via window.merlinFactBinding.onInit', () => {
  const src = stripComments(read(RENDERER_JS));
  // The renderer may hold the bridge reference in a local (e.g.
  // `_factBridge`) after reading it from window.merlinFactBinding at
  // module init — accept either direct property access or a local
  // alias whose binding reads window.merlinFactBinding.
  const direct = /window\.merlinFactBinding\.onInit/.test(src);
  const aliased = /window\.merlinFactBinding/.test(src) && /\.onInit\s*\(/.test(src);
  assert.ok(direct || aliased,
    'renderer.js must consume the preload bridge via window.merlinFactBinding.onInit (direct or via a local alias)');
  // And the legacy global must be gone.
  assert.ok(!/window\.__merlinInitFactBinding\s*=/.test(src),
    'renderer.js must NOT assign initFactBinding to window.__merlinInitFactBinding — the old global was how main.js reached into renderer via executeJavaScript');
});

// ── Opaque-handle bridge surface (new in v1.12.1) ───────────────────
//
// The renderer runs with contextIsolation + nodeIntegration:false, so
// there is no `require`, no `Buffer`, no `fs` inside the renderer JS
// world. Earlier builds did `require('./facts/...')` in renderer.js and
// threw ReferenceError in production — silently swallowed by try/catch.
// Facts modules now live in preload; the renderer calls an opaque-handle
// bridge. These scans lock the surface shape so a refactor can't silently
// fall back to the broken `require`-in-renderer pattern.

test('preload.js exposes createCache / watchFactsFile / runAllPasses / mountCharts / tail quarantine surface', () => {
  const src = stripComments(read(PRELOAD_JS));
  for (const method of [
    'createCache', 'closeCache',
    'watchFactsFile', 'stopWatcher',
    'runAllPasses', 'mountCharts',
    'createTailQuarantine', 'tailPush', 'tailFinalize',
  ]) {
    const re = new RegExp('\\b' + method + '\\s*:\\s*(\\(|function)');
    assert.ok(re.test(src),
      `preload.js merlinFactBinding must expose ${method} (opaque-handle bridge method)`);
  }
});

test('preload.js requires facts modules in Node context (not renderer)', () => {
  const src = stripComments(read(PRELOAD_JS));
  assert.ok(/require\(\s*['"]\.\/facts\/facts-cache['"]\s*\)/.test(src),
    'preload.js must require facts-cache — facts modules belong in preload Node context, not renderer');
  assert.ok(/require\(\s*['"]\.\/facts\/verify-facts['"]\s*\)/.test(src),
    'preload.js must require verify-facts');
  assert.ok(/require\(\s*['"]\.\/facts\/chart-renderer['"]\s*\)/.test(src),
    'preload.js must require chart-renderer');
});

test('renderer.js does NOT require facts modules (no Node globals in isolated world)', () => {
  const src = stripComments(read(RENDERER_JS));
  for (const modPath of ['./facts/facts-cache', './facts/verify-facts', './facts/chart-renderer']) {
    const re = new RegExp("require\\(\\s*['\"]" + modPath.replace(/[.\/]/g, '\\$&') + "['\"]\\s*\\)");
    assert.ok(!re.test(src),
      `renderer.js contains require('${modPath}') — this throws ReferenceError in production (contextIsolation + nodeIntegration:false). Route through preload's merlinFactBinding bridge.`);
  }
});

test('renderer.js does NOT touch Buffer (undefined in isolated world)', () => {
  const src = stripComments(read(RENDERER_JS));
  assert.ok(!/Buffer\.isBuffer/.test(src),
    'renderer.js must not reference Buffer.isBuffer — Buffer is undefined in the isolated world; conversion happens in preload');
  assert.ok(!/Buffer\.from/.test(src),
    'renderer.js must not reference Buffer.from — Buffer is undefined in the isolated world; conversion happens in preload');
});

test('renderer.js never instantiates FactCache / TailQuarantine directly', () => {
  const src = stripComments(read(RENDERER_JS));
  assert.ok(!/new\s+FactCache\s*\(/.test(src),
    'renderer.js must NOT instantiate FactCache — those classes live in preload, renderer holds an opaque integer handle');
  assert.ok(!/new\s+TailQuarantine\s*\(/.test(src),
    'renderer.js must NOT instantiate TailQuarantine — classes live in preload');
});
