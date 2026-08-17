// goal.ts — /goal objective translation via AgentSession.prompt interception.
//
// pi dispatches extension commands (pi.registerCommand, e.g. pi-goal's /goal)
// BEFORE the input event fires (agent-session prompt(): _tryExecuteExtensionCommand
// runs first, input event only when no command matched). So an input handler can
// never see /goal text. All extensions share one pi-coding-agent module instance,
// so wrapping AgentSession.prototype.prompt here intercepts /goal submissions
// before command dispatch, translates only the objective, and passes the rebuilt
// command text through unchanged in shape.

import { AgentSession } from "@earendil-works/pi-coding-agent";
import { getEffectiveTranslateModel } from "./config";
import { formatCost } from "./status";
import { translate } from "./translate";
import { state } from "./state";
import { STATE_ENTRY_TYPE } from "./types";

// Subcommands that never carry an objective (pi-goal parseCommand).
const GOAL_CONTROL_SUBCOMMANDS = new Set([
	"pause",
	"resume",
	"clear",
	"stop",
	"status",
	"drop-last",
	"pop",
	"skip",
	"shift",
]);

// Subcommands whose remaining arguments are the objective text.
const GOAL_OBJECTIVE_SUBCOMMANDS = new Set([
	"edit",
	"add",
	"push",
	"prioritize",
	"unshift",
]);

type GoalObjectiveExtraction = {
	// Objective text to translate; undefined = nothing to translate (control command or usage error).
	objective?: string;
	rebuild: (translatedObjective: string) => string;
};

// Split `/goal ...` into the untranslatable command scaffold and the objective text.
// Returns undefined when the text is not a /goal command at all.
export function extractGoalObjective(
	text: string,
): GoalObjectiveExtraction | undefined {
	const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
	if (!match) return undefined;
	const noObjective: GoalObjectiveExtraction = { rebuild: (t) => t };
	const args = match[1]?.trim() ?? "";
	if (!args) return noObjective; // bare "/goal" shows status
	const firstWord = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
	if (!firstWord) return noObjective;
	if (GOAL_CONTROL_SUBCOMMANDS.has(firstWord[1])) return noObjective;
	let prefix = "";
	let rest = args;
	if (GOAL_OBJECTIVE_SUBCOMMANDS.has(firstWord[1])) {
		if (!firstWord[2]?.trim()) return noObjective; // e.g. "/goal edit" opens the menu
		prefix = `${firstWord[1]} `;
		rest = firstWord[2].trim();
	}
	// Optional "--tokens <budget>" scaffold before the objective.
	const budget = /^(--tokens\s+(\S+))(?:\s+([\s\S]*))?$/iu.exec(rest);
	if (budget) {
		// Malformed or invalid budget: pi-goal shows a usage error; nothing to translate.
		if (!budget[3]?.trim() || !/^(\d+(?:\.\d+)?)[km]?$/iu.test(budget[2]))
			return noObjective;
		prefix += `${budget[1]} `;
		rest = budget[3].trim();
	} else if (/^--tokens$/iu.test(rest)) {
		return noObjective; // missing budget value; pi-goal shows usage
	}
	if (!rest) return noObjective;
	return {
		objective: rest,
		rebuild: (translated) => `/goal ${prefix}${translated}`,
	};
}

const PROMPT_INTERCEPTOR_MARKER = Symbol.for(
	"pi-prompt-translate.prompt-interceptor",
);

type PromptOptions = {
	images?: unknown[];
	source?: string;
};

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
	try {
		const translated = await translate(
			ctx,
			goalCommand.objective,
			"English",
			"prompt",
		);
		const rebuilt = goalCommand.rebuild(translated.text);
		if (ctx.hasUI)
			ctx.ui.notify(
				`prompt-translate: /goal objective → EN ${formatCost(translated.costUsd, translated.costCzk)}`,
				"info",
			);
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
			usage: translated.usage,
		});
		return rebuilt;
	} catch (error) {
		if (ctx.hasUI)
			ctx.ui.notify(
				`prompt translation failed; continuing with original /goal objective: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		return text;
	}
}

export function installPromptInterceptor() {
	const proto = AgentSession.prototype as unknown as Record<
		PropertyKey,
		unknown
	>;
	if (proto[PROMPT_INTERCEPTOR_MARKER]) return;
	const original = proto.prompt;
	if (typeof original !== "function") return;
	const originalPrompt = original as (
		this: unknown,
		text: string,
		options?: PromptOptions,
	) => Promise<unknown>;
	proto.prompt = async function (
		this: unknown,
		text: string,
		options?: PromptOptions,
	) {
		const rewritten = await translateGoalCommandText(text, options);
		return originalPrompt.call(this, rewritten, options);
	};
	proto[PROMPT_INTERCEPTOR_MARKER] = true;
}
