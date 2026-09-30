// pipeline/index.ts — the event pipeline slice barrel.
//
// This is the slice that turns pi events into translations: the input hook, the
// tool-UI card rewrite, the entry renderers, and the at-words bridge. It owns the
// session-visible side effects (entries, notifications, displayed text) and leaves
// the model call itself to the translate kernel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAtWords } from "./at-words.js";
import { registerEntryRenderers } from "./entries.js";
import { registerAgentHooks } from "./hooks.js";
import { registerToolUiHooks } from "./tool-ui.js";

/**
 * Wire the pipeline. `track` collects every unsubscribe function the engine hands
 * back, so the composition root can drain them all in one place on
 * `session_shutdown` — that handler is the only place resources are released.
 */
export function registerPipeline(
	pi: ExtensionAPI,
	track: (result: unknown) => void,
): void {
	registerAgentHooks(pi, track);
	registerToolUiHooks(pi, track);
	registerAtWords(pi);
	registerEntryRenderers(pi);
}
