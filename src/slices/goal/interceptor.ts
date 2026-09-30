// goal/interceptor.ts — /goal objective translation via AgentSession.prompt interception.
//
// pi dispatches extension commands (pi.registerCommand, e.g. pi-goal's /goal)
// BEFORE the input event fires (agent-session prompt(): _tryExecuteExtensionCommand
// runs first, input event only when no command matched). So an input handler can
// never see /goal text. All extensions share one pi-coding-agent module instance,
// so wrapping AgentSession.prototype.prompt here intercepts /goal submissions
// before command dispatch, translates only the objective, and passes the rebuilt
// command text through unchanged in shape.
//
// The /goal scaffold parser is not here: it is shared with the pipeline, so it
// lives in the kernel (../../shared/goal-command.ts).

import { AgentSession } from "@earendil-works/pi-coding-agent";
import { getEffectiveTranslateModel } from "../../shared/config-model.js";
import { formatCost } from "../../shared/format.js";
import { extractGoalObjective } from "../../shared/goal-command.js";
import { detectLanguageOrCode, translate } from "../../shared/translate/index.js";
import { state } from "../../shared/state.js";
import { STATE_ENTRY_TYPE } from "../../shared/types.js";

const PROMPT_INTERCEPTOR_MARKER = Symbol.for(
	"pi-prompt-translate.prompt-interceptor",
);
/** The pristine AgentSession.prototype.prompt, stashed before the first wrap. */
const PROMPT_INTERCEPTOR_ORIGINAL = Symbol.for(
	"pi-prompt-translate.prompt-original",
);
/**
 * The live translation handler. The wrapper installed on the prototype is stable,
 * but the handler behind it is re-registered on every module load.
 */
const PROMPT_INTERCEPTOR_HANDLER = Symbol.for(
	"pi-prompt-translate.prompt-handler",
);

type PromptOptions = {
	images?: unknown[];
	source?: string;
};

type PromptHandler = (
	text: string,
	options?: PromptOptions,
) => Promise<string>;

async function translateGoalCommandText(
	text: string,
	options?: PromptOptions,
): Promise<string> {
	const config = state.config;
	if (!config.enabled) return text;
	if (options?.source === "extension") {
		// pi-goal continuation prompts bypass the input event (source "extension").
		// Re-arm the pending response translation in case a mid-goal plain-text turn
		// consumed it before the goal's actual final briefing.
		if (text.includes("pi-goal-prompt")) {
			state.pending = {
				targetLanguage: config.targetLanguage,
				translateResponses: config.translateResponses,
			};
		}
		return text;
	}
	if (options?.images?.length) return text;
	if (!text.startsWith("/goal")) return text;
	const ctx = state.sessionCtx;
	if (!ctx) return text;
	const goalCommand = extractGoalObjective(text);
	if (!goalCommand?.objective) return text;

	if (config.autodetect && config.boost === "off") {
		const detection = detectLanguageOrCode(goalCommand.objective);
		if (detection.isEnglishOrCode) {
			state.pending = {
				targetLanguage: config.targetLanguage,
				translateResponses: config.translateResponses,
			};
			return text;
		}
	}

	try {
		const translated = await translate(
			ctx,
			goalCommand.objective,
			"English",
			"prompt",
		);
		const rebuilt = goalCommand.rebuild(translated.text);
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`prompt-translate: /goal objective → EN ${formatCost(translated.costUsd, translated.costCzk)}`,
					"info",
				);
			}
		} catch {
			/* ignore notification failure if ctx is stale */
		}
		state.pending = {
			targetLanguage: config.targetLanguage,
			translateResponses: config.translateResponses,
		};
		state.lastGoalTransform = { from: text, to: rebuilt, at: Date.now() };
		state.piApi?.appendEntry(STATE_ENTRY_TYPE, {
			at: new Date().toISOString(),
			source: text,
			english: rebuilt,
			targetLanguage: config.targetLanguage,
			translateModel: getEffectiveTranslateModel().setting,
			boost: config.boost,
			usage: translated.usage,
			costUsd: translated.costUsd,
			costCzk: translated.costCzk,
		});
		return rebuilt;
	} catch (error) {
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`prompt translation failed; continuing with original /goal objective: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		} catch {
			/* ignore notification failure if ctx is stale */
		}
		return text;
	}
}

export function installPromptInterceptor() {
	const proto = AgentSession.prototype as unknown as Record<
		PropertyKey,
		unknown
	>;

	// Always re-point the wrapper at THIS module instance's `state`. A /reload
	// drops the extension cache and rebuilds the module graph, so `state` below is
	// a fresh object while `AgentSession.prototype` is not. Registering the handler
	// unconditionally is what keeps /goal translating after a reload; the previous
	// version bailed out on the marker and left the prototype calling a closure
	// holding a dead sessionCtx, so /goal silently stopped translating.
	proto[PROMPT_INTERCEPTOR_HANDLER] =
		translateGoalCommandText as unknown as PromptHandler;

	if (proto[PROMPT_INTERCEPTOR_MARKER]) return;

	// Unwrap from the pristine original, never from a previous wrapper: pi loads
	// every extension against one shared AgentSession, and a re-wrap of a re-wrap
	// would translate the same text once per install.
	const stashed = proto[PROMPT_INTERCEPTOR_ORIGINAL];
	const current = stashed ?? proto.prompt;
	if (typeof current !== "function") return;
	proto[PROMPT_INTERCEPTOR_ORIGINAL] = current;

	const originalPrompt = current as (
		this: unknown,
		text: string,
		options?: PromptOptions,
	) => Promise<unknown>;
	proto.prompt = async function (
		this: unknown,
		text: string,
		options?: PromptOptions,
	) {
		let rewritten = text;
		try {
			// Read the handler off the prototype on every call, never capture it:
			// the binding is replaced by the next module load.
			const handler = proto[PROMPT_INTERCEPTOR_HANDLER] as
				| PromptHandler
				| undefined;
			if (handler) rewritten = await handler(text, options);
		} catch {
			rewritten = text;
		}
		return originalPrompt.call(this, rewritten, options);
	};
	proto[PROMPT_INTERCEPTOR_MARKER] = true;
}

/** Restore AgentSession.prototype.prompt to its unpatched form. */
export function uninstallPromptInterceptor() {
	const proto = AgentSession.prototype as unknown as Record<
		PropertyKey,
		unknown
	>;
	if (!proto[PROMPT_INTERCEPTOR_MARKER]) return;
	const original = proto[PROMPT_INTERCEPTOR_ORIGINAL];
	if (typeof original === "function") proto.prompt = original;
	delete proto[PROMPT_INTERCEPTOR_MARKER];
	delete proto[PROMPT_INTERCEPTOR_ORIGINAL];
	delete proto[PROMPT_INTERCEPTOR_HANDLER];
}
