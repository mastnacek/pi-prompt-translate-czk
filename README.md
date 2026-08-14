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

## Prompt enhancement levels (`boost`)

Set with `/prompt-translate boost <level>`:

| Level  | What it does |
|--------|--------------|
| `off`  | Plain faithful translation. Typos/grammar fixed silently, meaning untouched. |
| `on` (= `boost`) | Faithful clarity edit. Output contains **only** what you wrote — no invented specifics, no restructuring. A short casual request stays short. |
| `mega` | Full restructure. Turns the request into clear imperative sentences and, for multi-part requests, an ordered task list (investigate → fix → verify). May make implicit-but-obvious expectations explicit (e.g. "check the configuration first"), but still never invents new features, files, or scope. |

Both levels run in the **same single LLM call** as the translation — no extra
request, only slightly longer output on `mega`.

Example (Czech input):

- Source: `tak už to funguje, ale ta hnědá barva se mi nelíbí, změň ji podle theme`
- `boost`: `It works now, but I don't like the brown background. Change it to match the theme.`
- `mega`: `It works now, but I don't like the brown background. Tasks: 1. Check which theme is configured in the pi agent. 2. Adjust the background color of the original-prompt box to match that theme.`

## Commands

```
/prompt-translate status                     Show full configuration and resolved model
/prompt-translate on|off                     Enable/disable prompt translation
/prompt-translate input on|off               Same as on|off
/prompt-translate responses on|off           Translate final reply back to target language
/prompt-translate lang <language>            Target language for replies (default Czech)
/prompt-translate model <m> [until DATE]     Set translate model; optional auto-expiry
/prompt-translate boost off|on|mega          Prompt enhancement level (see table above)
/prompt-translate think on|off               Use reasoning on the translate model (low effort, capped)
/prompt-translate original on|off            Show the original prompt above the translated one
/prompt-translate balance [refresh]          USD→CZK rate + OpenRouter credit balance
/prompt-translate debug on|off               Verbose notifications
/prompt-translate reset                      Reset all settings to defaults
/prompt-translate help                       Command summary
```

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

All settings are stored as custom entries in the pi session log, so they
survive reloads and are restored per session. `/prompt-translate reset`
restores the defaults:

```json
{
  "enabled": true,
  "translateResponses": true,
  "targetLanguage": "Czech",
  "translateModel": "google/gemini-3.5-flash-lite",
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
