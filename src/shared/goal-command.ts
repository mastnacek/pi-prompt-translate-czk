// goal-command.ts — /goal command scaffolding parser.
//
// Pure parsing, no session state and no engine access, so it lives in the kernel
// rather than in the goal slice: the pipeline needs it to recognise a /goal
// submission in the `input` event, and the goal interceptor needs it to split the
// command before extension dispatch swallows the text. Both consumers are separate
// slices and slices may not import each other (VSA §1.2) — so this is the shared
// piece, per the Q3 branch of the slice-membership tree.

/** Subcommands that never carry an objective (pi-goal parseCommand). */
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

/** Subcommands whose remaining arguments are the objective text. */
const GOAL_OBJECTIVE_SUBCOMMANDS = new Set([
	"edit",
	"add",
	"push",
	"prioritize",
	"unshift",
]);

export type GoalObjectiveExtraction = {
	// Objective text to translate; undefined = nothing to translate (control command or usage error).
	objective?: string;
	rebuild: (translatedObjective: string) => string;
};

/**
 * Split `/goal ...` into the untranslatable command scaffold and the objective text.
 * Returns undefined when the text is not a /goal command at all.
 */
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
		if (!budget[3]?.trim() || !/^(\d+(?:\.\d+)?)[km]?$/iu.exec(budget[2]))
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
