import { describe, expect, it } from "vitest";
import { protectPromptSegments, restoreProtectedSegments } from "./translate";

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

		expect(protectedResult.text).not.toContain("export function calculate()");
		expect(protectedResult.text).not.toContain("// Důležitý komentář");
		expect(protectedResult.text).toContain(
			"Vysvětli mi prosím tento kód a jak funguje:",
		);
		expect(protectedResult.text).toContain("Díky moc za pomoc!");
		expect(protectedResult.segments.length).toBeGreaterThanOrEqual(2);

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

		expect(restored).toContain("Please explain this code and how it works:");
		expect(restored).toContain(
			'[pi-read-all]: Loaded 1 file from "src/index.ts"',
		);
		expect(restored).toContain("export function calculate()");
		expect(restored).toContain("// Důležitý komentář v češtině");
		expect(restored).toContain("Thanks a lot for the help!");
	});

	it("protects @! triggers and markdown code blocks in prompt", () => {
		const prompt =
			'Analyzuj @!src/core/ a @!"src/my folder/" spolu s ```const x = 10;``` a inline `fooBar()`';
		const protectedResult = protectPromptSegments(prompt);

		expect(protectedResult.text).not.toContain("@!src/core/");
		expect(protectedResult.text).not.toContain('@!"src/my folder/"');
		expect(protectedResult.text).not.toContain("const x = 10;");
		expect(protectedResult.text).not.toContain("`fooBar()`");

		const translated = protectedResult.text
			.replace("Analyzuj", "Analyze")
			.replace("spolu s", "together with")
			.replace("a inline", "and inline");

		const restored = restoreProtectedSegments(
			translated,
			protectedResult.segments,
		);

		expect(restored).toContain("@!src/core/");
		expect(restored).toContain('@!"src/my folder/"');
		expect(restored).toContain("```const x = 10;```");
		expect(restored).toContain("`fooBar()`");
	});

	it("protects standard @ mentions, ? symbol queries, and confirmed at-words", () => {
		const prompt =
			'Vezmi soubor @data/config.json a @"src/my file.ts", prohledej ?seznam_uzivatelu a zkontroluj pole vysledekHledani';
		const knownAtWords = ["vysledekHledani", "seznam_uzivatelu"];

		const protectedResult = protectPromptSegments(prompt, knownAtWords);

		expect(protectedResult.text).not.toContain("@data/config.json");
		expect(protectedResult.text).not.toContain('@"src/my file.ts"');
		expect(protectedResult.text).not.toContain("?seznam_uzivatelu");
		expect(protectedResult.text).not.toContain("vysledekHledani");

		const translated = protectedResult.text
			.replace("Vezmi soubor", "Take file")
			.replace("a", "and")
			.replace("prohledej", "search")
			.replace("a zkontroluj pole", "and check array");

		const restored = restoreProtectedSegments(
			translated,
			protectedResult.segments,
		);

		expect(restored).toContain("@data/config.json");
		expect(restored).toContain('@"src/my file.ts"');
		expect(restored).toContain("?seznam_uzivatelu");
		expect(restored).toContain("vysledekHledani");
	});
});
