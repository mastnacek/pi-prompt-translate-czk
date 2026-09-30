// pipeline/entries.ts — session-entry renderers.
//
// Renderers are TUI-only concerns of this plugin's own entry types, so they live
// with the pipeline that appends them. Width safety: the engine hard-crashes if a
// rendered line exceeds the terminal, and these strings are built from user text
// (the source prompt can be arbitrarily long), so every section is a plain
// multi-line Text — pi-tui wraps it rather than overflowing the frame.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { state } from "../../shared/state.js";
import { STATE_ENTRY_TYPE, type BoostLevel, type TranslationUsage } from "../../shared/types.js";
import { styleAtWords } from "../../shared/display.js";
import { formatCost } from "../../shared/format.js";

export function registerEntryRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<{
		source?: string;
		english?: string;
		boost?: BoostLevel;
		usage?: TranslationUsage;
		costUsd?: number;
		costCzk?: number;
		conversationContext?: string;
	}>(STATE_ENTRY_TYPE, (entry, _options, theme) => {
		const source = entry.data?.source;
		if (typeof source !== "string" || !source.trim()) return undefined;

		if (state.config.diff) {
			const box = new Box(1, 1, (text) => theme.bg("selectedBg", text));
			const boostBadge =
				entry.data?.boost && entry.data.boost !== "off"
					? ` [boost: ${entry.data.boost}]`
					: "";
			const historyBadge = entry.data?.conversationContext
				? " [history: attached]"
				: "";
			const usage = entry.data?.usage;
			const tokStr =
				usage?.totalTokens === undefined
					? ""
					: ` · ${usage.totalTokens} tok (in: ${usage.input}, out: ${usage.output})`;
			const costStr =
				entry.data?.costUsd === undefined
					? ""
					: ` · ${formatCost(entry.data.costUsd, entry.data.costCzk)}`;

			const header =
				theme.fg(
					"accent",
					`🔄 Prompt Translation Diff${boostBadge}${historyBadge}`,
				) + theme.fg("dim", `${tokStr}${costStr}`);

			const originalSection = `${theme.fg("customMessageLabel", "Original (CZ):")}\n${theme.fg("customMessageText", styleAtWords(source))}`;
			const englishSection =
				entry.data?.english && entry.data.english.trim() !== source.trim()
					? `\n\n${theme.fg("customMessageLabel", "Enhanced (EN):")}\n${theme.fg("customMessageText", entry.data.english)}`
					: "";
			const historySection = entry.data?.conversationContext
				? `\n\n${theme.fg("customMessageLabel", "Attached History Context:")}\n${theme.fg("dim", entry.data.conversationContext)}`
				: "";

			box.addChild(
				new Text(
					`${header}\n\n${originalSection}${englishSection}${historySection}`,
				),
			);
			return box;
		}

		if (!state.config.showOriginal) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("selectedBg", text));
		const historyBadge = entry.data?.conversationContext
			? ` ${theme.fg("dim", "[with history]")}`
			: "";
		box.addChild(
			new Text(
				`${theme.fg("customMessageLabel", "original:")}${historyBadge}\n${theme.fg("customMessageText", styleAtWords(source))}`,
			),
		);
		return box;
	});
}
