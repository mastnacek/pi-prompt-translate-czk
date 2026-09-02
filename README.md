# pi-prompt-translate

Pi extension that translates user prompts into English before they reach the
agent, and optionally translates the final assistant reply back into your
configured language. Includes an optional **prompt enhancement (boost)** stage,
a display of the original prompt, cost tracking (USD + CZK), and an OpenRouter
balance readout.

## How it works

1. You type a prompt (e.g. Czech).
2. The extension sends it to a small/cheap translate model in a single LLM call.
3. The translated (and optionally enhanced) English text replaces the prompt
   sent to the agent. The agent works and answers in English.
4. If response translation is on, the final briefing is translated back to your
   target language. The original prompt is shown above the translated message
   in a theme-colored box (display only, never sent to the LLM).

`/goal` objectives are translated too (only the objective text; the command
scaffold is preserved).

### Code, URL & Integrity Protection

- **Token Masking:** Code blocks (`` `...` `` and ```` ```...``` ````), URLs (`http(s)://`, `file://`), `@file` mentions, `?symbol` queries, and XML contexts are masked with placeholder tokens before translation and restored after.
- **XML Context Delimitation:** Prompts are cleanly isolated in `<source_text>` XML tags so models never confuse instructions with conversational commands. Echoed wrappers are safely stripped.
- **Placeholder Integrity Fallback:** If a model modifies or drops a placeholder token, fuzzy matching and dropped-token safety recovery ensure that code and links are never lost.
- **Technical Preservation:** Prompts enforce strict negative few-shot rules against translating CLI commands (`git clone`, `npm run`, flags) and code identifiers.

## Prompt enhancement levels (`boost`)

Set with `/prompt-translate boost <level>`:

| Level  | What it does |
|--------|--------------|
| `off`  | Plain faithful translation. Typos/grammar fixed silently, meaning untouched. |
| `on` (= `boost`) | Faithful clarity edit. Output contains **only** what you wrote — no invented specifics, no restructuring. A short casual request stays short. |
| `plus` | Imperative sentences + light structure. Explicit multi-part requests become an ordered task list, but **strict fidelity**: every sentence must trace to your words — no inferred steps, checks, or details. |
| `mega` | Full restructure into clear imperatives + ordered task list (investigate → fix → verify). Reordering/structuring allowed, but every task must correspond to something you explicitly said. |

All levels run in the **same single LLM call** as the translation — no extra
request, only slightly longer output on `plus`/`mega`.

Example (Czech input):

- Source: `tak už to funguje, ale ta hnědá barva se mi nelíbí, změň ji podle theme`
- `boost`: `It works now, but I don't like the brown background. Change it to match the theme.`
- `plus`: `It works now, but I don't like the brown background. Change it to match the configured pi theme.`
- `mega`: `It works now, but I don't like the brown background. Tasks: 1. Check which theme is configured in the pi agent. 2. Adjust the background color of the original-prompt box to match that theme.`

## Commands

```
/prompt-translate status                     Show full configuration and resolved model
/prompt-translate stats                      Show telemetry, cache hit rate, and financial savings
/prompt-translate on|off                     Enable/disable prompt translation
/prompt-translate input on|off               Same as on|off
/prompt-translate responses on|off           Translate final reply back to target language
/prompt-translate lang <language>            Target language for replies (default Czech)
/prompt-translate model <m> [until DATE]     Set translate model; optional auto-expiry
/prompt-translate boost off|on|plus|mega    Prompt enhancement level (see table above)
/prompt-translate diff on|off                Show side-by-side prompt diff with token count and cost
/prompt-translate detect on|off              Auto-skip translation if prompt is already English or code
/prompt-translate think on|off               Use reasoning on the translate model (low effort, capped)
/prompt-translate original on|off            Show the original prompt above the translated one
/prompt-translate balance [refresh]          USD→CZK rate + OpenRouter credit balance
/prompt-translate debug on|off               Verbose notifications
/prompt-translate reset                      Reset all settings to defaults
/prompt-translate help                       Command summary
```

### OpenRouter Routing & Cache Optimization

When using an OpenRouter model (e.g. `openrouter/google/gemini-3.5-flash-lite`), the extension automatically applies transport-layer optimizations without altering translation text or semantics:
- **Provider Sticky Routing (`x-session-id`):** Pins all translation turns in a session to the same backend provider endpoint (10-min sliding window), keeping the provider's prompt cache warm and unlocking 50–90% cost discounts on repeated system prompt prefix tokens.
- **Attribution Headers:** Sends `HTTP-Referer` and `X-Title: Pi Prompt Translate` to isolate translation metrics and analytics in your OpenRouter dashboard.
- **Savings & Telemetry Accounting:** Automatically tracks cumulative cached tokens, cache write tokens, hit rates, and estimated dollar / CZK savings, viewable anytime via `/prompt-translate stats`.

### Temporary model with auto-fallback

```
/prompt-translate model openrouter/google/gemini-3.7-flash until 2026-08-26
```

Uses the temporary model through the end of that day (inclusive), then
automatically falls back to the base `translateModel` — permanently; the
override clears itself on first use after expiry. The footer shows
`gemini-3.7-flash · til 08-26` while active.

Model IDs are `<provider>/<model>`. Note the provider matters:
`google/gemini-3.7-flash` does not exist on the direct `google` provider — use
`openrouter/google/gemini-3.7-flash`. If a temporary model is broken (not
found, missing auth), translation automatically falls back to the base model
with a warning instead of failing.

## Status bar

One compact footer segment (left → right):

```
⇄ Czech · ⚡ mega · think low · gemini-3.7-flash · til 08-26 · $0.000468 · OR$9.42
```

- `⇄ Czech` — input translation on, target language (red `⇄ off` when disabled)
- `⚡ boost|mega` — enhancement level (hidden when off)
- `think low` — reasoning enabled on the translate model
- model — effective translate model (short name), `til MM-DD` for temporary
- `$…` — accumulated translation cost this session (amber)
- `OR$…` — remaining OpenRouter credit (amber, when available)

## Original prompt display

Each translated prompt gets a box above it with the original text
(`original:` label). Colors come from the active pi theme: the box background
uses the theme's `selectedBg` slot (contrasts with the user message
background), label/text use `customMessageLabel`/`customMessageText`. The box
adapts automatically when you switch themes. Toggle with
`/prompt-translate original on|off`.

## Configuration persistence

Settings persist on two levels:

- **Session** (default): stored as custom entries in the pi session log,
  restored per session.
- **Global** (`--global` flag): also written to
  `~/.pi/agent/pi-prompt-translate.json` and applied to **every** session.

Precedence: `defaults < global file < session entries`. A change made without
`--global` overrides the global config for that session only.

```
/prompt-translate boost mega --global    # all future sessions use mega
/prompt-translate lang German --global   # replies in German everywhere
/prompt-translate global show            # inspect the global config file
/prompt-translate global off             # delete it, back to defaults
```

`/prompt-translate status` shows `globalConfig=on|off`. `/prompt-translate reset`
restores the defaults:

```json
{
  "enabled": true,
  "translateResponses": true,
  "targetLanguage": "Czech",
  "translateModel": "openrouter/google/gemini-3.5-flash-lite",
  "translateReasoning": true,
  "boost": "off",
  "showOriginal": true
}
```

## Cost notes

- Translation runs on a small model; typical prompt translation costs
  fractions of a cent (shown in every notification, e.g. `($0.000228 / 0.004780 Kč)`).
- USD→CZK conversion uses ČNB daily rates (fallback: frankfurter.app).
- OpenRouter balance is read from `https://openrouter.ai/api/v1/credits` using
  `OPENROUTER_API_KEY` or the key of your OpenRouter translate model.
- `:batch` model variants on OpenRouter are ~50% cheaper and fine for
  translation latency.

## Credits

Fork of [05kim/pi-prompt-translate](https://github.com/05kim/pi-prompt-translate) (MIT).
Fork additions: CZK balance/exchange-rate status, `--global` config persistence,
prompt-builder refactor, and [pi-at-words](https://github.com/mastnacek/pi-at-words) integration.
