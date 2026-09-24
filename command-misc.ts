import { existsSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	clearBalanceCache,
	getOpenRouterBalance,
	getUsdToCzkRate,
} from "./balance.js";
import {
	clearGlobalConfig,
	GLOBAL_CONFIG_FILE,
	normalizeLanguage,
} from "./config.js";
import { state } from "./state.js";
import {
	formatActiveValue,
	formatChoice,
	formatTelemetryOverview,
	refreshBalanceStatus,
	statusText,
	updateTranslateStatus,
} from "./status.js";
import { extractRecentContext } from "./translate.js";
import { DEFAULT_CONFIG } from "./types.js";

export async function handleMiscCommands(
	subcommand: string,
	rest: string[],
	ctx: ExtensionCommandContext,
	persist: () => void,
	writeGlobal: boolean,
): Promise<boolean> {
	const config = state.config;

	if (subcommand === "status") {
		ctx.ui.notify(await statusText(ctx), "info");
		return true;
	}
	if (
		subcommand === "stats" ||
		subcommand === "telemetry" ||
		subcommand === "savings"
	) {
		ctx.ui.notify(await formatTelemetryOverview(ctx), "info");
		return true;
	}
	if (
		subcommand === "lang" ||
		subcommand === "language" ||
		subcommand === "target"
	) {
		const language = normalizeLanguage(rest.join(" "));
		if (!language) {
			ctx.ui.notify(
				`prompt-translate target language: ${formatActiveValue(config.targetLanguage)}\nPoužití: /prompt-translate lang <language>`,
				"info",
			);
			return true;
		}
		config.targetLanguage = language;
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate target language set to ${language}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}
	if (subcommand === "history") {
		const value = (rest[0] ?? "").toLowerCase();
		if (value === "inspect" || value === "show" || value === "preview") {
			const context = extractRecentContext(ctx);
			if (context) {
				ctx.ui.notify(
					`prompt-translate history (mód: ${formatChoice(["off", "ask", "auto", "always"], config.historyMode)}) — extrahovaný kontext:\n\n${context}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`prompt-translate history (mód: ${formatChoice(["off", "ask", "auto", "always"], config.historyMode)}): Žádný kontext předchozí konverzace k odeslání.`,
					"info",
				);
			}
			return true;
		}
		const mode =
			value === "on" || value === "ask"
				? "ask"
				: value === "off"
					? "off"
					: value === "auto"
						? "auto"
						: value === "always"
							? "always"
							: undefined;
		if (!mode) {
			ctx.ui.notify(
				`prompt-translate history: ${formatChoice(["off", "ask", "auto", "always"], config.historyMode)} | \x1b[2minspect\x1b[0m`,
				"info",
			);
			return true;
		}
		config.historyMode = mode;
		persist();
		ctx.ui.notify(
			`prompt-translate history context: ${mode}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}
	if (["original", "showoriginal", "source"].includes(subcommand)) {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate original: ${formatChoice(["on", "off"], config.showOriginal)}\nPoužití: /prompt-translate original on|off`,
				"info",
			);
			return true;
		}
		config.showOriginal = value === "on";
		persist();
		ctx.ui.notify(
			`prompt-translate original prompt display ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}
	if (subcommand === "balance") {
		const force = rest[0];
		if (force === "refresh") clearBalanceCache();
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
			lines.push("OpenRouter: balance unavailable");
		}
		ctx.ui.notify(lines.join(" | "), "info");
		return true;
	}
	if (subcommand === "reset") {
		state.config = { ...DEFAULT_CONFIG };
		state.pending = undefined;
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify("prompt-translate settings reset", "info");
		return true;
	}
	if (subcommand === "global") {
		const value = rest[0];
		if (value === "off" || value === "clear") {
			clearGlobalConfig();
			ctx.ui.notify("prompt-translate global config cleared", "info");
			return true;
		}
		if (!value || value === "show") {
			ctx.ui.notify(
				existsSync(GLOBAL_CONFIG_FILE)
					? `prompt-translate global config (${GLOBAL_CONFIG_FILE}):\n${JSON.stringify(config, null, 2)}`
					: "prompt-translate has no active global config (using defaults)",
				"info",
			);
			return true;
		}
		ctx.ui.notify("Usage: /prompt-translate global [show|off]", "warning");
		return true;
	}

	return false;
}
