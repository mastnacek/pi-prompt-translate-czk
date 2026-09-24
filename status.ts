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

import {
	ANSI_AMBER,
	ANSI_RESET,
	ANSI_GREEN,
	ANSI_CYAN,
	ANSI_LAVENDER,
	ANSI_RED,
	ANSI_DIM,
	ANSI_YELLOW,
	ANSI_BOLD,
	ANSI_BRIGHT_GREEN,
	ANSI_BRIGHT_CYAN,
	paint,
	formatChoice,
	formatActiveValue,
	formatToggleBadge,
	buildHelpText,
	fmtSmallAmount,
} from "./status-palette";
import {
	PROVIDER_SHORT_CODES,
	providerShortCode,
	shortModelLabel,
	balanceColor,
	formatUsage,
	formatCost,
	formatTelemetryOverview,
} from "./status-telemetry";

// Re-exported so existing consumers can keep importing from this module.
// Re-exported so existing consumers can keep importing from this module.
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
export * from "./status-palette";
export * from "./status-telemetry";

const STATE_STATUS_KEY = "prompt-translate-state";

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
