# AGENTS.md — repository rules for `pi-prompt-translate-czk`

Fork of `05kim/pi-prompt-translate` with CZK balance/rate status, global config,
and pi at-words integration. The Czech-fork features are deliberate; the code
layout follows the Pi plugin VSA convention.

## Layout (vertical slice architecture)

```
index.ts                 composition root ONLY — wiring, no logic
src/shared/              kernel: no slice may be imported from here
  state.ts               session state + unsubscriber store
  types.ts               entry types, config shape, telemetry shape
  config.ts              normalisation, persistence, command-value parsing
  config-model.ts        which model answers a translation call
  languages.ts           language aliases
  prompts.ts             system prompts (agent-facing, English by design)
  display.ts             final-translation map, at-word highlighting
  balance.ts             OpenRouter balance + USD→CZK cache
  format.ts              pure presentation helpers + debug notify
  diagnostics.ts         read-only renderers for /status and /stats
  status-bus.ts          the seam the status slice publishes through
  goal-command.ts        /goal scaffold parser
  translate/             the translation engine
    index.ts             barrel — the kernel's public surface
    core.ts              the model call, retries, telemetry
    protect.ts           segment masking / restoration rules
    context.ts           request headers, payload wrapper, history
    text.ts              message helpers, token estimation
    language.ts          English/code detection
src/slices/              features; slices never import each other
  pipeline/              pi event → translation (input, answer, tool-UI, entries, at-words)
  goal/                  /goal interception via AgentSession.prototype.prompt
  status/                the footer status segment
  commands/              /prompt-translate and its completions
test/                    vitest; imports the kernel barrel and owning modules
```

## Invariants

1. **A slice never imports another slice.** If two slices need the same thing, it
   belongs in `src/shared/` (Q3 of the membership tree). The one live example is
   `shared/status-bus.ts`: the status slice owns the footer, everyone else asks it
   to repaint through the kernel, and `shared/goal-command.ts` is the `/goal`
   parser shared by the pipeline and the goal slice.
2. **`src/shared/` never imports a slice.** The dependency arrow points one way:
   slices → shared.
3. **`index.ts` contains wiring only** — register the slices, drain subscriptions
   on `session_shutdown`, nothing else. Behaviour that moved out of it lives in
   `slices/pipeline/entries.ts` (entry renderers) and
   `slices/pipeline/at-words.ts` (the at-words bridge).
4. **No import cycles.** The tree is acyclic by construction; a cycle means a
   module is in the wrong layer.
5. **Hard limit 400 lines per file, soft target 300.** `src/shared/translate/protect.ts`
   (326), `src/slices/commands/complete.ts` (312) and
   `src/shared/translate/language.ts` (308) are over the soft target and are left
   alone deliberately: they are single-concept rule catalogues, and splitting them
   by length rather than by concept is the anti-pattern the VSA reference rejects.
6. **Split by concept, never by line count.** New code goes into the slice that
   owns the feature; a second concept inside an existing file starts a sibling.

## Engine pin

`devDependencies` must match the running engine's minor line (`^0.99.1`), not a
range inherited from an older checkout. A stale pin type-checks the plugin against
an API the loaded engine does not have. Verify with:

```bash
npm view @earendil-works/pi-coding-agent version   # what npm publishes
npm run check && npm test                          # typecheck + 51 tests
```

`tsconfig.json` deliberately has **no** `paths` mapping: the engine types resolve
from `node_modules`, so a checkout on any machine type-checks. Do not reintroduce
machine-specific absolute paths.

## Language of the code

User-visible text is Czech/English mixed by design — this fork targets a Czech
operator. Tool descriptions and model-facing instructions stay English; they are
read by the agent, not the user.
