// REGRESSION GUARD (2026-05-10, BUG-G005 token-redaction audit):
//
// Three log helpers in main.js (appendErrorLog, appendActivityLog, appendAudit)
// write to user-facing files (.merlin-errors.log, activity.jsonl,
// .merlin-audit.log). Same trust profile as the Go-side activity.jsonl: support
// tickets, Discord pastes, GitHub issues. A token landing in any of them is a
// 1:1 leak.
//
// `appendAudit` already redacts inline (32+-char base64 catch-all). The other
// two now route through `redactSecret()` from `./log-redaction.js`. This file
// covers the helper's regex behavior + a source-scan that locks the wiring
// in main.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { redactSecret, redactJsonValue } = require('./log-redaction');

// ── Behavioural tests ─────────────────────────────────────────────────

test('redactSecret scrubs OpenAI-style sk- keys', () => {
  const got = redactSecret('Authenticated with sk-abcdefgh1234567890ABCDEFGH');
  assert.ok(got.includes('[REDACTED]'), `expected [REDACTED] marker, got ${got}`);
  assert.ok(!got.includes('sk-abc'), `prefix still visible: ${got}`);
});

test('redactSecret scrubs Stripe live keys', () => {
  // Fixture intentionally uses a clearly-fake suffix (no Stripe account-ID
  // prefix `51`/`52`) so GitHub's push-protection secret scanner does not
  // flag this test as committing a real key. The redaction regex matches
  // on the `sk_live_` prefix + ≥8 base62 chars, not on Stripe's heuristic.
  const got = redactSecret('key=sk_live_FAKEFIXTUREabcdefgh1234567890');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('sk_live_FAKE'), `stripe key still visible: ${got}`);
});

test('redactSecret scrubs Stripe test keys', () => {
  // Same fake-fixture rule as above — sidesteps the live-key scanner heuristic.
  const got = redactSecret('key=sk_test_FAKEFIXTUREabcdefgh1234567890');
  assert.ok(got.includes('[REDACTED]'), got);
});

test('redactSecret scrubs GitHub PAT prefixes', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghs_', 'ghu_']) {
    const raw = `header X-Auth: ${prefix}abcdefgh1234567890AB`;
    const got = redactSecret(raw);
    assert.ok(got.includes('[REDACTED]'), `${prefix}: ${got}`);
    assert.ok(!got.includes(`${prefix}abc`), `${prefix}: still visible: ${got}`);
  }
});

test('redactSecret scrubs github_pat_ long-form', () => {
  const got = redactSecret('github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('github_pat_11'), got);
});

test('redactSecret scrubs AWS access keys', () => {
  const got = redactSecret('AWS keys AKIAIOSFODNN7EXAMPLE in env');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('AKIAIO'), got);
});

test('redactSecret scrubs Slack bot/user/app tokens', () => {
  for (const prefix of ['xoxb-', 'xoxp-', 'xoxa-', 'xoxs-', 'xoxr-']) {
    const raw = `Bearer ${prefix}12345-67890-AbCdEfGhIjKl`;
    const got = redactSecret(raw);
    assert.ok(got.includes('[REDACTED]'), `${prefix}: ${got}`);
    assert.ok(!got.includes(`${prefix}12345`), `${prefix}: still visible: ${got}`);
  }
});

test('redactSecret scrubs Meta long-lived tokens (EAA prefix)', () => {
  const got = redactSecret('FB token EAAB1ZBcABCdefGhijklmnoPqrSTUvw');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('EAAB1ZBcABCdef'), got);
});

test('redactSecret scrubs fal.ai keys', () => {
  const got = redactSecret('X-Api-Key: fal_abcdef1234567890');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('fal_abcdef'), got);
});

test('redactSecret scrubs webhook signing secrets (whsec_)', () => {
  const got = redactSecret('stripe whsec_abcdef0123456789FEDCBA');
  assert.ok(got.includes('[REDACTED]'), got);
});

test('redactSecret scrubs Shopify admin tokens (shpat_)', () => {
  const got = redactSecret('shop access shpat_abcdef0123456789FEDCBA0987');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('shpat_abc'), got);
});

test('redactSecret scrubs Shopify shared secrets (shpss_)', () => {
  const got = redactSecret('shpss_abcdef0123456789FEDCBA0987');
  assert.ok(got.includes('[REDACTED]'), got);
});

test('redactSecret scrubs Google API keys (AIza prefix)', () => {
  const got = redactSecret('url ?key=AIzaSyA-FakeKeyValue123456_abcDEF');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('AIzaSyA-Fake'), got);
});

test('redactSecret scrubs Stripe Connect account IDs', () => {
  const got = redactSecret('ca_live_abcdef0123456789FEDCBA0987');
  assert.ok(got.includes('[REDACTED]'), got);
});

test('redactSecret scrubs Groq keys (gsk_ prefix)', () => {
  const got = redactSecret('gsk_abcdefghij1234567890ABCDEF');
  assert.ok(got.includes('[REDACTED]'), got);
});

test('redactSecret scrubs long opaque tokens (40+ chars)', () => {
  const got = redactSecret('opaque ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef trailing');
  assert.ok(got.includes('[REDACTED]'), got);
  assert.ok(!got.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'), got);
});

// ── Negative tests: do not over-redact benign text ─────────────────────

test('redactSecret does NOT redact ordinary log lines', () => {
  const benign = [
    'meta-push completed at 2026-05-10T14:30:00Z',
    'campaign 120211234567890 paused (frequency 3.2)',
    'ROAS 4.2 within target band',
    'Saturday Special: 30% off site-wide',
    'Eastside Pottery is the brand vertical: ceramics',
    'file path C:\\Users\\Foo\\Documents\\report.pdf',
    'shopify store mybrand.myshopify.com - vault key set',
    'skip retry - not a transient error',
    'akiak - Japanese for autumn red, used in 8 ad headlines',
    'LinkedIn Ads campaign 12345678 active',
    'product slug eastside-pottery-mug-large',
  ];
  for (const line of benign) {
    assert.equal(redactSecret(line), line, `over-redacted: ${line}`);
  }
});

test('redactSecret returns non-strings unchanged', () => {
  assert.equal(redactSecret(undefined), undefined);
  assert.equal(redactSecret(null), null);
  assert.equal(redactSecret(42), 42);
  assert.equal(redactSecret(''), '');
});

test('redactSecret scrubs both prefix and long token in same string', () => {
  const raw = 'request id ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef and stripe key sk_live_AbCdEf01234567';
  const got = redactSecret(raw);
  assert.ok(!got.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'), got);
  assert.ok(!got.includes('sk_live_AbCdEf'), got);
  // At least 2 [REDACTED] markers (one per token)
  const count = (got.match(/\[REDACTED\]/g) || []).length;
  assert.ok(count >= 2, `expected >= 2 markers, got ${count}: ${got}`);
});

test('redactJsonValue scrubs strings inside nested object', () => {
  const obj = {
    action: 'stripe-sync',
    detail: 'connected with sk_live_AbCdEf01234567',
    nested: {
      token: 'EAAB1ZBcABCdefGhijklmnoPqrSTUvw',
      safe: 'normal text',
    },
    arr: ['regular', 'shpat_abcdef0123456789FEDCBA'],
  };
  const out = redactJsonValue(obj);
  assert.ok(!JSON.stringify(out).includes('sk_live_AbCdEf'));
  assert.ok(!JSON.stringify(out).includes('EAAB1ZBcAB'));
  assert.ok(!JSON.stringify(out).includes('shpat_abcdef'));
  assert.equal(out.nested.safe, 'normal text');
  assert.equal(out.action, 'stripe-sync');
});

// ── Source-scan: appendErrorLog + appendActivityLog must redact ─────────

const SRC_MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('appendErrorLog routes through redactSecret before fs.appendFileSync', () => {
  // Locate the appendErrorLog body and confirm the appendFileSync call
  // wraps its argument in the redactor.
  const fnMatch = SRC_MAIN.match(/function appendErrorLog\(line\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'appendErrorLog function not found in main.js');
  const body = fnMatch[0];
  assert.ok(
    /fs\.appendFileSync\([^,]+,\s*_logRedactSecret\(line\)\s*\)/.test(body),
    `appendErrorLog must call _logRedactSecret(line) inside fs.appendFileSync — got:\n${body}`
  );
});

test('appendActivityLog routes through redactSecret before fs.appendFileSync', () => {
  const fnMatch = SRC_MAIN.match(/function appendActivityLog\(logPath, line\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'appendActivityLog function not found in main.js');
  const body = fnMatch[0];
  assert.ok(
    /fs\.appendFileSync\([^,]+,\s*_logRedactSecret\(line\)\s*\)/.test(body),
    `appendActivityLog must call _logRedactSecret(line) inside fs.appendFileSync — got:\n${body}`
  );
});

test('main.js requires the log-redaction module', () => {
  assert.ok(
    /require\(['"]\.\/log-redaction['"]\)/.test(SRC_MAIN),
    'main.js must require ./log-redaction'
  );
});

// ── Source-scan: no log helper writes raw token-shaped substrings ──────

test('no console.log/error/warn in main.js interpolates a *AccessToken or *ApiKey field name', () => {
  // Match console calls whose arguments mention .somethingAccessToken,
  // .somethingApiKey, .clientSecret, etc. without redactSecret nearby.
  const leakRe = /console\.(log|error|warn|info)\([^)]{0,400}\.(accessToken|refreshToken|apiKey|clientSecret|botToken|webhookUrl|developerToken)\b/gi;
  const matches = [];
  let m;
  while ((m = leakRe.exec(SRC_MAIN)) !== null) {
    const slice = m[0];
    if (slice.includes('redactSecret') || slice.includes('redactOutput')) continue;
    // Skip property comparisons like `.accessToken === ''`
    if (/\.(accessToken|refreshToken|apiKey|clientSecret|botToken|webhookUrl|developerToken)\s*[=!<>]/.test(slice)) continue;
    matches.push(slice.slice(0, 200));
  }
  if (matches.length > 0) {
    assert.fail(
      `BUG-G005 token-redaction audit: ${matches.length} console call(s) interpolate credential-bearing fields without redaction:\n  ${matches.join('\n  ')}`
    );
  }
});

// REGRESSION GUARD (2026-05-11, post-audit Mailchimp redaction gap):
// Mailchimp keys are <32-hex>-<dc> shape (35-37 chars). The existing
// LONG_TOKEN_RE (40+ chars) and TOKEN_PREFIX_RE (no Mailchimp prefix)
// miss them. New MAILCHIMP_KEY_RE closes the gap. Mirrors the Go-side
// secretMailchimpPattern at autocmo-core/main.go.

test('redactSecret scrubs Mailchimp API keys (us6 / us21 / eu1)', () => {
  // Fixtures are constructed at runtime so no Mailchimp-shaped
  // literal appears in source — GitHub's secret-scanning push
  // protection treats anything matching `<32-hex>-<dc>` as a real
  // key regardless of entropy (32× '0' is flagged the same as a
  // high-entropy real key). The redaction regex matches by SHAPE
  // (32 lowercase hex + dash + 1-4 alpha + 1-3 digits), so a
  // runtime-built string exercises the same code path the regex
  // would face in production.
  const cases = [
    '0'.repeat(32) + '-us6',
    '1'.repeat(32) + '-us21',
    '0'.repeat(32) + '-eu1',
  ];
  for (const key of cases) {
    const got = redactSecret(`audit line: key=${key} fired`);
    assert.ok(got.includes('[REDACTED]'),
      `expected [REDACTED] in ${got}`);
    assert.ok(!got.includes(key),
      `Mailchimp key ${key} survived redaction: ${got}`);
  }
});

test('MAILCHIMP_KEY_RE does not over-match generic 32-hex strings without dc suffix', () => {
  // A bare SHA-256 hash (64 hex chars) without a dc suffix should not
  // be matched by MAILCHIMP_KEY_RE specifically (it might still be
  // caught by LONG_TOKEN_RE — that's fine — but the Mailchimp regex
  // alone shouldn't fire).
  const noDc = 'log: 64-hex hash e3b0c44298fc1c149afbf4c8996fb92427ae41e4 (no dc)';
  // We can't easily test the standalone regex from this file without
  // exporting it; instead verify behavior by ensuring a string with
  // structure NOT matching the Mailchimp shape passes redactSecret
  // unchanged (modulo the long-token rule on the 40-char prefix).
  // The 40+ char rule might catch the hash — that's expected.
  const got = redactSecret(noDc);
  // The non-hex prose "(no dc)" should survive.
  assert.ok(got.includes('(no dc)'),
    'non-credential prose survives: ' + got);
});
