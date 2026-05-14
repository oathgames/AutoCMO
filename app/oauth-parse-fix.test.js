// oauth-parse-fix.test.js — regression-guard tests for the
// meta-connect-parse-fix (2026-05-14). Live incident: Meta connection
// succeeded but the renderer modal showed "Failed to parse exchange
// result: Unexpected non-whitespace character after JSON at position 73
// (line 5 column 3)" — a raw JSON.parse error leak that violated
// Hard-Won Security Rule 6 + tanked the connection UX.
//
// Two fixes ship together; both are covered here:
//   1. extractJsonBlock falls back to a brace-balanced scanner when the
//      line-trim heuristic produces invalid JSON (typical: binary
//      printed two complete JSON blocks back-to-back)
//   2. renderer.js friendlyError() catches "Failed to parse exchange
//      result" and emits a sympathetic Reconnect chip instead of
//      passing the raw parse error through verbatim

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractJsonBlock,
  parseLastBalancedJsonObject,
} = require('./oauth-fast-open');

// ─────────────────────────────────────────────────────────────────────────────
// extractJsonBlock — fast path still works on the typical binary output
// ─────────────────────────────────────────────────────────────────────────────

test('extractJsonBlock: fast path handles pretty-printed single JSON object', () => {
  const stdout = [
    '[INFO] starting exchange',
    'Status: ok',
    '{',
    '  "platform": "meta",',
    '  "scope": "ads_management,pages_show_list"',
    '}',
    '',
  ].join('\n');
  const result = extractJsonBlock(stdout);
  assert.strictEqual(result.platform, 'meta');
  assert.strictEqual(result.scope, 'ads_management,pages_show_list');
});

test('extractJsonBlock: handles nested JSON correctly', () => {
  const stdout = [
    'preamble',
    '{',
    '  "ok": true,',
    '  "data": {',
    '    "key": "value"',
    '  }',
    '}',
  ].join('\n');
  const result = extractJsonBlock(stdout);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.key, 'value');
});

// ─────────────────────────────────────────────────────────────────────────────
// extractJsonBlock — robust path handles the pathological inputs that broke
// the fast path in the live incident
// ─────────────────────────────────────────────────────────────────────────────

test('extractJsonBlock: handles two adjacent JSON blocks (the live-incident shape)', () => {
  // Pre-fix: the line-trim heuristic walked from the LAST `}` to the
  // FIRST `{` and concatenated BOTH blocks into the slice. JSON.parse
  // then failed at the start of the second block. The balanced-brace
  // fallback picks just the LAST complete block.
  const stdout = [
    '{',
    '  "stage": "preflight",',
    '  "status": "ok"',
    '}',
    '{',
    '  "platform": "meta",',
    '  "result": "success"',
    '}',
  ].join('\n');
  const result = extractJsonBlock(stdout);
  assert.strictEqual(result.platform, 'meta');
  assert.strictEqual(result.result, 'success');
  // The first block's "stage" key must NOT leak through.
  assert.strictEqual(result.stage, undefined);
});

test('extractJsonBlock: handles JSON followed by a postscript log line', () => {
  // Variant of the live incident — second block is unstructured text,
  // not another JSON object. The fast path would still concatenate
  // garbage into the slice. The fallback recovers.
  const stdout = [
    '{',
    '  "platform": "meta",',
    '  "scope": "ads"',
    '}',
    '[preflight:warn] Merlin isn\'t activated on this device yet.',
  ].join('\n');
  const result = extractJsonBlock(stdout);
  assert.strictEqual(result.platform, 'meta');
});

test('extractJsonBlock: handles JSON with brace characters inside string values', () => {
  // The brace-balanced scanner MUST respect string literals. A `}` inside
  // a string value can't be allowed to close a depth-1 scope.
  const stdout = [
    '{',
    '  "platform": "meta",',
    '  "tip": "fields like {scope} and {token} are part of the URL"',
    '}',
  ].join('\n');
  const result = extractJsonBlock(stdout);
  assert.strictEqual(result.platform, 'meta');
  assert.ok(result.tip.includes('{scope}'));
});

test('extractJsonBlock: handles escaped quotes inside string values', () => {
  // Escaped quotes must NOT toggle the in-string state.
  const stdout = [
    '{',
    '  "platform": "meta",',
    '  "note": "got an error like \\"Bad request\\" from the API"',
    '}',
  ].join('\n');
  const result = extractJsonBlock(stdout);
  assert.strictEqual(result.platform, 'meta');
  assert.ok(result.note.includes('"Bad request"'));
});

test('extractJsonBlock: throws when stdout contains no JSON', () => {
  assert.throws(() => extractJsonBlock('no json here, just text'),
    /no JSON in binary stdout/);
});

test('extractJsonBlock: throws when stdout is empty', () => {
  assert.throws(() => extractJsonBlock(''), /no JSON in binary stdout/);
  assert.throws(() => extractJsonBlock(null), /no JSON in binary stdout/);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseLastBalancedJsonObject — direct tests of the robust scanner
// ─────────────────────────────────────────────────────────────────────────────

test('parseLastBalancedJsonObject: returns the LAST complete block', () => {
  const text = '{"first":1}{"second":2}{"third":3}';
  const result = parseLastBalancedJsonObject(text);
  assert.deepStrictEqual(result, { third: 3 });
});

test('parseLastBalancedJsonObject: handles stray closing brace without crashing', () => {
  // A stray `}` outside any block must not corrupt depth tracking.
  const text = '}{"ok":true}';
  const result = parseLastBalancedJsonObject(text);
  assert.deepStrictEqual(result, { ok: true });
});

test('parseLastBalancedJsonObject: throws on stray opening brace with no close', () => {
  // Unclosed block — no complete block found.
  assert.throws(() => parseLastBalancedJsonObject('{ "no close'),
    /no JSON in binary stdout/);
});

// ─────────────────────────────────────────────────────────────────────────────
// renderer.js friendlyError() — parse error → sympathetic Reconnect chip
// ─────────────────────────────────────────────────────────────────────────────

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

test('renderer friendlyError: catches "Failed to parse exchange result" and emits Reconnect chip', () => {
  // The branch must (a) match the parse-error substring, (b) emit a
  // [[chip:Reconnect <Plat>:...]] sentinel when platformName is known,
  // (c) fall through to a generic sympathetic message when not. Match
  // BEFORE the generic JSON / 5xx branches so the parse-specific copy
  // wins.
  assert.ok(/failed to parse exchange result/i.test(RENDERER_SRC),
    'friendlyError must include a literal-substring match for the parse error');
  assert.ok(/unexpected non-whitespace character after json/i.test(RENDERER_SRC),
    'friendlyError must also match the JSON.parse exception text variant');
  // The branch must produce a Reconnect chip sentinel when platformName
  // is supplied.
  assert.ok(/\[\[chip:Reconnect \$\{plat\}:reconnect:\$\{platLower\}\]\]/.test(RENDERER_SRC),
    'parse-error branch must emit a [[chip:Reconnect <plat>:reconnect:<lower>]] sentinel');
});

test('renderer friendlyError: parse-error branch fires BEFORE the verbatim-passthrough fallback', () => {
  // The pre-fix fallback at the end of friendlyError() passes any
  // ≤150-char error through verbatim. The live-incident error string
  // was 116 chars, well under that ceiling — so the fallback exposed
  // the raw parse error to the user. The new branch must match BEFORE
  // that fallback. Source-scan: find the branch's "Failed to parse
  // exchange result" check and assert the verbatim fallback (`return s`)
  // appears LATER in the file.
  const parseIdx = RENDERER_SRC.indexOf("failed to parse exchange result");
  const fallbackIdx = RENDERER_SRC.indexOf('// ── Final safe fallback ──');
  assert.ok(parseIdx > 0, 'parse-error branch must exist');
  assert.ok(fallbackIdx > 0, 'final fallback must exist');
  assert.ok(parseIdx < fallbackIdx,
    'parse-error branch must come BEFORE the verbatim-passthrough fallback');
});

test('renderer friendlyError: parse-error branch is documented as a regression guard', () => {
  // Future maintainers must know WHY this branch exists — the
  // 2026-05-14 meta-connect-parse-fix incident traces here.
  assert.ok(/meta-connect-parse-fix/.test(RENDERER_SRC),
    'parse-error branch must cite the meta-connect-parse-fix incident anchor');
});

test('oauth-fast-open: extractJsonBlock cites the live-incident anchor', () => {
  const src = fs.readFileSync(path.join(__dirname, 'oauth-fast-open.js'), 'utf8');
  assert.ok(/meta-connect-parse-fix/.test(src),
    'extractJsonBlock must cite the meta-connect-parse-fix incident anchor');
  assert.ok(/parseLastBalancedJsonObject/.test(src),
    'the fallback scanner must be named parseLastBalancedJsonObject');
});
