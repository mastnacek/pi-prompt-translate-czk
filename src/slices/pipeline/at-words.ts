// pipeline/at-words.ts — the pi at-words integration.
//
// The engine publishes the confirmed at-word list on its own bus; this turns it
// into one alternation regex that the protection layer and the TUI highlighter
// both read. It is pipeline work (an event subscription feeding session state),
// not shared kernel, even though the highlight helper lives in shared/display.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state } from "../../shared/state.js";
import { AT_WORDS_MENTION_SRC, setAtWordsRegex } from "../../shared/display.js";

export function registerAtWords(pi: ExtensionAPI): void {
	pi.events.on("at-words:words-updated", (data: unknown) => {
		const words = (data as { words?: unknown } | undefined)?.words;
		if (!Array.isArray(words)) return;
		const filteredWords = words.filter(
			(w): w is string =>
				typeof w === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w),
		);
		state.atWords = filteredWords;
		// Copy before sorting: filteredWords is the array now held by state.atWords,
		// and sorting in place left the shared list ordered by length. Harmless to the
		// regex (JS alternation is ordered, so that order is the one it needs) but not
		// the order anything else reading state.atWords expects.
		const alts = [...filteredWords]
			.sort((a, b) => b.length - a.length)
			.join("|");
		if (!alts) {
			setAtWordsRegex(null);
			return;
		}
		setAtWordsRegex(
			new RegExp(
				`(?:${AT_WORDS_MENTION_SRC})|(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])`,
				"g",
			),
		);
	});
}
