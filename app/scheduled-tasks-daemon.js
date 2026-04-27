// scheduled-tasks-daemon.js
//
// Direct, deterministic, ZERO-LLM file-IO module that synchronises Merlin's
// Spellbook state with the Claude Code Desktop scheduled-tasks daemon.
//
// ─── Why this module exists ──────────────────────────────────────────────
//
// The Spellbook used to update merlin-config.json's `enabled` flag locally
// and then ASK CLAUDE (via an SDK message) to call
// `mcp__scheduled-tasks__update_scheduled_task`. That path is:
//   - non-deterministic (the model may refuse "silent" actions, get the
//     prefix wrong, or hallucinate "the tool doesn't exist")
//   - blocked when no SDK turn is active (queue cap → silent drop)
//   - blocked when the SDK session lacks the scheduled-tasks MCP server
//     (Merlin's SDK only registers `merlin` as an MCP server)
//
// Symptom users see: clicking Disable on a default-on spell triggers
//   "I can't do that. There's no update_scheduled_task tool, and I won't
//    take silent action on scheduled tasks."
// — and the daemon keeps firing the spell every cycle while the UI
// confidently shows it as Off. That is *drift*, the worst possible state.
//
// This module replaces the LLM hop with deterministic file IO against the
// daemon's authoritative state file.
//
// ─── Daemon state file format ────────────────────────────────────────────
//
// Claude Code Desktop persists registered scheduled tasks in:
//
//   Windows : %APPDATA%\Claude\claude-code-sessions\<UUID>\<UUID>\scheduled-tasks.json
//   macOS   : ~/Library/Application Support/Claude/claude-code-sessions/<UUID>/<UUID>/scheduled-tasks.json
//   Linux   : ~/.config/Claude/claude-code-sessions/<UUID>/<UUID>/scheduled-tasks.json
//
// The two UUID levels appear to identify the install/profile pair. There
// is exactly one scheduled-tasks.json per install. Schema observed:
//
//   {
//     "scheduledTasks": [
//       {
//         "id": "merlin-pog-morning-briefing",
//         "cronExpression": "26 5 * * 1-5",
//         "enabled": true,
//         "filePath": "C:\\Users\\…\\.claude\\scheduled-tasks\\<id>\\SKILL.md",
//         "createdAt": 1773860928673,
//         "lastRunAt": "2026-04-27T13:00:47.925Z",
//         "lastScheduledFor": "2026-04-27T12:57:00.000Z",
//         "cwd": "D:\\autoCMO-claude",
//         "approvedPermissions": [{ "toolName": "Bash" }, …],
//         "notifySessionId": "local_<UUID>"
//       },
//       …
//     ]
//   }
//
// Forward-compat rule: when we update an entry we PRESERVE every unknown
// field on the existing entry (lastRunAt, approvedPermissions, etc.) and
// only overwrite the keys we own (enabled, cronExpression, filePath, cwd,
// id, createdAt). When we INSERT a new entry we set only the minimum
// required keys; the daemon fills in lastRunAt/lastScheduledFor on first
// fire.
//
// ─── Concurrency model ───────────────────────────────────────────────────
//
// Claude Code Desktop owns this file: it writes lastRunAt after each run
// and lastScheduledFor when arming the next fire. We must:
//   1. Re-read the file inside our lock to avoid clobbering daemon writes.
//   2. Use atomic temp+rename so a half-written file is never observed.
//   3. Acquire an OS-friendly best-effort lock (.scheduled-tasks.json.lock
//      sentinel file with mtime check + retry) to serialise concurrent
//      Merlin operations across instances.
//
// Each public mutation (registerOrUpdateTask, setEnabled, removeTask) is
// a single read-modify-write transaction guarded by the lock. The lock is
// best-effort, not strict — if the daemon stomps our write within the
// race window we self-heal on the next read by detecting the divergence
// and surfacing it to the caller.
//
// ─── Verify-after-write contract ─────────────────────────────────────────
//
// Every mutation re-reads the file after writing and confirms the change
// landed. The return value carries `{ ok, verified, drift?, error? }` so
// the IPC handler can surface drift to the user with a friendly retry
// button — the opposite of today's "synced: false" silent-drop path.
//
// REGRESSION GUARD (2026-04-27, spellbook-rsi):
// The toggle/create paths must NEVER fall back to sending a Claude SDK
// message asking the model to call update_scheduled_task. That path was
// the source of the original "There's no update_scheduled_task tool"
// refusal. If you find yourself reintroducing it because "the daemon
// file is missing": instead, surface a friendly install prompt to the
// user (see daemonAvailability()).
//
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// File names + sentinels — kept here so they can't drift between
// production code and tests.
const STATE_FILENAME = 'scheduled-tasks.json';
const LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 30_000; // a stale lock older than this is overridden

// Lock-acquisition retry parameters. The lock is held only for the
// duration of one read-modify-write — typically <50ms — so retries are
// short and cheap.
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_MAX = 80; // ~2s total budget

// ─── Path discovery ──────────────────────────────────────────────────────

/**
 * Build the OS-specific list of candidate parent directories that may
 * contain a Claude Code Desktop install's `claude-code-sessions` tree.
 *
 * Returns an array — first entry is the canonical location, subsequent
 * entries are fallbacks. We return paths even if they don't exist; the
 * caller filters with statSync.
 *
 * Override via `MERLIN_SCHEDULED_TASKS_ROOT` for tests + sandboxed envs.
 */
function candidateRoots() {
  const override = process.env.MERLIN_SCHEDULED_TASKS_ROOT;
  if (override) return [override];

  const home = os.homedir();
  const platform = process.platform;
  const roots = [];

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(appData, 'Claude', 'claude-code-sessions'));
  } else if (platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'));
  } else {
    // Linux + everything else falls through to XDG-ish locations.
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    roots.push(path.join(xdg, 'Claude', 'claude-code-sessions'));
  }
  return roots;
}

/**
 * Find the canonical scheduled-tasks.json path for this user, OR null if
 * no Claude Code Desktop install was discovered. Matches:
 *
 *   <root>/<outer-uuid>/<inner-uuid>/scheduled-tasks.json
 *
 * If multiple install-pairs exist, the most recently modified file wins
 * (Claude Code Desktop touches the file on every daemon write, so the
 * newest one is the active install). Errors during discovery degrade to
 * null — never throw — so a missing or unreadable directory shows the
 * user a friendly "install Claude Code Desktop" prompt instead of a
 * crash.
 */
function findStateFile() {
  const roots = candidateRoots();
  let best = null;
  let bestMtime = 0;
  for (const root of roots) {
    let outerEntries;
    try {
      outerEntries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const outer of outerEntries) {
      if (!outer.isDirectory()) continue;
      const outerPath = path.join(root, outer.name);
      let innerEntries;
      try {
        innerEntries = fs.readdirSync(outerPath, { withFileTypes: true });
      } catch { continue; }
      for (const inner of innerEntries) {
        if (!inner.isDirectory()) continue;
        const candidate = path.join(outerPath, inner.name, STATE_FILENAME);
        let stat;
        try { stat = fs.statSync(candidate); } catch { continue; }
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = candidate;
        }
      }
    }
  }
  return best;
}

/**
 * Public availability check used by the renderer to gate the "schedule
 * spells" UX. Returns:
 *   { available: true,  path: '<absolute path>' }
 *   { available: false, reason: 'no-install' | 'unreadable' | 'malformed' }
 *
 * No throws — every error path maps to a friendly reason code so the
 * renderer can render copy without parsing exceptions.
 */
function daemonAvailability() {
  const p = findStateFile();
  if (!p) return { available: false, reason: 'no-install' };
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== 'object') {
      return { available: false, reason: 'malformed', path: p };
    }
    return { available: true, path: p };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { available: false, reason: 'no-install' };
    if (e instanceof SyntaxError) return { available: false, reason: 'malformed', path: p };
    return { available: false, reason: 'unreadable', path: p };
  }
}

// ─── Locking ─────────────────────────────────────────────────────────────

/**
 * Attempt to acquire the lock. Best-effort, not strict: a stale lock older
 * than LOCK_STALE_MS is broken (the holder presumably crashed). Returns
 * a release() function on success, or null on contention timeout.
 *
 * The lock is a sentinel file with O_CREAT | O_EXCL semantics. We don't
 * rely on flock(2) because Node has no built-in cross-platform flock and
 * the daemon doesn't use one anyway — we just need to serialise Merlin's
 * own concurrent toggles within the same install.
 */
async function acquireLock(stateFile) {
  const lockPath = stateFile + LOCK_SUFFIX;
  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      // Caller must release. unlink swallows ENOENT so double-release is
      // safe (a lock that's already gone — e.g. because we broke a stale
      // one — is logically equivalent to released).
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* ignore — already released */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Lock exists. Check if it's stale (holder crashed without unlock).
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Stale — break it. Subsequent attempt will create afresh.
          try { fs.unlinkSync(lockPath); } catch { /* race with another breaker */ }
          continue;
        }
      } catch { /* lock vanished between EEXIST and stat — retry */ }
      await new Promise((res) => setTimeout(res, LOCK_RETRY_DELAY_MS));
    }
  }
  return null;
}

// ─── Read / write helpers ────────────────────────────────────────────────

/**
 * Read and parse the state file. On any failure returns
 * { tasks: [], path: null, error: <reason> } so callers don't have to
 * try/catch around every call. Callers that mutate must check `error`
 * before assuming `tasks` is authoritative.
 */
function readState(stateFile) {
  if (!stateFile) return { tasks: [], path: null, error: 'no-install' };
  let raw;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { tasks: [], path: stateFile, error: null };
    return { tasks: [], path: stateFile, error: 'unreadable' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { tasks: [], path: stateFile, error: 'malformed' }; }
  if (!parsed || typeof parsed !== 'object') {
    return { tasks: [], path: stateFile, error: 'malformed' };
  }
  const tasks = Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
  // Clone parsed so callers can mutate the returned `raw` object without
  // affecting our internal cache (we don't have one yet, but this keeps
  // future caching safe). JSON.parse already creates a fresh object, but
  // we copy the unknown top-level keys explicitly so the writer can
  // round-trip them untouched.
  const otherKeys = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== 'scheduledTasks') otherKeys[k] = v;
  }
  return { tasks, path: stateFile, error: null, otherKeys };
}

/**
 * Atomic write: tmp + rename. Preserves any unknown top-level keys the
 * file had (forward-compat with future Claude Code Desktop schema
 * additions). The temp filename includes the pid + a random suffix so
 * concurrent writers can't collide on the same temp path.
 */
function writeState(stateFile, tasks, otherKeys) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { ...(otherKeys || {}), scheduledTasks: tasks };
  const json = JSON.stringify(payload, null, 2);
  const suffix = `.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = stateFile + suffix;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

// ─── Validation ──────────────────────────────────────────────────────────

// Mirrors create-spell's stricter task-ID rule. Path-traversal and shell-
// meta chars are rejected before we use the value as a filesystem path.
const TASK_ID_RE = /^merlin-[a-z0-9_-]+$/i;
const TASK_ID_MAX = 200;

function isValidTaskId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= TASK_ID_MAX && TASK_ID_RE.test(id);
}

// ─── Public mutators ─────────────────────────────────────────────────────

/**
 * Register a NEW spell with the daemon, OR update an existing entry's
 * cronExpression/filePath/cwd in-place. Idempotent.
 *
 *   id          required, must match TASK_ID_RE
 *   cron        required, 5-field cron string
 *   filePath    required, absolute path to the SKILL.md
 *   cwd         required, working directory the daemon should run from
 *   enabled     optional, defaults true on insert; preserved on update
 *
 * Returns:
 *   { ok: true,  verified: true, action: 'inserted'|'updated'|'unchanged' }
 *   { ok: false, reason: 'no-install' | 'lock-timeout' | 'unreadable'
 *                       | 'malformed' | 'verify-mismatch' | 'invalid-id' }
 */
async function registerOrUpdateTask({ id, cron, filePath, cwd, enabled }) {
  if (!isValidTaskId(id)) return { ok: false, reason: 'invalid-id' };
  if (typeof cron !== 'string' || !cron.trim()) return { ok: false, reason: 'invalid-cron' };
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, reason: 'invalid-filepath' };
  if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, reason: 'invalid-cwd' };

  const stateFile = findStateFile();
  if (!stateFile) return { ok: false, reason: 'no-install' };

  const release = await acquireLock(stateFile);
  if (!release) return { ok: false, reason: 'lock-timeout' };
  try {
    const { tasks, otherKeys, error } = readState(stateFile);
    if (error === 'unreadable') return { ok: false, reason: 'unreadable' };
    if (error === 'malformed') return { ok: false, reason: 'malformed' };

    const idx = tasks.findIndex((t) => t && t.id === id);
    let action;
    if (idx === -1) {
      tasks.push({
        id,
        cronExpression: cron,
        enabled: enabled === false ? false : true,
        filePath,
        cwd,
        createdAt: Date.now(),
      });
      action = 'inserted';
    } else {
      const existing = tasks[idx];
      // Preserve everything we don't own (lastRunAt, approvedPermissions,
      // notifySessionId, etc.) so the daemon's runtime metadata isn't
      // wiped when Merlin re-registers an existing task.
      const merged = {
        ...existing,
        cronExpression: cron,
        filePath,
        cwd,
      };
      if (enabled === true || enabled === false) merged.enabled = enabled;
      // Detect no-op so the verify-after-write step doesn't false-positive
      // a "drift" warning when nothing actually changed.
      const same = (
        existing.cronExpression === merged.cronExpression
        && existing.filePath === merged.filePath
        && existing.cwd === merged.cwd
        && existing.enabled === merged.enabled
      );
      if (same) action = 'unchanged';
      else { tasks[idx] = merged; action = 'updated'; }
    }

    if (action !== 'unchanged') writeState(stateFile, tasks, otherKeys);

    // Verify-after-write: re-read and confirm the entry exists with the
    // expected values. If the daemon raced us between rename and read,
    // we surface the drift instead of declaring success.
    const verify = readState(stateFile);
    const verifyEntry = verify.tasks.find((t) => t && t.id === id);
    if (!verifyEntry) return { ok: false, reason: 'verify-mismatch' };
    if (verifyEntry.cronExpression !== cron) return { ok: false, reason: 'verify-mismatch' };
    if (enabled !== undefined && verifyEntry.enabled !== enabled) {
      return { ok: false, reason: 'verify-mismatch' };
    }
    return { ok: true, verified: true, action };
  } finally {
    release();
  }
}

/**
 * Flip a task's `enabled` field. Read-modify-write under lock + verify.
 *
 * Returns:
 *   { ok: true,  verified: true, action: 'enabled'|'disabled'|'unchanged' }
 *   { ok: false, reason: 'no-install' | 'lock-timeout' | 'not-found'
 *                       | 'unreadable' | 'malformed' | 'verify-mismatch'
 *                       | 'invalid-id' }
 *
 * not-found means the task is on disk as a SKILL.md folder but was never
 * registered with the daemon. In that case the renderer can offer a
 * "Register and enable" repair button which calls registerOrUpdateTask.
 */
async function setEnabled(id, enabled) {
  if (!isValidTaskId(id)) return { ok: false, reason: 'invalid-id' };
  if (typeof enabled !== 'boolean') return { ok: false, reason: 'invalid-enabled' };

  const stateFile = findStateFile();
  if (!stateFile) return { ok: false, reason: 'no-install' };

  const release = await acquireLock(stateFile);
  if (!release) return { ok: false, reason: 'lock-timeout' };
  try {
    const { tasks, otherKeys, error } = readState(stateFile);
    if (error === 'unreadable') return { ok: false, reason: 'unreadable' };
    if (error === 'malformed') return { ok: false, reason: 'malformed' };

    const idx = tasks.findIndex((t) => t && t.id === id);
    if (idx === -1) return { ok: false, reason: 'not-found' };

    const prev = tasks[idx].enabled;
    if (prev === enabled) {
      // Already in the requested state. Skip the write but still verify.
      const verify = readState(stateFile);
      const v = verify.tasks.find((t) => t && t.id === id);
      if (!v || v.enabled !== enabled) return { ok: false, reason: 'verify-mismatch' };
      return { ok: true, verified: true, action: 'unchanged' };
    }

    tasks[idx] = { ...tasks[idx], enabled };
    writeState(stateFile, tasks, otherKeys);

    const verify = readState(stateFile);
    const v = verify.tasks.find((t) => t && t.id === id);
    if (!v || v.enabled !== enabled) return { ok: false, reason: 'verify-mismatch' };
    return { ok: true, verified: true, action: enabled ? 'enabled' : 'disabled' };
  } finally {
    release();
  }
}

/**
 * Remove a task from the daemon registry. The SKILL.md folder removal is
 * the caller's concern (see main.js's delete-spell handler). Idempotent
 * on missing tasks: deleting a task that's not registered returns
 * { ok: true, action: 'unchanged' } rather than failing.
 */
async function removeTask(id) {
  if (!isValidTaskId(id)) return { ok: false, reason: 'invalid-id' };

  const stateFile = findStateFile();
  if (!stateFile) return { ok: false, reason: 'no-install' };

  const release = await acquireLock(stateFile);
  if (!release) return { ok: false, reason: 'lock-timeout' };
  try {
    const { tasks, otherKeys, error } = readState(stateFile);
    if (error === 'unreadable') return { ok: false, reason: 'unreadable' };
    if (error === 'malformed') return { ok: false, reason: 'malformed' };

    const idx = tasks.findIndex((t) => t && t.id === id);
    if (idx === -1) return { ok: true, verified: true, action: 'unchanged' };

    const next = tasks.slice(0, idx).concat(tasks.slice(idx + 1));
    writeState(stateFile, next, otherKeys);

    const verify = readState(stateFile);
    const stillThere = verify.tasks.find((t) => t && t.id === id);
    if (stillThere) return { ok: false, reason: 'verify-mismatch' };
    return { ok: true, verified: true, action: 'removed' };
  } finally {
    release();
  }
}

/**
 * Read-only snapshot of the daemon's view, keyed by task id. Used by
 * list-spells to overlay daemon state on top of disk SKILL.md folders so
 * the renderer can surface any drift (folder exists but daemon doesn't
 * know about it; or vice versa).
 */
function snapshot() {
  const stateFile = findStateFile();
  if (!stateFile) return { available: false, reason: 'no-install', tasksById: {} };
  const { tasks, error } = readState(stateFile);
  if (error) return { available: false, reason: error, tasksById: {} };
  const tasksById = {};
  for (const t of tasks) {
    if (t && typeof t.id === 'string') tasksById[t.id] = t;
  }
  return { available: true, path: stateFile, tasksById };
}

// ─── Friendly error mapping ──────────────────────────────────────────────
//
// `reason` codes are stable contract — every public mutator returns one of
// them on failure, and the renderer can map directly without ever seeing
// a raw FS error. Keep the strings short, plain English, action-oriented.
//
// Used by main.js's IPC handlers + renderer.js's friendlyError() so the
// user never sees a stack trace, errno, or "verify-mismatch" — only
// "couldn't sync to Claude Code — try again."

const FRIENDLY_REASONS = {
  'no-install': 'Couldn\'t find Claude Code Desktop on this computer. Open Claude Code Desktop once, then try again.',
  'lock-timeout': 'Another change was being saved at the same time. Please try again.',
  'unreadable': 'Couldn\'t read the schedule file. Close Claude Code Desktop, reopen it, and try again.',
  'malformed': 'The schedule file looked broken. Open Claude Code Desktop to repair it, then try again.',
  'verify-mismatch': 'The change didn\'t stick. Try again — Claude Code Desktop may have been restarting.',
  'not-found': 'This spell isn\'t registered with Claude Code Desktop yet. Try activating it again.',
  'invalid-id': 'That spell name has invalid characters.',
  'invalid-cron': 'That schedule isn\'t a valid cron expression.',
  'invalid-filepath': 'Internal error — missing schedule file path.',
  'invalid-cwd': 'Internal error — missing working directory.',
  'invalid-enabled': 'Internal error — invalid on/off value.',
};

function friendlyReason(reason) {
  return FRIENDLY_REASONS[reason] || 'Something went wrong syncing with Claude Code Desktop. Please try again.';
}

module.exports = {
  // Public API
  daemonAvailability,
  registerOrUpdateTask,
  setEnabled,
  removeTask,
  snapshot,
  friendlyReason,
  // Internal — exported for tests only
  _internal: {
    findStateFile,
    readState,
    writeState,
    acquireLock,
    isValidTaskId,
    candidateRoots,
    STATE_FILENAME,
    LOCK_SUFFIX,
    LOCK_STALE_MS,
    FRIENDLY_REASONS,
  },
};
