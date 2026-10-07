#!/usr/bin/env node
// Runs the real prompt against a provider for a set of classic confusable pairs and
// reports validity, length and latency. Needs the local fixture (npm run fixture).
// Usage: PROVIDER=gemini API_KEY=... [MODEL=...] [BASE_URL=...] [LANG_OUT=English] node tools/eval-prompt.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const core = createRequire(import.meta.url)('../wanikani-nuance.user.js');
const provider = process.env.PROVIDER || 'gemini';
const cfg = {
  apiKey: process.env.API_KEY || '',
  model: process.env.MODEL || core.PROVIDERS[provider].defaultModel,
  baseUrl: process.env.BASE_URL || '',
};
const language = process.env.LANG_OUT || 'English';

const PAIRS = [
  ['必要', '重要'], ['思う', '考える'], ['早い', '速い'], ['決める', '決定する'], ['上る', '登る'],
  ['大切', '大事'], ['始める', '始まる'], ['見る', '見える'], ['会う', '合う'], ['幸せ', '幸福'],
];

const dir = new URL('../test/fixtures/local/', import.meta.url);
const subjects = JSON.parse(readFileSync(new URL('subjects.json', dir), 'utf8'));
const byChars = new Map(subjects.filter((s) => !s.data.hidden_at).map((s) => [s.data.characters, s]));

const wordsOf = (result) =>
  [
    ...result.words.flatMap((w) => [w.core_meaning, w.register_note, ...w.contexts, w.example.translation]),
    ...result.choose.map((c) => c.when),
    result.rule_of_thumb,
    result.common_mistake,
  ].join(' ').split(/\s+/).filter(Boolean).length;

const runs = [];
for (const pair of PAIRS) {
  const items = pair.map((c) => byChars.get(c)).filter(Boolean);
  if (items.length !== pair.length) {
    console.log(`skip ${pair.join('/')}: not on WK`);
    continue;
  }
  const words = items.map(core.wordInfo).sort((a, b) => a.id - b.id);
  const req = core.buildRequest(provider, cfg, core.buildPrompt(words, language));
  const t0 = Date.now();
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  const ms = Date.now() - t0;
  const json = await res.json().catch(() => null);
  const run = { pair: pair.join('/'), status: res.status, ms };
  try {
    const { text, model } = core.parseResponse(provider, res.status, json);
    run.model = model;
    run.result = core.parseResult(text);
    run.explanationWords = wordsOf(run.result);
    run.exampleChars = run.result.words.map((w) => w.example.ja.length);
    run.usage = json.usageMetadata || json.usage;
  } catch (e) {
    run.error = e.message;
  }
  runs.push(run);
  console.log(`${run.pair.padEnd(12)} ${String(run.status).padEnd(4)} ${String(ms).padStart(5)}ms ${run.error ? 'ERROR ' + run.error : `${run.explanationWords} words, examples ${run.exampleChars.join('/')} chars`}`);
  if (res.status === 402 || res.status === 401 || res.status === 403) break;
}

const ok = runs.filter((r) => !r.error);
console.log(`\nvalid ${ok.length}/${runs.length}; over 180 words: ${ok.filter((r) => r.explanationWords > 180).length}; median latency ${runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)] || 0}ms`);
const out = new URL(`eval-${provider}-${cfg.model.replace(/\W+/g, '_')}.json`, dir);
writeFileSync(out, JSON.stringify(runs, null, 1));
console.log(`full output: ${out.pathname}`);
