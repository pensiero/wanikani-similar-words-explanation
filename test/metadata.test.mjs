// Lints the userscript header against the code, so a release can't ship with a
// missing @grant/@connect or an unbumped prompt version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const source = readFileSync(new URL('../wanikani-nuance.user.js', import.meta.url), 'utf8');
const header = source.slice(source.indexOf('// ==UserScript=='), source.indexOf('// ==/UserScript=='));
const meta = (key) => [...header.matchAll(new RegExp(`^// @${key}\\s+(.+)$`, 'gm'))].map((m) => m[1].trim());
const core = createRequire(import.meta.url)('../wanikani-nuance.user.js');

test('version is semver', () => {
  assert.match(meta('version')[0], /^\d+\.\d+\.\d+$/);
});

test('every GM_ function used is granted, and nothing extra', () => {
  const body = source.slice(source.indexOf('// ==/UserScript=='));
  const used = new Set([...body.matchAll(/\b(GM_\w+)\(/g)].map((m) => m[1]));
  const granted = new Set(meta('grant').filter((g) => g.startsWith('GM_')));
  assert.deepEqual([...used].sort(), [...granted].sort());
});

test('every built-in provider host and Kanji Search are in @connect', () => {
  const connect = new Set(meta('connect'));
  for (const p of Object.values(core.PROVIDERS)) {
    if (p.baseUrl) assert.ok(connect.has(new URL(p.baseUrl).hostname), `missing @connect ${new URL(p.baseUrl).hostname}`);
  }
  assert.ok(connect.has('www.kanjisearch.com'));
  assert.ok(!connect.has('*'), 'no wildcard @connect');
});

test('Item Info Injector is pinned to a version', () => {
  assert.ok(meta('require').some((r) => /item-info-injector.+\?version=\d+$/.test(r)));
});
