// spell-skill-md.js
//
// Pure helpers for building a SKILL.md body from user-controlled values.
// Extracted from main.js so the YAML/markdown escaping rules can be unit-
// tested without spinning up Electron.
//
// REGRESSION GUARD (2026-04-27, spellbook-rsi):
// SKILL.md frontmatter is YAML 1.2. Three values land in frontmatter
// (`name`, `description`, `cronExpression`). Before this audit they were
// interpolated raw — a description containing a literal `\n---\n` could
// move the YAML boundary and let the body bleed into metadata. cron was
// only regex-validated for shape, not for embedded quotes. Both were
// YAML-injection surfaces.
//
// All values now go through escapeYamlDoubleQuoted before reaching the
// `name: "..."` / `description: "..."` / `cronExpression: "..."` lines.
// Brand name is also escaped for markdown inline-code spans because the
// brand-lock section contains `${brandName}` inside backticks.
//
// See spell-skill-md.test.js for the full set of injection cases pinned.

'use strict';

// YAML 1.2 §7.3.2 — characters that must be escaped inside a double-quoted
// scalar. We escape backslash first to avoid double-escaping the others'
// escape sequences.
function escapeYamlDoubleQuoted(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

// Markdown inline-code spans (`...`). A brand name with a backtick would
// close the span early; control chars have no business in a brand name
// anyway. brandName is constrained to /^[a-z0-9_-]+$/ at the IPC boundary
// — this is defence-in-depth for any future call site that relaxes that.
function escapeMarkdownInlineCode(value) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/`/g, '\\`');
}

// Marker that distinguishes legacy SKILL.md bodies (pre-2026-04-24 brand
// lock migration) from current ones. main.js's migrateLegacySkills uses
// this string as the gate for re-migration.
const SKILL_BODY_MARKER = '<!-- merlin-skill-v2 -->';

function buildSkillBody({ fullTaskId, description, cron, prompt, brandName }) {
  const safeTaskId = escapeYamlDoubleQuoted(fullTaskId);
  const safeDescription = escapeYamlDoubleQuoted(description);
  const safeCron = escapeYamlDoubleQuoted(cron);
  const frontmatter =
    '---\n' +
    `name: "${safeTaskId}"\n` +
    `description: "${safeDescription}"\n` +
    `cronExpression: "${safeCron}"\n` +
    '---\n';

  let brandLock = '';
  if (brandName) {
    const brandQ = escapeMarkdownInlineCode(brandName);
    brandLock = `
## Brand Lock — ${brandQ}

This scheduled task operates EXCLUSIVELY on brand \`${brandQ}\`. Every brand-scoped MCP tool call in this session MUST include \`brand: "${brandQ}"\` as an argument. Do not omit it. Do not substitute another brand. The Merlin MCP server will REFUSE brand-scoped actions that are missing the brand argument and return a loud error — don't let that happen by forgetting.

Examples of correctly-scoped calls for this task:

- \`mcp__merlin__dashboard({ action: "dashboard", brand: "${brandQ}", batchCount: 7 })\`
- \`mcp__merlin__meta_ads({ action: "insights", brand: "${brandQ}" })\`
- \`mcp__merlin__tiktok_ads({ action: "insights", brand: "${brandQ}" })\`
- \`mcp__merlin__google_ads({ action: "insights", brand: "${brandQ}" })\`
- \`mcp__merlin__shopify({ action: "analytics", brand: "${brandQ}" })\`
- \`mcp__merlin__klaviyo({ action: "performance", brand: "${brandQ}" })\`
- \`mcp__merlin__email({ action: "audit", brand: "${brandQ}" })\`
- \`mcp__merlin__seo({ action: "audit", brand: "${brandQ}" })\`
- \`mcp__merlin__content({ action: "image", brand: "${brandQ}" })\`
- \`mcp__merlin__video({ action: "generate", brand: "${brandQ}" })\`

Brand assets live at \`assets/brands/${brandQ}/\`. Read \`brand.md\` for voice and positioning, and \`memory.md\` for prior decisions before acting. Save any new learnings back to \`memory.md\` so the next run compounds.
`;
  }
  const firstRunBlock = `\nFirst-run check: If this is the first time running (no prior results exist for this task), use the best quality settings, narrate each step, show results visually, and end with a summary of what you did and when the next scheduled run is.\n`;
  return `${frontmatter}${SKILL_BODY_MARKER}\n${brandLock}${firstRunBlock}\n${prompt}\n`;
}

module.exports = {
  buildSkillBody,
  escapeYamlDoubleQuoted,
  escapeMarkdownInlineCode,
  SKILL_BODY_MARKER,
};
