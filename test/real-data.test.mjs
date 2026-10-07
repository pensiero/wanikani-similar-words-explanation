// Runs against your own WaniKani data when present (npm run fixture); skipped otherwise.
// The fixture is git-ignored because WK content must not be redistributed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const core = createRequire(import.meta.url)('../wanikani-nuance.user.js');
const dir = new URL('./fixtures/local/', import.meta.url);
const present = existsSync(new URL('subjects.json', dir));

function loadItems() {
  const read = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  const byId = (list) => new Map(list.map((x) => [x.data.subject_id, x.data]));
  const assignments = byId(read('assignments.json'));
  const materials = byId(read('study_materials.json'));
  return read('subjects.json').map((s) => ({ ...s, assignments: assignments.get(s.id), study_materials: materials.get(s.id) }));
}

test('real data: index builds fast and candidate lists stay small', { skip: !present && 'no local fixture' }, () => {
  const items = loadItems();
  const t0 = performance.now();
  const index = core.buildIndex(items);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `index took ${ms.toFixed(0)}ms`);
  let withCandidates = 0;
  for (const id of index.learned) {
    const c = core.findCandidates(index, id, null);
    assert.ok(c.length <= core.MAX_CANDIDATES);
    if (c.length) withCandidates++;
  }
  console.log(`learned=${index.learned.size} withCandidates=${withCandidates} indexMs=${ms.toFixed(0)}`);
});

test('real data: known confusable pairs are found when both are learned', { skip: !present && 'no local fixture' }, () => {
  const index = core.buildIndex(loadItems());
  const idOf = (chars) => (index.byChars.get(chars) || []).find((id) => index.learned.has(id));
  for (const [a, b] of [['必要', '重要'], ['上る', '登る'], ['早い', '速い'], ['大切', '大事']]) {
    const [ia, ib] = [idOf(a), idOf(b)];
    if (!ia || !ib) continue;
    assert.ok(core.findCandidates(index, ia, null).some((c) => c.id === ib), `${a} should list ${b}`);
  }
});
