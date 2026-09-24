import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { formatChoice, updateTranslateStatus } from "./status.js";

export function handleToggleCommands(
	subcommand: string,
	rest: string[],
	ctx: ExtensionCommandContext,
	persist: () => void,
	writeGlobal: boolean,
): boolean {
	const config = state.config;

	if (subcommand === "on" || subcommand === "enable") {
		config.enabled = true;
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate input enabled (target: ${config.targetLanguage})${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (subcommand === "off" || subcommand === "disable") {
		config.enabled = false;
		state.pending = undefined;
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate input disabled${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (["input", "prompt", "prompts"].includes(subcommand)) {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate input: ${formatChoice(["on", "off"], config.enabled)}\nPoužití: /prompt-translate input on|off`,
				"info",
			);
			return true;
		}
		config.enabled = value === "on";
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate input ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (["responses", "response", "reply", "replies", "output"].includes(subcommand)) {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate responses: ${formatChoice(["on", "off"], config.translateResponses)}\nPoužití: /prompt-translate responses on|off`,
				"info",
			);
			return true;
		}
		config.translateResponses = value === "on";
		if (state.pending) state.pending.translateResponses = config.translateResponses;
		persist();
		ctx.ui.notify(
			`prompt-translate responses ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (subcommand === "confirm") {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate confirm: ${formatChoice(["on", "off"], config.confirm)}\nPoužití: /prompt-translate confirm on|off`,
				"info",
			);
			return true;
		}
		config.confirm = value === "on";
		persist();
		updateTranslateStatus(ctx);
		ctx.ui.notify(
			`prompt-translate translation confirmation ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (subcommand === "diff") {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate diff: ${formatChoice(["on", "off"], config.diff)}\nPoužití: /prompt-translate diff on|off`,
				"info",
			);
			return true;
		}
		config.diff = value === "on";
		persist();
		ctx.ui.notify(
			`prompt-translate translation diff summary ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (subcommand === "detect" || subcommand === "autodetect") {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate detect: ${formatChoice(["on", "off"], config.autodetect)}\nPoužití: /prompt-translate detect on|off`,
				"info",
			);
			return true;
		}
		config.autodetect = value === "on";
		persist();
		ctx.ui.notify(
			`prompt-translate dynamic language detection ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	if (subcommand === "debug") {
		const value = rest[0];
		if (value !== "on" && value !== "off") {
			ctx.ui.notify(
				`prompt-translate debug: ${formatChoice(["on", "off"], config.debug)}\nPoužití: /prompt-translate debug on|off`,
				"info",
			);
			return true;
		}
		config.debug = value === "on";
		persist();
		ctx.ui.notify(
			`prompt-translate debug ${value}${writeGlobal ? " (uloženo globálně)" : " (uloženo do projektu)"}`,
			"info",
		);
		return true;
	}

	return false;
}
