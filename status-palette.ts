// Extracted from status.ts to keep modules focused.
// status.ts — footer status segment, color palette, money/usage formatting, debug notify.

import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type TranslateConfig,
} from "./types";
import {
	getEffectiveTranslateModel,
} from "./config";

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
