import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	getAvailableModels,
	getEffectiveTranslateModel,
} from "./config.js";
import { state } from "./state.js";
import { DEFAULT_CONFIG, type TranslateConfig } from "./types.js";

export function getCommandDocs(cfg: TranslateConfig): Record<string, string> {
	const onOff = (v: boolean) => (v ? "[● ON]" : "[○ OFF]");
	const effectiveModel = getEffectiveTranslateModel();
	const modelLabel =
		cfg.temporaryModel && cfg.temporaryModelUntil
			? `${cfg.temporaryModel} (til ${cfg.temporaryModelUntil})`
			: effectiveModel.setting;

	return {
		on: "zapne překlad promptů do angličtiny",
		off: "vypne překlad promptů",
		status: "zobrazí podrobný stav překladu a zůstatek",
		input: `přepínač překladu uživatelských promptů ${onOff(cfg.enabled)}`,
		responses: `přepínač překladu odpovědí asistenta zpět ${onOff(cfg.translateResponses)}`,
		lang: `cílový jazyk pro odpovědi [● ${cfg.targetLanguage}]`,
		model: `model pro překlad [● ${modelLabel}]`,
		think: `přepínač reasoning/thinking pro překladový model ${onOff(cfg.translateReasoning)}`,
		boost: `úroveň vylepšení promptu [● ${cfg.boost}]`,
		confirm: `potvrzení přeloženého promptu před odesláním ${onOff(cfg.confirm)}`,
		history: `režim vkládání historie konverzace [● ${cfg.historyMode}]`,
		original: `zobrazení původního promptu nad překladem ${onOff(cfg.showOriginal)}`,
		diff: `zobrazení porovnání původního a vylepšeného promptu ${onOff(cfg.diff)}`,
		detect: `automatická detekce angličtiny a kódu ${onOff(cfg.autodetect)}`,
		balance: "zůstatek OpenRouter kreditu a kurz ČNB (balance refresh)",
		stats: "přehled telemetrie, úspor prompt cachingu a OpenRouter routingu",
		telemetry: "alias pro stats",
		savings: "alias pro stats",
		debug: `podrobné logování překladu do UI ${onOff(cfg.debug)}`,
		global: "správa globální konfigurace (show | off)",
		reset: "resetuje všechna nastavení na výchozí hodnoty",
		help: "zobrazí podrobnou nápovědu",
	};
}

export function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart();

	const getCompletionsClean = (cleanPrefix: string): AutocompleteItem[] | null => {
		const tokens = cleanPrefix.split(/\s+/).filter(Boolean);
		const trailingSpace = /\s$/.test(cleanPrefix);
		const normalizedPrefix = tokens.join(" ").toLowerCase();
		const cfg = state.config;

		if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
			const cmd = tokens[0].toLowerCase();

			if (
				[
					"input",
					"responses",
					"response",
					"think",
					"thinking",
					"confirm",
					"original",
					"diff",
					"detect",
					"autodetect",
					"debug",
				].includes(cmd)
			) {
				let currentVal = false;
				if (cmd === "input") currentVal = cfg.enabled;
				else if (["responses", "response"].includes(cmd)) currentVal = cfg.translateResponses;
				else if (["think", "thinking"].includes(cmd)) currentVal = cfg.translateReasoning;
				else if (cmd === "confirm") currentVal = cfg.confirm;
				else if (cmd === "original") currentVal = cfg.showOriginal;
				else if (cmd === "diff") currentVal = cfg.diff;
				else if (["detect", "autodetect"].includes(cmd)) currentVal = cfg.autodetect;
				else if (cmd === "debug") currentVal = cfg.debug;

				const items = [
					{
						value: `${cmd} on`,
						label: `${cmd} on`,
						description: `zapnout${currentVal ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: `${cmd} off`,
						label: `${cmd} off`,
						description: `vypnout${currentVal ? "" : " · ● AKTIVNÍ"}`,
					},
				];
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			if (cmd === "boost") {
				const currentBoost = cfg.boost;
				const items = [
					{
						value: "boost off",
						label: "boost off",
						description: `vypnuto (přímý překlad)${currentBoost === "off" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "boost on",
						label: "boost on",
						description: `jemné vyjasnění (clarity edit)${currentBoost === "boost" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "boost plus",
						label: "boost plus",
						description: `imperativ + lehká struktura${currentBoost === "plus" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "boost mega",
						label: "boost mega",
						description: `plné přeformulování na číslované úkoly${currentBoost === "mega" ? " · ● AKTIVNÍ" : ""}`,
					},
				];
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			if (cmd === "history") {
				const currentMode = cfg.historyMode;
				const items = [
					{
						value: "history off",
						label: "history off",
						description: `vypnuto (bez historie)${currentMode === "off" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "history ask",
						label: "history ask",
						description: `interaktivní dotaz před každým promptem${currentMode === "ask" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "history auto",
						label: "history auto",
						description: `automaticky při detekci zájmen/odkazů${currentMode === "auto" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "history always",
						label: "history always",
						description: `vždy připojit nedávnou historii${currentMode === "always" ? " · ● AKTIVNÍ" : ""}`,
					},
					{
						value: "history inspect",
						label: "history inspect",
						description: "zobrazit aktuálně extrahovaný kontext historie",
					},
				];
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			if (cmd === "balance") {
				const items = [
					{
						value: "balance refresh",
						label: "balance refresh",
						description: "vynutit načtení kurzu ČNB a kreditu OpenRouter",
					},
				];
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			if (cmd === "global") {
				const items = [
					{
						value: "global show",
						label: "global show",
						description: "zobrazit obsah globálního konfiguračního souboru",
					},
					{
						value: "global off",
						label: "global off",
						description: "smazat globální konfiguraci (použít výchozí)",
					},
				];
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			if (cmd === "model") {
				const available = getAvailableModels(state.sessionCtx);
				const activeModel = cfg.temporaryModel ?? cfg.translateModel;
				const items: AutocompleteItem[] = available.map((m) => {
					const isActive =
						m === activeModel ||
						(m === "default" && activeModel === DEFAULT_CONFIG.translateModel);
					let baseDesc = `použít model ${m}`;
					if (m === "current") {
						baseDesc = "použít aktuální model konverzace";
					} else if (m === "default") {
						baseDesc = "použít výchozí překladový model";
					}
					return {
						value: `model ${m}`,
						label: `model ${m}`,
						description: `${baseDesc}${isActive ? " · ● AKTIVNÍ" : ""}`,
					};
				});
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			if (["lang", "language", "target"].includes(cmd)) {
				const currentLang = cfg.targetLanguage.toLowerCase();
				const languages = [
					"Czech",
					"English",
					"Slovak",
					"German",
					"French",
					"Spanish",
					"Italian",
					"Polish",
					"Russian",
					"Japanese",
					"Chinese",
				];
				const items: AutocompleteItem[] = languages.map((l) => ({
					value: `lang ${l}`,
					label: `lang ${l}`,
					description: `nastavit cílový jazyk na ${l}${l.toLowerCase() === currentLang ? " · ● AKTIVNÍ" : ""}`,
				}));
				const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
				return filtered.length > 0 ? filtered : null;
			}

			return null;
		}

		const typed = (tokens[0] ?? "").toLowerCase();
		const NON_TERMINAL = new Set([
			"--global",
			"lang",
			"language",
			"target",
			"model",
			"think",
			"thinking",
			"boost",
			"history",
			"input",
			"responses",
			"confirm",
			"diff",
			"detect",
			"original",
			"debug",
			"balance",
			"global",
		]);
		const docs = getCommandDocs(cfg);
		const items: AutocompleteItem[] = [];

		if ("--global".startsWith(typed)) {
			items.push({
				value: "--global ",
				label: "--global",
				description: "uložit následující nastavení trvale (~/.pi/agent/)",
			});
		}

		for (const [key, description] of Object.entries(docs)) {
			if (key.toLowerCase().startsWith(typed)) {
				items.push({
					value: NON_TERMINAL.has(key) ? `${key} ` : key,
					label: key,
					description,
				});
			}
		}
		return items.length > 0 ? items : null;
	};

	if (trimmed.startsWith("--global")) {
		const afterGlobal = trimmed.slice(8).trimStart();
		const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);

		if (!hasTrailingSpace && afterGlobal === "") {
			return [
				{
					value: "--global ",
					label: "--global",
					description: "uložit následující nastavení trvale (~/.pi/agent/)",
				},
			];
		}

		const subCompletions = getCompletionsClean(afterGlobal);
		if (!subCompletions) return null;

		return subCompletions
			.filter((item) => item.label !== "--global")
			.map((item) => ({
				value: `--global ${item.value}`,
				label: item.label,
				description: item.description,
			}));
	}

	return getCompletionsClean(trimmed);
}
