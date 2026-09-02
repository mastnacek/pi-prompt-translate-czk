import { describe, expect, it } from "vitest";
import {
	buildEffectiveHeaders,
	cleanTranslationOutput,
	createTranslationContext,
	detectLanguageOrCode,
	extractRecentContext,
	hasDeicticReferences,
	protectFinalAnswerSegments,
	protectPromptSegments,
	restoreProtectedSegments,
} from "./translate";
import { formatTelemetryOverview } from "./status";
import { state } from "./state";

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

	it("protects URLs in prompts (standalone and in markdown links)", () => {
		const prompt =
			"Podívej se na https://hermes-agent.nousresearch.com/docs/features a odkaz [Dokumentace](https://example.com/api?user=1&test=true).";
		const protectedResult = protectPromptSegments(prompt);

		expect(protectedResult.text).not.toContain(
			"https://hermes-agent.nousresearch.com/docs/features",
		);
		expect(protectedResult.text).not.toContain(
			"https://example.com/api?user=1&test=true",
		);
		expect(protectedResult.text).toContain("[Dokumentace](");

		const translated = protectedResult.text
			.replace("Podívej se na", "Check out")
			.replace("a odkaz", "and link")
			.replace("[Dokumentace]", "[Documentation]");

		const restored = restoreProtectedSegments(
			translated,
			protectedResult.segments,
		);

		expect(restored).toContain(
			"Check out https://hermes-agent.nousresearch.com/docs/features",
		);
		expect(restored).toContain(
			"[Documentation](https://example.com/api?user=1&test=true)",
		);
	});

	it("protects URLs in final answer segments", () => {
		const answer =
			"Here is the result. Documentation: https://docs.example.com/guide. <action>Do not touch</action>";
		const protectedResult = protectFinalAnswerSegments(answer);

		expect(protectedResult.text).not.toContain(
			"https://docs.example.com/guide",
		);
		expect(protectedResult.text).not.toContain("<action>Do not touch</action>");

		const translated = protectedResult.text.replace(
			"Here is the result. Documentation:",
			"Zde je výsledek. Dokumentace:",
		);

		const restored = restoreProtectedSegments(
			translated,
			protectedResult.segments,
		);

		expect(restored).toContain("https://docs.example.com/guide");
		expect(restored).toContain("<action>Do not touch</action>");
	});

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

	it("cleans translation output from echoed XML wrapper tags", () => {
		expect(
			cleanTranslationOutput("<source_text>Hello world</source_text>"),
		).toBe("Hello world");
		expect(
			cleanTranslationOutput("<translation>\nHello world\n</translation>"),
		).toBe("Hello world");
		expect(cleanTranslationOutput("Hello world")).toBe("Hello world");
	});

	it("wraps translation context input in <source_text> XML tags", () => {
		const ctx = createTranslationContext("system prompt", "user prompt");
		expect(ctx.messages[0].content).toBe(
			"<source_text>\nuser prompt\n</source_text>",
		);
	});

	it("detects standalone URLs as english/code to bypass unnecessary translation", () => {
		const res = detectLanguageOrCode(
			"https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban",
		);
		expect(res.isEnglishOrCode).toBe(true);
		expect(res.reason).toBe("url_only");
	});

	it("builds effective headers for OpenRouter with sticky routing and attribution", () => {
		const orHeaders = buildEffectiveHeaders("openrouter", "sess-12345", {
			"custom-h": "val",
			"null-h": null,
		});
		expect(orHeaders["HTTP-Referer"]).toBe(
			"https://github.com/mastnacek/pi-prompt-translate-czk",
		);
		expect(orHeaders["X-Title"]).toBe("Pi Prompt Translate");
		expect(orHeaders["x-session-id"]).toBe("sess-12345");
		expect(orHeaders["custom-h"]).toBe("val");
		expect(orHeaders).not.toHaveProperty("null-h");

		const nonOrHeaders = buildEffectiveHeaders("google", "sess-12345", {
			"custom-h": "val",
		});
		expect(nonOrHeaders).not.toHaveProperty("HTTP-Referer");
		expect(nonOrHeaders).not.toHaveProperty("X-Title");
		expect(nonOrHeaders).not.toHaveProperty("x-session-id");
		expect(nonOrHeaders["custom-h"]).toBe("val");
	});

	it("formats telemetry overview with cache hits and savings metrics", async () => {
		state.telemetry.totalRequests = 10;
		state.telemetry.promptRequests = 7;
		state.telemetry.answerRequests = 3;
		state.telemetry.openRouterRequests = 10;
		state.telemetry.cacheHitTurns = 8;
		state.telemetry.cachedTokens = 2500;
		state.telemetry.savedCostUsd = 0.0025;
		state.sessionCostUsd = 0.001;

		const mockCtx = {
			signal: undefined,
			hasUI: false,
		} as never;

		const overview = await formatTelemetryOverview(mockCtx);
		expect(overview).toContain("pi-prompt-translate — Telemetry & Optimizations");
		expect(overview).toContain("Cache Hit Rate:   80.0%");
		expect(overview).toContain("Tokens from Cache: 2,500");
		expect(overview).toContain("Sticky Routing:   Active (x-session-id pinned)");
		expect(overview).toContain("Saved via Cache:");
	});

	it("detects deictic reference words indicating conversational dependency", () => {
		expect(hasDeicticReferences("udělej to taky pro druhou metodu")).toBe(true);
		expect(hasDeicticReferences("proč to hází chybu?")).toBe(true);
		expect(hasDeicticReferences("tento kód nefunguje")).toBe(true);
		expect(hasDeicticReferences("stejný problém jako minule")).toBe(true);
		expect(hasDeicticReferences("vytvoř novou funkci calculate()")).toBe(false);
	});

	it("wraps conversation context into <conversation_context> XML tags", () => {
		const ctxWithHistory = createTranslationContext(
			"system prompt",
			"udělej to taky",
			"User: Refactor db.ts\nAssistant: Done.",
		);
		expect(ctxWithHistory.messages[0].content).toContain(
			"<conversation_context>\nUser: Refactor db.ts\nAssistant: Done.\n</conversation_context>",
		);
		expect(ctxWithHistory.messages[0].content).toContain(
			"<source_text>\nudělej to taky\n</source_text>",
		);

		const ctxWithoutHistory = createTranslationContext(
			"system prompt",
			"udělej to taky",
		);
		expect(ctxWithoutHistory.messages[0].content).not.toContain(
			"<conversation_context>",
		);
	});

	it("extracts recent conversation context from session manager entries", () => {
		const mockContext = {
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: { role: "user", content: "Můžeš zkontrolovat db.ts?" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "Zkontrolováno, spojení je opravené." },
							],
						},
					},
					{
						type: "other_entry",
					},
				],
			},
		} as never;

		const extracted = extractRecentContext(mockContext);
		expect(extracted).toContain("User: Můžeš zkontrolovat db.ts?");
		expect(extracted).toContain(
			"Assistant: Zkontrolováno, spojení je opravené.",
		);
	});

	it("cleans echoed conversation_context from model output", () => {
		const echoed =
			"<conversation_context>User: foo\nAssistant: bar</conversation_context>\nRefactor the second function.";
		expect(cleanTranslationOutput(echoed)).toBe(
			"Refactor the second function.",
		);
	});
});
