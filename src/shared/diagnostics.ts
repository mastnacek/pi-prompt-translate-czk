// diagnostics.ts — read-only diagnostic renderers for /status and /stats.
//
// Both are pure projections of kernel state plus the balance cache, and both are
// called by the commands slice. The footer segment that repaints on every
// translation is a different thing and lives in slices/status/render.ts.

import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCost, fmtSmallAmount, providerShortCode, shortModelLabel, ANSI_GREEN, ANSI_RED, ANSI_YELLOW } from "./format.js";
import type { TranslationUsage } from "./types.js";
import { GLOBAL_CONFIG_FILE } from "./config.js";
import {
	getEffectiveTranslateModel,
	modelLabel,
	resolveConfiguredModel,
} from "./config-model.js";
import { getOpenRouterBalance, getUsdToCzkRate } from "./balance.js";
import { state } from "./state.js";

export async function formatTelemetryOverview(
	ctx: ExtensionContext,
): Promise<string> {
	const tel = state.telemetry;
	const effectiveModel = getEffectiveTranslateModel();
	const czkRate = await getUsdToCzkRate(ctx.signal);
	// Hit rate is over prompt+answer requests only. The old denominator was
	// totalRequests, which silently includes tool-UI card translations — so turning
	// `/prompt-translate ui on` lowered the reported rate without anything about the
	// prompt/answer cache having changed. Tool requests are now listed on their own
	// line instead of being folded in invisibly.
	const cacheableRequests = tel.promptRequests + tel.answerRequests;
	const hitRate =
		cacheableRequests > 0
			? ((tel.promptAnswerCacheHits / cacheableRequests) * 100).toFixed(1)
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
		`  • Total Requests:   ${tel.totalRequests} (${tel.promptRequests} prompts, ${tel.answerRequests} answers, ${tel.toolRequests} tool-UI)`,
		"",
		"⚡ Prompt Caching & Performance",
		`  • Cache Hit Rate:   ${hitRate}% (${tel.promptAnswerCacheHits} of ${cacheableRequests} prompt+answer requests hit cache)`,
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
		`toolUiText=${config.translateToolUi ? "on" : "off"}`,
		`usdToCzk=${rateText} (ČNB)`,
		`openRouterBalance=${balanceText}`,
		`debug=${config.debug ? "on" : "off"}`,
	].join(", ");
}
