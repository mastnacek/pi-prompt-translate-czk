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
scaffold is preserved). This needs a hook on `AgentSession.prototype.prompt`,
because pi dispatches extension commands before the `input` event. The patch is
re-pointed at the new module state on every `session_start` and removed again on
`session_shutdown`, so it keeps working across `/reload` and session swaps
instead of silently pointing at a dead session context.

### Code, URL & Integrity Protection

- **Token Masking:** Code blocks (`` `...` `` and ```` ```...``` ````), URLs (`http(s)://`, `file://`), `@file` mentions, `?symbol` queries, and XML contexts are masked with placeholder tokens before translation and restored after. Assistant answers are masked for the same code-fence, inline-code and `@file` rules as prompts, so a code sample in a reply comes back byte-identical.
- **XML Context Delimitation:** The source payload is wrapped in a **per-request** random tag (`<source_text_…>`) instead of a fixed `<source_text>`, so a `</source_text>` inside your own prompt is just text and cannot close the block early; any raw closing tag for our tag names is escaped on top of that. The system prompt names the same tag the payload uses, and echoed wrappers are safely stripped.
- **Placeholder Integrity Fallback:** If a model modifies or drops a placeholder token, fuzzy matching and dropped-token safety recovery ensure that code and links are never lost. The fuzzy matcher replaces *every* occurrence (a model may legitimately reference the same file twice), requires a whole-token match, and tolerates only spaces/underscores — not newlines.
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
/prompt-translate confirm on|off             Require confirmation dialog before sending translated prompt
/prompt-translate history off|ask|auto|always|inspect Conversation context injection mode / inspection
/prompt-translate diff on|off                Show side-by-side prompt diff with token count and cost
/prompt-translate detect on|off              Auto-skip translation if prompt is already English or code
/prompt-translate ui on|off                  Translate tool-rendered text (quick-win card, closing echo) into the target language
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

### Conversation History Context & Interactive Toggle

When following up on previous assistant responses (e.g. *"udělej to taky pro druhou funkci"*, *"proč to nefunguje?"*), natural language contains pronouns and deictic references that pure stateless translation cannot resolve.

Configure with `/prompt-translate history <mode>`:

- **`off` (default):** Pure stateless translation (minimum token usage).
- **`ask` (or `on`):** Prompts you interactively via TUI before each translation asking whether to include recent conversation context.
- **`auto`:** Automatically includes recent context when deictic references (e.g. *to*, *tento*, *druhou*, *stejně*, *předchozí*) are detected in the prompt.
- **`always`:** Always attaches the last 1–2 turns of context into the translation request.
- **`inspect` (or `/prompt-translate history inspect`):** Displays currently extracted conversation history without changing settings.

When active, conversation history is fenced in `<conversation_context>` tags. The model uses it strictly for pronoun/reference resolution while translating only `<source_text>`. When attached, history context is visually badged in the TUI diff box (`[history: attached]` and `Attached History Context:` section) and prompt notifications.

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

### Tool-UI Text (quick-win card)

The agent is forced to work in English, and some tools render model-authored English straight into your screen. The `quick_win` card is the common case: its title, impact, steps, proof and the closing statusline echo land in an overlay before any assistant sentence exists, so reply translation never sees them.

`/prompt-translate ui on` (default) hooks `tool_call` and rewrites the tool's own text arguments **before the tool runs** — so the overlay, the statusline echo and the transcript all render the same target-language card. Arguments that are enums (`effort`) are never touched, or the tool would reject its own input.

All fields of one call travel in a single LLM request as `<<<n>>>`-marked blocks, and the contract is **all-or-nothing**: the model must return exactly the markers `<<<0>>>` … `<<<n-1>>>`, each once, in order, each with a non-empty translation. A dropped *or shifted* marker (a model counting from 1 is the common case) leaves the **whole card in English** rather than writing translations into the wrong fields — a shifted set would otherwise render the impact line under the title. Any failure keeps the English card and logs to debug — a broken translation must never block the tool.

```
/prompt-translate ui off        English cards, no extra translation call
/prompt-translate ui on --global  make the setting apply to all sessions
```

Static vocabulary that the tool itself owns (`Quick win:`, `Impact:`, `Steps:`) and the model-facing choice directive stay in English by design: the directive is an instruction to the agent, not UI copy.

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

## Development

Vertical slice architecture: a thin `index.ts` composition root, a `src/shared/`
kernel, and `src/slices/{pipeline,goal,status,commands}/` features. Slices never
import each other — anything two of them need moves into `src/shared/`. The full
map and the invariants are in [AGENTS.md](AGENTS.md). There is deliberately no
string table: `/prompt-translate lang` sets the *target* language of the
translation, not a UI locale, and the operator-facing copy stays Czech next to the
English text the model reads.

```bash
npm install     # devDeps are pinned to the engine minor line you run
npm run check   # tsc --noEmit (no machine-specific paths in tsconfig)
npm test        # vitest, 51 tests
```

## Credits

Fork of [05kim/pi-prompt-translate](https://github.com/05kim/pi-prompt-translate) (MIT).
Fork additions: CZK balance/exchange-rate status, `--global` config persistence,
prompt-builder refactor, and [pi-at-words](https://github.com/mastnacek/pi-at-words) integration.
