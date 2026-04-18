// chart-renderer.test.js — node:test tests for the SVG chart renderer.
// Uses a minimal fake DOM; no jsdom dependency.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountCharts, mountChartsInHtml, CHART_SELECTOR } = require('./chart-renderer');

// Tiny DOM shim: just enough to satisfy mountCharts().
function makeEl(payload) {
  let innerHTML = '';
  const attrs = { 'data-chart-payload': payload, class: 'merlin-chart' };
  return {
    tagName: 'DIV',
    set innerHTML(h) { innerHTML = h; },
    get innerHTML() { return innerHTML; },
    getAttribute: (k) => attrs[k] || null,
    setAttribute: (k, v) => { attrs[k] = v; },
  };
}

function makeRoot(elements) {
  return {
    querySelectorAll: (sel) => { assert.equal(sel, CHART_SELECTOR); return elements; },
  };
}

function encodePayload(obj) {
  return JSON.stringify(obj).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

test('mountCharts renders a bar chart with one rect per datapoint', () => {
  const payload = encodePayload({
    title: 'Spend by platform', kind: 'bar',
    data: [
      { id: 'a1', label: 'meta',   value: 1000, display: '$1,000' },
      { id: 'b2', label: 'tiktok', value: 500,  display: '$500' },
    ],
  });
  const el = makeEl(payload);
  const mounted = mountCharts(makeRoot([el]));
  assert.equal(mounted, 1);
  assert.ok(el.innerHTML.includes('<svg'));
  const rects = (el.innerHTML.match(/<rect /g) || []).length;
  assert.equal(rects, 2);
  assert.ok(el.innerHTML.includes('data-fact="a1"'));
  assert.ok(el.innerHTML.includes('data-fact="b2"'));
  assert.ok(el.innerHTML.includes('Spend by platform'));
});

test('mountCharts renders a line chart with one circle per datapoint', () => {
  const payload = encodePayload({
    title: 'ROAS trend', kind: 'line',
    data: [
      { id: 'd1', label: 'w1', value: 1.8 },
      { id: 'd2', label: 'w2', value: 2.4 },
      { id: 'd3', label: 'w3', value: 3.1 },
    ],
  });
  const el = makeEl(payload);
  mountCharts(makeRoot([el]));
  assert.ok(el.innerHTML.includes('<path'));
  const circles = (el.innerHTML.match(/<circle /g) || []).length;
  assert.equal(circles, 3);
});

test('mountCharts renders a donut chart with one arc per slice', () => {
  const payload = encodePayload({
    title: 'Revenue mix', kind: 'donut',
    data: [
      { id: 'r1', label: 'shopify', value: 7000 },
      { id: 'r2', label: 'stripe',  value: 3000 },
    ],
  });
  const el = makeEl(payload);
  mountCharts(makeRoot([el]));
  const paths = (el.innerHTML.match(/<path /g) || []).length;
  assert.equal(paths, 2);
});

test('mountCharts falls back to text when data is empty', () => {
  const payload = encodePayload({ title: 'Empty', kind: 'bar', data: [] });
  const el = makeEl(payload);
  mountCharts(makeRoot([el]));
  assert.ok(el.innerHTML.includes('no data available'));
  assert.ok(!el.innerHTML.includes('<svg'));
});

test('mountCharts tolerates bad JSON payload', () => {
  const el = makeEl('not-json');
  mountCharts(makeRoot([el]));
  assert.ok(el.innerHTML.includes('no data available'));
});

test('mountCharts is a no-op on null/bad root', () => {
  assert.equal(mountCharts(null), 0);
  assert.equal(mountCharts({}), 0);
});

test('mountCharts escapes special chars in title and labels', () => {
  const payload = encodePayload({
    title: '<script>x</script>', kind: 'bar',
    data: [{ id: 'e1', label: 'A&B', value: 5, display: '"5"' }],
  });
  const el = makeEl(payload);
  mountCharts(makeRoot([el]));
  assert.ok(!el.innerHTML.includes('<script>'));
  assert.ok(el.innerHTML.includes('&lt;script&gt;'));
  assert.ok(el.innerHTML.includes('A&amp;B'));
});

// Regression: the empty-data fallback path previously interpolated
// payload.title into innerHTML without escaping — a config with empty
// `data` plus a title containing HTML would have injected raw tags. The
// happy path (svgFrame) was always safe; only this fallback leaked. If
// this test ever regresses, fallback rendering is back on an XSS path.
test('mountCharts fallback path escapes title (AI review WARN regression guard)', () => {
  const payload = encodePayload({
    title: '<img src=x onerror=alert(1)>', kind: 'bar', data: [], // empty triggers fallback
  });
  const el = makeEl(payload);
  mountCharts(makeRoot([el]));
  assert.ok(el.innerHTML.includes('no data available'));
  assert.ok(!el.innerHTML.includes('<img src=x'),
    `fallback path leaked raw HTML: ${el.innerHTML}`);
  assert.ok(el.innerHTML.includes('&lt;img'),
    `fallback path did not escape: ${el.innerHTML}`);
});

// ── mountChartsInHtml (string-based, preload-side) ────────────────────
//
// The renderer runs with contextIsolation + no nodeIntegration, so DOM
// elements can't cleanly cross contextBridge into preload. Production
// path calls this string-based analogue on the HTML before innerHTML
// assignment. These tests mirror the DOM-version tests to lock parity.

test('mountChartsInHtml swaps bar-chart placeholder for inline SVG', () => {
  const payload = encodePayload({
    title: 'Spend', kind: 'bar',
    data: [
      { id: 'a1', label: 'meta',   value: 1000, display: '$1,000' },
      { id: 'b2', label: 'tiktok', value: 500,  display: '$500' },
    ],
  });
  const html = `<p>preamble</p><div class="merlin-chart" data-chart-payload="${payload}"></div><p>tail</p>`;
  const out = mountChartsInHtml(html);
  assert.ok(out.includes('<svg'));
  assert.ok(out.includes('data-fact="a1"'));
  assert.ok(out.includes('data-fact="b2"'));
  assert.ok(out.includes('<p>preamble</p>'));
  assert.ok(out.includes('<p>tail</p>'));
  // Outer placeholder div preserved (send-boundary verifier scans it).
  assert.ok(out.includes('<div class="merlin-chart" data-chart-payload="'));
});

test('mountChartsInHtml handles multiple placeholders in one pass', () => {
  const p1 = encodePayload({ title: 'A', kind: 'bar', data: [{ id: 'x', label: 'x', value: 1 }] });
  const p2 = encodePayload({ title: 'B', kind: 'line', data: [{ id: 'y', label: 'y', value: 2 }, { id: 'z', label: 'z', value: 3 }] });
  const html =
    `<div class="merlin-chart" data-chart-payload="${p1}"></div>` +
    `<div class="merlin-chart" data-chart-payload="${p2}"></div>`;
  const out = mountChartsInHtml(html);
  const svgCount = (out.match(/<svg/g) || []).length;
  assert.equal(svgCount, 2);
  assert.ok(out.includes('<rect '));
  assert.ok(out.includes('<path '));
});

test('mountChartsInHtml is a no-op when no placeholders are present', () => {
  const html = '<p>hello world</p><div class="other">not a chart</div>';
  assert.equal(mountChartsInHtml(html), html);
});

test('mountChartsInHtml handles non-string / empty input', () => {
  assert.equal(mountChartsInHtml(''), '');
  assert.equal(mountChartsInHtml(null), null);
  assert.equal(mountChartsInHtml(undefined), undefined);
});

test('mountChartsInHtml falls back to text on empty data', () => {
  const payload = encodePayload({ title: 'Nothing', kind: 'bar', data: [] });
  const html = `<div class="merlin-chart" data-chart-payload="${payload}"></div>`;
  const out = mountChartsInHtml(html);
  assert.ok(out.includes('no data available'));
  assert.ok(!out.includes('<svg'));
});

test('mountChartsInHtml fallback escapes title (XSS regression guard)', () => {
  const payload = encodePayload({
    title: '<img src=x onerror=alert(1)>', kind: 'bar', data: [],
  });
  const html = `<div class="merlin-chart" data-chart-payload="${payload}"></div>`;
  const out = mountChartsInHtml(html);
  assert.ok(!out.includes('<img src=x'), `fallback leaked raw HTML: ${out}`);
  assert.ok(out.includes('&lt;img'), `fallback did not escape: ${out}`);
});

test('mountChartsInHtml does NOT re-mount an already-mounted placeholder', () => {
  // After first pass, placeholder body is non-empty (<svg>...</svg>). The
  // regex requires an empty body (></div>) so a second pass is a no-op —
  // matching the idempotency contract of the DOM version.
  const payload = encodePayload({ title: 'X', kind: 'bar', data: [{ id: 'a', label: 'a', value: 1 }] });
  const html = `<div class="merlin-chart" data-chart-payload="${payload}"></div>`;
  const first = mountChartsInHtml(html);
  const second = mountChartsInHtml(first);
  assert.equal(first, second, 'second pass must be a no-op (idempotent)');
});

test('mountChartsInHtml tolerates malformed payload (returns fallback)', () => {
  const html = `<div class="merlin-chart" data-chart-payload="not-json"></div>`;
  const out = mountChartsInHtml(html);
  assert.ok(out.includes('no data available'));
});
