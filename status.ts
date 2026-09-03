// status.ts — footer status segment, color palette, money/usage formatting, debug notify.

import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GLOBAL_CONFIG_FILE,
	getEffectiveTranslateModel,
	modelLabel,
	readDefaultModel,
	resolveConfiguredModel,
	TRANSLATE_REASONING_LEVEL,
} from "./config";
import {
	cachedBalance,
	cachedUsdToCzkRate,
	getOpenRouterBalance,
	getUsdToCzkRate,
} from "./balance";
import { state } from "./state";
import type {
	TranslationUsage,
	TranslateModelSetting,
	TranslateConfig,
	BoostLevel,
} from "./types";

const STATE_STATUS_KEY = "prompt-translate-state";

// Soft amber ANSI — distinct (money) but not harsh; dark-theme friendly.
const ANSI_AMBER = "\x1b[38;2;218;165;32m";
const ANSI_RESET = "\x1b[0m";

// Dark-theme-friendly palette for the translate status segment.
// Green = active target language, cyan = thinking, lavender = model,
// dim = separators, red = disabled. Distinct from the amber money segments.
const ANSI_GREEN = "\x1b[38;2;95;200;140m";
const ANSI_CYAN = "\x1b[38;2;95;200;230m";
const ANSI_LAVENDER = "\x1b[38;2;170;160;220m";
const ANSI_RED = "\x1b[38;2;210;100;100m";
const ANSI_DIM = "\x1b[38;2;120;124;140m";
const ANSI_YELLOW = "\x1b[38;2;230;200;90m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_BRIGHT_GREEN = "\x1b[92m";
const ANSI_BRIGHT_CYAN = "\x1b[96m";

function paint(color: string, text: string): string {
	return `${color}${text}${ANSI_RESET}`;
}

export {
	ANSI_GREEN,
	ANSI_CYAN,
	ANSI_LAVENDER,
	ANSI_RED,
	ANSI_DIM,
	ANSI_YELLOW,
	ANSI_RESET,
	ANSI_BOLD,
	ANSI_BRIGHT_GREEN,
	ANSI_BRIGHT_CYAN,
	paint,
};

/**
 * Formats a list of choices (e.g. ["on", "off"] or ["off", "on", "plus", "mega"])
 * highlighting the active option in bold green with a bullet indicator,
 * and dimming inactive options.
 */
export function formatChoice(
	choices: Array<{ value: string; label?: string } | string>,
	activeValue: string | boolean,
): string {
	let activeStr = "";
	if (typeof activeValue === "boolean") {
		activeStr = activeValue ? "on" : "off";
	} else {
		activeStr = activeValue.toLowerCase();
	}

	return choices
		.map((c) => {
			const val = typeof c === "string" ? c : c.value;
			const lbl = typeof c === "string" ? c : (c.label ?? c.value);
			const isActive =
				val.toLowerCase() === activeStr || (val === "on" && activeStr === "boost");
			if (isActive) {
				return `${ANSI_BOLD}${ANSI_GREEN}● ${lbl}${ANSI_RESET}`;
			}
			return `${ANSI_DIM}${lbl}${ANSI_RESET}`;
		})
		.join(`${ANSI_DIM}|${ANSI_RESET}`);
}

/**
 * Formats an active single value (string/number) in bright cyan with a bullet.
 */
export function formatActiveValue(value: string | number): string {
	return `${ANSI_BOLD}${ANSI_CYAN}● ${value}${ANSI_RESET}`;
}

/**
 * Formats a boolean value as a colored badge: ● ON (green) / ○ OFF (red/dim).
 */
export function formatToggleBadge(enabled: boolean): string {
	return enabled
		? `${ANSI_BOLD}${ANSI_GREEN}● ON${ANSI_RESET}`
		: `${ANSI_DIM}${ANSI_RED}○ OFF${ANSI_RESET}`;
}

export function formatConfirmationBody(options: {
	source: string;
	english: string;
	boost?: BoostLevel;
	conversationContext?: string;
	usage?: TranslationUsage;
	costUsd?: number;
	costCzk?: number;
	styleSource?: (text: string) => string;
}): string {
	const {
		source,
		english,
		boost,
		conversationContext,
		usage,
		costUsd,
		costCzk,
		styleSource = (t) => t,
	} = options;

	const boostBadge = boost && boost !== "off" ? ` [boost: ${boost}]` : "";
	const historyBadge = conversationContext ? " [history: attached]" : "";
	const tokStr =
		usage?.totalTokens === undefined
			? ""
			: ` · ${usage.totalTokens} tok (in: ${usage.input}, out: ${usage.output})`;
	const costStr =
		costUsd === undefined ? "" : ` · ${formatCost(costUsd, costCzk)}`;

	const header = `${ANSI_BOLD}${ANSI_CYAN}🔄 Prompt Translation Diff${boostBadge}${historyBadge}${ANSI_RESET}${ANSI_DIM}${tokStr}${costStr}${ANSI_RESET}`;
	const originalSection = `${ANSI_BOLD}${ANSI_YELLOW}Original (CZ):${ANSI_RESET}\n${styleSource(source)}`;
	const englishSection = `${ANSI_BOLD}${ANSI_GREEN}Enhanced (EN):${ANSI_RESET}\n${ANSI_BRIGHT_GREEN}${english}${ANSI_RESET}`;
	const historySection = conversationContext
		? `\n\n${ANSI_BOLD}${ANSI_LAVENDER}Attached History Context:${ANSI_RESET}\n${ANSI_DIM}${conversationContext}${ANSI_RESET}`
		: "";
	const question = `\n\n${ANSI_BOLD}${ANSI_CYAN}Odeslat tento překlad agentovi?${ANSI_RESET} ${ANSI_DIM}(Ne = odeslat původní text bez překladu)${ANSI_RESET}`;

	return `${header}\n\n${originalSection}\n\n${englishSection}${historySection}${question}`;
}

export function buildHelpText(
	config: TranslateConfig,
	sessionCostUsd: number,
): string {
	const effectiveModel = getEffectiveTranslateModel();
	const modelDisplay =
		config.temporaryModel && config.temporaryModelUntil
			? `${config.temporaryModel} (dočasně do ${config.temporaryModelUntil})`
			: effectiveModel.setting;

	return [
		`${ANSI_BOLD}${ANSI_CYAN}pi-prompt-translate${ANSI_RESET} — stav: vstupy ${formatToggleBadge(config.enabled)}, odpovědi ${formatToggleBadge(config.translateResponses)}`,
		"Překládá české prompty do angličtiny pro vyšší kvalitu uvažování LLM a volitelně překládá odpovědi zpět.",
		"",
		`${ANSI_BOLD}Příkazy & Konfigurace:${ANSI_RESET}`,
		`  /prompt-translate on|off            — hlavní vypínač překladu promptů (${formatChoice(["on", "off"], config.enabled)})`,
		`  /prompt-translate responses on|off  — překlad odpovědí asistenta zpět (${formatChoice(["on", "off"], config.translateResponses)})`,
		`  /prompt-translate lang <jazyk>      — cílový jazyk pro odpovědi (${formatActiveValue(config.targetLanguage)})`,
		`  /prompt-translate boost <level>     — úroveň vylepšení promptu (${formatChoice(["off", "on", "plus", "mega"], config.boost)})`,
		`  /prompt-translate model <model>     — model pro překlad (${formatActiveValue(modelDisplay)})`,
		`  /prompt-translate think on|off      — uvažování překladového modelu (${formatChoice(["on", "off"], config.translateReasoning)})`,
		`  /prompt-translate confirm on|off    — potvrzení před odesláním agentovi (${formatChoice(["on", "off"], config.confirm)})`,
		`  /prompt-translate history [mode]    — historie konverzace (${formatChoice(["off", "ask", "auto", "always"], config.historyMode)} | ${ANSI_DIM}inspect${ANSI_RESET})`,
		`  /prompt-translate diff on|off       — porovnání promptu a tokeny (${formatChoice(["on", "off"], config.diff)})`,
		`  /prompt-translate detect on|off     — autodetekce kódu a angličtiny (${formatChoice(["on", "off"], config.autodetect)})`,
		`  /prompt-translate original on|off   — zobrazení původního promptu (${formatChoice(["on", "off"], config.showOriginal)})`,
		`  /prompt-translate debug on|off      — podrobné logování (${formatChoice(["on", "off"], config.debug)})`,
		`  /prompt-translate history inspect   — náhled extrahovaného kontextu historie`,
		`  /prompt-translate balance [refresh] — zůstatek na OpenRouter a kurz ČNB`,
		`  /prompt-translate stats             — přehled telemetrie, úspor a OpenRouter routingu`,
		`  /prompt-translate global show|off   — trvalá globální konfigurace pro všechna sezení`,
		`  /prompt-translate reset             — obnoví výchozí nastavení`,
		"",
		`${ANSI_DIM}Tip: přidejte --global k jakémukoli podpříkazu pro trvalé uložení.${ANSI_RESET}`,
		"",
		`${ANSI_BOLD}Aktuální přehled:${ANSI_RESET}`,
		`  • Cíl: ${formatActiveValue(config.targetLanguage)} | Boost: ${formatChoice(["off", "on", "plus", "mega"], config.boost)} | Model: ${formatActiveValue(effectiveModel.setting)}`,
		`  • Historie: ${formatChoice(["off", "ask", "auto", "always"], config.historyMode)} | Potvrzení: ${formatToggleBadge(config.confirm)} | Reasoning: ${formatToggleBadge(config.translateReasoning)}`,
		`  • Cena sezení: ${ANSI_BOLD}${ANSI_YELLOW}$${sessionCostUsd.toFixed(4)}${ANSI_RESET}`,
	].join("\n");
}

// Show real amounts even when tiny: 0.000022 USD, 0.000468 Kč — never collapse to 0.000.
export function fmtSmallAmount(n: number): string {
	if (!Number.isFinite(n)) return "n/a";
	if (n === 0) return "0";
	const abs = Math.abs(n);
	const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
	return n.toFixed(decimals);
}

const PROVIDER_SHORT_CODES: Record<string, string> = {
	openrouter: "OR",
	google: "G",
	anthropic: "A",
	openai: "OAI",
	"openai-codex": "OAI",
	ollama: "OLL",
	deepseek: "DS",
	mistral: "M",
	groq: "GROQ",
	cerebras: "CB",
	xai: "XAI",
	"kimi-coding": "KIMI",
	moonshotai: "KIMI",
	"zai-coding-cn": "ZAI",
	zai: "ZAI",
};

// Compact provider abbreviation for the status bar.
export function providerShortCode(provider: string): string {
	const p = provider.toLowerCase();
	const mapped = PROVIDER_SHORT_CODES[p];
	if (mapped) return mapped;
	return provider.length <= 4
		? provider.toUpperCase()
		: provider.slice(0, 3).toUpperCase();
}

// Short, readable model label for the status bar with compact provider code:
// e.g. "openrouter/google/gemini-3.7-flash" -> "OR:gemini-3.7-flash"
//      "google/gemini-3.5-flash-lite"      -> "G:gemini-3.5-flash-lite"
function shortModelLabel(setting: TranslateModelSetting): string {
	if (setting === "current") {
		const current = state.sessionCtx?.model as Model<Api> | undefined;
		if (current?.provider && current.id) {
			const p = providerShortCode(current.provider);
			const slash = current.id.lastIndexOf("/");
			const m = slash >= 0 ? current.id.slice(slash + 1) : current.id;
			return `${p}:${m}`;
		}
		return "current";
	}
	if (setting === "default") {
		const { provider, model } = readDefaultModel();
		if (provider && model) {
			const p = providerShortCode(provider);
			const slash = model.lastIndexOf("/");
			const m = slash >= 0 ? model.slice(slash + 1) : model;
			return `${p}:${m}`;
		}
		return "default";
	}
	const firstSlash = setting.indexOf("/");
	if (firstSlash === -1) return setting;
	const provider = setting.slice(0, firstSlash);
	const p = providerShortCode(provider);
	const lastSlash = setting.lastIndexOf("/");
	const modelName = setting.slice(lastSlash + 1);
	return `${p}:${modelName}`;
}

// Balance alert thresholds (in USD):
// > $3.00       -> Green (healthy)
// $1.00 - $3.00 -> Yellow (warning / time to refill)
// < $1.00       -> Red (critical)
function balanceColor(remainingUsd: number): string {
	if (remainingUsd <= 1.0) return ANSI_RED;
	if (remainingUsd <= 3.0) return ANSI_YELLOW;
	return ANSI_GREEN;
}

// Single compact, color-coded status segment: translate state, thinking, model,
// and per-session translation cost (amber). Structured in 3 semantic clusters
// (Target & Mode │ Model & Thinking │ Cost & Balance) in ONE key.
function translateStatusText(): string {
	const config = state.config;
	if (!config.enabled) return paint(ANSI_RED, "\u21c4 off");

	const effectiveModel = getEffectiveTranslateModel();
	const groupSep = paint(ANSI_DIM, " \u2502 ");
	const itemSep = paint(ANSI_DIM, " \u00b7 ");

	// Group 1: Target language & boost mode
	const targetGroup = [paint(ANSI_GREEN, `\u21c4 ${config.targetLanguage}`)];
	if (config.boost !== "off") {
		targetGroup.push(paint(ANSI_YELLOW, `\u26a1 ${config.boost}`));
	}

	// Group 2: Model, reasoning & temporary expiry
	const modelGroup = [
		paint(ANSI_LAVENDER, shortModelLabel(effectiveModel.setting)),
	];
	if (config.translateReasoning) {
		modelGroup.push(paint(ANSI_CYAN, `🧠 ${TRANSLATE_REASONING_LEVEL}`));
	}
	if (effectiveModel.temporaryUntil) {
		modelGroup.push(
			paint(
				ANSI_DIM,
				`⏳ ${effectiveModel.temporaryUntil.toISOString().slice(5, 10)}`,
			),
		);
	}

	// Group 3: Session translation cost / OpenRouter balance in CZK (compact single credit card segment)
	const rate = cachedUsdToCzkRate();
	const costUsd = state.sessionCostUsd;
	const bal = cachedBalance();

	let moneyStr = "💳 ";
	if (typeof rate === "number" && rate > 0) {
		const costCzk = costUsd * rate;
		moneyStr += paint(ANSI_AMBER, fmtSmallAmount(costCzk));
		if (bal) {
			const bColor = balanceColor(bal.remaining);
			const balCzk = bal.remaining * rate;
			moneyStr += `${paint(ANSI_DIM, " / ")}${paint(bColor, `${fmtSmallAmount(balCzk)} Kč`)}`;
		} else {
			moneyStr += paint(ANSI_AMBER, " Kč");
		}
	} else {
		moneyStr += paint(ANSI_AMBER, `$${fmtSmallAmount(costUsd)}`);
		if (bal) {
			const bColor = balanceColor(bal.remaining);
			moneyStr += `${paint(ANSI_DIM, " / ")}${paint(bColor, `$${bal.remaining.toFixed(2)}`)}`;
		}
	}
	const costGroup = [moneyStr];

	return [
		targetGroup.join(itemSep),
		modelGroup.join(itemSep),
		costGroup.join(itemSep),
	].join(groupSep);
}

export function updateTranslateStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATE_STATUS_KEY, translateStatusText());
}

export async function refreshBalanceStatus(ctx: ExtensionContext) {
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

export function debug(ctx: ExtensionContext, message: string) {
	if (state.config.debug && ctx.hasUI)
		ctx.ui.notify(`[prompt-translate] ${message}`, "info");
}

export function formatUsage(usage: TranslationUsage, rate?: number): string {
	const cost = usage.cost?.total;
	let costText = "";
	if (typeof cost === "number") {
		if (typeof rate === "number" && rate > 0) {
			costText = `, cost=${fmtSmallAmount(cost * rate)} Kč`;
		} else {
			costText = `, cost=$${cost.toFixed(6)}`;
		}
	}
	return `input=${usage.input}, output=${usage.output}, cacheRead=${usage.cacheRead}, cacheWrite=${usage.cacheWrite}, total=${usage.totalTokens}${costText}`;
}

export function formatCost(costUsd?: number, costCzk?: number): string {
	if (typeof costCzk === "number") return `(${fmtSmallAmount(costCzk)} Kč)`;
	if (typeof costUsd === "number") return `($${fmtSmallAmount(costUsd)})`;
	return "(cost n/a)";
}

export async function formatTelemetryOverview(
	ctx: ExtensionContext,
): Promise<string> {
	const tel = state.telemetry;
	const effectiveModel = getEffectiveTranslateModel();
	const czkRate = await getUsdToCzkRate(ctx.signal);
	const hitRate =
		tel.totalRequests > 0
			? ((tel.cacheHitTurns / tel.totalRequests) * 100).toFixed(1)
			: "0.0";
	const costCzk =
		typeof czkRate === "number" && czkRate > 0
			? state.sessionCostUsd * czkRate
			: undefined;
	const savingsCzk =
		typeof czkRate === "number" && czkRate > 0
			? tel.savedCostUsd * czkRate
			: undefined;

	const formatUsdCzk = (usd: number, czk?: number) => {
		if (typeof czk === "number") {
			return `$${fmtSmallAmount(usd)} (~${fmtSmallAmount(czk)} Kč)`;
		}
		return `$${fmtSmallAmount(usd)}`;
	};

	return [
		"═══════════════════════════════════════════════════════",
		" 🚀 pi-prompt-translate — Telemetry & Optimizations",
		"═══════════════════════════════════════════════════════",
		"",
		"📡 Model & OpenRouter Routing",
		`  • Active Model:     ${effectiveModel.setting}`,
		`  • History Context:  ${state.config.historyMode}`,
		`  • App Attribution:  Pi Prompt Translate`,
		`  • Sticky Routing:   ${tel.openRouterRequests > 0 ? "Active (x-session-id pinned)" : "Ready"}`,
		`  • Total Requests:   ${tel.totalRequests} (${tel.promptRequests} prompts, ${tel.answerRequests} answers)`,
		"",
		"⚡ Prompt Caching & Performance",
		`  • Cache Hit Rate:   ${hitRate}% (${tel.cacheHitTurns} of ${tel.totalRequests} turns hit cache)`,
		`  • Tokens from Cache: ${tel.cachedTokens.toLocaleString("en-US")} tokens read`,
		`  • Cache Writes:     ${tel.cacheWriteTokens.toLocaleString("en-US")} tokens written`,
		"",
		"💰 Cost Accounting & Savings",
		`  • Total Incurred:   ${formatUsdCzk(state.sessionCostUsd, costCzk)}`,
		`  • Saved via Cache:  ${formatUsdCzk(tel.savedCostUsd, savingsCzk)}`,
		"",
		"🔧 Active Optimizations",
		"  [✔] x-session-id Sticky Provider Routing (10-min backend lock)",
		"  [✔] OpenRouter Dashboard Analytics Attribution (X-Title / Referer)",
		"  [✔] XML Source Isolation (<source_text> boundary)",
		"  [✔] Token Masking (Code blocks, URLs, @mentions, ?symbols)",
		"  [✔] Fuzzy & Lost-Token Recovery Fallback",
		"═══════════════════════════════════════════════════════",
	].join("\n");
}

export async function statusText(ctx: ExtensionContext): Promise<string> {
	const config = state.config;
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
		`history=${config.historyMode}`,
		`confirm=${config.confirm ? "on" : "off"}`,
		`showOriginal=${config.showOriginal ? "on" : "off"}`,
		`usdToCzk=${rateText} (ČNB)`,
		`openRouterBalance=${balanceText}`,
		`debug=${config.debug ? "on" : "off"}`,
	].join(", ");
}
