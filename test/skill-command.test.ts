/**
 * /skill:<name> <args> parsing and translatable-input routing.
 *
 * The engine contract being mirrored: AgentSession._expandSkillCommand splits
 * on the FIRST space, keeps `/skill:<name>` byte-identical and appends the args
 * verbatim — so only args are translatable and the rebuilt command must survive
 * the round trip.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	extractSkillCommand,
	isKnownSkill,
} from "../src/shared/skill-command.js";
import { resolveTranslatableInput } from "../src/shared/translatable-input.js";
import { state } from "../src/shared/state.js";

function fakePi(
	commands: Array<{ name: string; source: string }>,
): ExtensionAPI {
	return { getCommands: () => commands } as unknown as ExtensionAPI;
}

const skillPi = fakePi([
	{ name: "skill:spec-coauthor", source: "skill" },
	{ name: "skill:uma-memory-pi", source: "skill" },
	{ name: "model", source: "extension" },
]);

describe("extractSkillCommand", () => {
	it("splits a skill command into scaffold and args", () => {
		const result = extractSkillCommand(
			"/skill:spec-coauthor Spec this: potřebuji iterovat 50k dokumentů",
		);
		expect(result?.skillName).toBe("spec-coauthor");
		expect(result?.args).toBe("Spec this: potřebuji iterovat 50k dokumentů");
	});

	it("handles a command without args", () => {
		const result = extractSkillCommand("/skill:uma-memory-pi");
		expect(result?.skillName).toBe("uma-memory-pi");
		expect(result?.args).toBe("");
	});

	it("round-trips through rebuild", () => {
		const result = extractSkillCommand("/skill:spec-coauthor český text");
		expect(result).toBeDefined();
		const rebuilt = result!.rebuild("translated text");
		expect(rebuilt).toBe("/skill:spec-coauthor translated text");
		// The rebuilt command must parse to the same scaffold.
		expect(extractSkillCommand(rebuilt)?.skillName).toBe("spec-coauthor");
	});

	it("rejects a bare /skill: with no name", () => {
		expect(extractSkillCommand("/skill:")).toBeUndefined();
	});

	it("rejects other slash commands and plain text", () => {
		expect(extractSkillCommand("/model gpt-4")).toBeUndefined();
		expect(extractSkillCommand("/goal optimalizuj pipeline")).toBeUndefined();
		expect(extractSkillCommand("bez slash prefixu")).toBeUndefined();
	});

	it("rejects leading whitespace (engine would not expand it)", () => {
		expect(extractSkillCommand(" /skill:spec-coauthor text")).toBeUndefined();
	});
});

describe("isKnownSkill", () => {
	it("recognizes skills from getCommands()", () => {
		expect(isKnownSkill(skillPi, "spec-coauthor")).toBe(true);
	});

	it("rejects unknown names and non-skill sources", () => {
		expect(isKnownSkill(skillPi, "nope")).toBe(false);
		// "model" exists but with source "extension" — not a skill.
		expect(isKnownSkill(skillPi, "model")).toBe(false);
	});
});

describe("resolveTranslatableInput", () => {
	beforeEach(() => {
		state.lastGoalTransform = undefined;
		state.lastSkillTransform = undefined;
	});

	it("passes plain Czech text through", () => {
		const result = resolveTranslatableInput("český prompt", skillPi);
		expect(result?.text).toBe("český prompt");
		expect(result?.skillName).toBeUndefined();
	});

	it("translates only the args of a known skill", () => {
		const result = resolveTranslatableInput(
			"/skill:spec-coauthor český text",
			skillPi,
		);
		expect(result?.text).toBe("český text");
		expect(result?.skillName).toBe("spec-coauthor");
		expect(result?.rebuild?.("english text")).toBe(
			"/skill:spec-coauthor english text",
		);
	});

	it("passes unknown skill commands through untouched", () => {
		expect(
			resolveTranslatableInput("/skill:unknown-skill český text", skillPi),
		).toBeUndefined();
	});

	it("passes a known skill without args through untouched", () => {
		expect(
			resolveTranslatableInput("/skill:spec-coauthor", skillPi),
		).toBeUndefined();
	});

	it("passes other slash commands through untouched", () => {
		expect(resolveTranslatableInput("/model gpt-4", skillPi)).toBeUndefined();
	});

	it("passes a /goal control subcommand through untouched", () => {
		expect(resolveTranslatableInput("/goal status", skillPi)).toBeUndefined();
	});

	it("treats the echo of a recent skill transform as done", () => {
		state.lastSkillTransform = {
			from: "/skill:spec-coauthor český text",
			to: "/skill:spec-coauthor english text",
			at: Date.now(),
		};
		expect(
			resolveTranslatableInput("/skill:spec-coauthor english text", skillPi),
		).toBeUndefined();
	});

	it("re-translates after the guard window expires", () => {
		state.lastSkillTransform = {
			from: "/skill:spec-coauthor český text",
			to: "/skill:spec-coauthor english text",
			at: Date.now() - 31_000,
		};
		const result = resolveTranslatableInput(
			"/skill:spec-coauthor english text",
			skillPi,
		);
		expect(result?.text).toBe("english text");
	});
});
