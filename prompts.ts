/**
 * System prompts and prompt-building logic for pi-prompt-translate.
 *
 * Three prompt-translation modes (selected via the `boost` config level):
 *  - PROMPT_TRANSLATE_SYSTEM_PROMPT ("off")  — plain faithful translation
 *  - PROMPT_BOOST_SYSTEM_PROMPT   ("boost") — faithful clarity edit, no restructuring
 *  - PROMPT_MEGA_SYSTEM_PROMPT    ("mega")  — restructure into ordered imperative tasks
 *
 * Plus the English-only instruction appended to the agent system prompt for
 * translated turns, with helpers to keep it idempotent across turns.
 */

export const PROMPT_TRANSLATE_SYSTEM_PROMPT = [
	"Translate to English. Output only the translation.",
	"Silently fix obvious typos, spelling, and grammar mistakes in the source text, but never change meaning, code, or intent.",
	"Keep code, paths, commands, markdown, placeholders, JSON, XML-like tags, and technical terms unchanged when appropriate.",
].join("\n");

export const PROMPT_BOOST_SYSTEM_PROMPT = [
	"Translate the user's text to English and lightly edit it into a clear prompt for an AI coding agent. Output only the resulting English prompt.",
	"Fidelity first: the output must contain ONLY information and requests explicitly present in the source. Never invent specifics (file names, steps, references, constraints, examples) and never expand a short remark into a detailed brief.",
	"Preserve the user's intent, tone, and level of detail: a short casual request stays short; do not add structure, bullet lists, or background the user did not provide.",
	"Silently fix typos and grammar, drop filler, and resolve ambiguity only when the intended meaning is obvious from the source.",
	"Keep code, paths, commands, markdown, placeholders, JSON, XML-like tags, and technical terms unchanged when appropriate.",
	"If the source is a question, keep it a question. Never answer or execute the prompt.",
].join("\n");

export const PROMPT_MEGA_SYSTEM_PROMPT = [
	"Translate the user's text to English and rewrite it as a well-structured, high-signal prompt for an AI coding agent. Output only the improved English prompt.",
	"Turn the request into clear, direct imperative sentences.",
	"When the request has multiple parts, break it into an ordered task list (1., 2., 3.) in the order the agent should execute the work; infer a sensible order from context (e.g. investigate before fixing, verify at the end).",
	"Make implicit-but-obvious expectations explicit (e.g. check how something is configured before adjusting it) when the source clearly implies them, but never invent new features, files, scope, or constraints the user did not ask for.",
	"Preserve every name, path, command, constraint, and detail from the source. Keep code, markdown, placeholders, JSON, XML-like tags, and technical terms unchanged.",
	"Fix typos and grammar; drop filler and hedging. Keep the result compact — structure only when the request genuinely has multiple parts.",
	"If the source is a question, keep it a question. Never answer or execute the prompt.",
].join("\n");

export const ENGLISH_ONLY_AGENT_INSTRUCTION = [
	"pi-prompt-translate is active for this turn.",
	"The user's original prompt may have been translated into English before this request reached you.",
	"Do all actual work, tool-use planning, tool call arguments, intermediate assistant messages, and final assistant answer in English.",
	"Do not answer in the user's original language or the configured target language during the agent run.",
].join("\n");

export const LEGACY_RESPONSE_TRANSLATION_INSTRUCTION =
	"If response translation is enabled, the extension will translate only the final English work briefing/final answer after the turn is complete.";

export const RESPONSE_TRANSLATION_ENABLED_INSTRUCTION =
	"Response translation is enabled; the extension will translate only the final English work briefing/final answer after the turn is complete.";

export const RESPONSE_TRANSLATION_DISABLED_INSTRUCTION =
	"Response translation is disabled; the extension will not translate the final answer, so keep the final answer in English.";

export function buildEnglishOnlyInstruction(
	translateResponses: boolean,
): string {
	return [
		ENGLISH_ONLY_AGENT_INSTRUCTION,
		translateResponses
			? RESPONSE_TRANSLATION_ENABLED_INSTRUCTION
			: RESPONSE_TRANSLATION_DISABLED_INSTRUCTION,
	].join("\n");
}

export function stripResponseTranslationInstructions(
	systemPrompt: string,
): string {
	return systemPrompt
		.split("\n")
		.filter(
			(line) =>
				line !== LEGACY_RESPONSE_TRANSLATION_INSTRUCTION &&
				line !== RESPONSE_TRANSLATION_ENABLED_INSTRUCTION &&
				line !== RESPONSE_TRANSLATION_DISABLED_INSTRUCTION,
		)
		.join("\n");
}

export function appendEnglishOnlyInstruction(
	systemPrompt: string,
	translateResponses: boolean,
): string {
	const responseInstruction = translateResponses
		? RESPONSE_TRANSLATION_ENABLED_INSTRUCTION
		: RESPONSE_TRANSLATION_DISABLED_INSTRUCTION;
	if (systemPrompt.includes(ENGLISH_ONLY_AGENT_INSTRUCTION)) {
		const stripped = stripResponseTranslationInstructions(systemPrompt);
		return `${stripped}\n${responseInstruction}`;
	}
	return `${systemPrompt}\n\n${buildEnglishOnlyInstruction(translateResponses)}`;
}
