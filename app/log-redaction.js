// Merlin — Log Redaction (BUG-G005, 2026-05-10)
//
// REGRESSION GUARD (2026-05-10, BUG-G005 token-redaction audit):
// Hard-Won Rule 6 says every user-visible error passes through friendlyError().
// That guard covers the renderer chat surface — it does NOT cover the audit /
// activity / error log files at:
//   - <appRoot>/.merlin-errors.log     (appendErrorLog)
//   - <appRoot>/.merlin-audit.log      (appendAudit, already redacts inline)
//   - <appRoot>/assets/brands/<b>/activity.jsonl  (appendActivityLog)
//
// All three are user-facing in the same way the activity.jsonl Go-side log
// is: support tickets, Discord pastes, GitHub issues. A single token landing
// in any of them is a 1:1 leak.
//
// `appendAudit` already runs an inline 32+-char-base64 redaction. `appendErrorLog`
// and `appendActivityLog` previously did not. This module is the shared helper
// they now route through. The pattern matches Go-side redactSecret in
// autocmo-core/main.go so a token leak surfaced in one repo's audit is caught
// in the other's.
//
// Coverage: log-redaction.test.js covers every prefix below + the negative
// cases (benign strings stay intact).

'use strict';

// Platform-specific token prefixes. Order: most specific first so longer
// prefixes (sk_live_) win over shorter ones (sk-) when both could match.
// Suffix minimum is 8 chars to avoid false-positives on identifiers like
// `sk-test` in an inline comment or doc fixture.
const TOKEN_PREFIX_RE = /(sk_live_|sk_test_|sk-|github_pat_|ghp_|gho_|ghs_|ghu_|AKIA|ASIA|xoxb-|xoxp-|xoxa-|xoxs-|xoxr-|ca_live_|ca_test_|EAA[A-Z]|fal_|whsec_|gsk_|shpat_|shpss_|AIza)[A-Za-z0-9_\-]{8,}/g;

// Mailchimp Marketing API key shape: <32-hex>-<datacenter> (e.g.
// abc123def456...-us6). 32+1+2=35 chars at minimum — the existing
// LONG_TOKEN_RE requires 40+, so a Mailchimp key in a log line would
// NOT be redacted by the generic sweep. Mailchimp keys also have no
// committed `mc_` / `mc-` prefix, so TOKEN_PREFIX_RE can't catch them
// by prefix.
//
// REGRESSION GUARD (2026-05-11, post-audit token-redaction gap):
// Cross-repo adversarial audit caught this — Hard-Won Rule G005 says
// every recognizable token shape gets redacted in logs; Mailchimp keys
// were exempt purely because their shape didn't fit either existing
// pattern. The regex is structurally restrictive (lowercase hex + dash
// + 2-3-char alnum dc) so it doesn't false-positive on generic hashes.
// Mirrors autocmo-core/main.go's secretMailchimpPattern exactly so a
// token leak detected in one repo's audit is caught in the other's.
const MAILCHIMP_KEY_RE = /\b[a-f0-9]{32}-[a-z]{1,4}[0-9]{1,3}\b/g;

// Long opaque base64-ish token catch-all (matches the appendAudit existing
// behavior + the relay-client logSafe behavior). Tightened minimum from 32
// to 40 because shorter strings tend to be legitimate identifiers (campaign
// IDs, ad IDs are typically 16-20 chars). 40+ is the empirical floor for
// platform-issued opaque tokens.
const LONG_TOKEN_RE = /[A-Za-z0-9_\-+/]{40,}={0,2}/g;

/**
 * Redact all credential-shaped substrings from `s`. Conservative — narrow
 * regex to avoid breaking normal log lines (timestamps, IDs, file paths).
 *
 * @param {string} s
 * @returns {string} redacted copy with `[REDACTED]` in place of any matched
 *                   token shape; returns `s` unchanged if input isn't a string.
 */
function redactSecret(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  // Run prefix pass first — it catches short prefixed tokens (sk-XXXX) that
  // the long-token sweep would miss because they're under the 40-char floor.
  let out = s.replace(TOKEN_PREFIX_RE, '[REDACTED]');
  // Mailchimp pattern (35-37 chars) sits between the prefix sweep and the
  // long-token sweep — must run before LONG_TOKEN_RE so an unredacted
  // Mailchimp key doesn't pass through (LONG_TOKEN_RE's 40-char floor
  // wouldn't catch it).
  out = out.replace(MAILCHIMP_KEY_RE, '[REDACTED]');
  out = out.replace(LONG_TOKEN_RE, '[REDACTED]');
  return out;
}

/**
 * Redact a JSON-serializable value's leaf strings. Matches the shape used
 * by appendActivityLog callers, which JSON.stringify a structured event.
 * In-place mutation for objects, returns new arrays for arrays (mirrors
 * mcp-redact.js's redactJsonObj contract).
 */
function redactJsonValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecret(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactJsonValue);
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      value[k] = redactSecret(v);
    } else if (v && typeof v === 'object') {
      value[k] = redactJsonValue(v);
    }
  }
  return value;
}

module.exports = { redactSecret, redactJsonValue };
