/**
 * The translation pipeline: builds the request, calls the model, retries transient
 * failures and returns the translated text with usage and cost.
 *
 * The surrounding pieces live in sibling modules (protection, context, language
 * detection, message helpers); this module re-exports them so existing importers —
 * including the tests — keep working unchanged.
 */
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	TRANSLATE_REASONING_BUDGET,
	TRANSLATE_REASONING_LEVEL,
	getEffectiveTranslateModel,
	getModelAndAuth,
	modelLabel,
} from "./config";
import { getUsdToCzkRate } from "./balance";
import { debug, formatUsage, updateTranslateStatus } from "./status";
import { state } from "./state";
import type { ExtensionContextWithCompleteSimple, ModelWithAuth, TranslationResult } from "./types";
import {
	PROMPT_BOOST_SYSTEM_PROMPT,
	PROMPT_MEGA_SYSTEM_PROMPT,
	PROMPT_PLUS_SYSTEM_PROMPT,
	PROMPT_TRANSLATE_SYSTEM_PROMPT,
} from "./prompts";
import { protectPromptSegments, protectFinalAnswerSegments, restoreProtectedSegments, cleanTranslationOutput } from "./translate-protect.js";
import { buildEffectiveHeaders, createTranslationContext, isTransientError } from "./translate-context.js";
import { getText, estimateTranslationMaxTokens } from "./translate-text.js";

// Re-exported so every existing importer keeps working unchanged.
export { detectLanguageOrCode } from "./translate-language.js";
export { protectPromptSegments, protectFinalAnswerSegments, restoreProtectedSegments, cleanTranslationOutput } from "./translate-protect.js";
export { buildEffectiveHeaders, hasDeicticReferences, extractRecentContext, createTranslationContext } from "./translate-context.js";
export { getText, hasToolCall, withSingleText, estimateTranslationMaxTokens } from "./translate-text.js";

export async function translate(
	ctx: ExtensionContext,
	text: string,
	targetLanguage: string,
	purpose: "prompt" | "answer",
	conversationContext?: string,
): Promise<TranslationResult> {
	const config = state.config;
	// Resolve the translate model; when a temporary override is broken (not found,
	// no auth, ...), fall back to the base model instead of failing the translation.
	let modelAuth: ModelWithAuth;
	try {
		modelAuth = await getModelAndAuth(ctx);
	} catch (error) {
		const effective = getEffectiveTranslateModel().setting;
		if (effective === config.translateModel) throw error;
		modelAuth = await getModelAndAuth(ctx, config.translateModel);
		if (ctx.hasUI)
			ctx.ui.notify(
				`prompt-translate: ${error instanceof Error ? error.message : String(error)} — fell back to ${config.translateModel}`,
				"warning",
			);
	}
	const { model, apiKey, headers, env } = modelAuth;
	const czkRate = await getUsdToCzkRate(ctx.signal);
	debug(ctx, `${purpose} translation with ${modelLabel(model)}`);

	const protectedInput =
		purpose === "answer"
			? protectFinalAnswerSegments(text)
			: purpose === "prompt"
				? protectPromptSegments(text)
				: { text, segments: [] };
	const systemPrompt =
		purpose === "prompt"
			? config.boost === "mega"
				? PROMPT_MEGA_SYSTEM_PROMPT
				: config.boost === "plus"
					? PROMPT_PLUS_SYSTEM_PROMPT
					: config.boost === "boost"
						? PROMPT_BOOST_SYSTEM_PROMPT
						: PROMPT_TRANSLATE_SYSTEM_PROMPT
			: [
					`Translate the text inside <source_text> to ${targetLanguage}. Output ONLY the translation.`,
					"Do not wrap your output in <source_text> tags, and do not add commentary.",
					"Keep code, paths, commands, flags, markdown, URLs, JSON, placeholders, XML-like tags, machine-readable sections, and protected tokens unchanged.",
					"Never alter, translate, remove, or add content inside placeholders like __PI_PROMPT_TRANSLATE_PROTECTED_0__.",
				].join("\n");

	const llmContext = createTranslationContext(
		systemPrompt,
		protectedInput.text,
		conversationContext,
	);
	const thinkOn = config.translateReasoning && model.reasoning === true;
	const sessionId = ctx.sessionManager.getSessionId();
	const effectiveHeaders = buildEffectiveHeaders(
		model.provider,
		sessionId,
		headers,
	);
	const makeOptions = (
		reasoning: ThinkingLevel | undefined,
	): SimpleStreamOptions & { reasoningEffort?: ThinkingLevel } => ({
		apiKey,
		headers: effectiveHeaders,
		env,
		maxTokens: estimateTranslationMaxTokens(
			model,
			protectedInput.text,
			!!reasoning,
		),
		reasoning,
		reasoningEffort: reasoning,
		thinkingBudgets: reasoning ? TRANSLATE_REASONING_BUDGET : undefined,
		signal: ctx.signal,
		sessionId,
	});
	const instrumentedCompleteSimple = (ctx as ExtensionContextWithCompleteSimple)
		.completeSimple;
	const shouldUseInstrumentedTranslation =
		purpose === "prompt" && instrumentedCompleteSimple;
	const makeDoCall =
		(reasoning: ThinkingLevel | undefined) =>
		async (): Promise<AssistantMessage> => {
			const opts = makeOptions(reasoning);
			try {
				if (shouldUseInstrumentedTranslation) {
					return await instrumentedCompleteSimple(model, llmContext, {
						...opts,
						trace: {
							name: "prompt-translation",
							extension: "pi-prompt-translate",
							purpose,
							metadata: { targetLanguage },
						},
					});
				}
				const registry = ctx.modelRegistry as
					| {
							completeSimple?: (
								model: Model<Api>,
								context: Context,
								options?: SimpleStreamOptions,
							) => Promise<AssistantMessage>;
							complete?: (
								model: Model<Api>,
								context: Context,
								options?: unknown,
							) => Promise<AssistantMessage>;
					  }
					| undefined;
				if (registry && typeof registry.completeSimple === "function") {
					return await registry.completeSimple(model, llmContext, opts);
				}
				if (registry && typeof registry.complete === "function") {
					return await registry.complete(model, llmContext, opts);
				}
				return await completeSimple(model, llmContext, opts);
			} catch (error) {
				return {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
			}
		};

	let currentReasoning: ThinkingLevel | undefined = thinkOn
		? TRANSLATE_REASONING_LEVEL
		: undefined;
	let response = await makeDoCall(currentReasoning)();

	if (
		(response.stopReason === "error" || response.stopReason === "aborted") &&
		isTransientError(response.errorMessage)
	) {
		debug(ctx, "transient translation error; retrying once in 1s");
		await new Promise((r) => setTimeout(r, 1000));
		response = await makeDoCall(currentReasoning)();
	}

	const errMsg = response.errorMessage ?? "";
	const isMandatoryReasoningError =
		/reasoning is mandatory|mandatory.*reasoning|reasoning.*cannot be disabled/i.test(
			errMsg,
		);

	// If provider requires reasoning but we called without (or reasoning was stripped)
	if (
		(response.stopReason === "error" || response.stopReason === "aborted") &&
		isMandatoryReasoningError
	) {
		debug(
			ctx,
			"translation error: reasoning mandatory; retrying with thinking on",
		);
		currentReasoning = TRANSLATE_REASONING_LEVEL;
		response = await makeDoCall(currentReasoning)();
	} else if (
		currentReasoning &&
		(response.stopReason === "error" || response.stopReason === "aborted") &&
		/thinking|max_?tokens|unsupported.*reasoning|invalid.*reasoning|bad request|400/i.test(
			errMsg,
		) &&
		!isMandatoryReasoningError
	) {
		debug(ctx, "translation error with thinking on; retrying without thinking");
		currentReasoning = undefined;
		response = await makeDoCall(currentReasoning)();
	}

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(
			response.errorMessage ?? `Translation failed: ${response.stopReason}`,
		);
	}
	debug(
		ctx,
		`${purpose} translation usage: ${formatUsage(response.usage, czkRate)}`,
	);
	const cleanedOutput = cleanTranslationOutput(getText(response).trim());
	const translatedText = restoreProtectedSegments(
		cleanedOutput,
		protectedInput.segments,
	);
	const costUsd =
		typeof response.usage.cost?.total === "number"
			? response.usage.cost.total
			: undefined;
	const costCzk =
		typeof costUsd === "number" && typeof czkRate === "number" && czkRate > 0
			? costUsd * czkRate
			: undefined;
	if (typeof costUsd === "number") {
		state.sessionCostUsd += costUsd;
		updateTranslateStatus(ctx);
	}

	// Record telemetry & optimization statistics
	state.telemetry.totalRequests++;
	if (purpose === "prompt") {
		state.telemetry.promptRequests++;
	} else {
		state.telemetry.answerRequests++;
	}
	if (model.provider === "openrouter") {
		state.telemetry.openRouterRequests++;
	}
	const cacheRead = response.usage.cacheRead ?? 0;
	const cacheWrite = response.usage.cacheWrite ?? 0;
	if (cacheRead > 0) {
		state.telemetry.cachedTokens += cacheRead;
		state.telemetry.cacheHitTurns++;
		const inputRate = model.cost?.input ?? 0;
		const cacheReadRate = model.cost?.cacheRead ?? inputRate * 0.1;
		const savedTurnUsd = cacheRead * Math.max(0, inputRate - cacheReadRate);
		state.telemetry.savedCostUsd += savedTurnUsd;
	}
	if (cacheWrite > 0) {
		state.telemetry.cacheWriteTokens += cacheWrite;
	}
	return { text: translatedText, usage: response.usage, costUsd, costCzk };
}
