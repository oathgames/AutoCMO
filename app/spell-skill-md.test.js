// spell-skill-md.test.js
//
// REGRESSION GUARDS (2026-04-27, spellbook-rsi) for the YAML and markdown
// injection vectors found in the create-spell flow:
//
//   - description with "\n---\n" — moves the YAML boundary, lets prose
//     bleed into metadata
//   - cron with embedded `"` — closes the cronExpression scalar early,
//     daemon parser refuses to load
//   - brand name with backtick — closes the inline-code span in the
//     brand-lock examples, surfaces literal MCP call as parsable code
//
// Each test pins the escaped output, not just "no crash" — silent escape
// regressions would otherwise pass.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSkillBody,
  escapeYamlDoubleQuoted,
  escapeMarkdownInlineCode,
  SKILL_BODY_MARKER,
} = require('./spell-skill-md');

// Lightweight YAML 1.2 frontmatter parser sufficient for our 3-key
// double-quoted scalar shape. Splits on the first two `---` lines, then
// for each `key: "value"` line, applies the §7.3.2 escape rules in
// reverse so the test can compare raw input vs round-tripped output.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('frontmatter missing');
  const lines = m[1].split('\n');
  const out = {};
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z]+):\s*"((?:\\.|[^"\\])*)"\s*$/);
    if (!kv) continue;
    const [, k, raw] = kv;
    out[k] = raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return { keys: out, body: text.slice(m[0].length) };
}

// ─── escapeYamlDoubleQuoted ──────────────────────────────────────────────

test('escapeYamlDoubleQuoted escapes the four §7.3.2 chars in order', () => {
  assert.equal(escapeYamlDoubleQuoted('hello'), 'hello');
  assert.equal(escapeYamlDoubleQuoted('a"b'), 'a\\"b');
  assert.equal(escapeYamlDoubleQuoted('a\\b'), 'a\\\\b');
  assert.equal(escapeYamlDoubleQuoted('line1\nline2'), 'line1\\nline2');
  assert.equal(escapeYamlDoubleQuoted('cr\rin'), 'cr\\rin');
  assert.equal(escapeYamlDoubleQuoted(null), '');
  assert.equal(escapeYamlDoubleQuoted(undefined), '');
});

test('escapeYamlDoubleQuoted handles "kitchen sink" of all four chars at once', () => {
  const v = 'a"b\\c\nd\re';
  // backslash escapes first, then quote, then \r, then \n
  assert.equal(escapeYamlDoubleQuoted(v), 'a\\"b\\\\c\\nd\\re');
});

test('escapeMarkdownInlineCode neutralises backticks + strips control chars', () => {
  assert.equal(escapeMarkdownInlineCode('plain'), 'plain');
  assert.equal(escapeMarkdownInlineCode('a`b'), 'a\\`b');
  // Control char (\x07 = BEL) is silently dropped.
  assert.equal(escapeMarkdownInlineCode('a\x07b'), 'ab');
  assert.equal(escapeMarkdownInlineCode('a\nb'), 'ab'); // newline is a control char
});

// ─── buildSkillBody — happy path ─────────────────────────────────────────

test('buildSkillBody emits valid v2 frontmatter with the expected keys', () => {
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-daily-ads',
    description: 'Daily IVT test',
    cron: '0 9 * * 1-5',
    prompt: 'Generate three ads.',
    brandName: 'acme',
  });
  const { keys, body: rest } = parseFrontmatter(body);
  assert.equal(keys.name, 'merlin-acme-daily-ads');
  assert.equal(keys.description, 'Daily IVT test');
  assert.equal(keys.cronExpression, '0 9 * * 1-5');
  assert.ok(rest.startsWith(SKILL_BODY_MARKER));
  assert.ok(rest.includes('Brand Lock — acme'));
  assert.ok(rest.endsWith('Generate three ads.\n'));
});

test('buildSkillBody omits brand-lock section when brandName is empty', () => {
  const body = buildSkillBody({
    fullTaskId: 'merlin-shared',
    description: 'Universal task',
    cron: '0 0 * * *',
    prompt: 'Do work.',
    brandName: '',
  });
  assert.ok(!body.includes('Brand Lock'));
});

// ─── REGRESSION GUARDS — YAML/markdown injection ─────────────────────────

test('REGRESSION GUARD: description with embedded --- boundary cannot escape frontmatter', () => {
  const evilDescription = 'innocent prose\n---\ninjected: yes\n---\n';
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-daily-ads',
    description: evilDescription,
    cron: '0 9 * * 1-5',
    prompt: 'Body',
    brandName: 'acme',
  });
  // Frontmatter should still parse cleanly with description intact.
  const { keys } = parseFrontmatter(body);
  assert.equal(keys.description, evilDescription);
  // Most importantly: there must be EXACTLY two `---\n` boundaries in the
  // entire output (the open and close of the frontmatter). Any third one
  // would mean the description bled into the body as YAML.
  const boundaries = (body.match(/^---\n/gm) || []).length;
  assert.equal(boundaries, 2,
    `expected 2 frontmatter boundaries, got ${boundaries} — description bled out`);
});

test('REGRESSION GUARD: description with embedded double-quote does not break the scalar', () => {
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-daily-ads',
    description: 'a "quoted" word',
    cron: '0 9 * * 1-5',
    prompt: 'p',
    brandName: 'acme',
  });
  const { keys } = parseFrontmatter(body);
  assert.equal(keys.description, 'a "quoted" word');
});

test('REGRESSION GUARD: cron with embedded double-quote is escaped', () => {
  // Even though the IPC validator should reject this upstream, escape
  // here is defence-in-depth.
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-x',
    description: 'd',
    cron: '0 9 * * 1-5"; rm -rf /',
    prompt: 'p',
    brandName: 'acme',
  });
  const { keys } = parseFrontmatter(body);
  assert.equal(keys.cronExpression, '0 9 * * 1-5"; rm -rf /');
});

test('REGRESSION GUARD: brand name with backtick is escaped in markdown body', () => {
  // Brand-name validation rejects backticks at the IPC boundary, but
  // tests pin the escape behaviour as defence-in-depth.
  const body = buildSkillBody({
    fullTaskId: 'merlin-evil',
    description: 'd',
    cron: '0 9 * * *',
    prompt: 'p',
    brandName: 'a`b',
  });
  // Backticks neutralised — no closing-and-reopening of inline-code spans.
  assert.ok(body.includes('a\\`b'));
  assert.ok(!body.includes('`a`b`'));
});

test('REGRESSION GUARD: backslash in description is doubled, then escapes are not double-decoded', () => {
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-x',
    description: 'path C:\\Users\\acme',
    cron: '0 9 * * 1-5',
    prompt: 'p',
    brandName: 'acme',
  });
  const { keys } = parseFrontmatter(body);
  assert.equal(keys.description, 'path C:\\Users\\acme');
});

test('REGRESSION GUARD: every frontmatter field is wrapped in double quotes', () => {
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-x',
    description: 'd',
    cron: '0 9 * * *',
    prompt: 'p',
    brandName: 'acme',
  });
  // Each of name / description / cronExpression must use the double-quoted
  // YAML form — never a bare scalar (which would let `:` characters in the
  // value start a flow mapping).
  assert.ok(/^name: "[^"]+"\n/m.test(body), 'name not double-quoted');
  assert.ok(/^description: "[^"]*"\n/m.test(body), 'description not double-quoted');
  assert.ok(/^cronExpression: "[^"]+"\n/m.test(body), 'cron not double-quoted');
});

test('REGRESSION GUARD: prompt body is NOT escaped (stays as authored)', () => {
  // The prompt is rendered as markdown body, not YAML metadata. It must
  // round-trip exactly so users can include backticks, links, headers,
  // etc. — escaping it would change the agent's instructions silently.
  const richPrompt = 'Use `bash` to run `npm test`.\n\nReport with **bold**.';
  const body = buildSkillBody({
    fullTaskId: 'merlin-acme-x',
    description: 'd',
    cron: '0 9 * * *',
    prompt: richPrompt,
    brandName: 'acme',
  });
  assert.ok(body.endsWith(richPrompt + '\n'));
});
