// main-spellbook-rollback.test.js
//
// Pins the toggle-spell rollback contract. The 2026-04-27 RSI audit's
// independent scorer caught a real gap: the toggle handler updated
// merlin-config.json's `enabled` field BEFORE the daemon write returned.
// On daemon failure, the local config stayed mutated — a force-quit
// before the next loadSpells would persist a UI-only flip while the
// daemon kept the OLD state. That's exactly the "drift" the RSI is
// supposed to eliminate.
//
// We can't run the IPC handler directly without Electron, so this test
// performs a structural source-scan: the handler MUST capture the prior
// `enabled` value, attempt the daemon write, AND roll back the local
// config on every failure path. If anyone removes the rollback or
// re-orders the capture, the test fails loudly.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadHandlerSource() {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  // Extract the body of the toggle-spell IPC handler by anchoring on
  // ipcMain.handle('toggle-spell' and walking forward with a balanced-
  // paren counter. Strings and comments are tracked so braces inside
  // them don't throw the depth count off.
  const start = src.indexOf("ipcMain.handle('toggle-spell'");
  assert.ok(start !== -1, 'toggle-spell handler not found in main.js');
  const after = src.slice(start);

  let depth = 0;
  let inStr = false;
  let escape = false;
  let strCh = '';
  let inLineComment = false;
  let inBlockComment = false;
  let started = false;
  let endIdx = -1;
  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    const next = after[i + 1];
    if (escape) { escape = false; continue; }
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') escape = true;
      else if (c === strCh) inStr = false;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === '\'' || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; started = true; }
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (started && depth === 0) { endIdx = i; break; }
    }
  }
  assert.ok(endIdx !== -1, 'toggle-spell handler closing brace not found');
  return after.slice(0, endIdx + 1);
}

test('REGRESSION GUARD (2026-04-27): toggle-spell captures prevEnabled before mutating local config', () => {
  const body = loadHandlerSource();
  // The capture must happen BEFORE updateSpellConfig({ enabled }) is
  // called — otherwise reading "previous" returns the new value.
  const captureIdx = body.search(/const\s+prevEnabled\s*=/);
  const writeIdx = body.search(/updateSpellConfig\([^)]*\{[^}]*\benabled\b/);
  assert.ok(captureIdx !== -1, 'prevEnabled capture not found');
  assert.ok(writeIdx !== -1, 'updateSpellConfig write not found');
  assert.ok(captureIdx < writeIdx,
    `prevEnabled capture must precede the local config write — capture@${captureIdx} write@${writeIdx}`);
});

test('REGRESSION GUARD (2026-04-27): toggle-spell rolls back local config on daemon throw', () => {
  const body = loadHandlerSource();
  // The catch block around the daemon call must contain a rollback that
  // re-writes the prior `enabled` value. We look for the pattern
  // `updateSpellConfig(taskId, { enabled: prevEnabled })` inside any
  // catch block in the handler body.
  const catchBlocks = body.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/g) || [];
  const hasRollback = catchBlocks.some((blk) =>
    /updateSpellConfig\([^)]*\benabled\s*:\s*prevEnabled/.test(blk),
  );
  assert.ok(hasRollback,
    'no catch block in toggle-spell calls updateSpellConfig with enabled: prevEnabled');
});

test('REGRESSION GUARD (2026-04-27): toggle-spell rolls back local config on daemon non-ok return', () => {
  const body = loadHandlerSource();
  // After the daemonResult.ok happy-path early return, the unhappy-path
  // tail MUST roll back. Locate the early-return block, then check the
  // tail for a rollback call.
  const successReturnIdx = body.search(/synced:\s*true/);
  assert.ok(successReturnIdx !== -1, 'success return not found');
  const tail = body.slice(successReturnIdx);
  assert.ok(
    /updateSpellConfig\([^)]*\benabled\s*:\s*prevEnabled/.test(tail),
    'unhappy-path tail of toggle-spell must call updateSpellConfig({ enabled: prevEnabled }) before returning'
  );
});

test('REGRESSION GUARD (2026-04-27): toggle-spell handler is async (must await daemon)', () => {
  const body = loadHandlerSource();
  // The handler MUST be declared async so it can await the daemon call.
  // A regression to `(_, taskId, enabled) =>` (sync) would silently make
  // the handler return a Promise that the IPC layer mis-handles.
  assert.ok(/ipcMain\.handle\('toggle-spell'\s*,\s*async\s*\(/.test(body),
    'toggle-spell IPC handler must be declared async');
});

test('REGRESSION GUARD (2026-04-27): toggle-spell + create-spell + delete-spell all use scheduledTasksDaemon module', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  // The module require must be at the top of main.js; without it the
  // handlers below silently fall back to the broken LLM path on
  // future re-routes.
  assert.ok(
    /require\(\s*['"]\.\/scheduled-tasks-daemon['"]\s*\)/.test(src),
    'main.js must require ./scheduled-tasks-daemon'
  );
  // Each handler should reach into the module — toggle-spell via
  // setEnabled, create-spell via registerOrUpdateTask, delete-spell via
  // removeTask. Source-scanning these confirms the rewire is in place.
  assert.ok(/scheduledTasksDaemon\.setEnabled\(/.test(src),
    'toggle-spell must call scheduledTasksDaemon.setEnabled');
  assert.ok(/scheduledTasksDaemon\.registerOrUpdateTask\(/.test(src),
    'create-spell must call scheduledTasksDaemon.registerOrUpdateTask');
  assert.ok(/scheduledTasksDaemon\.removeTask\(/.test(src),
    'delete-spell must call scheduledTasksDaemon.removeTask');
});
