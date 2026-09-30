// config.ts — config normalisation, persistence and command-value parsing.
//
// Model resolution (which model answers a translation call) is a separate concept
// and lives in config-model.ts, which imports this file — one direction only.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingBudgets, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { CONFIG_ENTRY_TYPE, DEFAULT_CONFIG, type BoostLevel, type TranslateConfig, type TranslateModelSetting } from "./types.js";

// Global config file: applies to every session. Precedence:
// DEFAULT_CONFIG < global file < session entries (per-session overrides win).
const GLOBAL_CONFIG_FILE = join(getAgentDir(), "pi-prompt-translate.json");

// Thinking effort applied when translateReasoning is on and the translate model
// is reasoning-capable. "low" keeps translation cheap and fast while still
// letting the model silently fix typos/grammar. Reasoning tokens are capped via
// thinkingBudgets so a single translation call can't balloon in cost.
const TRANSLATE_REASONING_LEVEL = "low" as const satisfies ThinkingLevel;
const TRANSLATE_REASONING_BUDGET: ThinkingBudgets = { minimal: 256, low: 640 };

export {
	GLOBAL_CONFIG_FILE,
	TRANSLATE_REASONING_LEVEL,
	TRANSLATE_REASONING_BUDGET,
};

import { normalizeLanguage } from "./languages.js";
export { normalizeLanguage };

export function normalizeConfig(
	value: Partial<TranslateConfig>,
): TranslateConfig {
	return {
		...DEFAULT_CONFIG,
		...value,
		translateResponses:
			value.translateResponses ?? DEFAULT_CONFIG.translateResponses,
		translateModel: value.translateModel ?? DEFAULT_CONFIG.translateModel,
		translateReasoning:
			value.translateReasoning ?? DEFAULT_CONFIG.translateReasoning,
		// Legacy sessions persisted boost as a boolean; accept both shapes.
		boost:
			(value as { boost?: BoostLevel | boolean }).boost === true
				? "boost"
				: (value as { boost?: BoostLevel | boolean }).boost === false
					? "off"
					: (value.boost ?? DEFAULT_CONFIG.boost),
		historyMode:
			value.historyMode === "ask" ||
			value.historyMode === "auto" ||
			value.historyMode === "always" ||
			value.historyMode === "off"
				? value.historyMode
				: (value.historyMode as unknown) === true
					? "ask"
					: DEFAULT_CONFIG.historyMode,
		confirm: value.confirm ?? DEFAULT_CONFIG.confirm,
		showOriginal: value.showOriginal ?? DEFAULT_CONFIG.showOriginal,
		diff: value.diff ?? DEFAULT_CONFIG.diff,
		autodetect: value.autodetect ?? DEFAULT_CONFIG.autodetect,
		translateToolUi: value.translateToolUi ?? DEFAULT_CONFIG.translateToolUi,
		toolUiTools: Array.isArray(value.toolUiTools)
			? value.toolUiTools
					.filter((name): name is string => typeof name === "string")
					.map((name) => name.trim())
					.filter((name) => name.length > 0)
			: undefined,
		debug: value.debug ?? DEFAULT_CONFIG.debug,
	};
}

export function loadGlobalConfig(): Partial<TranslateConfig> {
	try {
		return JSON.parse(
			readFileSync(GLOBAL_CONFIG_FILE, "utf8"),
		) as Partial<TranslateConfig>;
	} catch {
		return {};
	}
}

export function saveGlobalConfig(cfg: Partial<TranslateConfig> = state.config) {
	try {
		// Ensure ~/.pi/agent exists before writing (AGENTS.md §5) — the agent dir
		// may not exist on a fresh machine.
		mkdirSync(dirname(GLOBAL_CONFIG_FILE), { recursive: true });
		writeFileSync(
			GLOBAL_CONFIG_FILE,
			JSON.stringify(cfg, null, 2),
			"utf8",
		);
	} catch {
		/* best-effort: global persistence must never break the session */
	}
}

export function clearGlobalConfig() {
	try {
		if (existsSync(GLOBAL_CONFIG_FILE)) unlinkSync(GLOBAL_CONFIG_FILE);
	} catch {
		/* best-effort */
	}
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-prompt-translate.json");
}

export function loadProjectConfig(cwd: string): Partial<TranslateConfig> {
	try {
		const filePath = projectConfigPath(cwd);
		if (existsSync(filePath)) {
			return JSON.parse(readFileSync(filePath, "utf8")) as Partial<TranslateConfig>;
		}
	} catch {
		/* ignore */
	}
	return {};
}

export function saveProjectConfig(cwd: string, cfg: Partial<TranslateConfig>) {
	try {
		const projDir = join(cwd, ".pi");
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			join(projDir, "pi-prompt-translate.json"),
			JSON.stringify(cfg, null, 2),
			"utf8",
		);
	} catch {
		/* ignore */
	}
}

export function saveConfig(
	cfg: Partial<TranslateConfig>,
	isGlobal = false,
	cwd?: string,
) {
	// `cfg` is threaded through on both paths. It used to be dropped in global mode,
	// which only worked because the sole caller passed state.config — the next
	// caller to pass anything else would have had its argument silently ignored.
	if (isGlobal || !cwd) {
		saveGlobalConfig(cfg);
	} else {
		saveProjectConfig(cwd, cfg);
	}
}

export function extractLatestConfig(ctx: ExtensionContext): TranslateConfig {
	const globalCfg = loadGlobalConfig();
	const projectCfg = ctx.cwd ? loadProjectConfig(ctx.cwd) : {};
	let latest = normalizeConfig({ ...globalCfg, ...projectCfg });
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === CONFIG_ENTRY_TYPE &&
			entry.data &&
			typeof entry.data === "object"
		) {
			latest = normalizeConfig({
				...latest,
				...(entry.data as Partial<TranslateConfig>),
			});
		}
	}
	return latest;
}

export function persistConfig(pi: ExtensionAPI) {
	pi.appendEntry(CONFIG_ENTRY_TYPE, state.config);
}

export function parseModelSetting(
	raw: string,
): TranslateModelSetting | undefined {
	const value = raw.trim();
	if (value === "current" || value === "default") return value;
	if (/^[^\s/]+\/.+$/.test(value)) return value as `${string}/${string}`;
	return undefined;
}

// Parse "until" dates as local end-of-day, so "until 2026-08-26" keeps the
// temporary model active through that whole day.
export function parseUntilDate(raw: string): Date | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!m) return undefined;
	const d = new Date(
		Number(m[1]),
		Number(m[2]) - 1,
		Number(m[3]),
		23,
		59,
		59,
		999,
	);
	return Number.isNaN(d.getTime()) ? undefined : d;
}
