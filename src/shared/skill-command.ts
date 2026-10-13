// skill-command.ts — /skill:<name> <args> parser.
//
// Pure parsing plus a registry lookup, no session state, so it lives in the
// kernel rather than in the pipeline slice (same reasoning as goal-command.ts:
// the pipeline is the only consumer today, but the parser must stay testable
// without an engine). The engine expands `/skill:name args` by splitting on the
// FIRST space (`AgentSession._expandSkillCommand`) and appends the args verbatim
// to the loaded instructions as a user request — so the scaffold
// (`/skill:<name>`) is untranslatable and the args are the translatable part.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SkillCommandExtraction = {
	skillName: string;
	/** Trimmed text after the skill name; "" when the command carries no args. */
	args: string;
	/** Reassemble the command around a translated args string. */
	rebuild: (translatedArgs: string) => string;
};

/**
 * Split `/skill:<name> <args>` into the untranslatable scaffold and the args.
 * Returns undefined when the text is not a skill command at all.
 *
 * Matches the raw text without trimming: the engine's expansion uses
 * `startsWith("/skill:")` on the raw input, so a leading space means the command
 * would never expand — translating its args would change nothing the model sees.
 */
export function extractSkillCommand(
	text: string,
): SkillCommandExtraction | undefined {
	const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
	if (!match) return undefined;
	const skillName = match[1];
	const args = match[2]?.trim() ?? "";
	return {
		skillName,
		args,
		rebuild: (translatedArgs) => `/skill:${skillName} ${translatedArgs}`,
	};
}

/**
 * Whether the engine actually knows this skill. `pi.getCommands()` surfaces
 * every discoverable skill as `{ name: "skill:<name>", source: "skill" }`
 * (`AgentSession.getCommands`), so an unknown `/skill:xyz` would pass through
 * the engine unexpanded and must not be transformed either.
 */
export function isKnownSkill(pi: ExtensionAPI, skillName: string): boolean {
	return pi
		.getCommands()
		.some(
			(command) =>
				command.source === "skill" && command.name === `skill:${skillName}`,
		);
}
