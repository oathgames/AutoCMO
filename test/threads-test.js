#!/usr/bin/env node
// test/threads-test.js
//
// Unit tests for app/threads.js — the per-brand conversation thread store.
// Run with `node test/threads-test.js`. Exits non-zero on any failure.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const threads = require('../app/threads');

let passed = 0;
let failed = 0;
const errors = [];

function assert(cond, label) {
  if (cond) { passed++; return; }
  failed++;
  errors.push(label);
  console.error('  FAIL:', label);
}

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; return; }
  failed++;
  errors.push(`${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  console.error('  FAIL:', label, '→ expected', JSON.stringify(expected), 'got', JSON.stringify(actual));
}

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-threads-'));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Test: empty read returns skeleton ────────────────────────
(function testEmptyRead() {
  const dir = makeTmp();
  try {
    const data = threads.read(dir);
    assertEq(data, { brands: {} }, 'empty read returns {brands: {}}');
    const thread = threads.getThread(dir, 'acme');
    assertEq(thread.bubbles, [], 'getThread on unknown brand returns empty bubbles');
    assertEq(thread.sessionId, null, 'getThread on unknown brand returns null sessionId');
  } finally { cleanup(dir); }
})();

// ── Test: sessionId roundtrip ────────────────────────────────
(function testSessionIdRoundtrip() {
  const dir = makeTmp();
  try {
    const ok = threads.setSessionId(dir, 'acme', '550e8400-e29b-41d4-a716-446655440000');
    assert(ok, 'setSessionId returns true');
    assertEq(threads.getSessionId(dir, 'acme'), '550e8400-e29b-41d4-a716-446655440000', 'getSessionId reads what we wrote');
    // Different brand, no leakage
    assertEq(threads.getSessionId(dir, 'other'), null, 'sessionId does not leak across brands');
  } finally { cleanup(dir); }
})();

// ── Test: bubble append + ordering ───────────────────────────
(function testBubbleAppend() {
  const dir = makeTmp();
  try {
    threads.appendBubble(dir, 'acme', 'user', 'hello');
    threads.appendBubble(dir, 'acme', 'claude', 'hi there');
    threads.appendBubble(dir, 'acme', 'user', 'what is ROAS?');
    const thread = threads.getThread(dir, 'acme');
    assertEq(thread.bubbles.length, 3, 'three bubbles persisted');
    assertEq(thread.bubbles[0].role, 'user', 'first bubble is user');
    assertEq(thread.bubbles[0].text, 'hello', 'first bubble text matches');
    assertEq(thread.bubbles[1].role, 'claude', 'second bubble is claude');
    assertEq(thread.bubbles[2].text, 'what is ROAS?', 'third bubble text matches');
  } finally { cleanup(dir); }
})();

// ── Test: per-brand isolation ────────────────────────────────
(function testBrandIsolation() {
  const dir = makeTmp();
  try {
    threads.appendBubble(dir, 'brandA', 'user', 'A-message');
    threads.appendBubble(dir, 'brandB', 'user', 'B-message');
    threads.appendBubble(dir, 'brandA', 'claude', 'A-reply');
    const a = threads.getThread(dir, 'brandA');
    const b = threads.getThread(dir, 'brandB');
    assertEq(a.bubbles.length, 2, 'brandA has 2 bubbles');
    assertEq(b.bubbles.length, 1, 'brandB has 1 bubble');
    assertEq(a.bubbles[0].text, 'A-message', 'brandA first bubble is A-message');
    assertEq(b.bubbles[0].text, 'B-message', 'brandB first bubble is B-message');
  } finally { cleanup(dir); }
})();

// ── Test: bubble cap enforces oldest-prune ───────────────────
(function testBubbleCap() {
  const dir = makeTmp();
  try {
    const cap = threads.MAX_BUBBLES;
    for (let i = 0; i < cap + 10; i++) {
      threads.appendBubble(dir, 'acme', 'user', `msg-${i}`);
    }
    const thread = threads.getThread(dir, 'acme');
    assertEq(thread.bubbles.length, cap, `bubbles capped at MAX_BUBBLES=${cap}`);
    // Oldest pruned: first bubble should be msg-10, last should be msg-(cap+9)
    assertEq(thread.bubbles[0].text, 'msg-10', 'oldest bubbles pruned when over cap');
    assertEq(thread.bubbles[thread.bubbles.length - 1].text, `msg-${cap + 9}`, 'most recent bubble retained');
  } finally { cleanup(dir); }
})();

// ── Test: invalid inputs silently rejected ────────────────────
(function testInputValidation() {
  const dir = makeTmp();
  try {
    assert(!threads.appendBubble(dir, '', 'user', 'hi'), 'empty brand rejected');
    assert(!threads.appendBubble(dir, 'acme', 'system', 'hi'), 'unknown role rejected');
    assert(!threads.appendBubble(dir, 'acme', 'user', ''), 'empty text rejected');
    assert(!threads.setSessionId(dir, 'acme', ''), 'empty sessionId rejected');
    assert(!threads.setSessionId(dir, '', 'uuid'), 'empty brand for setSessionId rejected');
    // File should not have been created
    const filePath = threads.filePath(dir);
    assert(!fs.existsSync(filePath) || threads.read(dir).brands.acme === undefined,
      'invalid ops do not create bogus brand entries');
  } finally { cleanup(dir); }
})();

// ── Test: clearThread resets ──────────────────────────────────
(function testClearThread() {
  const dir = makeTmp();
  try {
    threads.setSessionId(dir, 'acme', 'uuid-1');
    threads.appendBubble(dir, 'acme', 'user', 'hello');
    threads.clearThread(dir, 'acme');
    const thread = threads.getThread(dir, 'acme');
    assertEq(thread.sessionId, null, 'clearThread nulls sessionId');
    assertEq(thread.bubbles, [], 'clearThread empties bubbles');
  } finally { cleanup(dir); }
})();

// ── Test: text truncation at MAX_TEXT_LEN ────────────────────
(function testTextTruncation() {
  const dir = makeTmp();
  try {
    const big = 'x'.repeat(threads.MAX_TEXT_LEN + 500);
    threads.appendBubble(dir, 'acme', 'claude', big);
    const thread = threads.getThread(dir, 'acme');
    assertEq(thread.bubbles[0].text.length, threads.MAX_TEXT_LEN, 'text truncated to MAX_TEXT_LEN');
  } finally { cleanup(dir); }
})();

// ── Test: atomic write survives corruption ───────────────────
(function testCorruptionRecovery() {
  const dir = makeTmp();
  try {
    const filePath = threads.filePath(dir);
    fs.writeFileSync(filePath, 'not valid json {{{');
    const data = threads.read(dir);
    assertEq(data, { brands: {} }, 'corrupt file reads as empty skeleton');
    // Subsequent writes overwrite the corruption
    threads.appendBubble(dir, 'acme', 'user', 'recovered');
    const thread = threads.getThread(dir, 'acme');
    assertEq(thread.bubbles.length, 1, 'recovered after corruption');
  } finally { cleanup(dir); }
})();

// ── Summary ──────────────────────────────────────────────────
console.log(`\nthreads-test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
process.exit(0);
