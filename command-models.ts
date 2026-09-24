import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	parseModelSetting,
	parseUntilDate,
	resolveConfiguredModel,
} from "./config.js";
import { state } from "./state.js";
import { formatChoice, updateTranslateStatus } from "./status.js";
import type { BoostLevel } from "./types.js";

export async function handleModelCommands(
	subcommand: string,
	rest: string[],
	ctx: ExtensionCommandContext,
	persist: () => void,
	writeGlobal: boolean,
): Promise<boolean> {
	const config = state.config;

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
			return true;
		}
		if (untilIndex >= 0) {
			const untilRaw = rest[untilIndex + 1] ?? "";
			const until = parseUntilDate(untilRaw);
			if (!until) {
				ctx.ui.notify(
					`Invalid "until" date: ${untilRaw || "(missing)"}. Use YYYY-MM-DD.`,
					"warning",
				);
				return true;
			}
			if (until.getTime() < Date.now()) {
				ctx.ui.notify(
					`"until" date ${untilRaw} is in the past; keeping ${config.translateModel}.`,
					"warning",
				);
				return true;
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
				`prompt-translate using ${modelSetting} until ${untilRaw} (inclusive), then falling back to ${config.translateModel}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
				"info",
			);
			return true;
		}
		config.translateModel = modelSetting;
		config.temporaryModel = undefined;
		config.temporaryModelUntil = undefined;
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate translation model set to ${modelSetting}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (
		subcommand === "think" ||
		subcommand === "thinking" ||
		subcommand === "reason" ||
		subcommand === "reasoning"
	) {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate thinking: ${formatChoice(["on", "off"], config.translateReasoning)}\nPoužití: /prompt-translate think on|off`,
				"info",
			);
			return true;
		}
		config.translateReasoning = value === "on";
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate thinking ${value}${value === "on" ? " (uses reasoning when the translate model supports it)" : ""}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
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
				`prompt-translate boost: ${formatChoice(["off", "on", "plus", "mega"], config.boost)}\nPoužití: /prompt-translate boost off|on|plus|mega`,
				"info",
			);
			return true;
		}
		config.boost = level;
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate boost level: ${level}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	return false;
}
