/**
 * Placeholder restoration: exact, fuzzy and recovery paths of
 * restoreProtectedSegments — including the guard that stops the recovery from
 * re-appending a value the model already emitted without its placeholder.
 *
 * Split out of `protection.test.ts` (line-limit campaign); segment masking
 * stays there.
 */
import { describe, expect, it } from "vitest";
import { restoreProtectedSegments } from "../src/shared/translate/protect";

describe("restoreProtectedSegments", () => {
	it("handles exact, fuzzy, and dropped placeholder restorations safely", () => {
		const segments = [
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
				value: "https://foo.com",
			},
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_1__",
				value: "```const x = 1;```",
			},
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_2__",
				value: "myImportantFunction()",
			},
		];

		// Exact match
		const exact = restoreProtectedSegments(
			"See __PI_PROMPT_TRANSLATE_PROTECTED_0__",
			[segments[0]],
		);
		expect(exact).toBe("See https://foo.com");

		// Fuzzy match (LLM lost trailing underscore)
		const fuzzy = restoreProtectedSegments(
			"Code: __PI_PROMPT_TRANSLATE_PROTECTED_1",
			[segments[1]],
		);
		expect(fuzzy).toBe("Code: ```const x = 1;```");

		// Dropped placeholder recovery (LLM completely dropped token)
		const dropped = restoreProtectedSegments("Just plain text.", [segments[2]]);
		expect(dropped).toContain("Just plain text.");
		expect(dropped).toContain("myImportantFunction()");
	});

	it("restores every occurrence of a repeated placeholder, fuzzy branch included", () => {
		const segment = {
			placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
			value: "src/a.ts",
		};
		// Exact branch already replaced all occurrences; the fuzzy branch used to
		// replace only the first, handing the agent a literal placeholder back.
		expect(
			restoreProtectedSegments(
				"Fix __PI_PROMPT_TRANSLATE_PROTECTED_0__ and __PI_PROMPT_TRANSLATE_PROTECTED_0__",
				[segment],
			),
		).toBe("Fix src/a.ts and src/a.ts");
		expect(
			restoreProtectedSegments(
				"Fix __PI_PROMPT_TRANSLATE_PROTECTED_0 and __PI_PROMPT_TRANSLATE_PROTECTED_0",
				[segment],
			),
		).toBe("Fix src/a.ts and src/a.ts");
	});

	it("does not let the fuzzy branch match placeholder text across lines or inside words", () => {
		const segment = {
			placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
			value: "src/a.ts",
		};
		// Split across two lines: the old `[_\\s]?` allowed any whitespace,
		// including a newline, so a dropped underscore spanned lines. The token is
		// left in place; recovery appends the value at the end instead.
		const split = restoreProtectedSegments(
			"See __PI_PROMPT_TRANSLATE\nPROTECTED_0__ here",
			[segment],
		);
		expect(
			split.startsWith("See __PI_PROMPT_TRANSLATE\nPROTECTED_0__ here"),
		).toBe(true);
		// Embedded in a longer identifier: must not be treated as the placeholder.
		// (A literal `x__PI_..._0__x` is not a case — that is an exact substring and
		// the exact branch replaces it, correctly.)
		const embedded = restoreProtectedSegments(
			"y__PI PROMPT TRANSLATE PROTECTED 0 end",
			[segment],
		);
		expect(embedded.startsWith("y__PI PROMPT TRANSLATE PROTECTED 0 end")).toBe(
			true,
		);
	});

	it("does not re-append a value the model already emitted without its placeholder", () => {
		// The real failure: a dense code answer comes back with the placeholders
		// dropped but their meaning kept. Recovery then re-appended every path, id
		// and URL as a trailing list of duplicates.
		const segments = [
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
				value: "src/slices/routing/index.ts",
			},
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_1__",
				value: "https://openrouter.ai/api/alpha/decisions",
			},
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_2__",
				value: "typesafe/jev-1.13",
			},
		];

		const restored = restoreProtectedSegments(
			"Trasa vede přes src/slices/routing/index.ts na typesafe/jev-1.13.",
			segments,
		);

		// Already present in the prose → not appended again.
		expect(restored).toMatch(
			/^Trasa vede přes src\/slices\/routing\/index\.ts na typesafe\/jev-1\.13\./,
		);
		expect(restored.match(/src\/slices\/routing\/index\.ts/g)).toHaveLength(1);
		expect(restored.match(/typesafe\/jev-1\.13/g)).toHaveLength(1);

		// Genuinely lost → still recovered, exactly once.
		expect(restored).toContain("https://openrouter.ai/api/alpha/decisions");
		expect(restored.match(/openrouter\.ai/g)).toHaveLength(1);
	});

	it("still recovers a value that appears nowhere, without duplicating it", () => {
		const segments = [
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
				value: "lotusscript_modular",
			},
		];
		const restored = restoreProtectedSegments("Použij plugin.", segments);
		expect(restored).toContain("lotusscript_modular");
		expect(restored.match(/lotusscript_modular/g)).toHaveLength(1);
	});

	it("matches a present value even when the model stripped its markdown delimiters", () => {
		// The real model behaviour: it emits the meaning in prose and drops the
		// backticks, so comparing the delimited segment value never matches and the
		// recovery appended a duplicate of text that was already there.
		const segments = [
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
				value: "`https://openrouter.ai/api/alpha/decisions`",
			},
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_1__",
				value: "`client.ts:20`",
			},
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_2__",
				value: "`sub_HledejLidyIFX.lss`",
			},
		];

		const restored = restoreProtectedSegments(
			"Router volá https://openrouter.ai/api/alpha/decisions z client.ts:20, " +
			"procedura sub_HledejLidyIFX.lss se nezměnila.",
			segments,
		);

		// Inner underscores survive the bare comparison.
		expect(restored.split("openrouter.ai").length - 1).toBe(1);
		expect(restored.split("client.ts:20").length - 1).toBe(1);
		expect(restored.split("sub_HledejLidyIFX.lss").length - 1).toBe(1);
	});

	it("still recovers when only the delimiters differ and the value is genuinely gone", () => {
		const segments = [
			{
				placeholder: "__PI_PROMPT_TRANSLATE_PROTECTED_0__",
				value: "`lotusscript_modular`",
			},
		];
		const restored = restoreProtectedSegments("Použij plugin.", segments);
		expect(restored).toContain("lotusscript_modular");
		expect(restored.split("lotusscript_modular").length - 1).toBe(1);
	});
});
