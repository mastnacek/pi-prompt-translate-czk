// translate.ts — the translation engine: model call, retry/fallback policy,
// protected XML segments, message text helpers.

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingLevel,
	ToolCall,
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
import type {
	ExtensionContextWithCompleteSimple,
	ModelWithAuth,
	ProtectedSegment,
	ProtectedText,
	TranslationResult,
} from "./types";
import {
	PROMPT_BOOST_SYSTEM_PROMPT,
	PROMPT_MEGA_SYSTEM_PROMPT,
	PROMPT_PLUS_SYSTEM_PROMPT,
	PROMPT_TRANSLATE_SYSTEM_PROMPT,
} from "./prompts";

export function getText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function hasToolCall(message: AssistantMessage): boolean {
	return message.content.some(
		(part): part is ToolCall => part.type === "toolCall",
	);
}

export function withSingleText(
	message: AssistantMessage,
	text: string,
): AssistantMessage {
	const nextContent = message.content.filter((part) => part.type !== "text");
	return {
		...message,
		content: [...nextContent, { type: "text", text }],
	};
}

export function estimateTranslationMaxTokens(
	model: Model<Api>,
	text: string,
	reasoning = false,
): number {
	// Reasoning + answer share the max_tokens budget on most providers. Reserve
	// headroom for thinking when enabled so the actual translation isn't truncated.
	const hardCap = reasoning ? 16000 : 8192;
	const modelLimit = Math.max(1, Math.min(model.maxTokens ?? 4096, hardCap));
	const reasonBudget = reasoning
		? (TRANSLATE_REASONING_BUDGET[TRANSLATE_REASONING_LEVEL] ?? 640)
		: 0;
	const estimatedOutput = Math.ceil(text.length / 2) + 96 + reasonBudget;
	return Math.max(64, Math.min(modelLimit, estimatedOutput));
}

function shouldProtectTagName(tagName: string): boolean {
	const normalized = tagName.toLowerCase();
	return normalized.includes("action") || normalized === "pi-autoprompt-next";
}

export function protectPromptSegments(
	text: string,
	knownWords: string[] = state.atWords,
): ProtectedText {
	const segments: ProtectedSegment[] = [];
	let protectedText = text;
	const addSegment = (value: string) => {
		const placeholder = `__PI_PROMPT_TRANSLATE_PROTECTED_${segments.length}__`;
		segments.push({ placeholder, value });
		return placeholder;
	};

	// 1. Protect pi-read-all headers if present
	protectedText = protectedText.replace(
		/\[pi-read-all\]:[^\n]*\n*/g,
		(match) => addSegment(match),
	);

	// 2. Protect any <file ...>...</file>, <context>...</context>, <document>...</document>, <code ...>...</code>
	protectedText = protectedText.replace(
		/<(file|context|document|code|snippet)\b[^>]*>[\s\S]*?<\/\1>/gi,
		(match) => addSegment(match),
	);

	// 3. Protect multi-line markdown code blocks and inline code
	protectedText = protectedText.replace(
		/```[\s\S]*?```/g,
		(match) => addSegment(match),
	);
	protectedText = protectedText.replace(
		/`[^`\n]+`/g,
		(match) => addSegment(match),
	);

	// 4. Protect @! trigger paths (pi-read-all)
	protectedText = protectedText.replace(
		/@!"[^"\n]+"|@![^\s"(){}[\];,]+/g,
		(match) => addSegment(match),
	);

	// 5. Protect standard @ file mentions (@src/file.ts, @"quoted file.ts")
	protectedText = protectedText.replace(
		/@"[^"\n]+"|@[\w][\w./-]*/g,
		(match) => addSegment(match),
	);

	// 6. Protect ? symbol queries (?myFunc, ?varName from pi-at-words)
	protectedText = protectedText.replace(
		/(?<=[ \t([{]|^)\?[A-Za-z0-9_]{2,}/g,
		(match) => addSegment(match),
	);

	// 7. Protect confirmed ?words / symbols from @-mentioned files
	if (knownWords && knownWords.length > 0) {
		const alts = [...knownWords]
			.filter(
				(w): w is string =>
					typeof w === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w),
			)
			.sort((a, b) => b.length - a.length)
			.join("|");
		if (alts) {
			const re = new RegExp(
				`(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])`,
				"g",
			);
			protectedText = protectedText.replace(re, (match) => addSegment(match));
		}
	}

	return { text: protectedText, segments };
}

export function protectFinalAnswerSegments(text: string): ProtectedText {
	const segments: ProtectedSegment[] = [];
	let protectedText = text;
	const addSegment = (value: string) => {
		const placeholder = `__PI_PROMPT_TRANSLATE_PROTECTED_${segments.length}__`;
		segments.push({ placeholder, value });
		return placeholder;
	};

	protectedText = protectedText.replace(
		/<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g,
		(match, tagName: string) =>
			shouldProtectTagName(tagName) ? addSegment(match) : match,
	);
	protectedText = protectedText.replace(
		/<([A-Za-z][\w:-]*)\b[^>]*\/>/g,
		(match, tagName: string) =>
			shouldProtectTagName(tagName) ? addSegment(match) : match,
	);

	return { text: protectedText, segments };
}

export function restoreProtectedSegments(
	text: string,
	segments: ProtectedSegment[],
): string {
	let restored = text;
	for (const segment of segments) {
		restored = restored.split(segment.placeholder).join(segment.value);
	}
	return restored;
}

export function createTranslationContext(
	systemPrompt: string,
	text: string,
): Context {
	return {
		systemPrompt,
		// Omit volatile timestamps from translation-only requests to improve provider prompt-cache hits.
		messages: [{ role: "user", content: text } as never],
		tools: undefined,
	};
}

// Retry-worthy errors: rate limits, server errors, network/timeouts. Not 400 (e.g. mandatory reasoning).
function isTransientError(msg?: string): boolean {
	if (!msg) return true;
	return /(429|5\d\d|overload|rate.?limit|timeout|timed out|temporar|econnreset|etimedout|unavailable)/i.test(
		msg,
	);
}

const CZECH_SLOVAK_DIACRITICS_RE =
	/[áčďéěíňóřšťúůýžľĺŕôäöüßąćęłńśźżàâçèéêëîïôùûüÿñáéíóúÁČĎÉĚÍŇÓŘŠŤÚŮÝŽĽĹŔÔÄÖÜẞĄĆĘŁŃŚŹŻÀÂÇÈÉÊËÎÏÔÙÛÜŸÑÁÉÍÓÚ]/;

const CZECH_ASCII_WORDS = new Set([
	"ahoj",
	"cau",
	"prosim",
	"dekuji",
	"diky",
	"jak",
	"proc",
	"kde",
	"kdy",
	"kdo",
	"co",
	"chci",
	"potrebuji",
	"udelat",
	"udelej",
	"oprav",
	"opravit",
	"vytvor",
	"vytvorit",
	"napis",
	"napiste",
	"najdi",
	"hledej",
	"zkus",
	"zkuste",
	"muzes",
	"muzete",
	"pro",
	"nebo",
	"takze",
	"protoze",
	"kter",
	"ktera",
	"ktere",
	"ktery",
	"ktereho",
	"kterou",
	"tento",
	"tato",
	"toto",
	"tyto",
	"sem",
	"tam",
	"jeste",
	"uz",
	"vse",
	"vsechno",
	"soubor",
	"soubory",
	"funkce",
	"trida",
	"kod",
	"chyba",
	"chybu",
	"funguje",
	"nefunguje",
	"prikaz",
	"spust",
	"smaz",
	"pridej",
	"uprav",
	"zmen",
	"zobraz",
	"ukaz",
	"vypis",
	"podle",
	"zadost",
	"ukol",
	"vyres",
	"zkontroluj",
	"nainstaluj",
	"preloz",
	"preklad",
]);

const ENGLISH_COMMON_WORDS = new Set([
	"the",
	"be",
	"to",
	"of",
	"and",
	"a",
	"in",
	"that",
	"have",
	"i",
	"it",
	"for",
	"not",
	"on",
	"with",
	"he",
	"as",
	"you",
	"do",
	"at",
	"this",
	"but",
	"his",
	"by",
	"from",
	"they",
	"we",
	"say",
	"her",
	"she",
	"or",
	"an",
	"will",
	"my",
	"one",
	"all",
	"would",
	"there",
	"their",
	"what",
	"so",
	"up",
	"out",
	"if",
	"about",
	"who",
	"get",
	"which",
	"go",
	"me",
	"when",
	"make",
	"can",
	"like",
	"time",
	"no",
	"just",
	"him",
	"know",
	"take",
	"people",
	"into",
	"year",
	"your",
	"good",
	"some",
	"could",
	"them",
	"see",
	"other",
	"than",
	"then",
	"now",
	"look",
	"only",
	"come",
	"its",
	"over",
	"think",
	"also",
	"back",
	"after",
	"use",
	"two",
	"how",
	"our",
	"work",
	"first",
	"well",
	"way",
	"even",
	"new",
	"want",
	"because",
	"any",
	"these",
	"give",
	"day",
	"most",
	"us",
	"is",
	"are",
	"was",
	"were",
	"been",
	"has",
	"had",
	"does",
	"did",
	"please",
	"fix",
	"create",
	"write",
	"implement",
	"update",
	"refactor",
	"test",
	"build",
	"run",
	"check",
	"remove",
	"add",
	"delete",
	"show",
	"find",
	"search",
	"replace",
	"modify",
	"file",
	"files",
	"function",
	"class",
	"code",
	"bug",
	"error",
	"issue",
	"prompt",
	"review",
]);

export function detectLanguageOrCode(text: string): {
	isEnglishOrCode: boolean;
	reason: string;
} {
	const trimmed = text.trim();
	if (!trimmed) return { isEnglishOrCode: true, reason: "empty" };

	// 1. Slash commands, shell/repl prefixes
	if (
		trimmed.startsWith("/") ||
		trimmed.startsWith("$ ") ||
		trimmed.startsWith("> ") ||
		trimmed.startsWith("#!")
	) {
		return { isEnglishOrCode: true, reason: "command_or_script" };
	}

	// 2. Code blocks (```...```) or pure structured formats (JSON, diff)
	if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
		return { isEnglishOrCode: true, reason: "code_block" };
	}
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			JSON.parse(trimmed);
			return { isEnglishOrCode: true, reason: "json" };
		} catch {
			/* not valid json */
		}
	}
	if (
		trimmed.startsWith("diff --git") ||
		(trimmed.includes("--- a/") && trimmed.includes("+++ b/"))
	) {
		return { isEnglishOrCode: true, reason: "git_diff" };
	}

	// 3. Czech / Slovak / European non-English diacritics
	if (CZECH_SLOVAK_DIACRITICS_RE.test(trimmed)) {
		return { isEnglishOrCode: false, reason: "diacritics" };
	}

	// 4. Tokenize words
	const words = trimmed
		.toLowerCase()
		.split(/[^a-zA-Z]+/)
		.filter((w) => w.length > 1);
	if (words.length === 0) {
		return { isEnglishOrCode: true, reason: "symbols_only" };
	}

	let czechCount = 0;
	let englishCount = 0;
	for (const w of words) {
		if (CZECH_ASCII_WORDS.has(w)) czechCount++;
		if (ENGLISH_COMMON_WORDS.has(w)) englishCount++;
	}

	if (czechCount > 0 && czechCount >= englishCount) {
		return { isEnglishOrCode: false, reason: "czech_ascii_words" };
	}
	if (englishCount > 0 && englishCount >= czechCount) {
		return { isEnglishOrCode: true, reason: "english_detected" };
	}

	// 5. Code syntax indicators (keywords, imports, declarations)
	const codeIndicators =
		/[{}();=><!&|]|\b(import|export|const|let|var|function|class|return|def|fn|pub|struct|impl|async|await|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE)\b/;
	if (codeIndicators.test(trimmed)) {
		return { isEnglishOrCode: true, reason: "code_syntax" };
	}

	return { isEnglishOrCode: false, reason: "default" };
}

export async function translate(
	ctx: ExtensionContext,
	text: string,
	targetLanguage: string,
	purpose: "prompt" | "answer",
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
					`Translate to ${targetLanguage}. Output only the translation.`,
					"Keep code, paths, commands, markdown, JSON, placeholders, XML-like tags, machine-readable sections, and protected tokens unchanged.",
					"Never alter, translate, remove, or add content inside placeholders like __PI_PROMPT_TRANSLATE_PROTECTED_0__.",
				].join("\n");

	const llmContext = createTranslationContext(systemPrompt, protectedInput.text);
	const thinkOn = config.translateReasoning && model.reasoning === true;
	const makeOptions = (
		reasoning: ThinkingLevel | undefined,
	): SimpleStreamOptions & { reasoningEffort?: ThinkingLevel } => ({
		apiKey,
		headers,
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
		sessionId: ctx.sessionManager.getSessionId(),
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
	const translatedText = restoreProtectedSegments(
		getText(response).trim(),
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
	return { text: translatedText, usage: response.usage, costUsd, costCzk };
}
