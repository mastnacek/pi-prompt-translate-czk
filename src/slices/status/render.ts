// status/render.ts — the footer status segment: the one place that paints it.
//
// This slice owns the rendering. Everyone else asks for a repaint through the
// kernel seam (shared/status-bus.ts) so no other slice has to import this file.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEffectiveTranslateModel } from "../../shared/config-model.js";
import { TRANSLATE_REASONING_LEVEL } from "../../shared/config.js";
import { getOpenRouterBalance, getUsdToCzkRate, cachedBalance, cachedUsdToCzkRate } from "../../shared/balance.js";
import { state } from "../../shared/state.js";
import { ANSI_AMBER, ANSI_CYAN, ANSI_DIM, ANSI_GREEN, ANSI_LAVENDER, ANSI_RED, ANSI_YELLOW, balanceColor, fmtSmallAmount, paint, shortModelLabel } from "../../shared/format.js";

const STATE_STATUS_KEY = "prompt-translate-state";

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
