import { describe, expect, it } from "vitest";
import {
	protectPromptSegments,
	restoreProtectedSegments,
} from "./translate";

describe("protectPromptSegments & restoreProtectedSegments", () => {
	it("protects pi-read-all headers and <file> blocks from translation", () => {
		const prompt = [
			"Vysvětli mi prosím tento kód a jak funguje:",
			"",
			'[pi-read-all]: Loaded 1 file from "src/index.ts"',
			"",
			'<file path="src/index.ts" lines="10" size="100 B" tokens="~25">',
			"export function calculate() {",
			"  // Důležitý komentář v češtině",
			"  return 42;",
			"}",
			"</file>",
			"",
			"Díky moc za pomoc!",
		].join("\n");

		const protectedResult = protectPromptSegments(prompt);

		// Verified that the <file> block and [pi-read-all] are replaced with placeholders
		expect(protectedResult.text).not.toContain("export function calculate()");
		expect(protectedResult.text).not.toContain("// Důležitý komentář");
		expect(protectedResult.text).toContain("Vysvětli mi prosím tento kód a jak funguje:");
		expect(protectedResult.text).toContain("Díky moc za pomoc!");
		expect(protectedResult.segments.length).toBeGreaterThanOrEqual(2);

		// Simulate translation of the non-protected prompt text
		const translatedPrompt = protectedResult.text
			.replace(
				"Vysvětli mi prosím tento kód a jak funguje:",
				"Please explain this code and how it works:",
			)
			.replace("Díky moc za pomoc!", "Thanks a lot for the help!");

		const restored = restoreProtectedSegments(
			translatedPrompt,
			protectedResult.segments,
		);

		// Restored text must contain the translated prompt instructions AND the exact verbatim file content
		expect(restored).toContain("Please explain this code and how it works:");
		expect(restored).toContain('[pi-read-all]: Loaded 1 file from "src/index.ts"');
		expect(restored).toContain("export function calculate()");
		expect(restored).toContain("// Důležitý komentář v češtině");
		expect(restored).toContain("Thanks a lot for the help!");
	});

	it("protects @! triggers and markdown code blocks in prompt", () => {
		const prompt =
			"Analyzuj @!src/core/ a @!\"src/my folder/\" spolu s ```const x = 10;```";
		const protectedResult = protectPromptSegments(prompt);

		expect(protectedResult.text).not.toContain("@!src/core/");
		expect(protectedResult.text).not.toContain('@!"src/my folder/"');
		expect(protectedResult.text).not.toContain("const x = 10;");

		const translated = protectedResult.text.replace(
			"Analyzuj",
			"Analyze",
		).replace("spolu s", "together with");

		const restored = restoreProtectedSegments(
			translated,
			protectedResult.segments,
		);

		expect(restored).toContain("Analyze @!src/core/ and @!\"src/my folder/\" together with ```const x = 10;```".slice(0, 20));
		expect(restored).toContain("@!src/core/");
		expect(restored).toContain('@!"src/my folder/"');
		expect(restored).toContain("```const x = 10;```");
	});
});
