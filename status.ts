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
	getOpenRouterBalance,
	getUsdToCzkRate,
} from "./balance";
import { state } from "./state";
import type { TranslationUsage, TranslateModelSetting } from "./types";

const STATE_STATUS_KEY = "prompt-translate-state";

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

// Single compact, color-coded status segment: translate state, thinking, model,
// and per-session translation cost (amber). All merged into ONE key so the
// footer never overflows and hides the translate info behind "+N more".
function translateStatusText(): string {
	const config = state.config;
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
	parts.push(amber(`$${fmtSmallAmount(state.sessionCostUsd)}`));
	const bal = cachedBalance();
	if (bal) {
		parts.push(amber(`OR$${bal.remaining.toFixed(2)}`));
	}
	return parts.join(sep);
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
		costText = `, cost=$${cost.toFixed(6)}`;
		if (typeof rate === "number" && rate > 0)
			costText += ` (≈ ${(cost * rate).toFixed(3)} Kč)`;
	}
	return `input=${usage.input}, output=${usage.output}, cacheRead=${usage.cacheRead}, cacheWrite=${usage.cacheWrite}, total=${usage.totalTokens}${costText}`;
}

export function formatCost(costUsd?: number, costCzk?: number): string {
	if (typeof costUsd !== "number") return "(cost n/a)";
	const usd = `$${fmtSmallAmount(costUsd)}`;
	const czk =
		typeof costCzk === "number" ? ` / ${fmtSmallAmount(costCzk)} Kč` : "";
	return `(${usd}${czk})`;
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
		`showOriginal=${config.showOriginal ? "on" : "off"}`,
		`usdToCzk=${rateText} (ČNB)`,
		`openRouterBalance=${balanceText}`,
		`debug=${config.debug ? "on" : "off"}`,
	].join(", ");
}
