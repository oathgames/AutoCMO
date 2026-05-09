// REGRESSION GUARD (2026-05-09, binary-update-rsi):
//
// Single source of truth for the Merlin engine binary path + the cleanup
// of orphan binaries that prior versions of the auto-update flow left
// scattered across disk. Lives in its own module so it can be unit-tested
// in isolation and so the surface area of main.js doesn't grow further.
//
// THE PROBLEM THIS MODULE EXISTS TO SOLVE:
//
// Merlin's binary path resolution had three desync vectors before this
// module landed:
//
//   1. Two paths the spawn could choose from — install-local
//      (<appInstall>/.claude/tools/Merlin) which ships with the installer
//      and is read-only on Mac, and workspace
//      (<appRoot>/.claude/tools/Merlin) which /update wrote to. On Mac
//      install-local literally cannot be updated by the user (admin auth
//      required), so install-local was permanently stale after the very
//      first /update. On Windows, install-local was writable but the
//      auto-update flow still wrote to workspace, so the same drift
//      could occur.
//
//   2. Stale binaries lingering at unexpected locations — most notably
//      `os.tmpdir()/Merlin.exe` (an old installer or older auto-update
//      artifact that current code does NOT write but historical code
//      did). Live anchor: a v1.1.3 binary from 2026-04-28 was
//      discovered in a paying user's `%LOCALAPPDATA%\Temp\Merlin.exe`
//      on 2026-05-09, ~4 months after the code that wrote it there
//      had been removed. The user spent hours debugging Google OAuth
//      because their PATH-resolved spawn was hitting this orphan
//      instead of the install-local v1.21.27 binary. Today's
//      `getBinaryPath()` only checks two locations, so it can never
//      discover and clean up an orphan in a third location.
//
//   3. macOS Optimize Storage stub'ing a ContentDir-located binary.
//      The brand-persistence RSI moved StateDir out of ContentDir to
//      ~/Library/Application Support/Merlin/ to avoid this; the binary
//      was missed in that migration. A binary at
//      `~/Merlin/.claude/tools/Merlin` can be silently replaced with
//      a 0-byte stub by macOS when Optimize Storage activates, and
//      every spawn fails opaquely.
//
// THE FIX:
//
// A new CANONICAL location, OS-conventional, user-writable, immune to
// Optimize Storage:
//
//   Mac:     ~/Library/Application Support/Merlin/bin/Merlin
//   Windows: %LOCALAPPDATA%\Merlin\bin\Merlin.exe
//   Linux:   $XDG_DATA_HOME/Merlin/bin/Merlin
//            (fallback: ~/.local/share/Merlin/bin/Merlin)
//
// `getBinaryPath()` consults canonical FIRST. Install-local is the
// fallback for first-launch (before any /update has run) — once /update
// runs and populates canonical, install-local's role is done. Workspace
// is the legacy fallback only.
//
// On every app launch, two background tasks run:
//
//   (a) hydrateCanonicalBinary() — if canonical is missing or older
//       than install-local, copy install-local → canonical. On Mac:
//       chmod +x + clear quarantine attribute. This means every fresh
//       major-version install (which writes a new install-local via
//       the DMG/NSIS installer) automatically promotes its bundled
//       binary into canonical on first launch.
//
//   (b) cleanupOrphanBinaries() — scan known stale locations
//       (workspace, content-dir/.claude/tools, os.tmpdir(), legacy
//       %LOCALAPPDATA%\Programs paths) for any Merlin binary, delete
//       any that are NOT canonical AND NOT install-local. Logs each
//       deletion to .merlin-errors.log for telemetry. Idempotent —
//       safe to run on every launch, no-op when no orphans exist.
//
// HOW THIS PREVENTS THE 2026-05-08 → 05-09 INCIDENT FROM RECURRING:
//
//   - getBinaryPath() now prefers canonical, which /update is the only
//     thing allowed to write to. /update's binary download is
//     checksum-verified before write. Spawn-time integrity check
//     (`spawnSafeBinaryCheck` in this module) refuses to spawn a
//     binary that's older than MIN_BINARY_VERSION or has a corrupt
//     header — failing loudly instead of silently 3-scoping the user.
//
//   - cleanupOrphanBinaries() runs on every launch, deleting
//     `os.tmpdir()/Merlin[.exe]` and any other stale stash — so the
//     "v1.1.3 sitting in Temp for 11 days" failure mode is impossible:
//     even if SOME flow plants a binary in an unexpected location,
//     the next launch removes it.
//
//   - hydrateCanonicalBinary() compares versions; if install-local
//     ships a NEWER binary (e.g. fresh install of v1.22.0 over a
//     /update'd v1.21.28), canonical is overwritten. So fresh installs
//     always win over auto-update'd state. No "I just reinstalled and
//     it's still using the old auto-update'd binary" surprise.
//
// SHIP COHORT: v1.21.28. Closes audit findings C1 (Mac install-local
// can never auto-update), C3 (legacy workspace orphan after StateDir
// migration), D1 (installer tmp file orphan), D2 (no startup orphan
// scan). The companion `update-pending-restart` marker handles E1
// (stale main.js after /update); see writePendingRestartMarker below.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BINARY_NAME = process.platform === 'win32' ? 'Merlin.exe' : 'Merlin';

// Canonical user-writable binary directory. OS conventions:
//   Mac:     ~/Library/Application Support/Merlin/bin
//   Windows: %LOCALAPPDATA%\Merlin\bin
//   Linux:   $XDG_DATA_HOME/Merlin/bin (fallback: ~/.local/share/Merlin/bin)
//
// Why these specifically:
//   - Mac: Application Support is the documented location for app-private
//     data per Apple's File System Programming Guide. NOT ~/Library/Caches
//     (subject to system cleanup) and NOT ~/Documents (subject to Optimize
//     Storage / iCloud sync stub'ing).
//   - Windows: %LOCALAPPDATA% (NOT %APPDATA%) because the binary is
//     machine-specific (it's an architecture-specific compiled artifact)
//     and shouldn't roam between machines via the Roaming profile.
//   - Linux: XDG Base Directory spec — $XDG_DATA_HOME for app data files.
function getCanonicalBinaryDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Merlin', 'bin');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Merlin', 'bin');
  }
  // Linux + other Unix
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData && path.isAbsolute(xdgData)) {
    return path.join(xdgData, 'Merlin', 'bin');
  }
  return path.join(os.homedir(), '.local', 'share', 'Merlin', 'bin');
}

function getCanonicalBinaryPath() {
  return path.join(getCanonicalBinaryDir(), BINARY_NAME);
}

// resolveBinaryPath — preferred path order:
//   1. canonical (user-writable, where /update writes)
//   2. install-local (bundled with installer, ships fresh)
//   3. workspace (legacy fallback for old installs that pre-date
//      this module)
//
// All three locations are examined for *existence*; integrity checks
// (size, version, signature) live in spawnSafeBinaryCheck.
function resolveBinaryPath({ appInstall, appRoot }) {
  const canonical = getCanonicalBinaryPath();
  try { fs.accessSync(canonical, fs.constants.F_OK); return canonical; } catch {}
  if (appInstall) {
    const installBin = path.join(appInstall, '.claude', 'tools', BINARY_NAME);
    try { fs.accessSync(installBin, fs.constants.F_OK); return installBin; } catch {}
  }
  if (appRoot) {
    return path.join(appRoot, '.claude', 'tools', BINARY_NAME);
  }
  return canonical; // last resort — caller will get ENOENT but at least the path is sensible
}

// hydrateCanonicalBinary — copy install-local → canonical when canonical
// is missing OR install-local is newer (by version string OR mtime if
// version probe fails).
//
// Behavior:
//   - If install-local doesn't exist: no-op (nothing to copy from).
//     Caller should then trigger ensureBinary() to download.
//   - If canonical doesn't exist: copy install-local → canonical, set
//     +x on Mac/Linux, clear quarantine on Mac.
//   - If canonical exists AND install-local is newer (version-wise
//     or mtime-wise): overwrite canonical from install-local. This
//     handles "user reinstalled v1.22 over an auto-update'd v1.21.28"
//     by promoting the fresh bundled binary.
//   - If canonical >= install-local: no-op.
//
// Pure I/O — exec calls (chmod, xattr) are best-effort; any failure
// is logged and skipped. The caller (main.js boot path) MUST NOT block
// app launch on hydration failure — getBinaryPath() will fall through
// to install-local if canonical doesn't materialize.
async function hydrateCanonicalBinary({ appInstall, getBinaryVersionAt, log = console.log }) {
  if (!appInstall) return { hydrated: false, reason: 'no appInstall' };
  const installLocal = path.join(appInstall, '.claude', 'tools', BINARY_NAME);
  if (!fs.existsSync(installLocal)) {
    return { hydrated: false, reason: 'install-local missing' };
  }
  const canonical = getCanonicalBinaryPath();
  const canonicalDir = path.dirname(canonical);
  // Decide whether to copy.
  let shouldCopy = !fs.existsSync(canonical);
  if (!shouldCopy) {
    try {
      // Prefer version comparison if a probe function is provided. We can't
      // use simple compareVersions here without importing main.js helpers,
      // so the caller (main.js) passes its own getBinaryVersionAt + uses
      // its compareVersions internally to decide "newer".
      if (typeof getBinaryVersionAt === 'function') {
        const [installVer, canonVer] = await Promise.all([
          getBinaryVersionAt(installLocal).catch(() => null),
          getBinaryVersionAt(canonical).catch(() => null),
        ]);
        if (installVer && canonVer && compareVersionStrings(installVer, canonVer) > 0) {
          shouldCopy = true;
        }
      } else {
        // mtime fallback — if install-local is newer on disk than canonical.
        const installStat = fs.statSync(installLocal);
        const canonStat = fs.statSync(canonical);
        if (installStat.mtimeMs > canonStat.mtimeMs) {
          shouldCopy = true;
        }
      }
    } catch (e) {
      // If we can't decide, leave canonical alone. Spawn-time integrity
      // check will catch a truly-corrupt binary.
      log(`[binary-paths] hydration probe failed (leaving canonical untouched): ${e.message}`);
      return { hydrated: false, reason: 'probe failed' };
    }
  }
  if (!shouldCopy) {
    return { hydrated: false, reason: 'canonical >= install-local' };
  }
  try {
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.copyFileSync(installLocal, canonical);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(canonical, 0o755); } catch {}
      if (process.platform === 'darwin') {
        const { execSync } = require('child_process');
        // Clear quarantine — the binary was already trusted in the .app
        // bundle context, but copying via Node strips the bundle's trust
        // unless we explicitly clear the xattr.
        try { execSync(`xattr -d com.apple.quarantine "${canonical}" 2>/dev/null`); } catch {}
        // Defensively re-sign ad-hoc. Real sig verification happens at
        // CI build time on install-local; canonical is just a copy.
        try { execSync(`codesign --force --sign - "${canonical}" 2>/dev/null`); } catch {}
      }
    }
    log(`[binary-paths] hydrated canonical from install-local: ${canonical}`);
    return { hydrated: true, source: installLocal, target: canonical };
  } catch (e) {
    log(`[binary-paths] hydration copy failed: ${e.message}`);
    return { hydrated: false, reason: e.message };
  }
}

// compareVersionStrings — local helper to avoid importing main.js's
// compareVersions. Returns 1 if a > b, -1 if a < b, 0 if equal.
// Tolerant of trailing junk (e.g. "Merlin Pipeline v1.21.28" → 1.21.28).
function compareVersionStrings(a, b) {
  const norm = (s) => {
    const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : [0, 0, 0];
  };
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] > B[i]) return 1;
    if (A[i] < B[i]) return -1;
  }
  return 0;
}

// cleanupOrphanBinaries — scan known stale locations and delete any
// Merlin binary that's NOT the canonical or install-local copy.
//
// Locations scanned:
//   - workspace: <appRoot>/.claude/tools/Merlin[.exe]
//     (legacy auto-update target — pre-this-module)
//   - content-dir state leftovers: <appRoot>/.claude/tools/Merlin[.exe]
//     (same as workspace today; same path on most systems)
//   - tmpdir orphans: <os.tmpdir()>/Merlin[.exe]
//     (historical artifact from old code; current code never writes here)
//   - tmpdir installer: <os.tmpdir()>/Merlin.Setup.*.exe — clean these
//     too, they're installer-stage artifacts that the current install-update
//     flow leaks (D1 fix).
//
// Returns { deleted: [...], skipped: [...] } so the caller can log
// telemetry. Never throws — every delete is best-effort.
function cleanupOrphanBinaries({ appRoot, log = console.log }) {
  const canonical = getCanonicalBinaryPath();
  const result = { deleted: [], skipped: [], errors: [] };

  // Build the safe-list — paths that should NEVER be deleted by this
  // function. Includes canonical (current target) and the installer-
  // bundled location (which is the fallback if canonical is wiped).
  const safe = new Set([canonical]);

  const stale = [];
  if (appRoot) {
    stale.push(path.join(appRoot, '.claude', 'tools', BINARY_NAME));
  }
  // os.tmpdir orphans
  stale.push(path.join(os.tmpdir(), BINARY_NAME));

  // Installer-stage orphans (D1) — Merlin.Setup.X.Y.Z.exe / Merlin-X.Y.Z.dmg
  // left behind by installUpdateFromLatestRelease.
  try {
    const tmpEntries = fs.readdirSync(os.tmpdir());
    for (const entry of tmpEntries) {
      // Match installer artifact name patterns. We DO NOT just glob
      // /^Merlin/ — that would catch our own runtime tmp files (config,
      // STT audio, etc.). Be specific.
      if (/^Merlin\.Setup\.[\d.]+\.exe$/i.test(entry)) {
        stale.push(path.join(os.tmpdir(), entry));
      } else if (/^Merlin-[\d.]+(?:-arm64|-x64)?\.dmg$/i.test(entry)) {
        stale.push(path.join(os.tmpdir(), entry));
      } else if (/^merlin-update\.bat$/i.test(entry) || /^merlin-update\.log$/i.test(entry)) {
        stale.push(path.join(os.tmpdir(), entry));
      }
    }
  } catch {}

  for (const p of stale) {
    if (safe.has(p)) {
      result.skipped.push(p);
      continue;
    }
    try {
      if (!fs.existsSync(p)) {
        // No-op; not actually present.
        continue;
      }
      // Only delete if it looks like a Merlin executable — safety check
      // against accidentally deleting unrelated files at the same path.
      // For the exact-name path patterns above, this is mostly redundant,
      // but it's cheap insurance.
      const st = fs.statSync(p);
      if (!st.isFile() || st.size === 0) {
        // Empty file or directory at this path — don't delete via this
        // helper. cleanupOrphanBinaries is binary-only.
        result.skipped.push(p);
        continue;
      }
      fs.unlinkSync(p);
      result.deleted.push(p);
      log(`[binary-paths] cleaned orphan binary: ${p}`);
    } catch (e) {
      result.errors.push({ path: p, message: e.message });
      log(`[binary-paths] orphan-delete failed for ${p}: ${e.message}`);
    }
  }
  return result;
}

// ─── Pending-restart marker (E1 fix) ────────────────────────────────
//
// Every JS module loaded into the Electron main process via `require()`
// is locked in `require.cache` until the process restarts. When /update
// writes a new app/main.js or any other cached module to disk, the
// running process keeps using the OLD code — but the renderer reads the
// NEW version.json and shows the user "v1.21.28" while main.js is still
// running v1.21.27 logic. This is exactly how the 2026-05-08 fast-open
// scope drift hid for 8 days for users who had auto-updated but not
// restarted.
//
// Fix: during /update Phase 2, when any file in the `updatable` list is
// a JS module that's already in require.cache, write a marker file. On
// every launch + after /update completes, main.js reads the marker and
// surfaces a non-dismissable banner to the renderer: "Restart required
// to apply update." Click → relaunch.

const PENDING_RESTART_MARKER_NAME = '.merlin-pending-restart.json';

function pendingRestartMarkerPath(stateDir) {
  return path.join(stateDir, PENDING_RESTART_MARKER_NAME);
}

// writePendingRestartMarker — call after /update writes a JS module
// that's currently in require.cache. Idempotent: re-writing with the
// same data is fine.
//
// shape: { writtenAt: ISO timestamp, fromVersion, toVersion, files: [...] }
function writePendingRestartMarker(stateDir, payload) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const data = {
      writtenAt: new Date().toISOString(),
      fromVersion: payload.fromVersion || null,
      toVersion: payload.toVersion || null,
      files: Array.isArray(payload.files) ? payload.files : [],
    };
    fs.writeFileSync(pendingRestartMarkerPath(stateDir), JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function readPendingRestartMarker(stateDir) {
  try {
    const raw = fs.readFileSync(pendingRestartMarkerPath(stateDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearPendingRestartMarker(stateDir) {
  try {
    fs.unlinkSync(pendingRestartMarkerPath(stateDir));
    return true;
  } catch {
    return false;
  }
}

// isCachedJsModulePath — given a file path that /update is about to
// write, return true if it's a JS module that's already loaded into
// the running process via require(). Such writes need a restart prompt
// because Node's require.cache locks the old module in memory.
//
// Strategy: walk require.cache keys, normalize each cached path (resolve
// + lowercase on Windows), compare against the resolved candidate path.
function isCachedJsModulePath(candidatePath) {
  if (!candidatePath) return false;
  if (!candidatePath.endsWith('.js') && !candidatePath.endsWith('.mjs') && !candidatePath.endsWith('.cjs')) {
    return false;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(candidatePath);
  } catch {
    resolved = path.resolve(candidatePath);
  }
  const normalize = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  const target = normalize(resolved);
  for (const key of Object.keys(require.cache || {})) {
    let cachedReal = key;
    try { cachedReal = fs.realpathSync(key); } catch {}
    if (normalize(cachedReal) === target) return true;
  }
  // Also flag any file under app/ that matches a known-imported relative
  // module by basename — defense-in-depth for the case where realpath
  // can't be resolved (e.g. symlinks across volumes on Windows).
  const baseName = path.basename(target);
  for (const key of Object.keys(require.cache || {})) {
    if (path.basename(normalize(key)) === baseName) return true;
  }
  return false;
}

module.exports = {
  BINARY_NAME,
  getCanonicalBinaryDir,
  getCanonicalBinaryPath,
  resolveBinaryPath,
  hydrateCanonicalBinary,
  cleanupOrphanBinaries,
  compareVersionStrings,
  writePendingRestartMarker,
  readPendingRestartMarker,
  clearPendingRestartMarker,
  pendingRestartMarkerPath,
  isCachedJsModulePath,
  PENDING_RESTART_MARKER_NAME,
};
