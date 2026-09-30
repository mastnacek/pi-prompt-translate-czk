// config-model.ts — which model answers a translation call.
//
// Owns the temporary-override lifetime, registry lookups and auth, plus dynamic
// model discovery. Split from config.ts by concept (resolution vs. persistence),
// not by line count: the two never change together and the model half needs
// `getAgentDir`, the config half does not.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_ENTRY_TYPE, type ModelWithAuth, type TranslateModelSetting } from "./types.js";
import { parseUntilDate } from "./config.js";
import { state } from "./state.js";

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

/**
 * Dynamic model discovery following native Pi ModelRegistry, store, and settings.
 */
export function getAvailableModels(ctx?: ExtensionContext): string[] {
	const models = new Set<string>(["current", "default"]);

	// 1. Inspect runtime ModelRegistry
	try {
		const registry = (
			ctx as {
				modelRegistry?: {
					getModels?: () => Array<{ provider?: string; id?: string }>;
				};
			}
		)?.modelRegistry;
		if (registry?.getModels) {
			for (const m of registry.getModels()) {
				if (m.provider && m.id) {
					models.add(`${m.provider}/${m.id}`);
				}
			}
		}
	} catch {
		// Non-fatal
	}

	// 2. Read models from ~/.pi/agent/models.json (custom providers)
	try {
		const customModelsPath = join(getAgentDir(), "models.json");
		if (existsSync(customModelsPath)) {
			const data = JSON.parse(readFileSync(customModelsPath, "utf8")) as {
				providers?: Record<string, { models?: Array<{ id?: string }> }>;
			};
			if (data.providers) {
				for (const [provider, info] of Object.entries(data.providers)) {
					if (Array.isArray(info?.models)) {
						for (const m of info.models) {
							if (m?.id) models.add(`${provider}/${m.id}`);
						}
					}
				}
			}
		}
	} catch {
		// Non-fatal
	}

	// 3. Read models from ~/.pi/agent/models-store.json (cached remote catalogs)
	try {
		const storePath = join(getAgentDir(), "models-store.json");
		if (existsSync(storePath)) {
			const data = JSON.parse(readFileSync(storePath, "utf8")) as Record<
				string,
				{ models?: Array<string | { id?: string }> }
			>;
			for (const [provider, info] of Object.entries(data)) {
				if (Array.isArray(info?.models)) {
					for (const m of info.models) {
						const id = typeof m === "string" ? m : m?.id;
						if (id) models.add(`${provider}/${id}`);
					}
				}
			}
		}
	} catch {
		// Non-fatal
	}

	// 4. Read models from ~/.pi/agent/settings.json
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (existsSync(settingsPath)) {
			const data = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
				string,
				unknown
			>;
			const provs = data.providers as
				| Record<string, { models?: Array<string | { id?: string }> }>
				| undefined;
			if (provs && typeof provs === "object") {
				for (const [provider, info] of Object.entries(provs)) {
					if (Array.isArray(info?.models)) {
						for (const m of info.models) {
							const id = typeof m === "string" ? m : m?.id;
							if (id) models.add(`${provider}/${id}`);
						}
					}
				}
			}
		}
	} catch {
		// Non-fatal
	}

	return Array.from(models);
}
