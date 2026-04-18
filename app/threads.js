// Per-brand conversation threads.
//
// Each brand gets its own Claude Agent SDK session (resumed by sessionId) plus
// a lightweight bubble log used by the renderer to rehydrate the chat when the
// user switches brands. The SDK persists the authoritative transcript at
// ~/.claude/projects/<cwd-hash>/<session_id>.jsonl — this file only stores the
// minimum the UI needs: which session belongs to which brand, plus a flat list
// of user/claude bubbles to re-paint on switch.
//
// File format (threads.json):
//   {
//     "brands": {
//       "<brand-id>": {
//         "sessionId": "<uuid>" | null,
//         "lastActiveAt": "2026-04-18T12:34:56.000Z",
//         "bubbles": [ { "role": "user" | "claude", "text": "...", "ts": epoch_ms } ]
//       }
//     }
//   }
//
// Bubbles are capped at MAX_BUBBLES (oldest pruned first) so the file never
// grows unbounded. The SDK transcript on disk is the source of truth for
// Claude's memory — bubbles are UI-only.

const fs = require('fs');
const path = require('path');

const MAX_BUBBLES = 500;
const MAX_TEXT_LEN = 20000;

function filePath(appRoot) {
  return path.join(appRoot, '.merlin-threads.json');
}

function read(appRoot) {
  try {
    const raw = fs.readFileSync(filePath(appRoot), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { brands: {} };
    if (!parsed.brands || typeof parsed.brands !== 'object') parsed.brands = {};
    return parsed;
  } catch {
    return { brands: {} };
  }
}

function write(appRoot, data) {
  try {
    const full = filePath(appRoot);
    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, full);
    return true;
  } catch (e) {
    console.error('[threads] write failed:', e.message);
    return false;
  }
}

function ensureBrand(data, brand) {
  if (!data.brands[brand]) {
    data.brands[brand] = { sessionId: null, lastActiveAt: null, bubbles: [] };
  }
  const b = data.brands[brand];
  if (!Array.isArray(b.bubbles)) b.bubbles = [];
  if (typeof b.sessionId !== 'string' && b.sessionId !== null) b.sessionId = null;
  return b;
}

function getThread(appRoot, brand) {
  if (!brand) return { sessionId: null, lastActiveAt: null, bubbles: [] };
  const data = read(appRoot);
  return { ...ensureBrand(data, brand) };
}

function getSessionId(appRoot, brand) {
  if (!brand) return null;
  const data = read(appRoot);
  return ensureBrand(data, brand).sessionId || null;
}

function setSessionId(appRoot, brand, sessionId) {
  if (!brand || typeof sessionId !== 'string' || !sessionId) return false;
  const data = read(appRoot);
  const entry = ensureBrand(data, brand);
  if (entry.sessionId === sessionId) return true;
  entry.sessionId = sessionId;
  entry.lastActiveAt = new Date().toISOString();
  return write(appRoot, data);
}

function touch(appRoot, brand) {
  if (!brand) return false;
  const data = read(appRoot);
  const entry = ensureBrand(data, brand);
  entry.lastActiveAt = new Date().toISOString();
  return write(appRoot, data);
}

function appendBubble(appRoot, brand, role, text) {
  if (!brand) return false;
  if (role !== 'user' && role !== 'claude') return false;
  if (typeof text !== 'string' || !text.length) return false;
  const trimmed = text.length > MAX_TEXT_LEN ? text.slice(0, MAX_TEXT_LEN) : text;
  const data = read(appRoot);
  const entry = ensureBrand(data, brand);
  entry.bubbles.push({ role, text: trimmed, ts: Date.now() });
  if (entry.bubbles.length > MAX_BUBBLES) {
    entry.bubbles = entry.bubbles.slice(-MAX_BUBBLES);
  }
  entry.lastActiveAt = new Date().toISOString();
  return write(appRoot, data);
}

function clearThread(appRoot, brand) {
  if (!brand) return false;
  const data = read(appRoot);
  if (!data.brands[brand]) return true;
  data.brands[brand] = { sessionId: null, lastActiveAt: null, bubbles: [] };
  return write(appRoot, data);
}

function listBrands(appRoot) {
  const data = read(appRoot);
  return Object.keys(data.brands);
}

module.exports = {
  MAX_BUBBLES,
  MAX_TEXT_LEN,
  filePath,
  read,
  write,
  getThread,
  getSessionId,
  setSessionId,
  touch,
  appendBubble,
  clearThread,
  listBrands,
};
