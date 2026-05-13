// brand-manifest-scaffolder-persona.test.js — RSI iter 5 tests for the
// scaffolder's persona × LP × Andromeda extras path. Validates the
// US-Census race-distribution fail-safe, andromeda_axes defaults, and
// idempotency vs the extras data.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scaffoldBrandManifest } = require('./brand-manifest-scaffolder');

function makeTmpWorkspace(brand) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merlin-brand-iter5-test-'));
  const brandDir = path.join(root, 'assets', 'brands', brand);
  fs.mkdirSync(brandDir, { recursive: true });
  fs.mkdirSync(path.join(brandDir, 'logo'), { recursive: true });
  // Drop a logo so the scaffolder doesn't bail on "no canonical assets".
  fs.writeFileSync(path.join(brandDir, 'logo', 'logo.png'), 'png-bytes');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function readManifest(root, brand) {
  const p = path.join(root, 'assets', 'brands', brand, 'brand-manifest.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('iter 5: scaffolder accepts extras.personas and emits them on manifest', () => {
  const root = makeTmpWorkspace('test');
  try {
    const res = scaffoldBrandManifest(root, 'test', {
      extras: {
        personas: [{ slug: 'mom', label: 'Mom', emotional_triggers: ['guilt'], jobs_to_be_done: ['save time'], voice_register: 'warm', awareness_level: 'problem-aware' }],
      },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.hadPersonas, true);
    const manifest = readManifest(root, 'test');
    assert.strictEqual(manifest.personas.length, 1);
    assert.strictEqual(manifest.personas[0].slug, 'mom');
    // US Census race default applied (load-bearing fail-safe)
    const rd = manifest.personas[0].demographics.race_distribution;
    const nonZero = Object.values(rd).filter(v => v > 0).length;
    assert.ok(nonZero >= 2, 'US Census default must be multi-ethnic');
  } finally { cleanup(root); }
});

test('iter 5: scaffolder preserves caller-provided race_distribution', () => {
  const root = makeTmpWorkspace('test');
  try {
    const customRD = { hispanic_latino: 0.6, white: 0.3, african_american: 0.1 };
    const res = scaffoldBrandManifest(root, 'test', {
      extras: { personas: [{ slug: 'mom', label: 'Mom', demographics: { age_band: '35-45', race_distribution: customRD } }] },
    });
    assert.strictEqual(res.ok, true);
    const manifest = readManifest(root, 'test');
    assert.deepStrictEqual(manifest.personas[0].demographics.race_distribution, customRD,
      'caller race_distribution must NOT be overwritten');
  } finally { cleanup(root); }
});

test('iter 5: scaffolder emits default andromeda_axes when none provided', () => {
  const root = makeTmpWorkspace('test');
  try {
    const res = scaffoldBrandManifest(root, 'test');
    assert.strictEqual(res.ok, true);
    const manifest = readManifest(root, 'test');
    assert.ok(manifest.andromeda_axes);
    assert.ok(Array.isArray(manifest.andromeda_axes.contexts) && manifest.andromeda_axes.contexts.length >= 5);
    assert.ok(Array.isArray(manifest.andromeda_axes.styles) && manifest.andromeda_axes.styles.length >= 5);
  } finally { cleanup(root); }
});

test('iter 5: scaffolder honors caller-provided andromedaContexts override', () => {
  const root = makeTmpWorkspace('test');
  try {
    const res = scaffoldBrandManifest(root, 'test', {
      extras: { andromedaContexts: ['locker-room', 'tournament', 'practice'] },
    });
    assert.strictEqual(res.ok, true);
    const manifest = readManifest(root, 'test');
    assert.deepStrictEqual(manifest.andromeda_axes.contexts, ['locker-room', 'tournament', 'practice']);
  } finally { cleanup(root); }
});

test('iter 5: scaffolder accepts landing_pages and forbidden_* lists', () => {
  const root = makeTmpWorkspace('test');
  try {
    const res = scaffoldBrandManifest(root, 'test', {
      extras: {
        landingPages: [{ url: 'https://example.com/family', persona_slugs: ['mom'], primary_angle: 'hidden_cost' }],
        forbiddenPersonas: ['bargain-hunter'],
        forbiddenLandingPages: ['https://example.com/clearance'],
      },
    });
    assert.strictEqual(res.hadLandingPages, true);
    const manifest = readManifest(root, 'test');
    assert.strictEqual(manifest.landing_pages.length, 1);
    assert.strictEqual(manifest.landing_pages[0].url, 'https://example.com/family');
    assert.deepStrictEqual(manifest.forbidden_personas, ['bargain-hunter']);
    assert.deepStrictEqual(manifest.forbidden_landing_pages, ['https://example.com/clearance']);
  } finally { cleanup(root); }
});

test('iter 5: scaffolder idempotency — extras do NOT overwrite existing manifest', () => {
  const root = makeTmpWorkspace('test');
  try {
    scaffoldBrandManifest(root, 'test'); // first run — creates asset-only manifest
    const before = fs.readFileSync(path.join(root, 'assets', 'brands', 'test', 'brand-manifest.json'), 'utf8');
    scaffoldBrandManifest(root, 'test', { extras: { personas: [{ slug: 'mom', label: 'Mom' }] } });
    const after = fs.readFileSync(path.join(root, 'assets', 'brands', 'test', 'brand-manifest.json'), 'utf8');
    assert.strictEqual(after, before, 'idempotent re-run must NOT modify the manifest');
  } finally { cleanup(root); }
});

test('iter 5: scaffolder rebuild:true honors new personas + race default', () => {
  const root = makeTmpWorkspace('test');
  try {
    scaffoldBrandManifest(root, 'test'); // first run — no personas
    const res = scaffoldBrandManifest(root, 'test', {
      rebuild: true,
      extras: { personas: [{ slug: 'mom', label: 'Mom' }] },
    });
    assert.strictEqual(res.action, 'rebuilt');
    const manifest = readManifest(root, 'test');
    assert.strictEqual(manifest.personas.length, 1);
    assert.ok(manifest.personas[0].demographics.race_distribution);
  } finally { cleanup(root); }
});
