// index.ts — extension wiring: event handlers, /prompt-translate command,
// entry renderers. Logic lives in the sibling modules.
//
// Module graph (one direction, no cycles):
//   index → goal/translate/status/balance → config → types/state

import { existsSync } from "node:fs";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	clearBalanceCache,
	getOpenRouterBalance,
	getUsdToCzkRate,
} from "./balance";
import {
	GLOBAL_CONFIG_FILE,
	clearGlobalConfig,
	extractLatestConfig,
	getEffectiveTranslateModel,
	loadGlobalConfig,
	normalizeConfig,
	normalizeLanguage,
	parseModelSetting,
	parseUntilDate,
	persistConfig,
	resolveConfiguredModel,
	saveGlobalConfig,
} from "./config";
import { extractGoalObjective, installPromptInterceptor } from "./goal";
import {
	refreshBalanceStatus,
	statusText,
	updateTranslateStatus,
	debug,
	formatCost,
} from "./status";
import { state } from "./state";
import {
	createTranslationContext,
	estimateTranslationMaxTokens,
	getText,
	hasToolCall,
	protectFinalAnswerSegments,
	restoreProtectedSegments,
	translate,
	withSingleText,
} from "./translate";
import {
	CONFIG_ENTRY_TYPE,
	DEFAULT_CONFIG,
	FINAL_TRANSLATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	type BoostLevel,
	type FinalTranslationRecord,
	type TranslateConfig,
	type TranslationUsage,
} from "./types";
import {
	ENGLISH_ONLY_AGENT_INSTRUCTION,
	appendEnglishOnlyInstruction,
	buildEnglishOnlyInstruction,
} from "./prompts";

// --- pi-at-words integration ------------------------------------------------
// Highlight colors owned by pi-at-words: pink = confirmed ?words, green = @mentions.
// Word set arrives via the shared extension event bus; plugin absent = no-op passthrough.
const AT_WORDS_PINK = "\x1b[1m\x1b[38;2;255;95;215m";
const AT_WORDS_PINK_OFF = "\x1b[22m\x1b[39m";
const AT_WORDS_GREEN = "\x1b[1m\x1b[38;2;0;255;102m";
const AT_WORDS_GREEN_OFF = "\x1b[22m\x1b[39m";
// Mention paths (`@src/foo.ts`, `@"quoted path"`) — same source pattern as pi-at-words.
const AT_WORDS_MENTION_SRC = String.raw`@"[^"\n]+"|@[\w][\w./-]*`;
let atWordsRe: RegExp | null = null;

function styleAtWords(text: string): string {
	if (atWordsRe === null) return text;
	return text.replace(
		atWordsRe,
		(m) =>
			m.startsWith("@")
				? `${AT_WORDS_GREEN}${m}${AT_WORDS_GREEN_OFF}`
				: `${AT_WORDS_PINK}${m}${AT_WORDS_PINK_OFF}`,
	);
}

// --- final-translation map (displayed → English) ------------------------------
// Rebuilt on session_start; entries appended as translations happen.

let finalTranslationByDisplayedText = new Map<string, string>();

function rebuildFinalTranslationMap(ctx: ExtensionContext) {
	const next = new Map<string, string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== FINAL_TRANSLATION_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}
		const record = entry.data as Partial<FinalTranslationRecord>;
		if (
			typeof record.translated === "string" &&
			typeof record.english === "string"
		) {
			next.set(record.translated, record.english);
		}
	}
	finalTranslationByDisplayedText = next;
}

function rememberFinalTranslation(
	pi: ExtensionAPI,
	record: FinalTranslationRecord,
) {
	finalTranslationByDisplayedText.set(record.translated, record.english);
	pi.appendEntry(FINAL_TRANSLATION_ENTRY_TYPE, record);
}

function replaceDisplayedAssistantTextWithEnglish(
	message: ContextEvent["messages"][number],
): ContextEvent["messages"][number] {
	if (message.role !== "assistant") return message;
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text") return part;
		const english = finalTranslationByDisplayedText.get(part.text.trim());
		if (!english) return part;
		changed = true;
		return { ...part, text: english };
	});
	return changed ? { ...message, content } : message;
}

// Sum translation USD cost already recorded in this session log (survives restarts).
function sumSessionCostUsd(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;
		if (
			entry.customType !== STATE_ENTRY_TYPE &&
			entry.customType !== FINAL_TRANSLATION_ENTRY_TYPE
		)
			continue;
		const usage = (entry.data as { usage?: TranslationUsage } | undefined)?.usage;
		const cost = usage?.cost?.total;
		if (typeof cost === "number") total += cost;
	}
	return total;
}

export const __test = {
	CONFIG_ENTRY_TYPE,
	FINAL_TRANSLATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	DEFAULT_CONFIG,
	ENGLISH_ONLY_AGENT_INSTRUCTION,
	appendEnglishOnlyInstruction,
	buildEnglishOnlyInstruction,
	createTranslationContext,
	estimateTranslationMaxTokens,
	extractGoalObjective,
	extractLatestConfig,
	getText,
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
		finalTranslationByDisplayedText = new Map<string, string>();
	},
	restoreProtectedSegments,
	setConfig(next: TranslateConfig) {
		state.config = { ...next };
	},
	withSingleText,
};

export default function (pi: ExtensionAPI) {
	state.piApi = pi;
	installPromptInterceptor();

	// Sync confirmed-word set from pi-at-words (live updates; latest wins).
	pi.events.on("at-words:words-updated", (data: unknown) => {
		const words = (data as { words?: unknown } | undefined)?.words;
		if (!Array.isArray(words)) return;
		const alts = words
			.filter(
				(w): w is string =>
					typeof w === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w),
			)
			.sort((a, b) => b.length - a.length)
			.join("|");
		if (!alts) {
			atWordsRe = null;
			return;
		}
		// Single combined pass: mentions + words never nest/corrupt each other's color spans.
		atWordsRe = new RegExp(
			`(?:${AT_WORDS_MENTION_SRC})|(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])`,
			"g",
		);
	});

	// Render the original (untranslated) prompt above the translated user message.
	// STATE entries are appended in the input handler before pi creates the user
	// message entry, so this box lands directly above the translated text. The
	// entry is not part of the LLM context — display only.
	pi.registerEntryRenderer<{ source?: string }>(
		STATE_ENTRY_TYPE,
		(entry, _options, theme) => {
			if (!state.config.showOriginal) return undefined;
			const source = entry.data?.source;
			if (typeof source !== "string" || !source.trim()) return undefined;
			// Theme-driven styling, with pi-at-words pink for confirmed ?words.
			const box = new Box(1, 1, (text) => theme.bg("selectedBg", text));
			box.addChild(
				new Text(
					`${theme.fg("customMessageLabel", "original:")}\n${theme.fg("customMessageText", styleAtWords(source))}`,
				),
			);
			return box;
		},
	);
	pi.on("session_start", (_event, ctx) => {
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
	});

	pi.registerCommand("prompt-translate", {
		description:
			"Translate prompts to English and optionally translate final replies back to the configured language.",
		handler: async (args, ctx) => {
			const config = state.config;
			// "--global" can appear anywhere in the args: the change also persists
			// to the global config file, applying to all future sessions.
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const writeGlobal = tokens.includes("--global");
			const [subcommand, ...rest] = tokens.filter((t) => t !== "--global");
			const persist = () => {
				persistConfig(pi);
				if (writeGlobal) saveGlobalConfig();
			};
			if (!subcommand || subcommand === "status") {
				ctx.ui.notify(await statusText(ctx), "info");
				return;
			}
			if (subcommand === "on" || subcommand === "enable") {
				config.enabled = true;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify(
					`prompt-translate input enabled (target: ${config.targetLanguage})`,
					"info",
				);
				return;
			}
			if (subcommand === "off" || subcommand === "disable") {
				config.enabled = false;
				state.pending = undefined;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify("prompt-translate input disabled", "info");
				return;
			}
			if (["input", "prompt", "prompts"].includes(subcommand)) {
				const value = rest[0];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /prompt-translate input on|off", "warning");
					return;
				}
				config.enabled = value === "on";
				if (!config.enabled) state.pending = undefined;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify(`prompt-translate input ${value}`, "info");
				return;
			}
			if (
				["response", "responses", "answer", "answers", "reply", "replies"].includes(
					subcommand,
				)
			) {
				const value = rest[0];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /prompt-translate responses on|off", "warning");
					return;
				}
				config.translateResponses = value === "on";
				if (state.pending) state.pending.translateResponses = config.translateResponses;
				persist();
				ctx.ui.notify(`prompt-translate responses ${value}`, "info");
				return;
			}
			if (
				subcommand === "lang" ||
				subcommand === "language" ||
				subcommand === "target"
			) {
				const language = normalizeLanguage(rest.join(" "));
				if (!language) {
					ctx.ui.notify("Usage: /prompt-translate lang <language>", "warning");
					return;
				}
				config.targetLanguage = language;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify(
					`prompt-translate target language set to ${language}`,
					"info",
				);
				return;
			}
			if (subcommand === "model") {
				const untilIndex = rest.findIndex(
					(token) => token.toLowerCase() === "until",
				);
				const modelTokens = untilIndex >= 0 ? rest.slice(0, untilIndex) : rest;
				const modelSetting = parseModelSetting(modelTokens.join(" "));
				if (!modelSetting) {
					ctx.ui.notify(
						"Usage: /prompt-translate model current|default|<provider>/<model> [until YYYY-MM-DD]",
						"warning",
					);
					return;
				}
				if (untilIndex >= 0) {
					const untilRaw = rest[untilIndex + 1] ?? "";
					const until = parseUntilDate(untilRaw);
					if (!until) {
						ctx.ui.notify(
							`Invalid "until" date: ${untilRaw || "(missing)"}. Use YYYY-MM-DD.`,
							"warning",
						);
						return;
					}
					if (until.getTime() < Date.now()) {
						ctx.ui.notify(
							`"until" date ${untilRaw} is in the past; keeping ${config.translateModel}.`,
							"warning",
						);
						return;
					}
					config.temporaryModel = modelSetting;
					config.temporaryModelUntil = untilRaw;
					persist();
					updateTranslateStatus(ctx);
					try {
						await resolveConfiguredModel(ctx);
					} catch (error) {
						ctx.ui.notify(
							`warning: ${error instanceof Error ? error.message : String(error)} — fix with /prompt-translate model ... or the fallback to ${config.translateModel} fails silently at translation time`,
							"warning",
						);
					}
					ctx.ui.notify(
						`prompt-translate using ${modelSetting} until ${untilRaw} (inclusive), then falling back to ${config.translateModel}`,
						"info",
					);
					return;
				}
				config.translateModel = modelSetting;
				config.temporaryModel = undefined;
				config.temporaryModelUntil = undefined;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify(
					`prompt-translate translation model set to ${modelSetting}`,
					"info",
				);
				return;
			}
			if (
				subcommand === "think" ||
				subcommand === "thinking" ||
				subcommand === "reason" ||
				subcommand === "reasoning"
			) {
				const value = rest[0];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /prompt-translate think on|off", "warning");
					return;
				}
				config.translateReasoning = value === "on";
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify(
					`prompt-translate thinking ${value}${value === "on" ? " (uses reasoning when the translate model supports it)" : ""}`,
					"info",
				);
				return;
			}
			if (subcommand === "boost") {
				const value = rest[0];
				const level: BoostLevel | undefined =
					value === "on" || value === "boost"
						? "boost"
						: value === "off"
							? "off"
							: value === "plus" || value === "mega"
								? value
								: undefined;
				if (!level) {
					ctx.ui.notify(
						"Usage: /prompt-translate boost off|on|plus|mega — on = faithful clarity edit, plus = imperative + light structure (strict), mega = full restructure into ordered tasks",
						"warning",
					);
					return;
				}
				config.boost = level;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify(
					`prompt-translate boost level: ${level}${
						level === "mega"
							? " (full restructure into ordered imperative tasks; strict — no invented steps)"
							: level === "plus"
								? " (imperative + light structure, strict fidelity)"
								: level === "boost"
									? " (faithful clarity edit, no restructuring)"
									: ""
					}`,
					"info",
				);
				return;
			}
			if (["original", "showoriginal", "source"].includes(subcommand)) {
				const value = rest[0];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /prompt-translate original on|off", "warning");
					return;
				}
				config.showOriginal = value === "on";
				persist();
				ctx.ui.notify(`prompt-translate original prompt display ${value}`, "info");
				return;
			}
			if (subcommand === "balance") {
				const force = rest[0];
				if (force === "refresh") clearBalanceCache();
				await refreshBalanceStatus(ctx);
				const [rate, balance] = await Promise.all([
					getUsdToCzkRate(ctx.signal),
					getOpenRouterBalance(ctx),
				]);
				const lines: string[] = [];
				lines.push(
					`USD→CZK: ${typeof rate === "number" ? rate.toFixed(3) + " (ČNB)" : "n/a"}`,
				);
				if (balance) {
					const czk =
						typeof rate === "number" ? balance.remaining * rate : undefined;
					lines.push(
						`OpenRouter: $${balance.remaining.toFixed(2)}${typeof czk === "number" ? ` (≈ ${czk.toFixed(2)} Kč)` : ""} / $${balance.total.toFixed(2)} credit, used $${balance.used.toFixed(2)}`,
					);
				} else {
					lines.push(
						"OpenRouter: balance unavailable (set OPENROUTER_API_KEY or use an openrouter translate model)",
					);
				}
				ctx.ui.notify(lines.join(" | "), "info");
				return;
			}
			if (subcommand === "debug") {
				const value = rest[0];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /prompt-translate debug on|off", "warning");
					return;
				}
				config.debug = value === "on";
				persist();
				ctx.ui.notify(`prompt-translate debug ${value}`, "info");
				return;
			}
			if (subcommand === "reset") {
				state.config = { ...DEFAULT_CONFIG };
				state.pending = undefined;
				persist();
				updateTranslateStatus(ctx);
				ctx.ui.notify("prompt-translate settings reset", "info");
				return;
			}
			if (subcommand === "help") {
				ctx.ui.notify(
					"/prompt-translate on|off|status|input on|off|responses on|off|lang <language>|model current|default|<provider>/<model> [until YYYY-MM-DD]|think on|off|boost off|on|plus|mega|original on|off|balance [refresh]|debug on|off|global [show|off]|reset — add --global to any subcommand to persist for all sessions",
					"info",
				);
				return;
			}
			if (subcommand === "global") {
				const value = rest[0];
				if (value === "off" || value === "clear") {
					clearGlobalConfig();
					ctx.ui.notify(
						"prompt-translate global config cleared; future sessions use defaults",
						"info",
					);
					return;
				}
				if (!value || value === "show") {
					ctx.ui.notify(
						existsSync(GLOBAL_CONFIG_FILE)
							? `global config: ${JSON.stringify(loadGlobalConfig())}`
							: "no global config file; all sessions use defaults",
						"info",
					);
					return;
				}
				ctx.ui.notify(
					"Usage: /prompt-translate global [show|off] — any subcommand accepts --global to persist for all sessions",
					"warning",
				);
				return;
			}
			ctx.ui.notify("Unknown command. Use: /prompt-translate help", "warning");
		},
	});

	pi.on("input", async (event, ctx) => {
		state.sessionCtx = ctx;
		refreshBalanceStatus(ctx);
		if (!state.config.enabled || event.source === "extension" || event.images?.length) {
			return { action: "continue" };
		}
		// /goal commands: translate only the objective text, keep the command
		// scaffold (subcommand, --tokens budget) intact. Normally unreachable
		// (extension commands dispatch before the input event); the
		// AgentSession.prompt interceptor above handles /goal instead. Kept as a
		// fallback, with a guard against double-translating the interceptor's output.
		const goalCommand = extractGoalObjective(event.text);
		let textToTranslate: string;
		let rebuild: ((translated: string) => string) | undefined;
		if (goalCommand) {
			if (!goalCommand.objective) return { action: "continue" };
			if (
				state.lastGoalTransform &&
				event.text === state.lastGoalTransform.to &&
				Date.now() - state.lastGoalTransform.at < 30_000
			) {
				return { action: "continue" };
			}
			textToTranslate = goalCommand.objective;
			rebuild = goalCommand.rebuild;
		} else {
			if (event.text.trim().startsWith("/")) {
				return { action: "continue" };
			}
			textToTranslate = event.text;
		}

		try {
			const translated = await translate(
				ctx,
				textToTranslate,
				"English",
				"prompt",
			);
			if (ctx.hasUI)
				ctx.ui.notify(
					`prompt-translate: prompt → EN ${formatCost(translated.costUsd, translated.costCzk)}`,
					"info",
				);
			state.pending = {
				targetLanguage: state.config.targetLanguage,
				translateResponses: state.config.translateResponses,
			};
			pi.appendEntry(STATE_ENTRY_TYPE, {
				at: new Date().toISOString(),
				source: event.text,
				english: rebuild ? rebuild(translated.text) : translated.text,
				targetLanguage: state.config.targetLanguage,
				translateModel: getEffectiveTranslateModel().setting,
				usage: translated.usage,
			});
			return {
				action: "transform",
				text: rebuild ? rebuild(translated.text) : translated.text,
			};
		} catch (error) {
			ctx.ui.notify(
				`prompt translation failed; continuing with original prompt: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "continue" };
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Refresh the status segment every turn so "current" model stays in sync.
		updateTranslateStatus(ctx);
		if (!state.pending) return;
		debug(
			ctx,
			state.pending.translateResponses
				? "forcing agent run language to English; final briefing will be translated after completion"
				: "forcing agent run language to English; final briefing translation is disabled",
		);
		return {
			systemPrompt: appendEnglishOnlyInstruction(
				event.systemPrompt,
				state.pending.translateResponses,
			),
		};
	});

	pi.on("context", (event) => {
		if (!state.config.enabled || finalTranslationByDisplayedText.size === 0) return;
		const messages = event.messages.map(replaceDisplayedAssistantTextWithEnglish);
		if (messages.some((message, index) => message !== event.messages[index]))
			return { messages };
	});

	pi.on("turn_start", (event) => {
		if (state.pending && state.pending.turnIndex === undefined)
			state.pending.turnIndex = event.turnIndex;
	});

	pi.on("message_end", async (event, ctx) => {
		if (!state.pending || event.message.role !== "assistant") return;
		// goal_complete / goal_blocked / goal_wait end the goal run: pi-goal sends no
		// further assistant message afterwards, so the text riding alongside that tool
		// call IS the final briefing. Translate it despite the tool call.
		const toolNames = event.message.content
			.filter((part): part is ToolCall => part.type === "toolCall")
			.map((part) => part.name);
		const goalTerminal = toolNames.some(
			(name) =>
				name === "goal_complete" || name === "goal_blocked" || name === "goal_wait",
		);
		// Do not translate ordinary tool-calling assistant messages. Keep the pending
		// translation request alive so the final work briefing after tool execution is translated.
		if (
			!goalTerminal &&
			(event.message.stopReason === "toolUse" || toolNames.length > 0)
		)
			return;

		const finalText = getText(event.message);
		if (!finalText.trim()) return;

		const current = state.pending;
		state.pending = undefined;
		if (!current.translateResponses) return;

		try {
			const translated = await translate(
				ctx,
				finalText,
				current.targetLanguage,
				"answer",
			);
			rememberFinalTranslation(pi, {
				at: new Date().toISOString(),
				targetLanguage: current.targetLanguage,
				english: finalText.trim(),
				translated: translated.text,
				translateModel: getEffectiveTranslateModel().setting,
				usage: translated.usage,
			});
			if (ctx.hasUI)
				ctx.ui.notify(
					`prompt-translate: reply → ${current.targetLanguage} ${formatCost(translated.costUsd, translated.costCzk)}`,
					"info",
				);
			refreshBalanceStatus(ctx);
			return { message: withSingleText(event.message, translated.text) };
		} catch (error) {
			ctx.ui.notify(
				`answer translation failed; keeping original answer: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});
}
