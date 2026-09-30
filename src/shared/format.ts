// format.ts — pure presentation helpers: ANSI palette, menu/badge rendering,
// money and usage formatting, compact model labels.
//
// Everything here is a `(value) => string` function with no session access, which
// is what makes it shareable: the status slice paints the footer with it, the
// commands slice paints its menus with it, and the translate kernel formats a cost
// with it. Formatting that touched session state would belong in the status slice
// instead.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { type TranslateConfig, type TranslateModelSetting, type TranslationUsage } from "./types.js";
import { getEffectiveTranslateModel, readDefaultModel } from "./config-model.js";

// Soft amber ANSI — distinct (money) but not harsh; dark-theme friendly.
export const ANSI_AMBER = "\x1b[38;2;218;165;32m";

export const ANSI_RESET = "\x1b[0m";

// Dark-theme-friendly palette for the translate status segment.
// Green = active target language, cyan = thinking, lavender = model,
// dim = separators, red = disabled. Distinct from the amber money segments.
export const ANSI_GREEN = "\x1b[38;2;95;200;140m";

export const ANSI_CYAN = "\x1b[38;2;95;200;230m";

export const ANSI_LAVENDER = "\x1b[38;2;170;160;220m";

export const ANSI_RED = "\x1b[38;2;210;100;100m";

export const ANSI_DIM = "\x1b[38;2;120;124;140m";

export const ANSI_YELLOW = "\x1b[38;2;230;200;90m";

export const ANSI_BOLD = "\x1b[1m";

export const ANSI_BRIGHT_GREEN = "\x1b[92m";

export const ANSI_BRIGHT_CYAN = "\x1b[96m";

export function paint(color: string, text: string): string {
	return `${color}${text}${ANSI_RESET}`;
}

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

// ---------------------------------------------------------------------------
// Compact labels and money formatting (from the former status-telemetry.ts)
// ---------------------------------------------------------------------------

export const PROVIDER_SHORT_CODES: Record<string, string> = {
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
export function shortModelLabel(setting: TranslateModelSetting): string {
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
export function balanceColor(remainingUsd: number): string {
	if (remainingUsd <= 1.0) return ANSI_RED;
	if (remainingUsd <= 3.0) return ANSI_YELLOW;
	return ANSI_GREEN;
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

// ---------------------------------------------------------------------------
// Debug notify
// ---------------------------------------------------------------------------

/**
 * Emit a debug line when `debug` is on. In the kernel rather than the status
 * slice: it is the cheapest way to see what a translation just did, and the
 * modules that need it (the translate kernel, the pipeline) are not allowed to
 * import the status slice.
 */
export function debug(ctx: ExtensionContext, message: string) {
	if (state.config.debug && ctx.hasUI)
		ctx.ui.notify(`[prompt-translate] ${message}`, "info");
}
