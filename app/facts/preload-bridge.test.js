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

test('renderer.js accepts Uint8Array vaultKey (contextBridge structured-clone shape)', () => {
  const src = stripComments(read(RENDERER_JS));
  // After contextBridge clones a Buffer it arrives as Uint8Array in
  // the renderer isolated world. Buffer.isBuffer returns false on a
  // plain Uint8Array, so the renderer must handle both.
  assert.ok(/vaultKey\s+instanceof\s+Uint8Array/.test(src),
    'renderer.js initFactBinding must handle Uint8Array vaultKey (Buffer arrives as Uint8Array post-structured-clone)');
});

test('renderer.js subscribes via window.merlinFactBinding.onInit', () => {
  const src = stripComments(read(RENDERER_JS));
  assert.ok(/window\.merlinFactBinding\.onInit/.test(src),
    'renderer.js must consume the preload bridge via window.merlinFactBinding.onInit');
  // And the legacy global must be gone.
  assert.ok(!/window\.__merlinInitFactBinding\s*=/.test(src),
    'renderer.js must NOT assign initFactBinding to window.__merlinInitFactBinding — the old global was how main.js reached into renderer via executeJavaScript');
});
