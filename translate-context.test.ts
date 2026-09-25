/**
 * Model context and display: request headers, telemetry, conversation context
 * handling, and the config/help/confirmation renderers.
 *
 * Split out of `translate.test.ts` (line-limit campaign); the protection tests
 * live in `translate-protection.test.ts`.
 */
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
import {
	buildHelpText,
	formatActiveValue,
	formatChoice,
	formatConfirmationBody,
	formatTelemetryOverview,
	formatToggleBadge,
	statusText,
} from "./status";
import { normalizeConfig } from "./config";
import { state } from "./state";

describe("translation context, telemetry and display helpers", () => {
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
							content: [{ type: "text", text: "Zkontrolováno, spojení je opravené." }],
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
		expect(extracted).toContain("Assistant: Zkontrolováno, spojení je opravené.");
	});

	it("cleans echoed conversation_context from model output", () => {
		const echoed =
			"<conversation_context>User: foo\nAssistant: bar</conversation_context>\nRefactor the second function.";
		expect(cleanTranslationOutput(echoed)).toBe("Refactor the second function.");
	});

	it("normalizes confirm option in config", () => {
		expect(normalizeConfig({}).confirm).toBe(false);
		expect(normalizeConfig({ confirm: true }).confirm).toBe(true);
		expect(normalizeConfig({ confirm: false }).confirm).toBe(false);
	});

	it("includes confirm and history in statusText output", async () => {
		state.config.confirm = true;
		state.config.historyMode = "auto";
		const mockCtx = {
			signal: undefined,
			hasUI: false,
			sessionManager: { getEntries: () => [] },
		} as never;
		const text = await statusText(mockCtx);
		expect(text).toContain("confirm=");
		expect(text).toContain("history=");
	});

	it("formats choices with active option highlighted", () => {
		const formatted = formatChoice(["off", "on", "plus", "mega"], "plus");
		expect(formatted).toContain("● plus");
		expect(formatted).toContain("off");
	});

	it("formats active single value and toggle badges", () => {
		expect(formatActiveValue("Czech")).toContain("● Czech");
		expect(formatToggleBadge(true)).toContain("● ON");
		expect(formatToggleBadge(false)).toContain("○ OFF");
	});

	it("builds rich help banner with highlighted active configuration", () => {
		const help = buildHelpText(state.config, 0.0012);
		expect(help).toContain("pi-prompt-translate");
		expect(help).toContain("Příkazy & Konfigurace:");
		expect(help).toContain("Aktuální přehled:");
		expect(help).toContain("Cena sezení:");
	});

	it("formats confirmation body matching the color-highlighted diff style", () => {
		const body = formatConfirmationBody({
			source: "Udělej to taky",
			english: "Do this too",
			boost: "boost",
			conversationContext: "User: Fix it\nAssistant: Fixed",
			costUsd: 0.0001,
			costCzk: 0.0024,
			usage: { input: 10, output: 5, totalTokens: 15 } as never,
		});
		expect(body).toContain("Prompt Translation Diff");
		expect(body).toContain("[boost: boost]");
		expect(body).toContain("[history: attached]");
		expect(body).toContain("Original (CZ):");
		expect(body).toContain("Udělej to taky");
		expect(body).toContain("Enhanced (EN):");
		expect(body).toContain("Do this too");
		expect(body).toContain("Attached History Context:");
		expect(body).toContain("User: Fix it");
		expect(body).toContain("Odeslat tento překlad agentovi?");
	});
});
