import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { getEffectiveTranslateModel } from "./config.js";
import {
	getFinalTranslationMap,
	rememberFinalTranslation,
	replaceDisplayedAssistantTextWithEnglish,
	styleAtWords,
} from "./display.js";
import { extractGoalObjective } from "./goal.js";
import { state } from "./state.js";
import {
	debug,
	formatConfirmationBody,
	formatCost,
	refreshBalanceStatus,
	updateTranslateStatus,
} from "./status.js";
import { appendEnglishOnlyInstruction } from "./prompts.js";
import {
	detectLanguageOrCode,
	extractRecentContext,
	getText,
	hasDeicticReferences,
	translate,
	withSingleText,
} from "./translate.js";
import { STATE_ENTRY_TYPE } from "./types.js";

export function registerAgentHooks(
	pi: ExtensionAPI,
	track: (result: unknown) => void,
): void {
	track(pi.on("input", async (event, ctx) => {
		state.sessionCtx = ctx;
		refreshBalanceStatus(ctx);
		if (
			!state.config.enabled ||
			event.source === "extension" ||
			event.images?.length
		) {
			return { action: "continue" };
		}

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

		if (state.config.autodetect && state.config.boost === "off") {
			const detection = detectLanguageOrCode(textToTranslate);
			if (detection.isEnglishOrCode) {
				debug(ctx, `skipped translation: prompt detected as ${detection.reason}`);
				state.pending = {
					targetLanguage: state.config.targetLanguage,
					translateResponses: state.config.translateResponses,
				};
				return { action: "continue" };
			}
		}

		let conversationContext: string | undefined;
		if (state.config.historyMode === "always") {
			conversationContext = extractRecentContext(ctx);
		} else if (state.config.historyMode === "auto") {
			if (hasDeicticReferences(textToTranslate)) {
				conversationContext = extractRecentContext(ctx);
				if (conversationContext) {
					debug(
						ctx,
						"auto-detected reference words; attached conversation context to translator",
					);
				}
			}
		} else if (state.config.historyMode === "ask" && ctx.hasUI) {
			const candidate = extractRecentContext(ctx);
			if (candidate) {
				const choice = await ctx.ui.select(
					"Kontext překladu: Připojit nedávnou historii konverzace k překladu?",
					[
						"Ne (výchozí — bez historie konverzace)",
						"Ano (připojit nedávnou historii konverzace)",
					],
				);
				if (choice?.startsWith("Ano")) {
					conversationContext = candidate;
					debug(ctx, "user confirmed attaching conversation context to translator");
				}
			}
		}

		if (conversationContext) {
			debug(
				ctx,
				`attached conversation context to translator:\n${conversationContext}`,
			);
		}

		try {
			const translated = await translate(
				ctx,
				textToTranslate,
				"English",
				"prompt",
				conversationContext,
			);
			const histBadge = conversationContext ? " [with history]" : "";
			if (ctx.hasUI) {
				ctx.ui.notify(
					`prompt-translate: prompt → EN${histBadge} ${formatCost(translated.costUsd, translated.costCzk)}`,
					"info",
				);
			}
			state.pending = {
				targetLanguage: state.config.targetLanguage,
				translateResponses: state.config.translateResponses,
			};
			const englishText = rebuild ? rebuild(translated.text) : translated.text;

			if (state.config.confirm && ctx.hasUI) {
				const promptPreview =
					event.text.length > 500 ? `${event.text.slice(0, 500)}…` : event.text;
				const transPreview =
					englishText.length > 500 ? `${englishText.slice(0, 500)}…` : englishText;
				const confirmationBody = formatConfirmationBody({
					source: promptPreview,
					english: transPreview,
					boost: state.config.boost,
					conversationContext,
					usage: translated.usage,
					costUsd: translated.costUsd,
					costCzk: translated.costCzk,
					styleSource: styleAtWords,
				});
				const confirmed = await ctx.ui.confirm(
					"Potvrdit překlad promptu",
					confirmationBody,
				);
				if (!confirmed) {
					ctx.ui.notify(
						"Překlad zamítnut; odesílám původní text bez překladu",
						"warning",
					);
					return { action: "continue" };
				}
			}

			pi.appendEntry(STATE_ENTRY_TYPE, {
				at: new Date().toISOString(),
				source: event.text,
				english: englishText,
				targetLanguage: state.config.targetLanguage,
				translateModel: getEffectiveTranslateModel().setting,
				boost: state.config.boost,
				usage: translated.usage,
				costUsd: translated.costUsd,
				costCzk: translated.costCzk,
				conversationContext,
			});
			return {
				action: "transform",
				text: englishText,
			};
		} catch (error) {
			ctx.ui.notify(
				`prompt translation failed; continuing with original prompt: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "continue" };
		}
	}));

	track(pi.on("before_agent_start", (event, ctx) => {
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
	}));

	track(pi.on("context", (event) => {
		const finalMap = getFinalTranslationMap();
		if (!state.config.enabled || finalMap.size === 0) return;
		const messages = event.messages.map(replaceDisplayedAssistantTextWithEnglish);
		if (messages.some((message, index) => message !== event.messages[index])) {
			return { messages };
		}
	}));

	track(pi.on("turn_start", (event) => {
		if (state.pending && state.pending.turnIndex === undefined) {
			state.pending.turnIndex = event.turnIndex;
		}
	}));

	track(pi.on("message_end", async (event, ctx) => {
		if (!state.pending || event.message.role !== "assistant") return;

		const toolNames = event.message.content
			.filter((part): part is ToolCall => part.type === "toolCall")
			.map((part) => part.name);
		const goalTerminal = toolNames.some(
			(name) =>
				name === "goal_complete" || name === "goal_blocked" || name === "goal_wait",
		);

		if (
			!goalTerminal &&
			(event.message.stopReason === "toolUse" || toolNames.length > 0)
		) {
			return;
		}

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
			if (ctx.hasUI) {
				ctx.ui.notify(
					`prompt-translate: reply → ${current.targetLanguage} ${formatCost(translated.costUsd, translated.costCzk)}`,
					"info",
				);
			}
			refreshBalanceStatus(ctx);
			return { message: withSingleText(event.message, translated.text) };
		} catch (error) {
			ctx.ui.notify(
				`answer translation failed; keeping original answer: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}));
}
