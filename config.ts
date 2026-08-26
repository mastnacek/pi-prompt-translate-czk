// config.ts — config normalization/persistence, model resolution, language aliases.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ThinkingBudgets, ThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./state";
import {
	CONFIG_ENTRY_TYPE,
	DEFAULT_CONFIG,
	type BoostLevel,
	type ModelWithAuth,
	type TranslateConfig,
	type TranslateModelSetting,
} from "./types";

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

export function normalizeLanguage(input: string): string {
	const value = input.trim().toLowerCase();
	const aliases: Record<string, string> = {
		ar: "Arabic",
		arabic: "Arabic",
		아랍어: "Arabic",
		العربية: "Arabic",
		cn: "Chinese",
		chinese: "Chinese",
		zh: "Chinese",
		zhcn: "Chinese",
		"zh-cn": "Chinese",
		중국어: "Chinese",
		中文: "Chinese",
		de: "German",
		deu: "German",
		german: "German",
		독일어: "German",
		deutsch: "German",
		en: "English",
		eng: "English",
		english: "English",
		영어: "English",
		es: "Spanish",
		esp: "Spanish",
		spanish: "Spanish",
		스페인어: "Spanish",
		español: "Spanish",
		fr: "French",
		fra: "French",
		fre: "French",
		french: "French",
		프랑스어: "French",
		français: "French",
		hi: "Hindi",
		hin: "Hindi",
		hindi: "Hindi",
		힌디어: "Hindi",
		हिन्दी: "Hindi",
		id: "Indonesian",
		ind: "Indonesian",
		indonesian: "Indonesian",
		인도네시아어: "Indonesian",
		"bahasa indonesia": "Indonesian",
		it: "Italian",
		ita: "Italian",
		italian: "Italian",
		이탈리아어: "Italian",
		italiano: "Italian",
		ja: "Japanese",
		jp: "Japanese",
		japanese: "Japanese",
		일본어: "Japanese",
		日本語: "Japanese",
		ko: "Korean",
		kor: "Korean",
		korean: "Korean",
		한국어: "Korean",
		한글: "Korean",
		nl: "Dutch",
		dut: "Dutch",
		nld: "Dutch",
		dutch: "Dutch",
		네덜란드어: "Dutch",
		nederlands: "Dutch",
		pl: "Polish",
		pol: "Polish",
		polish: "Polish",
		폴란드어: "Polish",
		polski: "Polish",
		pt: "Portuguese",
		por: "Portuguese",
		portuguese: "Portuguese",
		포르투갈어: "Portuguese",
		português: "Portuguese",
		ru: "Russian",
		rus: "Russian",
		russian: "Russian",
		러시아어: "Russian",
		русский: "Russian",
		th: "Thai",
		tha: "Thai",
		thai: "Thai",
		태국어: "Thai",
		ไทย: "Thai",
		tr: "Turkish",
		tur: "Turkish",
		turkish: "Turkish",
		터키어: "Turkish",
		türkçe: "Turkish",
		vi: "Vietnamese",
		vie: "Vietnamese",
		vietnamese: "Vietnamese",
		베트남어: "Vietnamese",
		"tiếng việt": "Vietnamese",
	};
	return aliases[value] ?? input.trim();
}

export function normalizeConfig(value: Partial<TranslateConfig>): TranslateConfig {
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
		showOriginal: value.showOriginal ?? DEFAULT_CONFIG.showOriginal,
		diff: value.diff ?? DEFAULT_CONFIG.diff,
		autodetect: value.autodetect ?? DEFAULT_CONFIG.autodetect,
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

export function saveGlobalConfig() {
	try {
		writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(state.config, null, 2), "utf8");
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

export function extractLatestConfig(ctx: ExtensionContext): TranslateConfig {
	let latest = normalizeConfig(loadGlobalConfig());
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

export function parseModelSetting(raw: string): TranslateModelSetting | undefined {
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

// The model actually used for translation right now: the temporary override while
// it is still valid, otherwise the base translateModel. An expired override is
// cleared and persisted so the fallback is automatic and permanent.
export function getEffectiveTranslateModel(): {
	setting: TranslateModelSetting;
	temporaryUntil?: Date;
} {
	const config = state.config;
	if (config.temporaryModel && config.temporaryModelUntil) {
		const until = parseUntilDate(config.temporaryModelUntil);
		if (until && Date.now() <= until.getTime()) {
			return { setting: config.temporaryModel, temporaryUntil: until };
		}
		config.temporaryModel = undefined;
		config.temporaryModelUntil = undefined;
		state.piApi?.appendEntry(CONFIG_ENTRY_TYPE, config);
	}
	return { setting: config.translateModel };
}

export function readDefaultModel(): { provider?: string; model?: string } {
	try {
		const settings = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		) as {
			defaultProvider?: string;
			defaultModel?: string;
		};
		return { provider: settings.defaultProvider, model: settings.defaultModel };
	} catch {
		return {};
	}
}

export function modelLabel(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

export async function resolveConfiguredModel(
	ctx: ExtensionContext,
	settingOverride?: TranslateModelSetting,
): Promise<Model<Api>> {
	const setting = settingOverride ?? getEffectiveTranslateModel().setting;
	if (setting === "current") {
		const model = ctx.model as Model<Api> | undefined;
		if (!model) throw new Error("No active model is selected.");
		return model;
	}

	if (setting === "default") {
		const { provider, model } = readDefaultModel();
		if (!provider || !model)
			throw new Error(
				"defaultProvider/defaultModel is not configured in pi settings.",
			);
		const found = ctx.modelRegistry.find(provider, model) as
			| Model<Api>
			| undefined;
		if (!found) throw new Error(`Default model not found: ${provider}/${model}`);
		return found;
	}

	const slash = setting.indexOf("/");
	const provider = setting.slice(0, slash);
	const modelId = setting.slice(slash + 1);
	const found = ctx.modelRegistry.find(provider, modelId) as
		| Model<Api>
		| undefined;
	if (!found) throw new Error(`Translation model not found: ${setting}`);
	return found;
}

export async function getModelAndAuth(
	ctx: ExtensionContext,
	settingOverride?: TranslateModelSetting,
): Promise<ModelWithAuth> {
	const model = await resolveConfiguredModel(ctx, settingOverride);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}
