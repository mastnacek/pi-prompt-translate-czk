// translatable-input.ts — decides which slice of a user input is translatable.
//
// Kernel-level routing: combines the goal parser, the skill parser and the
// double-transform guards into one decision so the pipeline slice stays a thin
// event shell. Returns undefined when the input must pass through untouched
// (plain slash command, bare /goal control, unknown or args-less /skill,
// double-transform echo).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractGoalObjective } from "./goal-command.js";
import { extractSkillCommand, isKnownSkill } from "./skill-command.js";
import { state } from "./state.js";

export type TranslatableInput = {
	/** The text to hand to the translator. */
	text: string;
	/** Reassemble the original scaffold around a translated string. */
	rebuild?: (translated: string) => string;
	/** Set when this is a /skill:<name> args translation (drives notify copy). */
	skillName?: string;
};

const TRANSFORM_GUARD_MS = 30_000;

function isEchoOfLastTransform(
	last: { from: string; to: string; at: number } | undefined,
	text: string,
): boolean {
	return Boolean(
		last && text === last.to && Date.now() - last.at < TRANSFORM_GUARD_MS,
	);
}

/**
 * Resolve the translatable slice of `text`, or undefined when the input must
 * flow on unchanged. `pi` may be undefined only when no session is bound yet,
 * in which case skill commands are not recognized (pass-through).
 */
export function resolveTranslatableInput(
	text: string,
	pi: ExtensionAPI | undefined,
): TranslatableInput | undefined {
	const goalCommand = extractGoalObjective(text);
	if (goalCommand) {
		if (!goalCommand.objective) return undefined;
		if (isEchoOfLastTransform(state.lastGoalTransform, text))
			return undefined;
		return { text: goalCommand.objective, rebuild: goalCommand.rebuild };
	}

	const skillCommand = extractSkillCommand(text);
	if (skillCommand && pi && isKnownSkill(pi, skillCommand.skillName)) {
		// /skill:<name> args — only the free-text args are translatable; the
		// scaffold stays byte-identical (engine splits on the first space).
		if (!skillCommand.args) return undefined;
		if (isEchoOfLastTransform(state.lastSkillTransform, text))
			return undefined;
		return {
			text: skillCommand.args,
			rebuild: skillCommand.rebuild,
			skillName: skillCommand.skillName,
		};
	}

	if (text.trim().startsWith("/")) return undefined;
	return { text };
}
