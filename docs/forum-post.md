**[Userscript] WaniKani Similar Words Explanation: "what's the difference between 必要 and 重要?" answered in the item info**

WaniKani often teaches words with near-identical English meanings many levels apart, and never says how they differ. I kept pasting pairs into ChatGPT, so I built that into WaniKani.

**What it does**
- Under **Meaning** in the item info (lessons, reviews after you answer, extra study, vocab pages), it lists words *you've already learned* that are easy to confuse with the current one. It finds them by shared meanings plus the hand-curated groups from [Kanji Search](https://www.kanjisearch.com) (thanks, Mark!).
- Pick one to three and click **Explain the difference**. You get a one-line gist, then for each word a short note (linked to its WaniKani page), how everyday vs formal it is, key expressions and an example, then one scene using all of them, and the one trap worth remembering. Strong matches you haven't learned yet are listed too, clearly marked.
- Nothing is sent unless you click. Answers are cached in your browser; **Regenerate** asks again.
- It never steals focus, so Enter still goes to the next review.

**LLM**
- Default: **Google Gemini's free tier** (bring your own key).
- Also supported: OpenRouter, a local Ollama, or any OpenAI-compatible endpoint.
- No key at all? **Ask ChatGPT** copies the prompt and opens ChatGPT.

**Install**
1. [Tampermonkey](https://www.tampermonkey.net/). On Chrome/Edge 138+, turn on *Allow User Scripts* in Tampermonkey's extension details.
2. [WaniKani Open Framework](https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549).
3. WaniKani Similar Words Explanation: GREASYFORK_LINK
4. Tampermonkey menu → WaniKani Similar Words Explanation → Settings → paste your [Gemini key](https://aistudio.google.com/apikey). Use a project with no billing account linked.

**Privacy:** only the compared words' characters, readings, WK meanings and part of speech go to the LLM you chose. No mnemonics, no account data, no tracking, no server of mine.

Source and issues: https://github.com/pensiero/wanikani-similar-words-explanation. MIT license. Feedback very welcome, especially pairs where the explanation is wrong.

SCREENSHOT_HERE
