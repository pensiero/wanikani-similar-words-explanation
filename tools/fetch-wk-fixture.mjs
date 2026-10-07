#!/usr/bin/env node
// Dumps vocab subjects and your started assignments from the WaniKani API v2 into
// test/fixtures/local/ (git-ignored: WK content must not be redistributed).
// Usage: WK_TOKEN=... node tools/fetch-wk-fixture.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const token = process.env.WK_TOKEN;
if (!token) throw new Error('Set WK_TOKEN (read-only personal access token)');

const OUT = new URL('../test/fixtures/local/', import.meta.url);
const headers = { Authorization: `Bearer ${token}`, 'Wanikani-Revision': '20170710' };

async function collect(url) {
  const out = [];
  while (url) {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page.data);
    url = page.pages.next_url;
    process.stderr.write(`\r${out.length} / ${page.total_count}`);
  }
  process.stderr.write('\n');
  return out;
}

const base = 'https://api.wanikani.com/v2';
const types = 'vocabulary,kana_vocabulary';
const subjects = await collect(`${base}/subjects?types=${types}`);
const assignments = await collect(`${base}/assignments?subject_types=${types}&started=true`);
const studyMaterials = await collect(`${base}/study_materials?subject_types=${types}`);

await mkdir(OUT, { recursive: true });
await writeFile(new URL('subjects.json', OUT), JSON.stringify(subjects));
await writeFile(new URL('assignments.json', OUT), JSON.stringify(assignments));
await writeFile(new URL('study_materials.json', OUT), JSON.stringify(studyMaterials));
console.log(`subjects=${subjects.length} assignments=${assignments.length} study_materials=${studyMaterials.length}`);
