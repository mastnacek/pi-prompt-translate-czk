/**
 * Markdown table protection: the grid is masked as one segment so the
 * translator cannot re-flow it into bare cells.
 *
 * Split out of `protection.test.ts` (line-limit campaign).
 */
import { describe, expect, it } from "vitest";
import {
  protectFinalAnswerSegments,
  protectPromptSegments,
  restoreProtectedSegments,
} from "../src/shared/translate/protect";

describe("markdown table protection", () => {
	it("protects a markdown table as one segment, before inline code", () => {
		// The grid used to reach the translator as prose: it came back re-flowed
		// into bare cells with the header and the `| --- |` separator gone.
		const text = [
			"## Three ids",
			"",
			"| ID | Where it is valid |",
			"| --- | --- |",
			"| `typesafe/jev-router` | OpenRouter chat |",
			"| `typesafe/jev-1.13` | OpenRouter decisions |",
			"",
			"The middle one matters.",
		].join("\n");

		const { text: masked, segments } = protectPromptSegments(text, []);

		// One segment for the whole grid, not one per inline code span.
		expect(segments).toHaveLength(1);
		expect(segments[0]!.value).toBe(
			"| ID | Where it is valid |\n| --- | --- |\n| `typesafe/jev-router` | OpenRouter chat |\n| `typesafe/jev-1.13` | OpenRouter decisions |",
		);
		// Prose around it stays translatable.
		expect(masked).toContain("The middle one matters.");
		expect(masked).toContain("__PI_PROMPT_TRANSLATE_PROTECTED_0__");

		const restored = restoreProtectedSegments(
			"## Tři ID\n\n__PI_PROMPT_TRANSLATE_PROTECTED_0__\n\nTen prostřední je důležitý.",
			segments,
		);
		expect(restored).toContain("| --- | --- |");
		expect(restored.split("jev-router").length - 1).toBe(1);
		expect(restored).toContain("Ten prostřední je důležitý.");
	});

	it("protects tables in the final-answer path too", () => {
		const text = ["| A | B |", "| --- | --- |", "| `x` | y |"].join("\n");
		const { segments } = protectFinalAnswerSegments(text);
		expect(segments).toHaveLength(1);
		expect(segments[0]!.value).toContain("| --- | --- |");
	});

	it("leaves a lone pipe row alone — it is prose, not a table", () => {
		const text = "Výsledek: | a | b | pokračuje větou.";
		const { segments } = protectPromptSegments(text, []);
		expect(segments).toHaveLength(0);
	});

	it("does not mistake an ASCII diagram for a table", () => {
		// `| --- |` is only a separator on row 2; a diagram has no such row.
		const diagram = ["+---+---+", "| a | b |", "+---+---+"].join("\n");
		const { segments } = protectPromptSegments(diagram, []);
		expect(segments).toHaveLength(0);
	});

});
