// types.ts — shared types, entry-type constants, and default config.
// Pure data: no imports from other modules (leaf of the dependency graph).

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONFIG_ENTRY_TYPE = "pi-prompt-translate-config";
export const STATE_ENTRY_TYPE = "pi-prompt-translate-state";
export const FINAL_TRANSLATION_ENTRY_TYPE =
	"pi-prompt-translate-final-translation";

export type TranslateModelSetting =
	| "current"
	| "default"
	| `${string}/${string}`;

/** Prompt enhancement level: "off" = plain translation, "boost" = faithful clarity
 *  edit, "plus" = imperative + light structure with strict fidelity,
 *  "mega" = full restructure into imperative, ordered tasks. */
export type BoostLevel = "off" | "boost" | "plus" | "mega";

export type TranslateConfig = {
	enabled: boolean;
	translateResponses: boolean;
	targetLanguage: string;
	translateModel: TranslateModelSetting;
	/** Optional temporary model override, active until `temporaryModelUntil` (inclusive),
	 *  then automatically falls back to `translateModel`. */
	temporaryModel?: TranslateModelSetting;
	/** ISO date (YYYY-MM-DD). The temporary model is used through the end of this day. */
	temporaryModelUntil?: string;
	/** Toggle thinking/reasoning for the translate model (only honored when the model supports it). */
	translateReasoning: boolean;
	/** Prompt enhancement level applied while translating (single LLM call).
	 *  "boost" = light faithful clarity edit, "mega" = restructure into ordered tasks. */
	boost: BoostLevel;
	/** When on, the original (untranslated) prompt is rendered above the translated
	 *  user message in a box with a distinct background color. */
	showOriginal: boolean;
	/** When on, displays a side-by-side or stacked diff of the original vs enhanced
	 *  prompt along with token usage and cost summary. */
	diff: boolean;
	/** When on, automatically detects if a prompt is already pure English or code
	 *  and skips translation to save latency and tokens. */
	autodetect: boolean;
	debug: boolean;
};

export type PendingTranslation = {
	turnIndex?: number;
	targetLanguage: string;
	translateResponses: boolean;
};

export type TranslationUsage = AssistantMessage["usage"];

export type TranslationResult = {
	text: string;
	usage: TranslationUsage;
	costUsd?: number;
	costCzk?: number;
};

export type ProtectedSegment = {
	placeholder: string;
	value: string;
};

export type ProtectedText = {
	text: string;
	segments: ProtectedSegment[];
};

export type FinalTranslationRecord = {
	at: string;
	targetLanguage: string;
	english: string;
	translated: string;
	translateModel: TranslateModelSetting;
	usage?: TranslationUsage;
};

export type ModelWithAuth = {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

export type ExtensionGenerationTraceOptions = {
	name?: string;
	extension?: string;
	purpose?: string;
	metadata?: Record<string, unknown>;
};

export type InstrumentedCompleteSimpleOptions = SimpleStreamOptions & {
	trace?: ExtensionGenerationTraceOptions;
};

export type InstrumentedCompleteSimple = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: InstrumentedCompleteSimpleOptions,
) => Promise<AssistantMessage>;

export type ExtensionContextWithCompleteSimple = ExtensionContext & {
	completeSimple?: InstrumentedCompleteSimple;
};

export type BalanceInfo = { remaining: number; total: number; used: number };

export const DEFAULT_CONFIG: TranslateConfig = {
	enabled: true,
	translateResponses: true,
	targetLanguage: "Czech",
	translateModel: "openrouter/google/gemini-3.5-flash-lite",
	translateReasoning: true,
	boost: "off",
	showOriginal: true,
	diff: true,
	autodetect: true,
	debug: false,
};
