# WK Nuance: Phase 1 proposal (2026-10-07)

> **Decisions (2026-10-07):** build on WKOF + Item Info Injector · Gemini free tier default, OpenRouter later · "learned" = Apprentice 1+ · similarity = shared meanings **+ Kanji Search groups via its JSON endpoint** (not its DOM; replaces the manual picker) · public GitHub + Greasy Fork. Kept for history; the README describes what was built.


Working name: **WK Nuance**. For the current vocab item it finds learned vocab with overlapping meanings, and on click it asks an LLM how they differ.

## A. Existing work

| Script | What it does / how it hooks | License, last update | Verdict |
|---|---|---|---|
| **WaniKani Open Framework (WKOF)** | Subject, assignment and study-material data, cached in IndexedDB with incremental `updated_after` sync. Handles the API token: it scrapes `/settings/personal_access_tokens`, or offers to create a token. | MIT. Last commit Aug 2023, but most active WK scripts depend on it. | **Build on it** (data layer) |
| **WK Item Info Injector** (Sinyaven) | Library: `wkItemInfo.on(review/lesson/lessonQuiz/extraStudy/itemPage).forType(vocabulary, kanaVocabulary).under('meaning').append(...)`. It tracks Turbo page swaps and the Stimulus quiz queue, and hands you the subject `id`, meanings, reading and POS. | MIT-0. v3.15, updated **2026-10-04** | **Build on it** (page hooks) |
| ConfusionGuesser (Sinyaven) | After a wrong answer, it lists items that match your input. Uses WKOF. | MIT-0, Jul 2026 | Next to it, complementary |
| User Synonyms++ (polv) | Allow, warn and block synonyms by hooking the answer checker | MIT, Nov 2023 | Independent. Optionally read WK's own user synonyms via WKOF |
| Niai (acm) | Visually similar **kanji**, bundled data | GPLv3, ~2018–21, predates Turbo | Not relevant (visual, kanji) |
| Homophone Explorer | Homophones on vocab pages | No license, 2018, almost certainly broken | Ignore |
| External Definition (Nicole Rauch / polv's JJ fork) | Scrapes Weblio/Kanjipedia via `GM_xmlhttpRequest` | No license, 2021/2023 | Ignore. Shows that third-party fetches are an accepted pattern |
| **Your "similar words" script** | Best guess: **Kanji Search Notes** (Mark Hennessy, Jul 2026, "groups of related words… meanings"). Its data appears curated, not from the API. | No license listed | **Independent.** Please confirm the name. |

**On scraping another script's DOM: no.** It couples us to markup that is undocumented and unlicensed, to load order and to its feature set. When that script changes, we break silently. Computing similarity ourselves from WKOF data costs about 40 lines, and it uses the same source of truth WK uses to grade answers.

## B. Similar-word detection

| Option | Pros | Cons |
|---|---|---|
| 1. Read other script's DOM | No similarity code to write | Fragile and order-dependent, and it only works where that script renders. License unclear. |
| 2. Own detection (WKOF) | Deterministic, testable, works on every page type | Exact meaning overlap misses near-synonyms with different English glosses |
| 3. Hybrid | Higher recall | Inherits all of option 1's fragility |

**Recommendation: option 2, plus a manual "compare with…" picker** that searches your learned vocab. The picker covers recall gaps without fuzzy-matching noise.

- **Index.** Built once per page load from `wkof.ItemData.get_items({ item_type: 'voc,kana_vocab' })`, keeping assignments with `srs_stage >= 1`.
- **Meaning keys.** Accepted meanings, whitelist `auxiliary_meanings` and, optionally, your own `meaning_synonyms`. Blacklist auxiliaries are excluded.
- **Normalization.** Lowercase, strip `(…)`, strip leading `to `/`a `/`the `, collapse whitespace. Match is exact on the normalized key.
- **Ranking.** Number of shared keys, then level distance. Show at most 8 candidates, each with a tooltip of the shared meaning, e.g. 必要 ↔ 重要 via "essential".
- **Token: push back.** Don't store our own token in GM storage. WKOF already obtains and manages a read-only token. A second copy only duplicates the secret and its UX. We need our own token only if we drop WKOF.
- **Rate limits.** The API allows 60 req/min. WKOF syncs incrementally, so after the first load we make about one request per endpoint per session. No extra caching is needed on our side.
- **Pages.** Reviews, lessons, lesson quiz, extra study, recent mistakes and `/vocabulary/*` item pages, all through the Injector. Kanji and radical pages are skipped in v1.

## C. LLM backend

| Option | Facts (checked 2026-10-07) | Verdict |
|---|---|---|
| **Gemini API free tier** | Official pricing page (updated 2026-10-06) lists 3.x Flash and Flash-Lite and 2.5 Flash/Flash-Lite/Pro as free. Free-tier data "used to improve products", but per the terms the EEA/UK/CH get paid-tier data terms. No billing needed. Exact RPD is shown only in AI Studio; for 5–30 calls a day it is a non-issue. Native JSON schema (`responseSchema`). Key goes in the `x-goog-api-key` header, never in the URL. | **Default** (Flash-Lite, minimal thinking) |
| Groq | Third-party sources, not official (Groq's page returned 403): ~1,000 RPD on Kimi K2 and gpt-oss-120b. OpenAI-compatible, JSON mode. Good Japanese on Kimi K2. | **Second provider**, same adapter as OpenRouter/Ollama |
| OpenRouter `:free` | 50 req/day without credits, 1,000/day after buying $10. Free model list is volatile and thin. Some upstreams train on prompts. | Supported via the OpenAI-compatible adapter, not recommended |
| Ollama (local) | Default `OLLAMA_ORIGINS` does **not** include `chrome-extension://` or `moz-extension://`, so you must set the env var. Nuance quality below ~14B (Qwen3, Gemma) is noticeably weaker. | Works, opt-in only |
| **ChatGPT free account** | No API access: ChatGPT and the API are separate products, billed separately. Automating chatgpt.com or its private endpoints violates OpenAI's Terms of Use ("automatically or programmatically extract data or Output"); this is from memory because their page blocked our fetch. It would also be brittle. | **No.** Won't build it. |
| Prefill fallback | `chatgpt.com/?q=` reportedly still prefills (a Jan 2026 report says it redirects to `?prompt=`). It is unofficial and has broken before; Claude.ai's `?q=` status is unclear and Gemini has none. | **Copy prompt to clipboard + open ChatGPT with `?q=`.** If the prefill fails, you just paste. |
| Paid backstop | Gemini 2.5 Flash-Lite ≈ $0.0003/call. Haiku 4.5 ≈ $0.003/call. | Mention in README only |

**Interface.** One shape: `provider.complete({ system, user, schema, temperature, maxTokens }) → { json, model }`.

- **Adapters.** There are only two: `gemini` (native, to get `responseSchema`) and `openai-compatible`.
- **Presets.** The `openai-compatible` adapter has presets for Groq, OpenRouter, Ollama, Mistral, DeepSeek and OpenAI, plus a custom base URL.
- **Fallback.** "Copy prompt / Open in ChatGPT" is a UI action, not a provider. It is always available, even without a key.

## D. Prompt

**JSON, not markdown.** We render it ourselves (typed fields, `textContent` only, no HTML injection, identical layout every time), and Gemini enforces the schema. The clipboard/ChatGPT fallback uses the same content spec with a "format as markdown with these headings" tail, because a human reads it there.

- **Grounding.** Each word's WK reading, meanings and part of speech go into the prompt. This stops invented readings.
- **Symmetric prompt.** The prompt treats all words equally ("compare these words", with no "the learner is studying X"). That keeps the order-independent cache key honest.
- **Settings.** `PROMPT_VERSION = 1`, `temperature 0.2`, `maxOutputTokens ~1024`.

Draft:

> **System:** You are a precise Japanese teacher explaining near-synonyms to an advanced learner. Be concrete and brief. Use the readings given; never invent readings. If the words are largely interchangeable, say so instead of inventing differences. Write explanations in {LANG}; keep Japanese words, collocations and example sentences in Japanese.
>
> **User:** Compare these Japanese words a learner keeps confusing:
> - 必要 (ひつよう): WK meanings: Necessary, Need, Essential; POS: noun, な adjective
> - 重要 (じゅうよう): WK meanings: Important, Essential, Principal; POS: noun, な adjective
>
> Return JSON matching the schema. Hard limits: core_meaning ≤ 10 words; register = one of casual|neutral|formal|written|literary plus a note ≤ 8 words; contexts ≤ 3 short phrases; collocations ≤ 3; one natural example sentence ≤ 30 characters with a {LANG} translation; `choose`: one line per word ("Use X when…"); rule_of_thumb ≤ 20 words; common_mistake ≤ 25 words, with a wrong → right pair if possible. Total explanation text ≤ 180 words.

Schema:

```
{ words: [{ word, reading, core_meaning, register, register_note, contexts[], collocations[], example: { ja, translation } }],
  choose: [{ word, when }], rule_of_thumb, common_mistake }
```

We validate on receipt. If it fails, we show an error with Regenerate and a "show raw" toggle; there is no silent retry.

## E. Cache

**GM storage, not IndexedDB.**

- **Isolation.** IndexedDB here would live on the wanikani.com origin, readable and clearable by page JS, other scripts and "clear site data". GM storage is per-script and sandboxed.
- **Size.** About 1.5 KB per entry, so 1,000 comparisons ≈ 1.5 MB. Trivial.

**Layout.** One key per entry, so we never rewrite a large blob:

- **Key:** `cmp:v{PROMPT_VERSION}:{lang}:{sortedSubjectIds.join('-')}`
- **Value:** `{ ids, words, provider, model, createdAt, result }`

**Provider not in the key.** The model is metadata. Switching provider shouldn't throw away good answers, and Regenerate exists for that.

**Maintenance.** Clear, export (JSON download) and import go in the Tampermonkey menu: about 40 lines, so they are in.

## F. UX

- **Placement.** A "Similar meanings" subsection under **Meaning** in item info, via the Injector. It contains candidate chips (characters, reading, shared meaning; multi-select, max 3, top one preselected) plus **Compare**. A chip whose selected set is already cached shows a dot. Selecting a cached set renders it instantly, with no request.
- **Panel.** Renders inline below the chips. The footer shows `provider · model · date`, **Regenerate** and **Copy prompt / Open in ChatGPT**. Loading shows "Asking Gemini…" with Cancel. Errors show the message (429, bad key, invalid JSON), Retry and the prompt-copy fallback.
- **No spoilers.** In reviews and quizzes, item info only exists *after* you answer. Showing same-meaning words before the meaning question would give the answer away, so this placement is a requirement, not a nicety.
- **Focus.** Buttons are `type=button` with `tabindex=-1`, and `mousedown` is `preventDefault`ed so they never take focus. Otherwise **Enter**, WK's "next" key, would re-trigger Compare. The picker's search input stops `keydown` propagation so WK hotkeys don't fire while typing.
- **Async safety.** A response always goes into the cache. It is rendered only if the panel for that item is still attached, so moving on mid-request is harmless and the answer is there next time.
- **Settings.** A small `<dialog>` opened from the Tampermonkey menu: provider, key, model, base URL, language and the "learned" threshold. Stored in GM storage, never logged.
  - I'm deliberately **not** using WKOF's Settings dialog: it persists to page-origin IndexedDB, which is the wrong place for an API key.

## G. Distribution

- **Metadata.**
  - `@match https://www.wanikani.com/*`
  - `@require` the Item Info Injector from Greasy Fork, pinned to a version (allowed: it's a Greasy Fork library).
  - `@grant GM_getValue GM_setValue GM_deleteValue GM_listValues GM_xmlhttpRequest GM_registerMenuCommand GM_setClipboard GM_openInTab`
  - `@connect generativelanguage.googleapis.com api.groq.com openrouter.ai localhost 127.0.0.1`. Any other host, such as a custom base URL, gets Tampermonkey's one-time allow prompt; no `@connect *`.
  - `@license MIT`
- **WKOF.** Not `@require`d (community norm). If it is missing, we show a one-line "install WKOF" notice.
- **Hosting.** Source lives on GitHub; distribution is through **Greasy Fork**, synced by webhook. That's the WK norm, and Greasy Fork rewrites `@updateURL`/`@downloadURL` to itself anyway. A GitHub raw `@updateURL` is only for a private beta.
- **Greasy Fork rules.** No minification, and the description must clearly say what is sent to which LLM.
  - **Sent:** characters, readings and meanings only.
  - **Never sent:** WK mnemonics or other WK content, which keeps clear of the ToS clause on redistributing their content.
- **Browsers.**
  - **Chrome/Edge 138+:** Tampermonkey needs **Manage Extension → "Allow User Scripts"** (older versions need Developer mode).
  - **Firefox:** nothing extra.
  - **Violentmonkey:** should work. I'll use only `GM_*` with callback-style `GM_xmlhttpRequest`.
- **What I can automate:** repo, metadata, README/forum post, unit tests, a GitHub Actions check (tests, `@version` bump), release tags.
- **What only you can do:** see the list below.

---

## Recommended architecture

```
WKOF (installed separately)          WK Item Info Injector (@require, pinned)
   │ ItemData: vocab + assignments       │ on(review|lesson|lessonQuiz|extraStudy|itemPage)
   ▼                                     ▼ forType(vocabulary|kanaVocabulary).under('meaning')
 SimilarityIndex ── candidates(id) ──▶ Panel (chips · Compare · result · Regenerate · Copy prompt)
                                         │
                       Cache (GM storage) ◀─┤ key = v{PV}:{lang}:{sorted ids}
                                         │ miss / regenerate
                                         ▼
                  PromptBuilder (versioned, JSON schema; markdown variant for clipboard)
                                         │
                  Provider: gemini | openai-compatible(groq, openrouter, ollama, custom)
                                         │ GM_xmlhttpRequest (+ @connect)
Settings <dialog> (GM storage) ◀── Tampermonkey menu: Settings · Export · Import · Clear cache
```

- **Shape.** One file, ~600–800 readable lines, no build step.
- **Pure core.** Normalize, index, prompt, cache key, validate and render take no WK globals, so Node's built-in test runner can test them. They are exported behind `if (typeof module === 'object')`, which is inert in Tampermonkey.
- **Thin glue.** The Injector/WKOF wiring is the only part that needs a live session.

**Testing plan.** I'd skip saved-HTML fixtures. The Injector owns the DOM, and saved Turbo pages without their JS test almost nothing. Instead:

1. Unit tests for the pure core.
2. A one-time dump of real subject data (any read-only token) to check that candidate lists look sane across all ~9k subjects.
3. A prompt eval on ~10 classic confusable pairs (必要/重要, 思う/考える, 早い/速い, 決める/決定する, 上る/登る, …) checking JSON validity, length and quality.
4. With your OK, a live check via Claude-in-Chrome in your logged-in browser, on **item pages and Extra Study only**, which don't touch SRS.

## Decisions for you

1. **Depend on WKOF + Item Info Injector?** Recommend **yes**. The alternative is our own token, sync, and Turbo/Stimulus hooks, about 3× the code, maintained by us alone. Risk: WKOF hasn't had a commit since 2023, but it is stable and the whole ecosystem rides on it.
2. **Default provider.** Recommend **Gemini free tier (Flash-Lite)** with Groq as the second preset. If you're outside the EEA/UK/CH and dislike free-tier training on your prompts (two vocab words), the paid tier costs about $0.0003/call.
3. **"Learned" threshold.** Recommend **started (Apprentice 1+)**: confusion starts the day you meet the second word. The alternative is Guru+ (passed).
4. **Similarity scope.** Recommend **exact normalized meaning overlap + manual picker**. The alternative is fuzzy word-overlap ("decide" ≈ "determine"), which brings noise and needs tuning.
5. **Publishing.** Recommend **public on Greasy Fork, synced from a public GitHub repo**. The alternative is private GitHub raw only.

## What I need from you

- The name of your "similar words" script. Is it Kanji Search Notes? Only placement and coexistence depend on it.
- Browser(s), script manager (Tampermonkey or Violentmonkey) and whether WKOF is already installed.
- Your region (EEA/UK/CH or not), for the Gemini data terms.
- Optional, for testing:
  - a WK read-only token and a Gemini key, exported as env vars (`WK_TOKEN`, `GEMINI_API_KEY`) in a shell you launch me from. I'll never write them to disk.
  - permission for the live Chrome check.
- GitHub repo name/visibility, and whether I should create it with `gh`.
