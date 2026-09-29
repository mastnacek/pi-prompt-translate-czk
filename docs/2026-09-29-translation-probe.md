# Translation probe — Czech input battery (2026-09-29)

Live test of `pi-prompt-translate-czk` in a real pi TUI pane, driven by
`herdr pane send-text` (so input passes the same `pi.on("input")` hook a human
typing would). Model `openrouter/google/gemini-3.5-flash-lite`, `boost: boost`.

Goal: find where the Czech→English prompt translation loses or alters meaning.

## Headline: the real bug is Czech inflection

```
Přepni se do herderu a otevři tam nový tab.
→ Switch to the herder directory and open a new tab there.   ← invented "directory"
```

The model does not recognise the inflected form `herderu` as the multiplexer
name and invents a noun to make the sentence work. This is the reported
"někdy napíšu herder a on to přeloží jinak".

Three-way comparison, same sentence:

| sent | what the agent received | |
|---|---|---|
| `herderu` | Switch to the **herder directory** and open a new tab there. | ❌ hallucinated noun |
| `<keep>herderu</keep>` | Switch to the herderu and open a new tab there. | ✅ faithful, awkward English |
| `<keep>herder</keep>u` | Switch to herder and open a new tab there. | ✅✅ best |

So the right habit is to wrap **only the stem** and leave the Czech ending
outside the tag — the model then keeps the name and drops the case ending.

## `<keep>` works, but the first probe round proved nothing

An early round (T1/T8) appeared to show `<keep>` rescuing names. It did not —
there was no control. With controls:

| pair | result |
|---|---|
| `Jak spustím herder znovu?` | → `How do I run herder again?` |
| `Jak spustím <keep>herder</keep> znovu?` | → `How do I run herder again?` — **identical** |
| `Otevři Cursor a najdi tam ten soubor.` | → `Open Cursor and find that file there.` |

The model already leaves proper names alone, and `herder` is an English word so
it passes through regardless. **`<keep>` adds nothing for uninflected names** —
its demonstrated value is only on inflected forms, where it suppresses the
hallucination.

## Full battery

| # | Czech input | What the agent received | |
|---|---|---|---|
| T1 | `Co dělá <keep>herder</keep> v <keep>src/herder.ts</keep>?` | `What does herder do in src/herder.ts?` | ✅ tags stripped, term visible |
| T2 | `Proč je pole \`userId\` nullable, když schéma říká, že není?` | `Why is the \`userId\` array nullable when the schema says it is not?` | ❌ **"pole" → "array"**, should be "field" |
| T3 | `Spusť \`npm run build\` a mrkni do /home/…/index.ts` | `Run \`npm run build\` and check /home/…/index.ts` | ✅ code + path intact |
| T4 | `Rozděl ten dlouhý připojovací řetězec na dva řádky, je nečitelný.` | `Split that long connection string into two lines, it's unreadable.` | ✅ |
| T5 | `oprav tu chybu v ty funkci co jsem psal vcera` | `Fix the bug in the function I wrote yesterday.` | ✅ typos + diacritics fixed |
| T6 | `Proč to padá?` | `Why is it crashing?` | ✅ deictic "to" resolved |
| T7 | `Why does the build fail?` | `Why does the build fail?` | ✅ English passthrough |
| T9 | `Přidej validaci, napiš testy a aktualizuj README.` | `Add validation, write tests, and update the README.` | ✅ boost invented nothing |

Cost: 0.0028–0.0048 Kč per prompt translation, ~420–490 tok in.

## Fixes applied

**1. Rule 11 missed every case ending** (`translate-protect.ts`). The old
pattern `(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])` matched only the
nominative, so `?herder` protected `otevři herder` but not `do herderu` — the
exact form that triggers the hallucination. Now a Czech ending is matched too
and **only the stem is wrapped**:

```
Přepni se do herderu   →  Přepni se do <keep>herder</keep>u
v herderu              →  v <keep>herder</keep>u
s herderem             →  s <keep>herder</keep>em
herderův tab           →  <keep>herder</keep>ův tab
o herderovi            →  o <keep>herder</keep>ovi
herdermann             →  herdermann          (longer word untouched)
```

Verified end-to-end in a live pi pane, not just as a unit test. Drove the real
`?herder` path: `@tmp_atwords_probe.ts herderu a otevři tam nový tab.`

```
Original (CZ):   @tmp_atwords_probe.ts herderu a otevři tam nový tab.
Enhanced (EN):   @tmp_atwords_probe.ts herder and open a new tab there.
```

The unprotected form of the same sentence produced `…the herder directory…`, so
the two outcomes discriminate cleanly. This is the whole chain working:
pi-at-words records the accepted word → `state.atWords` → rule 11 wraps the stem
→ the model keeps the name and drops the Czech ending.

**2. Rule 11 now marks instead of masks.** Unrelated to the above but landed
first: at-words used to become an opaque `__PI_PROMPT_TRANSLATE_PROTECTED_n__`,
which erased the sentence's context. Terms are now wrapped in a visible
`<keep>…</keep>` and the tags are stripped by `stripKeepTags()` on the way out.
If the model drops a tag the term still survives — the old code appended lost
segments to the end of the sentence.

Tests: 37 pass, `tsc --noEmit` clean.

## Open item: "pole"

`pole` is genuinely ambiguous in Czech (*field* / *array* / *meadow*). With
`userId` + `schéma` the sense is obvious to a Czech speaker, but the model chose
"array". Protection cannot fix this (we do not want the word kept in Czech).
Candidate, **only if it recurs**: one glossary line in `prompts.ts` next to
`KEEP_TERM_RULE`:

> In code, schema, database or struct context, Czech "pole" means the FIELD /
> column of a record — never "array".

## pi-at-words was not installed at all

`state.atWords` is fed exclusively by the `at-words:words-updated` event, emitted
only by [`mastnacek/pi-at-words`](https://github.com/mastnacek/pi-at-words). That
package was **absent from `settings.json`**, and nothing else in the extension
set emits the event — so rule 11 never fired and `?herder` did nothing at all.
Installed with `pi install git:github.com/mastnacek/pi-at-words`; `/reload` in an
active session is enough to pick up both it and the rule-11 fix.

Accepting a `?query` suggestion (Tab) is what calls `recordHighlight()`, so the
word has to be picked from the suggestion list — merely typing `?herder` does
not register it. An `@`-mention of a file containing the word must be in the
same message.

## Repo finding: devDeps pin a stale engine

`devDependencies` pin `@earendil-works/pi-coding-agent` / `pi-ai` at `^0.87.0`,
which resolves to **0.87.1**, while the running engine is **0.99.0** (pi-tui
resolves to 0.84.2). `^0.87.0` on a `0.x` version does not float — it is capped
below 0.88. The test suite and `tsc` therefore type-check against an API twelve
minor versions behind what actually loads the plugin.

## Harness findings

- **Intercom messages are NOT translated.** They arrive as `custom_message` /
  `customType: "intercom_message"` and never pass `pi.on("input")`. The first
  probe round recorded a message that reached the agent verbatim in Czech. A
  harness must type into the pane (`herdr pane send-text` + `send-keys Enter`).
- **The `Prompt Translation Diff` block is transient** — not a recording
  medium. The durable record is the session JSONL's `message` / `role: "user"`
  entries (`~/.pi/agent/sessions/**/*.jsonl`).
- **Messages sent during a turn land in the steering queue** and are not
  written to the JSONL until submitted. Record from an idle pane only — and
  racing it silently merges queued prompts into one user message.
- **`herdr pane get .agent_status` is unreliable**: reported `idle` while the
  TUI spun `Working` for minutes.
- **A prompt containing a real command hangs the turn.** T3's `npm run build`
  kept the pane busy >5 min and blocked the queue behind it. Prefer questions
  when probing translation.
- **Clear the input box before `send-text`** or the new text is appended to
  whatever was left there (one probe went out as `okOtevři Cursor…`).
- Queue lines are truncated to pane width; `Escape` expands the queue
  full-width where the complete text is readable.
