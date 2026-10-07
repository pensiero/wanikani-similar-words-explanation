// ==UserScript==
// @name         WaniKani Similar Words Explanation
// @namespace    https://github.com/pensiero/wanikani-similar-words-explanation
// @version      0.3.0
// @description  Lists vocab you have learned that is easy to confuse with the current word (shared meanings + Kanji Search groups) and, on click, asks an LLM how they differ. Answers are cached in your browser.
// @author       pensiero
// @license      MIT
// @match        https://www.wanikani.com/*
// @match        https://preview.wanikani.com/*
// @noframes
// @require      https://greasyfork.org/scripts/430565-wanikani-item-info-injector/code/WaniKani%20Item%20Info%20Injector.user.js?version=1951553
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      generativelanguage.googleapis.com
// @connect      openrouter.ai
// @connect      www.kanjisearch.com
// @connect      localhost
// @connect      127.0.0.1
// @homepageURL  https://github.com/pensiero/wanikani-similar-words-explanation
// @supportURL   https://github.com/pensiero/wanikani-similar-words-explanation/issues
// @downloadURL  https://raw.githubusercontent.com/pensiero/wanikani-similar-words-explanation/main/wanikani-similar-words-explanation.user.js
// @updateURL    https://raw.githubusercontent.com/pensiero/wanikani-similar-words-explanation/main/wanikani-similar-words-explanation.user.js
// ==/UserScript==

/* global GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_xmlhttpRequest,
   GM_registerMenuCommand, GM_setClipboard, GM_openInTab, unsafeWindow */

(function () {
  'use strict';

  // ===========================================================================
  // Core: pure functions, no page or GM access. Unit-tested in Node (see test/).
  // ===========================================================================

  // Bump whenever the prompt or the result schema changes: it is part of the
  // cache key, so old answers stop matching instead of rendering wrongly.
  const PROMPT_VERSION = 3;

  const LEARNED_MIN_SRS_STAGE = 1; // Apprentice 1: confusion starts at first sight
  const MAX_CANDIDATES = 8;
  const MAX_SELECTED = 3; // compared words besides the current one
  const KS_MAX_GROUP_SIZE = 6; // larger Kanji Search groups are enumerations (numbers, planets, days)
  const CACHE_PREFIX = 'cmp:';

  const REGISTERS = ['casual', 'neutral', 'formal', 'written', 'literary'];

  // Contrast-first: one gist, a short note per word, one shared scene. Every field
  // must add something the others don't; v1/v2 had four fields restating the same
  // distinction and a mandatory "common mistake" the model often had to invent.
  const RESULT_SCHEMA = {
    type: 'object',
    properties: {
      gist: { type: 'string' },
      words: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            word: { type: 'string' },
            reading: { type: 'string' },
            gloss: { type: 'string' },
            register: { type: 'string', enum: REGISTERS },
            note: { type: 'string' },
            expressions: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ja: { type: 'string' }, en: { type: 'string' } },
                required: ['ja', 'en'],
              },
            },
          },
          required: ['word', 'reading', 'gloss', 'register', 'note', 'expressions'],
        },
      },
      scene: {
        type: 'object',
        properties: {
          setup: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: { word: { type: 'string' }, ja: { type: 'string' }, en: { type: 'string' } },
              required: ['word', 'ja', 'en'],
            },
          },
        },
        required: ['setup', 'lines'],
      },
      watch_out: { type: 'string' },
    },
    required: ['gist', 'words', 'scene', 'watch_out'],
  };

  // "To Broadcast Something" and "broadcast" must collide; "Watch (Clock)" and "watch" too.
  function normalizeMeaning(meaning) {
    return meaning
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(something|someone|somebody)\b/g, ' ')
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(to|a|an|the) /, '')
      .trim();
  }

  // Accepted meanings, whitelisted auxiliary meanings and the user's own synonyms.
  // Blacklisted auxiliaries are wrong answers WK warns about, so they are excluded.
  function meaningKeys(item) {
    const raw = [
      ...item.data.meanings.filter((m) => m.accepted_answer).map((m) => m.meaning),
      ...(item.data.auxiliary_meanings || []).filter((m) => m.type === 'whitelist').map((m) => m.meaning),
      ...((item.study_materials && item.study_materials.meaning_synonyms) || []),
    ];
    return new Set(raw.map(normalizeMeaning).filter((k) => k.length > 1));
  }

  function wordInfo(item) {
    const d = item.data;
    const primaryFirst = (list) => [...list].sort((a, b) => Number(b.primary) - Number(a.primary));
    const readings = d.readings
      ? primaryFirst(d.readings.filter((r) => r.accepted_answer)).map((r) => r.reading)
      : [d.characters]; // kana-only vocab
    return {
      id: item.id,
      characters: d.characters,
      readings,
      meanings: primaryFirst(d.meanings.filter((m) => m.accepted_answer)).map((m) => m.meaning),
      partsOfSpeech: d.parts_of_speech || [],
      level: d.level,
    };
  }

  function isLearned(item) {
    return !!item.assignments && item.assignments.srs_stage >= LEARNED_MIN_SRS_STAGE;
  }

  // items: WKOF ItemData items (subject + .assignments + .study_materials).
  function buildIndex(items) {
    const byId = new Map();
    const byChars = new Map();
    const byKey = new Map();
    const learned = new Set();
    for (const item of items) {
      if (item.data.hidden_at) continue;
      byId.set(item.id, item);
      const ids = byChars.get(item.data.characters) || [];
      ids.push(item.id);
      byChars.set(item.data.characters, ids);
      if (!isLearned(item)) continue;
      learned.add(item.id);
      for (const key of meaningKeys(item)) {
        if (!byKey.has(key)) byKey.set(key, new Set());
        byKey.get(key).add(item.id);
      }
    }
    return { byId, byChars, byKey, learned };
  }

  // ksNote: the JSON kanjisearch.com serves for the current word, or null.
  function findCandidates(index, id, ksNote) {
    const item = index.byId.get(id);
    if (!item) return [];
    const found = new Map();
    // 期待 vs 期待する (or a kana duplicate) is the same word, not a confusable one.
    const stem = (characters) => characters.replace(/する$/, '');
    const entry = (otherId) => {
      const other = index.byId.get(otherId);
      if (otherId === id || !other || !index.learned.has(otherId)) return null;
      if (stem(other.data.characters) === stem(item.data.characters)) return null;
      if (!found.has(otherId)) found.set(otherId, { id: otherId, shared: [], ksGroupSize: null });
      return found.get(otherId);
    };

    for (const key of meaningKeys(item)) {
      for (const otherId of index.byKey.get(key) || []) {
        const e = entry(otherId);
        if (e) e.shared.push(key);
      }
    }
    for (const group of (ksNote && ksNote.groups) || []) {
      const size = group.entries.length;
      if (size > KS_MAX_GROUP_SIZE) continue;
      for (const ksEntry of group.entries) {
        if (ksEntry.metadata && ksEntry.metadata.notOnWk) continue;
        for (const otherId of index.byChars.get(ksEntry.characters) || []) {
          const e = entry(otherId);
          if (e) e.ksGroupSize = Math.min(e.ksGroupSize || Infinity, size);
        }
      }
    }

    const score = (e) => e.shared.length * 10 + (e.ksGroupSize ? 20 - e.ksGroupSize : 0);
    const level = item.data.level;
    return [...found.values()]
      .map((e) => ({ ...e, score: score(e), word: wordInfo(index.byId.get(e.id)) }))
      .sort((a, b) => b.score - a.score || Math.abs(a.word.level - level) - Math.abs(b.word.level - level) || a.id - b.id)
      .slice(0, MAX_CANDIDATES);
  }

  function normalizeLanguage(language) {
    return (language || 'English').trim() || 'English';
  }

  // Order-independent on purpose: the prompt treats all words symmetrically.
  function cacheKey(ids, language) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    return `${CACHE_PREFIX}v${PROMPT_VERSION}:${normalizeLanguage(language).toLowerCase()}:${sorted.join('-')}`;
  }

  function describeWords(words) {
    return words
      .map((w) => {
        const pos = w.partsOfSpeech.length ? `; part of speech: ${w.partsOfSpeech.join(', ')}` : '';
        return `- ${w.characters} (${w.readings.join('、')}): WaniKani meanings: ${w.meanings.join(', ')}${pos}`;
      })
      .join('\n');
  }

  // Words must be sorted by id by the caller so equal sets give equal prompts.
  function buildPrompt(words, language) {
    const lang = normalizeLanguage(language);
    const system = [
      'You are a Japanese teacher who explains near-synonyms to an advanced learner the way a good tutor talks: plainly, concretely, contrast first.',
      'Use the readings given; never invent readings. Prefer common, natural usage over rare dictionary senses.',
      'Do not attribute to these words a usage that belongs to a near-synonym outside this list.',
      'Each field must add something new. Never restate the gist in the notes, or a note in another note.',
      'If the words overlap or are interchangeable in some contexts, say so. If one word is not really a near-synonym of the others, say so in the gist rather than forcing a contrast.',
      'Every Japanese phrase must be grammatical, natural and commonly used. Translations must be natural, not word-for-word. Proofread for typos.',
      `Write all explanations and translations in ${lang}; keep Japanese words, expressions and sentences in Japanese.`,
    ].join('\n');
    const user = [
      'Compare these Japanese words that a learner keeps confusing:',
      describeWords(words),
      '',
      'Respond with JSON only, in this shape:',
      '{"gist":"","words":[{"word":"","reading":"","gloss":"","register":"","note":"","expressions":[{"ja":"","en":""}]}],"scene":{"setup":"","lines":[{"word":"","ja":"","en":""}]},"watch_out":""}',
      '',
      'Fields:',
      '- gist: one sentence (at most 30 words) that contrasts all the words at once, e.g. "期待 is what you hope will happen, 予想 what you think will happen, 想定 what you assume so you can plan for it."',
      '- words: one entry per word above, in the same order.',
      '  - gloss: at most 6 words.',
      `  - register: one of ${REGISTERS.join(', ')}; use neutral unless the register really differs.`,
      '  - note: 1–2 sentences (at most 40 words) on its nuance and what it typically applies to (people, objects, plans, feelings…). Mention register only if notable.',
      '  - expressions: 2–3 common set phrases, compounds or collocations that best show this word\'s territory (e.g. 期待外れ, 予想外, 想定内), each with a short gloss in en.',
      '- scene: one everyday situation in which every word appears; setup: at most 12 words describing it; lines: one natural sentence per word (at most 25 Japanese characters) with a natural translation in en. If one situation cannot fit all words naturally, use closely related moments.',
      '- watch_out: the single most useful extra contrast or trap (e.g. 予想外 "didn\'t see it coming" vs 想定外 "not in our plan", or a different word the learner may actually mean), at most 35 words. Leave it empty rather than inventing one.',
      '- Keep the whole answer under 200 words of explanation.',
    ].join('\n');
    return { system, user, schema: RESULT_SCHEMA };
  }

  // For ChatGPT and other frontier chat models: just the question. They answer it
  // well on their own, and a free-form answer reads better than our template.
  function buildChatPrompt(words, language) {
    const lang = normalizeLanguage(language);
    const list = words.map((w) => `${w.characters} (${w.readings[0]})`);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
    return `What's the difference between ${joined}? I'm an advanced learner of Japanese and keep mixing them up. Please answer in ${lang}.`;
  }

  // Tolerant: models sometimes wrap JSON in fences or drop optional bits.
  function parseResult(text) {
    const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let obj;
    try {
      obj = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('The model did not return valid JSON.');
    }
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    const words = list(obj && obj.words)
      .map((w) => ({
        word: str(w.word),
        reading: str(w.reading),
        gloss: str(w.gloss),
        register: str(w.register).toLowerCase(),
        note: str(w.note),
        expressions: list(w.expressions).map((e) => ({ ja: str(e.ja), en: str(e.en) })).filter((e) => e.ja).slice(0, 3),
      }))
      .filter((w) => w.word);
    if (words.length < 2) throw new Error('The model returned an incomplete comparison.');
    const scene = (obj.scene && typeof obj.scene === 'object') ? obj.scene : {};
    return {
      gist: str(obj.gist),
      words,
      scene: {
        setup: str(scene.setup),
        lines: list(scene.lines).map((l) => ({ word: str(l.word), ja: str(l.ja), en: str(l.en) })).filter((l) => l.ja),
      },
      watch_out: str(obj.watch_out),
    };
  }

  // Providers. `api` picks the wire format; everything OpenAI-compatible shares one.
  const PROVIDERS = {
    gemini: {
      label: 'Google Gemini',
      api: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-3.5-flash-lite',
      needsKey: true,
      keyUrl: 'https://aistudio.google.com/apikey',
    },
    openrouter: {
      label: 'OpenRouter',
      api: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-chat',
      needsKey: true,
      keyUrl: 'https://openrouter.ai/keys',
    },
    ollama: {
      label: 'Ollama (local)',
      api: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'qwen3:14b',
      needsKey: false,
    },
    custom: {
      label: 'Custom (OpenAI-compatible)',
      api: 'openai',
      baseUrl: '',
      defaultModel: '',
      needsKey: false,
    },
  };

  class ProviderError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // cfg: { apiKey, model, baseUrl }. Returns a plain request description.
  function buildRequest(providerId, cfg, prompt) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const base = (cfg.baseUrl || provider.baseUrl).replace(/\/+$/, '');
    if (!base) throw new Error('Set a base URL in Settings.');
    if (!cfg.model) throw new Error('Set a model in Settings.');
    if (provider.api === 'gemini') {
      return {
        url: `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: {
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            responseSchema: prompt.schema,
          },
        },
      };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (providerId === 'openrouter') headers['X-Title'] = 'WaniKani Similar Words Explanation';
    return {
      url: `${base}/chat/completions`,
      headers,
      body: {
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      },
    };
  }

  function errorMessage(json, status) {
    const err = json && json.error;
    if (typeof err === 'string') return err;
    if (err && err.message) return err.message;
    return `HTTP ${status}`;
  }

  // Returns { text, model } or throws ProviderError.
  function parseResponse(providerId, status, json) {
    if (status < 200 || status >= 300) throw new ProviderError(status, errorMessage(json, status));
    if (PROVIDERS[providerId].api === 'gemini') {
      const candidate = json && json.candidates && json.candidates[0];
      const parts = (candidate && candidate.content && candidate.content.parts) || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (!text) throw new ProviderError(status, `Empty answer (finish reason: ${(candidate && candidate.finishReason) || 'unknown'}).`);
      return { text, model: json.modelVersion || '' };
    }
    const choice = json && json.choices && json.choices[0];
    const text = choice && choice.message && choice.message.content;
    if (!text) throw new ProviderError(status, errorMessage(json, status));
    return { text, model: json.model || '' };
  }

  function friendlyError(error) {
    const s = error.status;
    const detail = error.message;
    if (s === 0) return `Network error: ${detail}`;
    if (s === 400 || s === 401 || s === 403) return `The provider rejected the request; check the API key and model in Settings. (${detail})`;
    if (s === 402) return `This key has no free quota or credits left. For Gemini, create the key in a project with no billing account linked. (${detail})`;
    if (s === 404) return `Model not found; check the model name in Settings. (${detail})`;
    if (s === 429) return `Rate limit or daily quota reached. Try again later or switch provider. (${detail})`;
    if (s >= 500) return `The provider had a server error. Try again. (${detail})`;
    return detail;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      PROMPT_VERSION, MAX_CANDIDATES, KS_MAX_GROUP_SIZE, RESULT_SCHEMA, PROVIDERS, ProviderError,
      normalizeMeaning, meaningKeys, wordInfo, isLearned, buildIndex, findCandidates, cacheKey,
      buildPrompt, buildChatPrompt, parseResult, buildRequest, parseResponse, friendlyError,
    };
    return;
  }

  // ===========================================================================
  // Browser glue: WKOF, Item Info Injector, GM storage, UI.
  // ===========================================================================

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const INDEX_TTL_MS = 15 * 60 * 1000;
  const KS_TIMEOUT_MS = 3000;
  const DEFAULT_SETTINGS = { provider: 'gemini', keys: {}, models: {}, baseUrls: {}, language: 'English', kanjiSearch: true };

  // ---- settings (GM storage only; never logged) ----------------------------

  function loadSettings() {
    const s = GM_getValue('settings', {});
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      keys: { ...(s.keys || {}) },
      models: { ...(s.models || {}) },
      baseUrls: { ...(s.baseUrls || {}) },
    };
  }

  function providerConfig(settings) {
    const p = PROVIDERS[settings.provider] || PROVIDERS.gemini;
    return {
      apiKey: settings.keys[settings.provider] || '',
      model: settings.models[settings.provider] || p.defaultModel,
      baseUrl: settings.baseUrls[settings.provider] || p.baseUrl,
    };
  }

  // ---- network ---------------------------------------------------------------

  function gmRequest({ method = 'GET', url, headers, body, timeout = 60000 }) {
    let handle;
    const promise = new Promise((resolve, reject) => {
      handle = GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new ProviderError(0, `could not reach ${new URL(url).host}`)),
        ontimeout: () => reject(new ProviderError(0, 'request timed out')),
        onabort: () => reject(Object.assign(new Error('aborted'), { aborted: true })),
      });
    });
    return { promise, abort: () => handle && handle.abort() };
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  const ksNotes = new Map();
  function fetchKanjiSearchNote(characters) {
    if (!ksNotes.has(characters)) {
      const url = `https://www.kanjisearch.com/notes/vocabulary/${encodeURIComponent(characters)}.json`;
      const note = gmRequest({ url, timeout: KS_TIMEOUT_MS })
        .promise.then((r) => (r.status === 200 ? safeJson(r.text) : null))
        .catch(() => null);
      ksNotes.set(characters, note);
    }
    return ksNotes.get(characters);
  }

  let indexPromise = null;
  let indexBuiltAt = 0;
  function getIndex() {
    const wkof = page.wkof;
    if (!wkof) return Promise.reject(new Error('wkof-missing'));
    if (!indexPromise || Date.now() - indexBuiltAt > INDEX_TTL_MS) {
      indexBuiltAt = Date.now();
      indexPromise = (async () => {
        wkof.include('ItemData');
        await wkof.ready('ItemData');
        const items = await wkof.ItemData.get_items({
          wk_items: { options: { assignments: true, study_materials: true }, filters: { item_type: 'voc,kana_voc' } },
        });
        return buildIndex(items);
      })();
      indexPromise.catch(() => {
        indexPromise = null;
      });
    }
    return indexPromise;
  }

  // ---- cache -----------------------------------------------------------------

  function cachedEntry(key) {
    const entry = GM_getValue(key, null);
    return entry && entry.result ? entry : null;
  }

  function cacheKeys() {
    return GM_listValues().filter((k) => k.startsWith(CACHE_PREFIX));
  }

  function exportCache() {
    const entries = Object.fromEntries(cacheKeys().map((k) => [k, GM_getValue(k)]));
    const blob = new Blob([JSON.stringify({ format: 'wk-similar-words-cache', version: 1, entries }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `wk-similar-words-cache-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Exported ${Object.keys(entries).length} cached comparisons.`);
  }

  function importCache() {
    const input = h('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const data = safeJson(await input.files[0].text());
      if (!data || data.format !== 'wk-similar-words-cache' || typeof data.entries !== 'object') {
        toast('That file is not a WaniKani Similar Words Explanation cache export.');
        return;
      }
      let count = 0;
      for (const [key, value] of Object.entries(data.entries)) {
        if (key.startsWith(CACHE_PREFIX) && value && value.result) {
          GM_setValue(key, value);
          count++;
        }
      }
      toast(`Imported ${count} cached comparisons.`);
    });
    input.click();
  }

  function clearCache() {
    const keys = cacheKeys();
    keys.forEach((k) => GM_deleteValue(k));
    toast(`Cleared ${keys.length} cached comparisons.`);
  }

  // ---- DOM helpers (text only: model output never becomes HTML) -------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c != null && c !== false && c !== '') el.append(c);
    }
    return el;
  }

  // Buttons never take focus: in reviews Enter means "next item", and a focused
  // button would swallow it.
  function button(label, onClick, attrs = {}) {
    return h(
      'button',
      {
        type: 'button',
        tabindex: '-1',
        class: 'wksw-btn',
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => {
          e.currentTarget.blur();
          onClick(e);
        },
        ...attrs,
      },
      label,
    );
  }

  function toast(message) {
    const el = h('div', { class: 'wksw-toast', role: 'status' }, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ---- panel -----------------------------------------------------------------

  function createPanel(index, currentId, candidates) {
    const selected = new Set([candidates[0].id]);
    let inflight = null;

    const chips = candidates.map((c) => {
      const why = [
        c.shared.length ? `shares meaning: ${c.shared.join(', ')}` : '',
        c.ksGroupSize ? 'Kanji Search group' : '',
      ].filter(Boolean).join(' · ');
      const chip = button(
        [h('span', { lang: 'ja', class: 'wksw-chip-ja' }, c.word.characters), ' ', h('span', { class: 'wksw-chip-meaning' }, c.word.meanings[0])],
        () => toggle(c.id),
        { class: 'wksw-btn wksw-chip', title: `${c.word.readings[0]} · ${why}`, 'data-id': String(c.id) },
      );
      return chip;
    });

    const status = h('div', { class: 'wksw-status', 'aria-live': 'polite' });
    const result = h('div', { class: 'wksw-result' });
    const compareBtn = button('Explain the difference', () => run(false), { class: 'wksw-btn wksw-primary' });
    const actions = h(
      'div',
      { class: 'wksw-actions' },
      compareBtn,
      button('Ask ChatGPT', askChat, { title: 'Copy the prompt and open ChatGPT (no API key needed)' }),
      button('⚙', openSettings, { title: 'WaniKani Similar Words Explanation settings', 'aria-label': 'Settings' }),
    );
    const root = h('div', { class: 'wksw' }, h('div', { class: 'wksw-chips' }, chips), actions, status, result);

    const language = () => normalizeLanguage(loadSettings().language);
    const selectedIds = () => [currentId, ...selected];
    const words = () => selectedIds().map((id) => wordInfo(index.byId.get(id))).sort((a, b) => a.id - b.id);

    function toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else {
        selected.add(id);
        if (selected.size > MAX_SELECTED) selected.delete(selected.values().next().value);
      }
      refresh();
    }

    function refresh() {
      for (const chip of chips) {
        const id = Number(chip.dataset.id);
        chip.setAttribute('aria-pressed', String(selected.has(id)));
        chip.classList.toggle('wksw-cached', !!cachedEntry(cacheKey([currentId, id], language())));
      }
      if (inflight) return;
      const entry = selected.size ? cachedEntry(cacheKey(selectedIds(), language())) : null;
      compareBtn.hidden = !!entry;
      compareBtn.disabled = selected.size === 0;
      status.replaceChildren();
      if (entry) renderResult(entry);
      else result.replaceChildren();
    }

    async function run(force) {
      if (inflight || selected.size === 0) return;
      const key = cacheKey(selectedIds(), language());
      if (!force && cachedEntry(key)) return refresh();

      const settings = loadSettings();
      const provider = PROVIDERS[settings.provider] || PROVIDERS.gemini;
      const cfg = providerConfig(settings);
      if (provider.needsKey && !cfg.apiKey) {
        status.replaceChildren(`Add your ${provider.label} API key first. `, button('Open settings', openSettings));
        return;
      }

      const ws = words();
      let request;
      try {
        request = buildRequest(settings.provider, cfg, buildPrompt(ws, language()));
      } catch (e) {
        status.replaceChildren(h('span', { class: 'wksw-error' }, e.message));
        return;
      }
      inflight = gmRequest({ method: 'POST', url: request.url, headers: request.headers, body: JSON.stringify(request.body) });
      compareBtn.disabled = true;
      status.replaceChildren(h('span', { class: 'wksw-spinner' }), ` Asking ${provider.label}… `, button('Cancel', () => inflight && inflight.abort()));

      try {
        const response = await inflight.promise;
        const parsed = parseResponse(settings.provider, response.status, safeJson(response.text));
        const entry = {
          v: PROMPT_VERSION,
          ids: ws.map((w) => w.id),
          words: ws.map((w) => w.characters),
          language: language(),
          provider: settings.provider,
          model: parsed.model || cfg.model,
          createdAt: Date.now(),
          result: parseResult(parsed.text),
        };
        GM_setValue(key, entry); // cached even if the user has moved on
        inflight = null;
        if (root.isConnected) refresh();
      } catch (e) {
        inflight = null;
        compareBtn.disabled = false;
        if (e.aborted) return refresh();
        const message = e instanceof ProviderError ? friendlyError(e) : e.message;
        status.replaceChildren(
          h('span', { class: 'wksw-error' }, message),
          ' ',
          button('Retry', () => run(force)),
          button('Ask ChatGPT instead', askChat),
        );
      }
    }

    function askChat() {
      const prompt = buildChatPrompt(words(), language());
      GM_setClipboard(prompt, 'text');
      GM_openInTab(`https://chatgpt.com/?q=${encodeURIComponent(prompt)}`, { active: true, insert: true });
      status.replaceChildren('Prompt copied. If ChatGPT does not prefill it, paste it there.');
    }

    // Reading order mirrors how a tutor explains: the one-line contrast, then each
    // word, then all words in one scene, then the one trap worth remembering.
    function renderResult(entry) {
      const r = entry.result;
      const providerLabel = (PROVIDERS[entry.provider] || {}).label || entry.provider;
      result.replaceChildren(
        r.gist && h('p', { class: 'wksw-gist' }, r.gist),
        h(
          'div',
          { class: 'wksw-words' },
          r.words.map((w) =>
            h(
              'div',
              { class: 'wksw-word' },
              h(
                'div',
                { class: 'wksw-word-head' },
                h('span', { lang: 'ja', class: 'wksw-ja' }, w.word),
                h('span', { lang: 'ja', class: 'wksw-reading' }, w.reading),
                w.register && w.register !== 'neutral' && h('span', { class: 'wksw-register' }, w.register),
              ),
              w.gloss && h('div', { class: 'wksw-gloss' }, w.gloss),
              w.note && h('p', { class: 'wksw-note' }, w.note),
              w.expressions.length &&
                h('ul', { class: 'wksw-expressions' }, w.expressions.map((e) => h('li', {}, h('span', { lang: 'ja' }, e.ja), ' ', h('span', { class: 'wksw-muted' }, e.en)))),
            ),
          ),
        ),
        r.scene.lines.length &&
          h(
            'div',
            { class: 'wksw-scene' },
            h('div', { class: 'wksw-label' }, 'In one scene'),
            r.scene.setup && h('div', { class: 'wksw-muted' }, r.scene.setup),
            h('ul', {}, r.scene.lines.map((l) => h('li', {}, h('span', { lang: 'ja' }, l.ja), h('span', { class: 'wksw-muted' }, l.en)))),
          ),
        r.watch_out && h('p', { class: 'wksw-watch' }, h('b', {}, 'Watch out: '), r.watch_out),
        h(
          'div',
          { class: 'wksw-footer' },
          h('span', { class: 'wksw-muted' }, `${providerLabel} · ${entry.model} · ${new Date(entry.createdAt).toLocaleDateString()}`),
          button('Regenerate', () => run(true)),
          button('Ask ChatGPT', askChat),
        ),
      );
    }

    refresh();
    return root;
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  }

  async function buildSection(state) {
    let index;
    try {
      index = await getIndex();
    } catch (e) {
      if (e.message !== 'wkof-missing') console.warn('[WaniKani Similar Words Explanation] could not load item data', e);
      return h(
        'p',
        { class: 'wksw-muted' },
        'WaniKani Similar Words Explanation needs the ',
        h('a', { href: 'https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549', target: '_blank', rel: 'noopener' }, 'WaniKani Open Framework'),
        '.',
      );
    }
    const settings = loadSettings();
    const ksNote = settings.kanjiSearch ? await withTimeout(fetchKanjiSearchNote(state.characters), KS_TIMEOUT_MS) : null;
    const candidates = findCandidates(index, state.id, ksNote);
    return candidates.length ? createPanel(index, state.id, candidates) : null;
  }

  // ---- settings dialog ---------------------------------------------------------

  function openSettings() {
    const draft = loadSettings();
    const field = (label, control, hint) => h('label', { class: 'wksw-setting' }, h('span', {}, label), control, hint && h('small', { class: 'wksw-muted' }, hint));

    const providerSelect = h('select', {}, Object.entries(PROVIDERS).map(([id, p]) => h('option', { value: id }, p.label)));
    const keyInput = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
    const modelInput = h('input', { type: 'text', spellcheck: 'false' });
    const baseInput = h('input', { type: 'text', spellcheck: 'false' });
    const keyLink = h('a', { target: '_blank', rel: 'noopener' }, 'Get a key');
    const languageInput = h('input', { type: 'text', value: draft.language });
    const ksInput = h('input', { type: 'checkbox' });
    ksInput.checked = draft.kanjiSearch;

    let current = draft.provider;
    const loadProviderFields = () => {
      const p = PROVIDERS[current];
      providerSelect.value = current;
      keyInput.value = draft.keys[current] || '';
      keyInput.placeholder = p.needsKey ? 'required' : 'optional';
      modelInput.value = draft.models[current] || '';
      modelInput.placeholder = p.defaultModel || 'model name';
      baseInput.value = draft.baseUrls[current] || '';
      baseInput.placeholder = p.baseUrl || 'https://…/v1';
      keyLink.hidden = !p.keyUrl;
      if (p.keyUrl) keyLink.href = p.keyUrl;
    };
    const storeProviderFields = () => {
      draft.keys[current] = keyInput.value.trim();
      draft.models[current] = modelInput.value.trim();
      draft.baseUrls[current] = baseInput.value.trim();
    };
    providerSelect.addEventListener('change', () => {
      storeProviderFields();
      current = providerSelect.value;
      loadProviderFields();
    });
    loadProviderFields();

    const cacheInfo = h('span', { class: 'wksw-muted' }, `${cacheKeys().length} cached comparisons`);
    let clearArmed = false;
    const clearBtn = h('button', { type: 'button' }, 'Clear');
    clearBtn.addEventListener('click', () => {
      if (!clearArmed) {
        clearArmed = true;
        clearBtn.textContent = 'Click again to clear';
        return;
      }
      clearCache();
      cacheInfo.textContent = '0 cached comparisons';
      clearBtn.textContent = 'Clear';
      clearArmed = false;
    });

    const dialog = h(
      'dialog',
      { class: 'wksw-dialog' },
      h(
        'form',
        { method: 'dialog' },
        h('h2', {}, 'WaniKani Similar Words Explanation'),
        field('Provider', providerSelect),
        field('API key', keyInput, h('span', {}, 'Stored only in Tampermonkey storage. ', keyLink)),
        field('Model', modelInput, 'Leave empty for the default.'),
        field('Base URL', baseInput, 'Leave empty for the default. Custom hosts ask for permission once.'),
        field('Explanation language', languageInput),
        h('label', { class: 'wksw-setting wksw-inline' }, ksInput, h('span', {}, 'Also use Kanji Search groups (fetches kanjisearch.com notes for the current word)')),
        h('div', { class: 'wksw-setting wksw-inline' }, cacheInfo, h('button', { type: 'button', onclick: exportCache }, 'Export'), h('button', { type: 'button', onclick: importCache }, 'Import'), clearBtn),
        h('div', { class: 'wksw-dialog-actions' }, h('button', { value: 'cancel' }, 'Cancel'), h('button', { value: 'save', class: 'wksw-primary' }, 'Save')),
      ),
    );
    // Keep WaniKani's quiz hotkeys from firing while typing in the dialog.
    for (const type of ['keydown', 'keyup', 'keypress']) dialog.addEventListener(type, (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'save') {
        storeProviderFields();
        draft.provider = current;
        draft.language = normalizeLanguage(languageInput.value);
        draft.kanjiSearch = ksInput.checked;
        GM_setValue('settings', draft);
        toast('Settings saved.');
      }
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---- styles & wiring ---------------------------------------------------------

  const CSS = `
    .wksw { margin: 0.5em 0 1em; font-size: 15px; line-height: 1.5; }
    .wksw-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .wksw-btn { font: inherit; font-size: 14px; color: inherit; background: transparent; cursor: pointer;
      border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: 6px; padding: 3px 10px; }
    .wksw-btn:hover { border-color: currentColor; }
    .wksw-btn[disabled] { opacity: 0.5; cursor: default; }
    .wksw-chip[aria-pressed="true"] { background: #a100f1; border-color: #a100f1; color: #fff; }
    .wksw-chip.wksw-cached::after { content: '•'; margin-left: 4px; }
    .wksw-chip-ja { font-size: 16px; }
    .wksw-chip-meaning { opacity: 0.75; }
    .wksw-primary { font-weight: 600; }
    .wksw-actions, .wksw-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .wksw-status { margin: 6px 0; min-height: 1em; }
    .wksw-error { color: #d0021b; }
    .wksw-muted { opacity: 0.7; font-size: 13px; }
    .wksw-words { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin: 8px 0; }
    .wksw-word { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; padding: 8px 10px; }
    .wksw-word-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .wksw-ja { font-size: 22px; }
    .wksw-register { margin-left: auto; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
    .wksw-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin-right: 6px; }
    .wksw-footer { margin-top: 8px; }
    .wksw-gist { font-size: 16px; font-weight: 600; margin: 8px 0; }
    .wksw-gloss { font-weight: 600; }
    .wksw-note { margin: 4px 0 6px; }
    .wksw-expressions { list-style: none; margin: 0; padding: 0; }
    .wksw-expressions li { margin: 2px 0; }
    .wksw-scene { margin: 8px 0; padding-left: 10px; border-left: 3px solid #a100f1; }
    .wksw-scene ul { list-style: none; margin: 4px 0 0; padding: 0; }
    .wksw-scene li { display: flex; flex-direction: column; margin-bottom: 4px; }
    .wksw-watch { margin: 6px 0; }
    .wksw-spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent;
      border-radius: 50%; animation: wksw-spin 0.8s linear infinite; vertical-align: -1px; }
    @keyframes wksw-spin { to { transform: rotate(360deg); } }
    .wksw-toast { position: fixed; right: 16px; bottom: 16px; z-index: 100000; background: #333; color: #fff;
      padding: 8px 12px; border-radius: 6px; font-size: 14px; }
    .wksw-dialog { width: min(440px, 92vw); border: none; border-radius: 10px; padding: 16px 20px; font-size: 14px; }
    .wksw-dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
    .wksw-dialog h2 { margin: 0 0 12px; font-size: 18px; }
    .wksw-setting { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
    .wksw-setting input[type=text], .wksw-setting input[type=password], .wksw-setting select { font: inherit; padding: 4px 6px; }
    .wksw-inline { flex-direction: row; align-items: center; gap: 8px; }
    .wksw-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  `;

  function addStyle() {
    if (document.getElementById('wksw-style')) return;
    document.head.append(h('style', { id: 'wksw-style' }, CSS));
  }

  const injector = page.wkItemInfo || window.wkItemInfo;
  if (!injector) {
    console.error('[WaniKani Similar Words Explanation] WaniKani Item Info Injector did not load.');
    return;
  }
  addStyle();
  GM_registerMenuCommand('Settings', openSettings);
  GM_registerMenuCommand('Export cache', exportCache);
  GM_registerMenuCommand('Import cache', importCache);
  injector
    .forType('vocabulary,kanaVocabulary')
    .under('meaning')
    .spoiling('meaning')
    .append('Similar words', (state) => buildSection(state));
})();
