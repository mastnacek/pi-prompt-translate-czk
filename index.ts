// index.ts — extension wiring: event handlers, /prompt-translate command,
// entry renderers. Logic lives in the sibling modules.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	extractLatestConfig,
	normalizeConfig,
	normalizeLanguage,
	parseModelSetting,
} from "./config.js";
import {
	CONFIG_ENTRY_TYPE,
	DEFAULT_CONFIG,
	FINAL_TRANSLATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	type BoostLevel,
	type TranslateConfig,
	type TranslationUsage,
} from "./types.js";
import {
	ENGLISH_ONLY_AGENT_INSTRUCTION,
	appendEnglishOnlyInstruction,
	buildEnglishOnlyInstruction,
} from "./prompts.js";
import {
	AT_WORDS_MENTION_SRC,
	rebuildFinalTranslationMap,
	rememberFinalTranslation,
	replaceDisplayedAssistantTextWithEnglish,
	setAtWordsRegex,
	styleAtWords,
	sumSessionCostUsd,
} from "./display.js";
import { extractGoalObjective, installPromptInterceptor } from "./goal.js";
import { state } from "./state.js";
import {
	formatCost,
	formatTelemetryOverview,
	refreshBalanceStatus,
	updateTranslateStatus,
} from "./status.js";
import {
	buildEffectiveHeaders,
	cleanTranslationOutput,
	createTranslationContext,
	estimateTranslationMaxTokens,
	extractRecentContext,
	getText,
	hasDeicticReferences,
	hasToolCall,
	protectFinalAnswerSegments,
	restoreProtectedSegments,
	withSingleText,
} from "./translate.js";
import { registerTranslateCommand } from "./command.js";
import { registerAgentHooks } from "./agent-hooks.js";

export default function (pi: ExtensionAPI) {
	const unsubscribers: Array<() => void> = [];

	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	state.piApi = pi;
	installPromptInterceptor();

	pi.events.on("at-words:words-updated", (data: unknown) => {
		const words = (data as { words?: unknown } | undefined)?.words;
		if (!Array.isArray(words)) return;
		const filteredWords = words.filter(
			(w): w is string =>
				typeof w === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w),
		);
		state.atWords = filteredWords;
		const alts = filteredWords.sort((a, b) => b.length - a.length).join("|");
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

	track(pi.on("session_start", (_event, ctx: ExtensionContext) => {
		state.sessionCtx = ctx;
		state.config = extractLatestConfig(ctx);
		rebuildFinalTranslationMap(ctx);
		state.sessionCostUsd = sumSessionCostUsd(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`pi-prompt-translate input ${state.config.enabled ? "on" : "off"}, responses ${state.config.translateResponses ? "on" : "off"} (target: ${state.config.targetLanguage}, model: ${state.config.translateModel})`,
				"info",
			);
		}
		refreshBalanceStatus(ctx);
		updateTranslateStatus(ctx);
	}));

	pi.on("session_shutdown", () => {
		while (unsubscribers.length > 0) unsubscribers.pop()?.();
		state.sessionCtx = undefined;
		state.pending = undefined;
		state.atWords = [];
		setAtWordsRegex(null);
	});

	registerTranslateCommand(pi);
	registerAgentHooks(pi, track);
}

export const __test = {
	CONFIG_ENTRY_TYPE,
	FINAL_TRANSLATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	DEFAULT_CONFIG,
	ENGLISH_ONLY_AGENT_INSTRUCTION,
	appendEnglishOnlyInstruction,
	buildEffectiveHeaders,
	buildEnglishOnlyInstruction,
	cleanTranslationOutput,
	createTranslationContext,
	estimateTranslationMaxTokens,
	extractGoalObjective,
	extractLatestConfig,
	extractRecentContext,
	formatTelemetryOverview,
	getText,
	hasDeicticReferences,
	hasToolCall,
	normalizeConfig,
	normalizeLanguage,
	parseModelSetting,
	protectFinalAnswerSegments,
	rebuildFinalTranslationMap,
	rememberFinalTranslation,
	replaceDisplayedAssistantTextWithEnglish,
	resetState() {
		state.config = { ...DEFAULT_CONFIG };
		state.pending = undefined;
	},
	restoreProtectedSegments,
	setConfig(next: TranslateConfig) {
		state.config = { ...next };
	},
	withSingleText,
};
