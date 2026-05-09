// REGRESSION GUARD (2026-05-09, klaviyo-perf-endpoints — live user request):
//
// The original klaviyo MCP surface exposed structural data (flows-list,
// flow-get, templates-list, campaigns) but NOT performance analytics —
// the actually-useful numbers a marketer needs to evaluate flow ROI
// (sends / opens / clicks / conversions / recovered revenue per flow,
// per-email stats inside a flow, metric aggregate counts over time).
//
// This test pins the THREE new actions in the klaviyo MCP tool's enum
// AND the input fields they need (flowId reused, metricId added). Any
// future cleanup that drops one of these from the enum fails CI.
//
// The Go-side handlers live in autocmo-core/klaviyo_performance.go.
// This test only locks the JS-side schema contract — the Go suite has
// its own coverage for the binary-action routing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MCP_TOOLS = fs.readFileSync(path.join(__dirname, 'mcp-tools.js'), 'utf8');

function klaviyoToolBlock() {
  // Slice the klaviyo defineTool block so we don't false-match against
  // other tools that happen to mention "performance" in their description.
  const start = MCP_TOOLS.indexOf("name: 'klaviyo'");
  assert.ok(start > 0, "name: 'klaviyo' must exist in mcp-tools.js");
  // The defineTool block ends at the next `}, tool, z, ctx));` after
  // the name. Take a generous slice — enum + input fields fit easily.
  const end = MCP_TOOLS.indexOf('}, tool, z, ctx));', start);
  assert.ok(end > start, 'klaviyo block must close cleanly');
  return MCP_TOOLS.slice(start, end + 30);
}

test('klaviyo enum exposes flow-performance, flow-message-performance, metric-aggregate', () => {
  const block = klaviyoToolBlock();
  for (const action of ['flow-performance', 'flow-message-performance', 'metric-aggregate']) {
    assert.ok(
      new RegExp(`'${action}'`).test(block),
      `klaviyo action enum must include '${action}' (live user request 2026-05-09 — original surface only had structural data, not performance numbers)`
    );
  }
});

test('klaviyo input declares metricId for metric-aggregate', () => {
  const block = klaviyoToolBlock();
  assert.ok(
    /metricId:\s*z\.string\(\)\.optional\(\)/.test(block),
    'klaviyo input must declare metricId — required for metric-aggregate (Klaviyo /api/metric-aggregates/ filters by metric_id)'
  );
});

test('klaviyo input flowId is shared between flow-* and flow-*-performance actions', () => {
  // The flowId field already exists for flow-get / flow-update-status /
  // flow-delete. The new performance actions reuse it. This test catches
  // a regression where someone splits flowId into per-action fields and
  // accidentally drops it from the performance side.
  const block = klaviyoToolBlock();
  assert.ok(
    /flowId:\s*z\.string\(\)\.optional\(\)/.test(block),
    'klaviyo input must declare flowId — required for flow-message-performance, optional for flow-performance'
  );
});

test('klaviyo description mentions the three performance actions', () => {
  // The LLM's first-line read of the tool is the description. Without
  // the performance actions called out there, the LLM will keep reaching
  // for the misnamed-but-historical "performance" action that returns
  // metric DEFINITIONS instead of actual data.
  const block = klaviyoToolBlock();
  assert.ok(
    /flow-performance/.test(block) && /flow-message-performance/.test(block) && /metric-aggregate/.test(block),
    'klaviyo tool description must call out the three performance actions so the LLM picks them over the legacy "performance" name'
  );
  assert.ok(
    /which subject line is winning|recovered.revenue|how many times did/i.test(block),
    'klaviyo description must hint at the use cases (subject-line A/B, recovered revenue, metric counts) so the LLM routes natural-language asks correctly'
  );
});

test('klaviyo handler still uses the action-prefix dispatch (no special case for performance actions)', () => {
  // The handler builds `klaviyo-${args.action}` from the action name.
  // A future PR that special-cases performance actions in JS (e.g. with
  // an actionMap) is fine, but the contract this test locks is that
  // RIGHT NOW the dispatch is uniform — performance actions go through
  // the same `klaviyo-` prefix that every other klaviyo action uses.
  const block = klaviyoToolBlock();
  assert.ok(
    /runBinary\(ctx,\s*'klaviyo-'\s*\+\s*args\.action/.test(block),
    'klaviyo handler must dispatch via klaviyo-${action} (uniform prefix — performance actions ride the same pipe)'
  );
});
