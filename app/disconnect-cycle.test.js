// disconnect-cycle.test.js
//
// REGRESSION GUARD (2026-05-10, C002):
// Disconnect → reconnect cycle integrity. Source-scan-style test (no
// real IPC). For each ACTIVE OAuth provider in oauth-provider-config.js,
// verify that:
//   1. main.js's `disconnect-platform` IPC handler has a `keyMap` entry
//      for the provider.
//   2. The keyMap entry explicitly lists the access token field plus
//      every related id / refresh / display field that the Go binary
//      writes during OAuth exchange (so a reconnect starts from a
//      clean slate, not a partially-stale config).
//   3. The disconnect handler clears those keys via vaultDelete on
//      VAULT_SENSITIVE_KEYS — the keyMap entries that name secrets
//      are present in oauth-persist.js's VAULT_SENSITIVE_KEYS so the
//      vault-clearing branch in main.js fires.
//
// The companion test in oauth-persist.test.js already pins "every
// OAUTH_PLATFORMS in renderer.js has a keyMap entry in main.js." This
// file deepens that to "every active provider in oauth-provider-config
// has a keyMap entry, AND that entry covers the platform's complete
// reconnect surface." Drift here is the 2026-04-27 LinkedIn-disconnect
// bug class: OAuth flow ships, disconnect path silently no-ops, user
// reconnects with stale ad-account-id from a prior brand and hits
// "ad account not found" the first time they push a creative.
//
// Run with: `node --test app/disconnect-cycle.test.js`

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ACTIVE_PLATFORMS, PROVIDERS } = require('./oauth-provider-config');
const { VAULT_SENSITIVE_KEYS } = require('./oauth-persist');

// Read main.js source once — every test below source-scans into it.
const MAIN_JS_SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

// Extract the keyMap object literal from inside the disconnect-platform
// IPC handler. Walks brace depth to handle the nested object structure.
function extractDisconnectKeyMap(src) {
  const handlerIdx = src.indexOf("ipcMain.handle('disconnect-platform'");
  assert.ok(handlerIdx >= 0,
    'disconnect-platform IPC handler must exist in main.js');
  // Find `const keyMap = {` after the handler declaration.
  const keyMapDeclIdx = src.indexOf('const keyMap', handlerIdx);
  assert.ok(keyMapDeclIdx >= 0 && keyMapDeclIdx - handlerIdx < 5000,
    'keyMap declaration must live inside disconnect-platform handler');
  const openBrace = src.indexOf('{', keyMapDeclIdx);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > openBrace, 'keyMap object literal must be balanced');

  const block = src.slice(openBrace, end + 1);
  // Per-platform entry parser. Each entry looks like:
  //   meta: ['metaAccessToken', 'metaAdAccountId', ...],
  // We capture the platform key + the array of strings.
  const entries = {};
  // Match `<word>: [` then the array contents until the matching `]`.
  // Comments inside the keyMap are fine — strip them to keep the
  // string-extraction simple. A multi-line // comment block precedes
  // every entry; only the bracketed array content matters.
  const cleaned = block
    .replace(/\/\/[^\n]*/g, '')      // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // strip block comments
  // Walk top-level entries by scanning for `<ident>: [` at depth 1.
  const entryRe = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = entryRe.exec(cleaned)) !== null) {
    const platform = m[1];
    const arrayBody = m[2];
    const keys = (arrayBody.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
    entries[platform] = keys;
  }
  return entries;
}

// Fields the Go binary writes during a successful OAuth exchange for
// each active provider. Pulled from autocmo-core/oauth.go's per-provider
// VaultPut + cfg.<Field> = result mutations. If a provider's exchange
// path ships a new field (e.g. "metaBusinessId"), add it here so the
// disconnect-cycle test catches the new orphan-field risk.
const REQUIRED_DISCONNECT_FIELDS = {
  meta: ['metaAccessToken', 'metaAdAccountId', 'metaPageId', 'metaPixelId'],
  tiktok: ['tiktokAccessToken', 'tiktokAdvertiserId', 'tiktokPixelId'],
  google: ['googleAccessToken', 'googleRefreshToken', 'googleAdsCustomerId'],
  amazon: ['amazonAccessToken', 'amazonRefreshToken', 'amazonProfileId'],
  reddit: ['redditAccessToken', 'redditRefreshToken', 'redditAdAccountId'],
  etsy: ['etsyAccessToken', 'etsyRefreshToken', 'etsyShopId', 'etsyKeystring'],
  linkedin: ['linkedinAccessToken', 'linkedinRefreshToken', 'linkedinAdAccountId'],
  stripe: ['stripeAccessToken', 'stripeAccountId'],
  slack: ['slackBotToken'],
};

const KEY_MAP = extractDisconnectKeyMap(MAIN_JS_SRC);

test('every ACTIVE_PLATFORMS provider has a disconnect-platform keyMap entry', () => {
  const missing = [];
  for (const platform of ACTIVE_PLATFORMS) {
    if (!KEY_MAP[platform] || KEY_MAP[platform].length === 0) {
      missing.push(platform);
    }
  }
  assert.deepStrictEqual(missing, [],
    `ACTIVE_PLATFORMS providers without a keyMap entry: ${missing.join(', ')}. ` +
    `Users will not be able to disconnect these — see Hard-Won regression for ` +
    `LinkedIn (v1.18.0–v1.18.9 had OAuth without disconnect).`);
});

test('keyMap entries explicitly clear access tokens for every active provider', () => {
  // The access token is the lock — clearing only secondary fields
  // (ad-account-id, profile-id) leaves the user authenticated and
  // would let a stale token continue making requests.
  const offenders = [];
  for (const platform of ACTIVE_PLATFORMS) {
    if (!REQUIRED_DISCONNECT_FIELDS[platform]) continue;
    const expected = REQUIRED_DISCONNECT_FIELDS[platform][0]; // first entry = access token
    const got = KEY_MAP[platform] || [];
    if (!got.includes(expected)) {
      offenders.push(`${platform}: keyMap missing ${expected}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `Disconnect keyMap entries missing the access-token field: ${offenders.join('; ')}`);
});

test('keyMap entries clear refresh tokens for every refresh-supporting provider', () => {
  // Google / Amazon / Reddit / Etsy / LinkedIn issue refresh tokens.
  // If disconnect doesn't clear the refresh token, MaybeRenewAllTokens
  // will still try to refresh after disconnect — hitting the BFF
  // unnecessarily and potentially re-establishing a connection the
  // user explicitly severed.
  const refreshProviders = ['google', 'amazon', 'reddit', 'etsy', 'linkedin'];
  const offenders = [];
  for (const platform of refreshProviders) {
    const refreshKey = `${platform}RefreshToken`;
    const got = KEY_MAP[platform] || [];
    if (!got.includes(refreshKey)) {
      offenders.push(`${platform}: keyMap missing ${refreshKey}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `Disconnect keyMap entries missing the refresh-token field: ${offenders.join('; ')}. ` +
    `MaybeRenewAllTokens would hit the BFF unnecessarily after disconnect.`);
});

test('keyMap covers every related field the Go binary writes per provider', () => {
  // Beyond access + refresh, the binary writes display IDs (adAccountId,
  // pageId, pixelId, profileId, shopId, etc.). Disconnect MUST clear
  // these so a reconnect under a different account doesn't inherit the
  // prior account's IDs — historical bug class: user reconnects Meta
  // for brand-A under brand-A's account, but metaPixelId still holds
  // brand-B's pixel and pixel-events POST silently to the wrong pixel.
  const offenders = [];
  for (const platform of ACTIVE_PLATFORMS) {
    const expected = REQUIRED_DISCONNECT_FIELDS[platform];
    if (!expected) continue;
    const got = KEY_MAP[platform] || [];
    const missingFields = expected.filter(f => !got.includes(f));
    if (missingFields.length > 0) {
      offenders.push(`${platform}: missing [${missingFields.join(', ')}]`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `Disconnect keyMap entries missing related fields: ${offenders.join('; ')}. ` +
    `Reconnecting under a different account would silently inherit stale IDs.`);
});

test('every secret-suffixed key in the disconnect keyMap is also vault-tracked', () => {
  // The vault-clearing branch in main.js runs:
  //   if (VAULT_SENSITIVE_KEYS.includes(key)) vaultDelete(brand, key);
  // If a keyMap entry's secret-looking field is missing from
  // VAULT_SENSITIVE_KEYS, the encrypted vault still holds the old
  // value after disconnect — and vaultGet during reconnect's
  // resolveVaultPlaceholders pass would resurrect it. Pin the
  // contract: every Token / Key / Secret / WebhookUrl key in keyMap
  // is in VAULT_SENSITIVE_KEYS.
  const sensitiveSuffix = /(Token|Key|Secret|WebhookUrl)$/;
  const offenders = [];
  for (const platform of ACTIVE_PLATFORMS) {
    const got = KEY_MAP[platform] || [];
    for (const key of got) {
      if (!sensitiveSuffix.test(key)) continue;
      if (!VAULT_SENSITIVE_KEYS.includes(key)) {
        offenders.push(`${platform}/${key}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `keyMap secret-looking fields not in VAULT_SENSITIVE_KEYS: ${offenders.join(', ')}. ` +
    `vaultDelete won't fire — encrypted vault will hold stale value through reconnect.`);
});

test('LinkedIn disconnect keyMap matches the 2026-04-27 incident fix', () => {
  // Anchor the historical bug class explicitly. Easier to triage a
  // future LinkedIn regression when this test names the fields
  // directly.
  assert.ok(KEY_MAP.linkedin, 'linkedin keyMap entry must exist');
  for (const required of ['linkedinAccessToken', 'linkedinRefreshToken', 'linkedinAdAccountId']) {
    assert.ok(KEY_MAP.linkedin.includes(required),
      `linkedin keyMap missing ${required} — restored after v1.18.0–v1.18.9 incident`);
  }
});

test('ACTIVE_PLATFORMS providers all have non-empty PROVIDERS config', () => {
  // Defense-in-depth: confirm the source-of-truth oauth-provider-config
  // has a real entry for every platform we'd disconnect. A missing
  // PROVIDERS entry means the renderer would never offer a connect
  // button — but if the disconnect path still references the platform,
  // it's a dead code path waiting to surface as a regression.
  const orphans = [];
  for (const platform of ACTIVE_PLATFORMS) {
    if (!PROVIDERS[platform] || !PROVIDERS[platform].clientId === undefined) {
      orphans.push(platform);
    }
  }
  assert.deepStrictEqual(orphans, [],
    `ACTIVE_PLATFORMS contains entries with no PROVIDERS config: ${orphans.join(', ')}`);
});
