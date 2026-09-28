/**
 * Tool-UI text translation — the third surface after prompts and answers.
 *
 * Some tools render model-authored English straight into the user's screen: the
 * quick-win card lands in an overlay, a statusline echo and the transcript before
 * any assistant sentence exists. Answer translation never sees that text, so the
 * only place to intervene is the `tool_call` event, whose `input` is mutable before
 * the tool executes. Mutating the arguments (rather than the result) is what makes
 * the overlay, the statusline and the transcript agree: the tool renders from the
 * arguments it was handed.
 *
 * Two deliberate limits:
 * - Only fields listed per tool are touched. Enum-like arguments (`effort`) must
 *   survive verbatim or the tool rejects its own input.
 * - All fields of one call go through a single LLM request as index-marked blocks.
 *   A card has 5-7 fields; five round trips would cost more than the card.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { debug } from "./status.js";
import { translate } from "./translate.js";
import { DEFAULT_TOOL_UI_TARGETS } from "./types.js";

/** Arguments whose text the user reads. Enum and structural fields stay out. */
const TOOL_UI_FIELDS: Record<string, readonly string[]> = {
	quick_win: ["title", "impact", "steps", "proof", "alternative"],
	quick_win_done: ["evidence"],
};

/** One translatable argument, addressed by a path into the tool input. */
export interface ToolTextField {
	path: readonly [string] | readonly [string, number];
	text: string;
}

const marker = (index: number): string => `<<<${index}>>>`;
const MARKER_RE = /^<<<(\d+)>>>$/;

export function isToolUiTarget(toolName: string): boolean {
	return (
		(state.config.toolUiTools ?? DEFAULT_TOOL_UI_TARGETS).includes(toolName) &&
		TOOL_UI_FIELDS[toolName] !== undefined
	);
}

/** Collect the translatable fields of one tool call, in stable key order. */
export function collectTextFields(
	input: Record<string, unknown>,
	allowedFields: readonly string[],
): ToolTextField[] {
	const fields: ToolTextField[] = [];
	for (const key of allowedFields) {
		const value = input[key];
		if (typeof value === "string") {
			if (value.trim().length > 0) fields.push({ path: [key], text: value });
			continue;
		}
		if (!Array.isArray(value)) continue;
		value.forEach((entry, index) => {
			if (typeof entry === "string" && entry.trim().length > 0) {
				fields.push({ path: [key, index], text: entry });
			}
		});
	}
	return fields;
}

/** One field per block, so a single translation call can carry the whole card. */
export function formatBlocks(fields: readonly ToolTextField[]): string {
	return fields.map((field, index) => `${marker(index)}\n${field.text}`).join("\n");
}

/**
 * Read the translations back. Anything the model did not mark comes back
 * `undefined`: a partial answer is discarded by the caller rather than written
 * into the tool input half-translated.
 */
export function parseBlocks(output: string, count: number): (string | undefined)[] {
	const parsed: (string | undefined)[] = new Array(count).fill(undefined);
	let current: number | undefined;
	let buffer: string[] = [];

	const flush = (): void => {
		if (current !== undefined && current < count) {
			const text = buffer.join("\n").trim();
			if (text.length > 0) parsed[current] = text;
		}
		buffer = [];
	};

	for (const line of output.split(/\r?\n/)) {
		const match = MARKER_RE.exec(line.trim());
		if (match) {
			flush();
			current = Number(match[1]);
			continue;
		}
		// Text before the first marker is preamble: dropped by design.
		if (current !== undefined) buffer.push(line);
	}
	flush();
	return parsed;
}

/** Write the translations back into the tool input, in place. */
export function applyTranslations(
	input: Record<string, unknown>,
	fields: readonly ToolTextField[],
	translations: readonly string[],
): number {
	let applied = 0;
	for (const [index, field] of fields.entries()) {
		const translated = translations[index];
		if (!translated) continue;
		const [key, itemIndex] = field.path;
		if (itemIndex === undefined) {
			input[key] = translated;
		} else {
			const list = input[key];
			// Bounds-check: writing past the end would silently grow the array and
			// invent a step the agent never asked for.
			if (!Array.isArray(list) || itemIndex >= list.length) continue;
			list[itemIndex] = translated;
		}
		applied++;
	}
	return applied;
}

export function registerToolUiHooks(
	pi: ExtensionAPI,
	track: (result: unknown) => void,
): void {
	track(
		pi.on("tool_call", async (event, ctx) => {
			const config = state.config;
			if (!config.enabled || !config.translateToolUi) return;
			if (!isToolUiTarget(event.toolName)) return;

			const input = event.input as Record<string, unknown>;
			const fields = collectTextFields(input, TOOL_UI_FIELDS[event.toolName]);
			if (fields.length === 0) return;

			try {
				const result = await translate(
					ctx,
					formatBlocks(fields),
					config.targetLanguage,
					"tool",
				);
				const parsed = parseBlocks(result.text, fields.length);
				const applied = applyTranslations(input, fields, parsed as string[]);
				if (applied < fields.length) {
					debug(
						ctx,
						`tool-ui: ${event.toolName} only partially translated (${applied}/${fields.length}); untouched fields stay English`,
					);
					return;
				}
				debug(
					ctx,
					`tool-ui: ${event.toolName} → ${config.targetLanguage} (${applied} fields)`,
				);
			} catch (error) {
				// Never rethrow: a failing tool_call handler blocks the tool itself,
				// and English text is a much better failure mode than no card.
				debug(
					ctx,
					`tool-ui: ${event.toolName} left English (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}),
	);
}
