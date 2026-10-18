import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../wanikani-similar-words-explanation.user.js');

// Minimal WKOF-shaped items: subject + assignments (+ study_materials).
function vocab(id, characters, meanings, { reading = 'よみ', level = 5, stage = 5, aux = [], synonyms } = {}) {
  return {
    id,
    object: 'vocabulary',
    data: {
      characters,
      level,
      meanings: meanings.map((meaning, i) => ({ meaning, primary: i === 0, accepted_answer: true })),
      auxiliary_meanings: aux,
      readings: [{ reading, primary: true, accepted_answer: true }],
      parts_of_speech: ['noun'],
    },
    assignments: stage == null ? undefined : { srs_stage: stage },
    study_materials: synonyms ? { meaning_synonyms: synonyms } : undefined,
  };
}

const items = [
  vocab(1, '必要', ['Necessary', 'Needed', 'Essential'], { reading: 'ひつよう', level: 6 }),
  vocab(2, '重要', ['Important', 'Essential'], { reading: 'じゅうよう', level: 9 }),
  vocab(3, '大切', ['Important', 'Precious'], { reading: 'たいせつ', level: 4 }),
  vocab(4, '不可欠', ['Indispensable', 'Essential'], { level: 30, stage: 0 }), // lesson not done
  vocab(5, '考える', ['To Think About', 'To Consider'], { reading: 'かんがえる' }),
  vocab(6, '思う', ['To Think'], { reading: 'おもう' }),
  vocab(7, '放送する', ['To Broadcast Something'], { aux: [{ meaning: 'To Air', type: 'whitelist' }] }),
  vocab(8, '伝える', ['To Convey'], { aux: [{ meaning: 'To Broadcast', type: 'blacklist' }], synonyms: ['to air'] }),
  { ...vocab(9, '隠し', ['Important']), data: { ...vocab(9, '隠し', ['Important']).data, hidden_at: '2020-01-01' } },
  vocab(10, '必要する', ['Necessary']), // fake する-form of 必要: same word, must not be a candidate
];

test('normalizeMeaning collapses WK phrasing variants', () => {
  assert.equal(core.normalizeMeaning('To Broadcast Something'), 'broadcast');
  assert.equal(core.normalizeMeaning('Watch (Clock)'), 'watch');
  assert.equal(core.normalizeMeaning('  The  End '), 'end');
  assert.equal(core.normalizeMeaning('To Put Something On'), 'put on');
});

test('meaningKeys uses whitelist auxiliaries and user synonyms, never blacklist', () => {
  assert.deepEqual([...core.meaningKeys(items[6])].sort(), ['air', 'broadcast']);
  assert.deepEqual([...core.meaningKeys(items[7])].sort(), ['air', 'convey']);
});

test('buildIndex indexes all visible items and tracks which are learned', () => {
  const index = core.buildIndex(items);
  assert.ok(index.learned.has(1));
  assert.ok(!index.learned.has(4), 'srs_stage 0 is not learned');
  assert.ok(!index.byId.has(9), 'hidden subjects are dropped');
  assert.deepEqual([...index.byKey.get('essential')].sort(), [1, 2, 4]);
});

test('findCandidates ranks shared meanings; weak unlearned matches stay out', () => {
  const index = core.buildIndex(items);
  const ids = core.findCandidates(index, 1, null).map((c) => c.id);
  assert.deepEqual(ids, [2], '不可欠 is unlearned and shares only one meaning');
  const fromImportant = core.findCandidates(index, 2, null);
  // One shared meaning each, so the closer level wins: 必要 (lvl 6) before 大切 (lvl 4) for 重要 (lvl 9).
  assert.deepEqual(fromImportant.map((c) => c.id), [1, 3]);
  assert.deepEqual(fromImportant[0].shared, ['essential']);
});

test('findCandidates merges Kanji Search groups and ignores enumerations', () => {
  const index = core.buildIndex(items);
  const ks = {
    groups: [
      { id: '考える,思う', entries: [{ characters: '考える', metadata: {} }, { characters: '思う', metadata: {} }] },
      { id: 'big', entries: Array.from({ length: core.KS_MAX_GROUP_SIZE + 1 }, (_, i) => ({ characters: i ? `x${i}` : '必要', metadata: {} })) },
      { id: 'notwk', entries: [{ characters: '想う', metadata: { notOnWk: true } }] },
    ],
  };
  const cands = core.findCandidates(index, 6, ks);
  assert.deepEqual(cands.map((c) => c.id), [5]);
  assert.equal(cands[0].ksGroupSize, 2);
  // A word found by both sources outranks one found by meaning only.
  const both = core.findCandidates(index, 2, { groups: [{ entries: [{ characters: '必要', metadata: {} }, { characters: '重要', metadata: {} }] }] });
  assert.equal(both[0].id, 1);
});

test('findCandidates sizes a Kanji Search group by its entries on WK only', () => {
  // The 交/混 family: 7 entries, but 交わす is not on WK, so it is a group of 6, not an enumeration.
  const family = ['交ぜる', '交じる', '交わる', '混ぜる', '混じる', '混ざる'];
  const index = core.buildIndex(family.map((c, i) => vocab(100 + i, c, [`Meaning ${i}`])));
  const entries = family.map((characters) => ({ characters, metadata: {} }));
  entries.splice(2, 0, { characters: '交わす', metadata: { notOnWk: true } });
  const cands = core.findCandidates(index, 105, { groups: [{ entries }] });
  assert.ok(cands.some((c) => c.id === 102), '混ざる lists 交わる');
  assert.equal(cands[0].ksGroupSize, 6);
});

test('findCandidates lists strong unlearned words after the learned ones', () => {
  const index = core.buildIndex(items);
  const ks = { groups: [{ entries: ['必要', '不可欠', '重要'].map((characters) => ({ characters, metadata: {} })) }] };
  const cands = core.findCandidates(index, 1, ks);
  assert.deepEqual(cands.map((c) => [c.id, c.learned]), [[2, true], [4, false]]);
});

test('markConfusion puts the word whose meaning or reading the user typed first', () => {
  const index = core.buildIndex(items);
  const cands = core.findCandidates(index, 2, null); // 重要: [必要, 大切]
  const mixed = core.markConfusion(index, 2, cands, 'precious', 'meaning');
  assert.deepEqual(mixed.map((c) => c.id), [3, 1]);
  assert.deepEqual(mixed[0].confused, { answer: 'precious', questionType: 'meaning' });
  assert.equal(core.markConfusion(index, 2, cands, 'Important', 'meaning'), cands, 'a right answer changes nothing');
  assert.equal(core.markConfusion(index, 2, cands, 'banana', 'meaning'), cands);
  assert.equal(core.markConfusion(index, 2, cands, 'たいせつ', 'reading')[0].id, 3);
  assert.equal(core.markConfusion(index, 2, cands, '', 'meaning'), cands);
});

test('markConfusion pulls in a non-candidate only when it shares a kanji or reading', () => {
  const extra = [
    ...items,
    vocab(11, '必死', ['Desperate'], { reading: 'ひっし', level: 7 }),
    vocab(12, '必ず', ['Certainly'], { reading: 'かならず', level: 30, stage: 0 }),
    vocab(13, '絶望', ['Desperate'], { reading: 'ぜつぼう', level: 20 }),
  ];
  const index = core.buildIndex(extra);
  const cands = core.findCandidates(index, 1, null);
  assert.equal(core.markConfusion(index, 1, cands, 'desperate', 'meaning')[0].id, 11, '必死 shares 必; 絶望 does not');
  assert.equal(core.markConfusion(index, 1, cands, 'certainly', 'meaning'), cands, '必ず is not learned');
});

test('highlightParts uses the model markers, else the word or its kanji stem', () => {
  assert.deepEqual(core.highlightParts('雨を**想定して**傘を持つ。', '想定'), [
    { text: '雨を', bold: false }, { text: '想定して', bold: true }, { text: '傘を持つ。', bold: false },
  ]);
  assert.deepEqual(core.highlightParts('新しい仕事を始めます。', '始める'), [
    { text: '新しい仕事を', bold: false }, { text: '始', bold: true }, { text: 'めます。', bold: false },
  ]);
  assert.deepEqual(core.highlightParts('期待する', '期待する'), [{ text: '期待する', bold: true }]);
  assert.deepEqual(core.highlightParts('関係ない文。', '想定'), [{ text: '関係ない文。', bold: false }]);
});

test('cacheKey is order-independent and versioned', () => {
  assert.equal(core.cacheKey([2, 1], 'English'), core.cacheKey([1, 2], ' english '));
  assert.match(core.cacheKey([1, 2], 'English'), new RegExp(`^cmp:v${core.PROMPT_VERSION}:english:1-2$`));
  assert.notEqual(core.cacheKey([1, 2], 'English'), core.cacheKey([1, 2], 'Italian'));
});

test('cacheKey and compareIds mix WK ids with added words', () => {
  assert.deepEqual([2, 'x:交わす', 1, 'x:あ'].sort(core.compareIds), [1, 2, 'x:あ', 'x:交わす']);
  assert.equal(core.cacheKey(['x:交わす', 2], 'English'), core.cacheKey([2, 'x:交わす'], 'English'));
  assert.match(core.cacheKey([2, 'x:交わす'], 'English'), /:2-x:交わす$/);
});

test('dictionaryWord keeps exact matches only, except for romaji', () => {
  const jisho = (word, reading, defs, pos = ['Godan verb']) => ({ japanese: [{ word, reading }], senses: [{ english_definitions: defs, parts_of_speech: pos }] });
  const kawasu = { data: [jisho('交わす', 'かわす', ['to exchange', 'to cross', 'to intersect'])] };
  assert.deepEqual(core.dictionaryWord(kawasu, '交わす'), {
    id: 'x:交わす', characters: '交わす', readings: ['かわす'], meanings: ['to exchange', 'to cross'], partsOfSpeech: ['Godan verb'], level: null, source: 'dictionary',
  });
  assert.equal(core.dictionaryWord(kawasu, 'かわす').characters, '交わす', 'kana finds the kanji form');
  assert.equal(core.dictionaryWord(kawasu, 'kawasu').characters, '交わす', 'romaji trusts the top hit');
  assert.equal(core.dictionaryWord({ data: [jisho('負', 'ふ', ['negative'])] }, 'ふがくくっ'), null, 'a loose match is not a match');
  assert.equal(core.dictionaryWord(null, 'x'), null);
  const wiki = { data: [{ japanese: [{ word: '交わす', reading: 'かわす' }], senses: [{ english_definitions: ['Wiki'], parts_of_speech: ['Wikipedia definition'] }, { english_definitions: ['to exchange'], parts_of_speech: [] }] }] };
  assert.deepEqual(core.dictionaryWord(wiki, '交わす').meanings, ['to exchange']);
});

test('buildPrompt describes added words and flags unknown ones', () => {
  const kawasu = { id: 'x:交わす', characters: '交わす', readings: ['かわす'], meanings: ['to exchange'], partsOfSpeech: ['Godan verb'], level: null, source: 'dictionary' };
  const known = core.buildPrompt([core.wordInfo(items[0]), kawasu], 'English');
  assert.match(known.user, /交わす \(かわす\): not on WaniKani; dictionary meanings: to exchange; part of speech: Godan verb/);
  assert.doesNotMatch(known.user, /may be a typo/);
  const odd = core.buildPrompt([core.wordInfo(items[0]), core.unknownWord(' ふがく ')], 'English');
  assert.match(odd.user, /- ふがく: not found on WaniKani or in a dictionary/);
  assert.match(odd.user, /may be a typo/);
  assert.equal(core.buildChatPrompt([core.wordInfo(items[0]), core.unknownWord('ふがく')], 'English').includes('and ふがく?'), true);
});

test('buildPrompt grounds readings and meanings and sets the language', () => {
  const words = [items[0], items[1]].map(core.wordInfo);
  const p = core.buildPrompt(words, 'Italian');
  assert.match(p.user, /必要 \(ひつよう\): WaniKani meanings: Necessary, Needed, Essential/);
  assert.match(p.system, /Write all explanations and translations in Italian/);
  assert.equal(p.schema, core.RESULT_SCHEMA);
  assert.match(p.user, /"gist"/);
  const chat = core.buildChatPrompt(words, 'English');
  assert.equal(chat, "What's the difference between 必要 (ひつよう) and 重要 (じゅうよう)? I'm an advanced learner of Japanese and keep mixing them up. Please answer in English.");
  assert.ok(encodeURIComponent(chat).length < 2000, 'prefill URL stays short');
});

test('parseResult accepts fenced JSON, coerces and drops empty bits', () => {
  const raw = '```json\n' + JSON.stringify({
    relation: 'Related',
    gist: '必要 is needed, 重要 matters.',
    words: [
      { word: '必要', reading: 'ひつよう', gloss: 'needed', register: 'Neutral', everyday: 'Very common', note: 'Requirement.', example: { ja: '傘が**必要**だ。', en: 'I need an umbrella.' }, expressions: [{ ja: '必要不可欠', en: 'indispensable' }, { ja: '', en: 'x' }, { ja: 'a', en: '' }, { ja: 'b', en: '' }, { ja: 'c', en: '' }] },
      { word: '重要', reading: 'じゅうよう', gloss: 'important', register: 'formal' },
    ],
    scene: { setup: 'Packing', lines: [{ word: '必要', ja: '傘が必要だ。', en: 'I need an umbrella.' }, { word: '重要', ja: '', en: 'x' }] },
  }) + '\n```';
  const r = core.parseResult(raw);
  assert.equal(r.gist, '必要 is needed, 重要 matters.');
  assert.equal(r.relation, 'related');
  assert.equal(core.parseResult('{"relation":"cousins","words":[{"word":"a"},{"word":"b"}]}').relation, '');
  assert.equal(r.words[0].register, 'neutral');
  assert.equal(r.words[0].everyday, 'very common');
  assert.deepEqual(r.words[0].example, { ja: '傘が**必要**だ。', en: 'I need an umbrella.' });
  assert.deepEqual(r.words[1].opposite, { ja: '', en: '' });
  assert.equal(r.words[1].everyday, '');
  assert.equal(r.words[0].expressions.length, 3);
  assert.deepEqual(r.words[1].expressions, []);
  assert.equal(r.scene.lines.length, 1);
  assert.equal(r.watch_out, '');
  assert.throws(() => core.parseResult('not json'), /valid JSON/);
  assert.throws(() => core.parseResult('{"words":[{"word":"a"}]}'), /incomplete/);
});

test('buildRequest: Gemini puts the key in a header and enforces the schema', () => {
  const prompt = core.buildPrompt([items[0], items[1]].map(core.wordInfo), 'English');
  const req = core.buildRequest('gemini', { apiKey: 'k', model: 'gemini-x' }, prompt);
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
  assert.ok(!req.url.includes('key='));
  assert.equal(req.headers['x-goog-api-key'], 'k');
  assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(req.body.generationConfig.temperature, 0.2);
});

test('buildRequest: OpenAI-compatible providers share one format', () => {
  const prompt = core.buildPrompt([items[0], items[1]].map(core.wordInfo), 'English');
  const or = core.buildRequest('openrouter', { apiKey: 'k', model: 'm' }, prompt);
  assert.equal(or.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(or.headers.Authorization, 'Bearer k');
  const ollama = core.buildRequest('ollama', { apiKey: '', model: 'qwen3:14b' }, prompt);
  assert.equal(ollama.url, 'http://localhost:11434/v1/chat/completions');
  assert.ok(!('Authorization' in ollama.headers));
  assert.throws(() => core.buildRequest('custom', { model: 'm' }, prompt), /base URL/);
});

test('parseResponse extracts text and maps errors', () => {
  const gem = core.parseResponse('gemini', 200, {
    candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{"a":1}' }] } }],
    modelVersion: 'gemini-x-001',
  });
  assert.deepEqual(gem, { text: '{"a":1}', model: 'gemini-x-001' });
  const oa = core.parseResponse('openrouter', 200, { choices: [{ message: { content: '{}' } }], model: 'm' });
  assert.deepEqual(oa, { text: '{}', model: 'm' });
  assert.throws(() => core.parseResponse('gemini', 429, { error: { message: 'quota' } }), (e) => e.status === 429 && e.message === 'quota');
  const msg = core.friendlyError(new core.ProviderError(402, 'depleted'));
  assert.match(msg, /no billing account/);
});
