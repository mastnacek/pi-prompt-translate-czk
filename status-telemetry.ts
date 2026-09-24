// Extracted from status.ts to keep modules focused.
// status.ts — footer status segment, color palette, money/usage formatting, debug notify.

import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANSI_GREEN,
	ANSI_RED,
	ANSI_YELLOW,
	fmtSmallAmount,
} from "./status-palette";
import {
	type TranslateModelSetting,
	type TranslationUsage,
} from "./types";
import {
	getEffectiveTranslateModel,
	readDefaultModel,
} from "./config";
import {
	getUsdToCzkRate,
} from "./balance";
import {
	state,
} from "./state";

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
