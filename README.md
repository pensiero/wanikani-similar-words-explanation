# WaniKani Similar Words Explanation

A Tampermonkey userscript for [WaniKani](https://www.wanikani.com). For the vocab item you're looking at, it lists words **you have already learned** that are easy to confuse with it (必要 / 重要, 思う / 考える, 上る / 登る …). When you click, it asks an LLM how they differ and shows a short, consistently structured answer inside the item info:

- a one-sentence gist that contrasts all the words at once
- for each word: reading, short gloss, a note on its nuance, and 2–3 key expressions (期待外れ, 予想外, 想定内 …)
- one everyday scene in which every word appears, with translations
- one "watch out": the trap or extra contrast most worth remembering, when there is one

It never calls an LLM by itself. Answers are cached in your browser, so revisiting a pair costs nothing. **Regenerate** asks again and replaces the cached answer.

## How it finds similar words

It combines two sources:

1. **Shared meanings.** It looks for vocab you've started (Apprentice 1 or higher) whose accepted WK meanings, whitelisted alternatives or your own synonyms overlap with the current word's.
2. **[Kanji Search](https://www.kanjisearch.com) groups.** These are hand-curated groups of related words from [Kanji Search Notes](https://greasyfork.org/scripts/444554-kanji-search-notes) by Mark Hennessy. They catch near-synonyms whose English glosses differ, such as 思う / 考える. Large enumerations (numbers, planets, days) are skipped. You can turn this source off in Settings.

Up to 8 candidates appear as chips. Pick one to three, then click **Explain the difference**. A dot on a chip means that pair is already cached.

The section sits under **Meaning** in the item info. In reviews it only appears after you've answered, so it never gives the meaning away. Its buttons never take keyboard focus, so Enter still moves to the next item.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
   - **Chrome / Edge 138+:** open Tampermonkey's extension details (right-click the icon → *Manage extension*) and turn on **Allow User Scripts**. On older versions, enable *Developer mode* on the extensions page instead. Without this, no userscript runs.
   - **Firefox:** nothing extra.
2. Install the [WaniKani Open Framework](https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549) if you don't have it yet.
3. Install **WaniKani Similar Words Explanation** from Greasy Fork (link coming), or from [GitHub](https://raw.githubusercontent.com/pensiero/wanikani-similar-words-explanation/main/wanikani-similar-words-explanation.user.js).
4. Get an LLM API key (see below), then on any WaniKani page open Tampermonkey's menu → **WaniKani Similar Words Explanation → Settings** and paste it in.

### LLM providers

| Provider | Cost | Notes |
|---|---|---|
| **Google Gemini** (default) | Free tier | Create a key at [AI Studio](https://aistudio.google.com/apikey). The key must come from a project **with no billing account linked**; a billing-linked project with an empty prepaid wallet returns HTTP 402. The default model `gemini-3.5-flash-lite` answers in about 2 s. The bigger Flash models give somewhat better answers, but on the free tier they often return 503 (overloaded) and take 6–90 s. Outside the EEA/UK/Switzerland, Google may use free-tier prompts to improve its products. |
| OpenRouter | Pay per use (a fraction of a cent per comparison) | Key from [openrouter.ai/keys](https://openrouter.ai/keys). Set any model, e.g. `deepseek/deepseek-chat`. |
| Ollama (local) | Free | You must allow extension origins: `OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*"`. Quality is noticeably weaker below ~14B models. |
| Custom | – | Any OpenAI-compatible `/chat/completions` endpoint. Tampermonkey asks once to allow the host. |
| **Ask ChatGPT** button | Free | No key needed. It copies a plain question ("What's the difference between …?") and opens ChatGPT; frontier chat models answer best without a template. ChatGPT's prefill parameter is unofficial; if it doesn't prefill, just paste. |

Your API key stays in Tampermonkey's storage. It is never logged, and it is sent only to the provider you chose.

## Privacy

- **To the LLM provider:** the characters, readings, WaniKani meanings and part of speech of the words you compare. Nothing else is sent: no mnemonics, no account data.
- **To kanjisearch.com** (if enabled): the characters of the current word.
- **To WaniKani:** your item data is read through the WaniKani Open Framework, which handles the API token.
- **Never:** no tracking, no analytics, no server of ours.

## Cache

Each answer is stored in Tampermonkey storage, keyed by the set of WaniKani subject IDs, the output language and the prompt version. Order doesn't matter. Changing the prompt version invalidates old answers. Switching provider does not; use Regenerate for that. Settings → Export / Import / Clear manages it.

## Development

No build step: `wanikani-similar-words-explanation.user.js` is the source. The pure core (meaning matching, candidate ranking, prompt, cache key, provider request and response handling) is exported to Node for tests.

```sh
npm test                                   # unit + metadata tests
WK_TOKEN=... npm run fixture               # optional: dump your vocab to test/fixtures/local (git-ignored)
PROVIDER=gemini API_KEY=... npm run eval   # run the real prompt on 10 confusable pairs
```

Bump `PROMPT_VERSION` whenever the prompt or schema changes, and `@version` on every release.

## Credits

- [WK Item Info Injector](https://greasyfork.org/scripts/430565) by Sinyaven (MIT-0)
- [WaniKani Open Framework](https://github.com/rfindley/wanikani-open-framework) by rfindley
- Similar-word groups from [Kanji Search](https://www.kanjisearch.com) by Mark Hennessy. If you find them useful, consider [supporting it](https://www.paypal.com/paypalme/mhennessy116).

MIT license.
