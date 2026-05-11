// Source-scan regression guard for the merlin:// protocol handler's
// Windows path case-insensitivity fix.
//
// REGRESSION GUARD (2026-05-11, image-unavailable-windows-case incident):
// Live user report: every image card in chat renders as "Image unavailable"
// even with v1.22.0's fixes for the 0-byte race (main-merlin-protocol-0byte
// .test.js) and the IMG retry path (gallery-viewer.test.js). Root cause was
// a Windows-only path case-sensitivity mismatch between two case-equivalent
// forms of the same canonical path: filePath came from `path.resolve(appRoot,
// requested)` where `requested` was an absolute path the Go binary emitted
// preserving the filesystem's case (e.g. C:\\Users\\Ryan\\Merlin\\...), and
// resolvedRoot came from `path.resolve(appRoot)` where appRoot is built from
// os.homedir() / process.env.USERPROFILE, which on Windows can return a
// different case for the same path (e.g. C:\\Users\\RYAN\\Merlin). The
// containment check `filePath.startsWith(resolvedRoot + path.sep)` is a
// case-sensitive JS string operation and returned false — handler 403'd,
// every retry from gallery-viewer.js hit the same 403, "Image unavailable"
// placeholder rendered. macOS and Linux were unaffected because their
// filesystems are case-sensitive (and os.homedir() / $HOME agree).
//
// Fix: introduce `pathContains` and `pathEquals` helpers that lowercase
// both sides before comparing on win32 only. The MIME-type and existence
// checks still gate access — only the prefix/equality string comparisons
// are loosened, which is sound because the underlying filesystem already
// treats those names case-insensitively.
//
// This test source-scans main.js to lock the fix in. The 0-byte test
// (main-merlin-protocol-0byte.test.js) verifies the retry surface; this
// test verifies the contain-ment check that gates that surface.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function getMerlinHandler() {
  const handlerStart = MAIN_JS.indexOf("protocol.handle('merlin'");
  assert.ok(handlerStart > 0, "protocol.handle('merlin', ...) must exist");
  // Take a slice that covers the helpers (defined just above the handler)
  // through the rest of the handler body.
  const helpersStart = MAIN_JS.lastIndexOf('REGRESSION GUARD (2026-05-11', handlerStart);
  assert.ok(helpersStart > 0, 'REGRESSION GUARD (2026-05-11, ...) comment must precede the handler');
  return MAIN_JS.slice(helpersStart, handlerStart + 6000);
}

test('merlin:// handler uses case-insensitive path containment on Windows', () => {
  const region = getMerlinHandler();

  // The two helpers must exist and branch on process.platform === 'win32'.
  assert.ok(/const\s+pathContains\s*=\s*\(/.test(region),
    'pathContains helper must be defined before the handler');
  assert.ok(/const\s+pathEquals\s*=\s*\(/.test(region),
    'pathEquals helper must be defined before the handler');

  // pathContains must lowercase BOTH sides on win32 (a one-sided
  // lowercase would still 403 the other direction).
  const pathContainsMatch = region.match(/const\s+pathContains\s*=\s*\([\s\S]*?\};/);
  assert.ok(pathContainsMatch, 'pathContains body must parse');
  const body = pathContainsMatch[0];
  assert.ok(/process\.platform\s*===\s*['"]win32['"]/.test(body),
    'pathContains must branch on process.platform === "win32"');
  assert.ok(/haystack\.toLowerCase\(\)/.test(body) && /needle\.toLowerCase\(\)/.test(body),
    'pathContains must lowercase BOTH haystack and needle on win32');

  // Same for pathEquals.
  const pathEqualsMatch = region.match(/const\s+pathEquals\s*=\s*\([\s\S]*?\};/);
  assert.ok(pathEqualsMatch, 'pathEquals body must parse');
  const eqBody = pathEqualsMatch[0];
  assert.ok(/process\.platform\s*===\s*['"]win32['"]/.test(eqBody),
    'pathEquals must branch on process.platform === "win32"');
  assert.ok(/a\.toLowerCase\(\)/.test(eqBody) && /b\.toLowerCase\(\)/.test(eqBody),
    'pathEquals must lowercase BOTH sides on win32');
});

test('merlin:// handler containment checks route through pathContains/pathEquals (no raw startsWith on paths)', () => {
  const region = getMerlinHandler();

  // The containment + equality checks must use the helpers, not raw
  // String.startsWith / === on the path strings.
  assert.ok(/pathContains\(filePath,\s*resolvedRoot\s*\+\s*path\.sep\)/.test(region),
    'appRoot containment check must use pathContains(filePath, resolvedRoot + path.sep)');
  assert.ok(/pathEquals\(filePath,\s*resolvedRoot\)/.test(region),
    'appRoot equality check must use pathEquals(filePath, resolvedRoot)');
  assert.ok(/ALLOWED_MERLIN_ROOTS\.some\(\(r\)\s*=>\s*pathContains\(filePath,\s*r\)\)/.test(region),
    'ALLOWED_MERLIN_ROOTS check must use pathContains(filePath, r), not filePath.startsWith(r)');

  // Defense-in-depth: the OLD raw-startsWith forms must NOT be present
  // anywhere in this region — otherwise a partial revert would silently
  // re-introduce the bug.
  const oldRootCheck = /filePath\.startsWith\(resolvedRoot\s*\+\s*path\.sep\)/;
  const oldRootsCheck = /ALLOWED_MERLIN_ROOTS\.some\(\(r\)\s*=>\s*filePath\.startsWith\(r\)\)/;
  assert.ok(!oldRootCheck.test(region),
    'old case-sensitive filePath.startsWith(resolvedRoot + sep) check must not be present');
  assert.ok(!oldRootsCheck.test(region),
    'old case-sensitive ALLOWED_MERLIN_ROOTS startsWith(r) check must not be present');
});

test('REGRESSION GUARD comment names the image-unavailable-windows-case incident', () => {
  const region = getMerlinHandler();
  assert.ok(/REGRESSION GUARD \(2026-05-11/.test(region),
    'REGRESSION GUARD comment with the 2026-05-11 date anchor must be present');
  assert.ok(/image-unavailable-windows-case/.test(region),
    'REGRESSION GUARD comment must name the incident slug');
  assert.ok(/case-insensitive/i.test(region),
    'REGRESSION GUARD must explain it loosens to case-insensitive matching');
});

test('pathContains / pathEquals do NOT loosen on non-Windows platforms', () => {
  const region = getMerlinHandler();
  // On macOS / Linux the comparison must remain byte-exact — those
  // filesystems ARE case-sensitive, so silently lowercasing would
  // create a containment-bypass on case-distinct neighbouring paths
  // (e.g. /Users/x/Merlin/results vs /Users/X/Merlin-Bad/results).
  const pathContainsBody = region.match(/const\s+pathContains\s*=\s*\([\s\S]*?\};/)[0];
  // The non-win32 branch must do raw startsWith — not a lowercased one.
  assert.ok(/return haystack\.startsWith\(needle\);/.test(pathContainsBody),
    'non-win32 branch of pathContains must do raw byte-exact startsWith');

  const pathEqualsBody = region.match(/const\s+pathEquals\s*=\s*\([\s\S]*?\};/)[0];
  assert.ok(/return a === b;/.test(pathEqualsBody),
    'non-win32 branch of pathEquals must do raw === byte-exact comparison');
});
