import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingLevel,
	ToolCall,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	getAgentDir,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	appendEnglishOnlyInstruction,
	buildEnglishOnlyInstruction,
	ENGLISH_ONLY_AGENT_INSTRUCTION,
	PROMPT_BOOST_SYSTEM_PROMPT,
	PROMPT_MEGA_SYSTEM_PROMPT,
	PROMPT_PLUS_SYSTEM_PROMPT,
	PROMPT_TRANSLATE_SYSTEM_PROMPT,
} from "./prompts";

const CONFIG_ENTRY_TYPE = "pi-prompt-translate-config";
const STATE_ENTRY_TYPE = "pi-prompt-translate-state";
const FINAL_TRANSLATION_ENTRY_TYPE = "pi-prompt-translate-final-translation";

type TranslateModelSetting = "current" | "default" | `${string}/${string}`;

/** Prompt enhancement level: "off" = plain translation, "boost" = faithful clarity
 *  edit, "plus" = imperative + light structure with strict fidelity,
 *  "mega" = full restructure into imperative, ordered tasks. */
type BoostLevel = "off" | "boost" | "plus" | "mega";

type TranslateConfig = {
	enabled: boolean;
	translateResponses: boolean;
	targetLanguage: string;
	translateModel: TranslateModelSetting;
	/** Optional temporary model override, active until `temporaryModelUntil` (inclusive),
	 *  then automatically falls back to `translateModel`. */
	temporaryModel?: TranslateModelSetting;
	/** ISO date (YYYY-MM-DD). The temporary model is used through the end of this day. */
	temporaryModelUntil?: string;
	/** Toggle thinking/reasoning for the translate model (only honored when the model supports it). */
	translateReasoning: boolean;
	/** Prompt enhancement level applied while translating (single LLM call).
	 *  "boost" = light faithful clarity edit, "mega" = restructure into ordered tasks. */
	boost: BoostLevel;
	/** When on, the original (untranslated) prompt is rendered above the translated
	 *  user message in a box with a distinct background color. */
	showOriginal: boolean;
	debug: boolean;
};

type PendingTranslation = {
	turnIndex?: number;
	targetLanguage: string;
	translateResponses: boolean;
};

type TranslationUsage = AssistantMessage["usage"];

type TranslationResult = {
	text: string;
	usage: TranslationUsage;
	costUsd?: number;
	costCzk?: number;
};

type ProtectedSegment = {
	placeholder: string;
	value: string;
};

type ProtectedText = {
	text: string;
	segments: ProtectedSegment[];
};

type FinalTranslationRecord = {
	at: string;
	targetLanguage: string;
	english: string;
	translated: string;
	translateModel: TranslateModelSetting;
	usage?: TranslationUsage;
};

type ModelWithAuth = {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

type ExtensionGenerationTraceOptions = {
	name?: string;
	extension?: string;
	purpose?: string;
	metadata?: Record<string, unknown>;
};

type InstrumentedCompleteSimpleOptions = SimpleStreamOptions & {
	trace?: ExtensionGenerationTraceOptions;
};

type InstrumentedCompleteSimple = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: InstrumentedCompleteSimpleOptions,
) => Promise<AssistantMessage>;

type ExtensionContextWithCompleteSimple = ExtensionContext & {
	completeSimple?: InstrumentedCompleteSimple;
};

// --- CZK conversion (ČNB) + OpenRouter account balance ---
const CNB_DAILY_URL = "https://api.cnb.cz/cnbapi/exrates/daily?lang=EN";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const BALANCE_TTL_MS = 5 * 60 * 1000;
const STATE_STATUS_KEY = "prompt-translate-state";
const FRANKFURTER_URL =
	"https://api.frankfurter.dev/v1/latest?base=USD&symbols=CZK";

let fxCache: { rate: number; date: string } | undefined;
let balanceCache: { info: BalanceInfo; ts: number } | undefined;
let sessionCostUsd = 0;

type BalanceInfo = { remaining: number; total: number; used: number };

// --- pi-at-words integration ------------------------------------------------
// Pink highlight for confirmed ?words (owned by pi-at-words). Word set arrives
// via the shared extension event bus; plugin absent = no-op passthrough.
const AT_WORDS_PINK = "\x1b[1m\x1b[38;2;255;95;215m";
const AT_WORDS_PINK_OFF = "\x1b[22m\x1b[39m";
// Mention paths (`@src/foo.ts`, `@"quoted path"`) — same source pattern as pi-at-words.
const AT_WORDS_MENTION_SRC = String.raw`@"[^"\n]+"|@[\w][\w./-]*`;
let atWordsRe: RegExp | null = null;

function pinkAtWords(text: string): string {
	if (atWordsRe === null) return text;
	return text.replace(
		atWordsRe,
		(m) => `${AT_WORDS_PINK}${m}${AT_WORDS_PINK_OFF}`,
	);
}

// Soft amber ANSI — distinct (money) but not harsh; dark-theme friendly.
const ANSI_AMBER = "\x1b[38;2;218;165;32m";
const ANSI_RESET = "\x1b[0m";
function amber(text: string): string {
	return `${ANSI_AMBER}${text}${ANSI_RESET}`;
}

// Dark-theme-friendly palette for the translate status segment.
// Green = active target language, cyan = thinking, lavender = model,
// dim = separators, red = disabled. Distinct from the amber money segments.
const ANSI_GREEN = "\x1b[38;2;95;200;140m";
const ANSI_CYAN = "\x1b[38;2;95;200;230m";
const ANSI_LAVENDER = "\x1b[38;2;170;160;220m";
const ANSI_RED = "\x1b[38;2;210;100;100m";
const ANSI_DIM = "\x1b[38;2;120;124;140m";
const ANSI_YELLOW = "\x1b[38;2;230;200;90m";
function paint(color: string, text: string): string {
	return `${color}${text}${ANSI_RESET}`;
}

// Show real amounts even when tiny: 0.000022 USD, 0.000468 Kč — never collapse to 0.000.
function fmtSmallAmount(n: number): string {
	if (!Number.isFinite(n)) return "n/a";
	if (n === 0) return "0";
	const abs = Math.abs(n);
	const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
	return n.toFixed(decimals);
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

// Short, readable model id for the status bar: drop the provider/openrouter
// prefix, keep the special "current"/"default" settings verbatim.
function shortModelLabel(setting: TranslateModelSetting): string {
	if (setting === "current" || setting === "default") return setting;
	const slash = setting.lastIndexOf("/");
	return slash >= 0 ? setting.slice(slash + 1) : setting;
}

// Single compact, color-coded status segment: translate state, thinking, model,
// and per-session translation cost (amber). All merged into ONE key so the
// footer never overflows and hides the translate info behind "+N more".
function translateStatusText(): string {
	if (!config.enabled) return paint(ANSI_RED, "\u21c4 off");
	const effectiveModel = getEffectiveTranslateModel();
	const sep = paint(ANSI_DIM, " \u00b7 ");
	const parts = [paint(ANSI_GREEN, `\u21c4 ${config.targetLanguage}`)];
	if (config.boost !== "off") {
		parts.push(paint(ANSI_YELLOW, `\u26a1 ${config.boost}`));
	}
	if (config.translateReasoning) {
		parts.push(paint(ANSI_CYAN, `think ${TRANSLATE_REASONING_LEVEL}`));
	}
	parts.push(paint(ANSI_LAVENDER, shortModelLabel(effectiveModel.setting)));
	if (effectiveModel.temporaryUntil) {
		parts.push(
			paint(
				ANSI_DIM,
				`til ${effectiveModel.temporaryUntil.toISOString().slice(5, 10)}`,
			),
		);
	}
	// Session translation cost always shown (even $0) so the amount never disappears.
	parts.push(amber(`$${fmtSmallAmount(sessionCostUsd)}`));
	const bal = balanceCache?.info;
	if (bal) {
		parts.push(amber(`OR$${bal.remaining.toFixed(2)}`));
	}
	return parts.join(sep);
}

function updateTranslateStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATE_STATUS_KEY, translateStatusText());
}

// Retry-worthy errors: rate limits, server errors, network/timeouts. Not 400 (e.g. mandatory reasoning).
function isTransientError(msg?: string): boolean {
	if (!msg) return true;
	return /(429|5\d\d|overload|rate.?limit|timeout|timed out|temporar|econnreset|etimedout|unavailable)/i.test(
		msg,
	);
}

async function getUsdToCzkRate(
	signal?: AbortSignal,
): Promise<number | undefined> {
	const today = new Date().toISOString().slice(0, 10);
	if (fxCache && fxCache.date === today) return fxCache.rate;
	// Primary: ČNB daily rates.
	try {
		const res = await fetch(CNB_DAILY_URL, { signal });
		if (res.ok) {
			const data = (await res.json()) as {
				rates?: Array<{ currencyCode: string; amount: number; rate: number }>;
			};
			const usd = data.rates?.find((r) => r.currencyCode === "USD");
			if (usd) {
				const rate = usd.amount > 0 ? usd.rate / usd.amount : usd.rate;
				fxCache = { rate, date: today };
				return rate;
			}
		}
	} catch {
		/* ČNB failed: fall through to fallback */
	}
	// Fallback: frankfurter.app (ECB-based rates, no auth).
	try {
		const res = await fetch(FRANKFURTER_URL, { signal });
		if (res.ok) {
			const data = (await res.json()) as { rates?: { CZK?: number } };
			const rate = data.rates?.CZK;
			if (typeof rate === "number" && rate > 0) {
				fxCache = { rate, date: today };
				return rate;
			}
		}
	} catch {
		/* best-effort */
	}
	return fxCache?.rate;
}

async function getOpenRouterApiKey(
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const envKey = process.env.OPENROUTER_API_KEY;
	if (envKey) return envKey;
	const candidates: Array<{ provider: string; id: string }> = [];
	try {
		const m = await resolveConfiguredModel(ctx);
		const provider = String(m.provider ?? "");
		if (/openrouter/i.test(provider)) candidates.push({ provider, id: m.id });
	} catch {
		/* model resolution optional: fall through to default candidates */
	}
	candidates.push({ provider: "openrouter", id: "openai/gpt-4o-mini" });
	for (const candidate of candidates) {
		try {
			const found = ctx.modelRegistry.find(candidate.provider, candidate.id) as
				| Model<Api>
				| undefined;
			if (!found) continue;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
			if (auth.ok && auth.apiKey) return auth.apiKey;
		} catch {
			/* best-effort key lookup: try next candidate */
		}
	}
	return undefined;
}

async function getOpenRouterBalance(
	ctx: ExtensionContext,
): Promise<BalanceInfo | undefined> {
	if (balanceCache && Date.now() - balanceCache.ts < BALANCE_TTL_MS)
		return balanceCache.info;
	const apiKey = await getOpenRouterApiKey(ctx);
	if (!apiKey) return undefined;
	try {
		const res = await fetch(OPENROUTER_CREDITS_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: ctx.signal,
		});
		if (!res.ok) return balanceCache?.info;
		const data = (await res.json()) as {
			data?: { total_credits?: number; total_usage?: number };
		};
		const total = data.data?.total_credits ?? 0;
		const used = data.data?.total_usage ?? 0;
		const info: BalanceInfo = { remaining: total - used, total, used };
		balanceCache = { info, ts: Date.now() };
		return info;
	} catch {
		return balanceCache?.info;
	}
}

async function refreshBalanceStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	try {
		await Promise.all([getOpenRouterBalance(ctx), getUsdToCzkRate(ctx.signal)]);
	} catch {
		// best-effort; stay silent
	}
	// Balance now renders inside the merged translate status segment (one key,
	// so the footer never overflows). Repaint it with the freshly cached value.
	updateTranslateStatus(ctx);
}

const DEFAULT_CONFIG: TranslateConfig = {
	enabled: true,
	translateResponses: true,
	targetLanguage: "Czech",
	translateModel: "google/gemini-3.5-flash-lite",
	translateReasoning: true,
	boost: "off",
	showOriginal: true,
	debug: false,
};

// Thinking effort applied when translateReasoning is on and the translate model
// is reasoning-capable. "low" keeps translation cheap and fast while still
// letting the model silently fix typos/grammar. Reasoning tokens are capped via
// thinkingBudgets so a single translation call can't balloon in cost.
const TRANSLATE_REASONING_LEVEL = "low" as const satisfies ThinkingLevel;
const TRANSLATE_REASONING_BUDGET: ThinkingBudgets = { minimal: 256, low: 640 };

let config: TranslateConfig = { ...DEFAULT_CONFIG };
let pending: PendingTranslation | undefined;
let finalTranslationByDisplayedText = new Map<string, string>();

// Latest extension context, used by the AgentSession.prompt interceptor (which
// runs outside any extension event) to reach the model registry and UI.
let sessionCtx: ExtensionContext | undefined;
let piApi: ExtensionAPI | undefined;
// Guard against double-translation if a future pi version ever routes /goal
// commands through the input event again after our prompt interceptor ran.
let lastGoalTransform: { from: string; to: string; at: number } | undefined;

function getText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function hasToolCall(message: AssistantMessage): boolean {
	return message.content.some(
		(part): part is ToolCall => part.type === "toolCall",
	);
}

function withSingleText(
	message: AssistantMessage,
	text: string,
): AssistantMessage {
	const nextContent = message.content.filter((part) => part.type !== "text");
	return {
		...message,
		content: [...nextContent, { type: "text", text }],
	};
}

function estimateTranslationMaxTokens(
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

function protectFinalAnswerSegments(text: string): ProtectedText {
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

function restoreProtectedSegments(
	text: string,
	segments: ProtectedSegment[],
): string {
	let restored = text;
	for (const segment of segments) {
		restored = restored.split(segment.placeholder).join(segment.value);
	}
	return restored;
}

function createTranslationContext(systemPrompt: string, text: string): Context {
	return {
		systemPrompt,
		// Omit volatile timestamps from translation-only requests to improve provider prompt-cache hits.
		messages: [{ role: "user", content: text } as never],
		tools: undefined,
	};
}

function normalizeLanguage(input: string): string {
	const value = input.trim().toLowerCase();
	const aliases: Record<string, string> = {
		ar: "Arabic",
		arabic: "Arabic",
		아랍어: "Arabic",
		العربية: "Arabic",
		cn: "Chinese",
		chinese: "Chinese",
		zh: "Chinese",
		zhcn: "Chinese",
		"zh-cn": "Chinese",
		중국어: "Chinese",
		中文: "Chinese",
		de: "German",
		deu: "German",
		german: "German",
		독일어: "German",
		deutsch: "German",
		en: "English",
		eng: "English",
		english: "English",
		영어: "English",
		es: "Spanish",
		esp: "Spanish",
		spanish: "Spanish",
		스페인어: "Spanish",
		español: "Spanish",
		fr: "French",
		fra: "French",
		fre: "French",
		french: "French",
		프랑스어: "French",
		français: "French",
		hi: "Hindi",
		hin: "Hindi",
		hindi: "Hindi",
		힌디어: "Hindi",
		हिन्दी: "Hindi",
		id: "Indonesian",
		ind: "Indonesian",
		indonesian: "Indonesian",
		인도네시아어: "Indonesian",
		"bahasa indonesia": "Indonesian",
		it: "Italian",
		ita: "Italian",
		italian: "Italian",
		이탈리아어: "Italian",
		italiano: "Italian",
		ja: "Japanese",
		jp: "Japanese",
		japanese: "Japanese",
		일본어: "Japanese",
		日本語: "Japanese",
		ko: "Korean",
		kor: "Korean",
		korean: "Korean",
		한국어: "Korean",
		한글: "Korean",
		nl: "Dutch",
		dut: "Dutch",
		nld: "Dutch",
		dutch: "Dutch",
		네덜란드어: "Dutch",
		nederlands: "Dutch",
		pl: "Polish",
		pol: "Polish",
		polish: "Polish",
		폴란드어: "Polish",
		polski: "Polish",
		pt: "Portuguese",
		por: "Portuguese",
		portuguese: "Portuguese",
		포르투갈어: "Portuguese",
		português: "Portuguese",
		ru: "Russian",
		rus: "Russian",
		russian: "Russian",
		러시아어: "Russian",
		русский: "Russian",
		th: "Thai",
		tha: "Thai",
		thai: "Thai",
		태국어: "Thai",
		ไทย: "Thai",
		tr: "Turkish",
		tur: "Turkish",
		turkish: "Turkish",
		터키어: "Turkish",
		türkçe: "Turkish",
		vi: "Vietnamese",
		vie: "Vietnamese",
		vietnamese: "Vietnamese",
		베트남어: "Vietnamese",
		"tiếng việt": "Vietnamese",
	};
	return aliases[value] ?? input.trim();
}

function normalizeConfig(value: Partial<TranslateConfig>): TranslateConfig {
	return {
		...DEFAULT_CONFIG,
		...value,
		translateResponses:
			value.translateResponses ?? DEFAULT_CONFIG.translateResponses,
		translateModel: value.translateModel ?? DEFAULT_CONFIG.translateModel,
		translateReasoning:
			value.translateReasoning ?? DEFAULT_CONFIG.translateReasoning,
		// Legacy sessions persisted boost as a boolean; accept both shapes.
		boost:
			(value as { boost?: BoostLevel | boolean }).boost === true
				? "boost"
				: (value as { boost?: BoostLevel | boolean }).boost === false
					? "off"
					: (value.boost ?? DEFAULT_CONFIG.boost),
		showOriginal: value.showOriginal ?? DEFAULT_CONFIG.showOriginal,
		debug: value.debug ?? DEFAULT_CONFIG.debug,
	};
}

// Global config file: applies to every session. Precedence:
// DEFAULT_CONFIG < global file < session entries (per-session overrides win).
const GLOBAL_CONFIG_FILE = join(getAgentDir(), "pi-prompt-translate.json");

function loadGlobalConfig(): Partial<TranslateConfig> {
	try {
		return JSON.parse(
			readFileSync(GLOBAL_CONFIG_FILE, "utf8"),
		) as Partial<TranslateConfig>;
	} catch {
		return {};
	}
}

function saveGlobalConfig() {
	try {
		writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
	} catch {
		/* best-effort: global persistence must never break the session */
	}
}

function clearGlobalConfig() {
	try {
		if (existsSync(GLOBAL_CONFIG_FILE)) unlinkSync(GLOBAL_CONFIG_FILE);
	} catch {
		/* best-effort */
	}
}

function extractLatestConfig(ctx: ExtensionContext): TranslateConfig {
	let latest = normalizeConfig(loadGlobalConfig());
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === CONFIG_ENTRY_TYPE &&
			entry.data &&
			typeof entry.data === "object"
		) {
			latest = normalizeConfig({
				...latest,
				...(entry.data as Partial<TranslateConfig>),
			});
		}
	}
	return latest;
}

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

function persistConfig(pi: ExtensionAPI) {
	pi.appendEntry(CONFIG_ENTRY_TYPE, config);
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

function readDefaultModel(): { provider?: string; model?: string } {
	try {
		const settings = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		) as {
			defaultProvider?: string;
			defaultModel?: string;
		};
		return { provider: settings.defaultProvider, model: settings.defaultModel };
	} catch {
		return {};
	}
}

function modelLabel(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

async function resolveConfiguredModel(
	ctx: ExtensionContext,
	settingOverride?: TranslateModelSetting,
): Promise<Model<Api>> {
	const setting = settingOverride ?? getEffectiveTranslateModel().setting;
	if (setting === "current") {
		const model = ctx.model as Model<Api> | undefined;
		if (!model) throw new Error("No active model is selected.");
		return model;
	}

	if (setting === "default") {
		const { provider, model } = readDefaultModel();
		if (!provider || !model)
			throw new Error(
				"defaultProvider/defaultModel is not configured in pi settings.",
			);
		const found = ctx.modelRegistry.find(provider, model) as
			| Model<Api>
			| undefined;
		if (!found) throw new Error(`Default model not found: ${provider}/${model}`);
		return found;
	}

	const slash = setting.indexOf("/");
	const provider = setting.slice(0, slash);
	const modelId = setting.slice(slash + 1);
	const found = ctx.modelRegistry.find(provider, modelId) as
		| Model<Api>
		| undefined;
	if (!found) throw new Error(`Translation model not found: ${setting}`);
	return found;
}

async function getModelAndAuth(
	ctx: ExtensionContext,
	settingOverride?: TranslateModelSetting,
): Promise<ModelWithAuth> {
	const model = await resolveConfiguredModel(ctx, settingOverride);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

function debug(ctx: ExtensionContext, message: string) {
	if (config.debug && ctx.hasUI)
		ctx.ui.notify(`[prompt-translate] ${message}`, "info");
}

function formatUsage(usage: TranslationUsage, rate?: number): string {
	const cost = usage.cost?.total;
	let costText = "";
	if (typeof cost === "number") {
		costText = `, cost=$${cost.toFixed(6)}`;
		if (typeof rate === "number" && rate > 0)
			costText += ` (≈ ${(cost * rate).toFixed(3)} Kč)`;
	}
	return `input=${usage.input}, output=${usage.output}, cacheRead=${usage.cacheRead}, cacheWrite=${usage.cacheWrite}, total=${usage.totalTokens}${costText}`;
}

function formatCost(costUsd?: number, costCzk?: number): string {
	if (typeof costUsd !== "number") return "(cost n/a)";
	const usd = `$${fmtSmallAmount(costUsd)}`;
	const czk =
		typeof costCzk === "number" ? ` / ${fmtSmallAmount(costCzk)} Kč` : "";
	return `(${usd}${czk})`;
}

async function translate(
	ctx: ExtensionContext,
	text: string,
	targetLanguage: string,
	purpose: "prompt" | "answer",
): Promise<TranslationResult> {
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
	): SimpleStreamOptions => ({
		apiKey,
		headers,
		env,
		maxTokens: estimateTranslationMaxTokens(
			model,
			protectedInput.text,
			!!reasoning,
		),
		reasoning,
		thinkingBudgets: reasoning ? TRANSLATE_REASONING_BUDGET : undefined,
		signal: ctx.signal,
		sessionId: ctx.sessionManager.getSessionId(),
	});
	const instrumentedCompleteSimple = (ctx as ExtensionContextWithCompleteSimple)
		.completeSimple;
	const shouldUseInstrumentedTranslation =
		purpose === "prompt" && instrumentedCompleteSimple;
	const makeDoCall =
		(reasoning: ThinkingLevel | undefined) => (): Promise<AssistantMessage> => {
			const opts = makeOptions(reasoning);
			return shouldUseInstrumentedTranslation
				? instrumentedCompleteSimple(model, llmContext, {
						...opts,
						trace: {
							name: "prompt-translation",
							extension: "pi-prompt-translate",
							purpose,
							metadata: { targetLanguage },
						},
					})
				: completeSimple(model, llmContext, opts);
		};

	let doCall = makeDoCall(thinkOn ? TRANSLATE_REASONING_LEVEL : undefined);
	let response = await doCall();
	if (
		(response.stopReason === "error" || response.stopReason === "aborted") &&
		isTransientError(response.errorMessage)
	) {
		debug(ctx, "transient translation error; retrying once in 1s");
		await new Promise((r) => setTimeout(r, 1000));
		response = await doCall();
	}
	// Thinking fallback: some providers reject reasoning requests (400 mandatory
	// reasoning, max_tokens too small for thinking, unsupported effort level, ...).
	// Retry once with thinking fully off so translation never hard-fails.
	if (
		thinkOn &&
		(response.stopReason === "error" || response.stopReason === "aborted") &&
		/reason|thinking|max_?tokens|mandatory|bad request|400/i.test(
			response.errorMessage ?? "",
		)
	) {
		debug(ctx, "translation error with thinking on; retrying without thinking");
		doCall = makeDoCall(undefined);
		response = await doCall();
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
		sessionCostUsd += costUsd;
		updateTranslateStatus(ctx);
	}
	return { text: translatedText, usage: response.usage, costUsd, costCzk };
}

function parseModelSetting(raw: string): TranslateModelSetting | undefined {
	const value = raw.trim();
	if (value === "current" || value === "default") return value;
	if (/^[^\s/]+\/.+$/.test(value)) return value as `${string}/${string}`;
	return undefined;
}

// Parse "until" dates as local end-of-day, so "until 2026-08-26" keeps the
// temporary model active through that whole day.
function parseUntilDate(raw: string): Date | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!m) return undefined;
	const d = new Date(
		Number(m[1]),
		Number(m[2]) - 1,
		Number(m[3]),
		23,
		59,
		59,
		999,
	);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

// The model actually used for translation right now: the temporary override while
// it is still valid, otherwise the base translateModel. An expired override is
// cleared and persisted so the fallback is automatic and permanent.
function getEffectiveTranslateModel(): {
	setting: TranslateModelSetting;
	temporaryUntil?: Date;
} {
	if (config.temporaryModel && config.temporaryModelUntil) {
		const until = parseUntilDate(config.temporaryModelUntil);
		if (until && Date.now() <= until.getTime()) {
			return { setting: config.temporaryModel, temporaryUntil: until };
		}
		config.temporaryModel = undefined;
		config.temporaryModelUntil = undefined;
		piApi?.appendEntry(CONFIG_ENTRY_TYPE, config);
	}
	return { setting: config.translateModel };
}

// Subcommands that never carry an objective (pi-goal parseCommand).
const GOAL_CONTROL_SUBCOMMANDS = new Set([
	"pause",
	"resume",
	"clear",
	"stop",
	"status",
	"drop-last",
	"pop",
	"skip",
	"shift",
]);

// Subcommands whose remaining arguments are the objective text.
const GOAL_OBJECTIVE_SUBCOMMANDS = new Set([
	"edit",
	"add",
	"push",
	"prioritize",
	"unshift",
]);

type GoalObjectiveExtraction = {
	// Objective text to translate; undefined = nothing to translate (control command or usage error).
	objective?: string;
	rebuild: (translatedObjective: string) => string;
};

// Split `/goal ...` into the untranslatable command scaffold and the objective text.
// Returns undefined when the text is not a /goal command at all.
function extractGoalObjective(
	text: string,
): GoalObjectiveExtraction | undefined {
	const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
	if (!match) return undefined;
	const noObjective: GoalObjectiveExtraction = { rebuild: (t) => t };
	const args = match[1]?.trim() ?? "";
	if (!args) return noObjective; // bare "/goal" shows status
	const firstWord = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
	if (!firstWord) return noObjective;
	if (GOAL_CONTROL_SUBCOMMANDS.has(firstWord[1])) return noObjective;
	let prefix = "";
	let rest = args;
	if (GOAL_OBJECTIVE_SUBCOMMANDS.has(firstWord[1])) {
		if (!firstWord[2]?.trim()) return noObjective; // e.g. "/goal edit" opens the menu
		prefix = `${firstWord[1]} `;
		rest = firstWord[2].trim();
	}
	// Optional "--tokens <budget>" scaffold before the objective.
	const budget = /^(--tokens\s+(\S+))(?:\s+([\s\S]*))?$/iu.exec(rest);
	if (budget) {
		// Malformed or invalid budget: pi-goal shows a usage error; nothing to translate.
		if (!budget[3]?.trim() || !/^(\d+(?:\.\d+)?)[km]?$/iu.test(budget[2]))
			return noObjective;
		prefix += `${budget[1]} `;
		rest = budget[3].trim();
	} else if (/^--tokens$/iu.test(rest)) {
		return noObjective; // missing budget value; pi-goal shows usage
	}
	if (!rest) return noObjective;
	return {
		objective: rest,
		rebuild: (translated) => `/goal ${prefix}${translated}`,
	};
}

// --- /goal objective translation via AgentSession.prompt interception ---
// pi dispatches extension commands (pi.registerCommand, e.g. pi-goal's /goal)
// BEFORE the input event fires (agent-session prompt(): _tryExecuteExtensionCommand
// runs first, input event only when no command matched). So an input handler can
// never see /goal text. All extensions share one pi-coding-agent module instance,
// so wrapping AgentSession.prototype.prompt here intercepts /goal submissions
// before command dispatch, translates only the objective, and passes the rebuilt
// command text through unchanged in shape.
const PROMPT_INTERCEPTOR_MARKER = Symbol.for(
	"pi-prompt-translate.prompt-interceptor",
);

type PromptOptions = {
	images?: unknown[];
	source?: string;
};

async function translateGoalCommandText(
	text: string,
	options?: PromptOptions,
): Promise<string> {
	if (!config.enabled) return text;
	if (options?.source === "extension") {
		// pi-goal continuation prompts bypass the input event (source "extension").
		// Re-arm the pending response translation in case a mid-goal plain-text turn
		// consumed it before the goal's actual final briefing.
		if (text.includes("pi-goal-prompt")) {
			pending = {
				targetLanguage: config.targetLanguage,
				translateResponses: config.translateResponses,
			};
		}
		return text;
	}
	if (options?.images?.length) return text;
	if (!text.startsWith("/goal")) return text;
	const ctx = sessionCtx;
	if (!ctx) return text;
	const goalCommand = extractGoalObjective(text);
	if (!goalCommand?.objective) return text;
	try {
		const translated = await translate(
			ctx,
			goalCommand.objective,
			"English",
			"prompt",
		);
		const rebuilt = goalCommand.rebuild(translated.text);
		if (ctx.hasUI)
			ctx.ui.notify(
				`prompt-translate: /goal objective → EN ${formatCost(translated.costUsd, translated.costCzk)}`,
				"info",
			);
		pending = {
			targetLanguage: config.targetLanguage,
			translateResponses: config.translateResponses,
		};
		lastGoalTransform = { from: text, to: rebuilt, at: Date.now() };
		piApi?.appendEntry(STATE_ENTRY_TYPE, {
			at: new Date().toISOString(),
			source: text,
			english: rebuilt,
			targetLanguage: config.targetLanguage,
			translateModel: getEffectiveTranslateModel().setting,
			usage: translated.usage,
		});
		return rebuilt;
	} catch (error) {
		if (ctx.hasUI)
			ctx.ui.notify(
				`prompt translation failed; continuing with original /goal objective: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		return text;
	}
}

function installPromptInterceptor() {
	const proto = AgentSession.prototype as unknown as Record<
		PropertyKey,
		unknown
	>;
	if (proto[PROMPT_INTERCEPTOR_MARKER]) return;
	const original = proto.prompt;
	if (typeof original !== "function") return;
	const originalPrompt = original as (
		this: unknown,
		text: string,
		options?: PromptOptions,
	) => Promise<unknown>;
	proto.prompt = async function (
		this: unknown,
		text: string,
		options?: PromptOptions,
	) {
		const rewritten = await translateGoalCommandText(text, options);
		return originalPrompt.call(this, rewritten, options);
	};
	proto[PROMPT_INTERCEPTOR_MARKER] = true;
}

export const __test = {
	CONFIG_ENTRY_TYPE,
	FINAL_TRANSLATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	DEFAULT_CONFIG,
	ENGLISH_ONLY_AGENT_INSTRUCTION,
	appendEnglishOnlyInstruction,
	buildEnglishOnlyInstruction,
	extractLatestConfig,
	getText,
	hasToolCall,
	normalizeConfig,
	normalizeLanguage,
	createTranslationContext,
	estimateTranslationMaxTokens,
	extractGoalObjective,
	parseModelSetting,
	protectFinalAnswerSegments,
	rebuildFinalTranslationMap,
	restoreProtectedSegments,
	rememberFinalTranslation,
	replaceDisplayedAssistantTextWithEnglish,
	resetState() {
		config = { ...DEFAULT_CONFIG };
		pending = undefined;
		finalTranslationByDisplayedText = new Map<string, string>();
	},
	setConfig(next: TranslateConfig) {
		config = { ...next };
	},
	withSingleText,
};

async function statusText(ctx: ExtensionContext): Promise<string> {
	const configuredModel = config.translateModel;
	const temporaryInfo =
		config.temporaryModel && config.temporaryModelUntil
			? `${config.temporaryModel} until ${config.temporaryModelUntil}`
			: "none";
	let resolved = "unavailable";
	try {
		resolved = modelLabel(await resolveConfiguredModel(ctx));
	} catch (error) {
		resolved = `error: ${error instanceof Error ? error.message : String(error)}`;
	}
	const [rate, balance] = await Promise.all([
		getUsdToCzkRate(ctx.signal),
		getOpenRouterBalance(ctx),
	]);
	const rateText = typeof rate === "number" ? rate.toFixed(3) : "n/a";
	const balanceText = balance
		? `$${balance.remaining.toFixed(2)} / $${balance.total.toFixed(2)} (used $${balance.used.toFixed(2)})`
		: "n/a";
	return [
		`prompt-translate input: ${config.enabled ? "on" : "off"}`,
		`responses=${config.translateResponses ? "on" : "off"}`,
		`target=${config.targetLanguage}`,
		`translateModel=${configuredModel}`,
		`temporaryModel=${temporaryInfo}`,
		`globalConfig=${existsSync(GLOBAL_CONFIG_FILE) ? "on" : "off"}`,
		`resolvedTranslateModel=${resolved}`,
		`currentModel=${modelLabel(ctx.model as Model<Api> | undefined)}`,
		`thinking=${config.translateReasoning ? "on (low)" : "off"}`,
		`boost=${config.boost}`,
		`showOriginal=${config.showOriginal ? "on" : "off"}`,
		`usdToCzk=${rateText} (ČNB)`,
		`openRouterBalance=${balanceText}`,
		`debug=${config.debug ? "on" : "off"}`,
	].join(", ");
}

export default function (pi: ExtensionAPI) {
	piApi = pi;
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
			if (!config.showOriginal) return undefined;
			const source = entry.data?.source;
			if (typeof source !== "string" || !source.trim()) return undefined;
			// Theme-driven styling, with pi-at-words pink for confirmed ?words.
			const box = new Box(1, 1, (text) => theme.bg("selectedBg", text));
			box.addChild(
				new Text(
					`${theme.fg("customMessageLabel", "original:")}\n${theme.fg("customMessageText", pinkAtWords(source))}`,
				),
			);
			return box;
		},
	);
	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		config = extractLatestConfig(ctx);
		rebuildFinalTranslationMap(ctx);
		sessionCostUsd = sumSessionCostUsd(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`pi-prompt-translate input ${config.enabled ? "on" : "off"}, responses ${config.translateResponses ? "on" : "off"} (target: ${config.targetLanguage}, model: ${config.translateModel})`,
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
				pending = undefined;
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
				if (!config.enabled) pending = undefined;
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
				if (pending) pending.translateResponses = config.translateResponses;
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
				if (force === "refresh") balanceCache = undefined;
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
				config = { ...DEFAULT_CONFIG };
				pending = undefined;
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
		sessionCtx = ctx;
		refreshBalanceStatus(ctx);
		if (!config.enabled || event.source === "extension" || event.images?.length) {
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
				lastGoalTransform &&
				event.text === lastGoalTransform.to &&
				Date.now() - lastGoalTransform.at < 30_000
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
			pending = {
				targetLanguage: config.targetLanguage,
				translateResponses: config.translateResponses,
			};
			pi.appendEntry(STATE_ENTRY_TYPE, {
				at: new Date().toISOString(),
				source: event.text,
				english: rebuild ? rebuild(translated.text) : translated.text,
				targetLanguage: config.targetLanguage,
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
		if (!pending) return;
		debug(
			ctx,
			pending.translateResponses
				? "forcing agent run language to English; final briefing will be translated after completion"
				: "forcing agent run language to English; final briefing translation is disabled",
		);
		return {
			systemPrompt: appendEnglishOnlyInstruction(
				event.systemPrompt,
				pending.translateResponses,
			),
		};
	});

	pi.on("context", (event) => {
		if (!config.enabled || finalTranslationByDisplayedText.size === 0) return;
		const messages = event.messages.map(replaceDisplayedAssistantTextWithEnglish);
		if (messages.some((message, index) => message !== event.messages[index]))
			return { messages };
	});

	pi.on("turn_start", (event) => {
		if (pending && pending.turnIndex === undefined)
			pending.turnIndex = event.turnIndex;
	});

	pi.on("message_end", async (event, ctx) => {
		if (!pending || event.message.role !== "assistant") return;
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

		const current = pending;
		pending = undefined;
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
