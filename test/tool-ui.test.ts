import { describe, expect, it } from "vitest";
import {
	applyTranslations,
	collectTextFields,
	formatBlocks,
	isToolUiTarget,
	parseBlocks,
	type ToolTextField,
} from "../src/slices/pipeline/tool-ui.js";
import { normalizeConfig } from "../src/shared/config.js";
import { state } from "../src/shared/state.js";
import { DEFAULT_TOOL_UI_TARGETS } from "../src/shared/types.js";

const QUICK_WIN_FIELDS = ["title", "impact", "steps", "proof", "alternative"];

const card = {
	title: "Translate the quick-win card",
	impact: "The user sees the card in Czech",
	effort: "hour",
	steps: ["Add the hook", "Run the tests"],
	proof: "npm test",
	alternative: "Translate the result instead",
};

describe("tool-UI field collection", () => {
	it("collects only allow-listed fields and never the enum", () => {
		const fields = collectTextFields(card, QUICK_WIN_FIELDS);
		expect(fields.map((f) => f.path)).toEqual([
			["title"],
			["impact"],
			["steps", 0],
			["steps", 1],
			["proof"],
			["alternative"],
		]);
		expect(fields.some((f) => f.path[0] === "effort")).toBe(false);
	});

	it("skips blank and non-string values", () => {
		const fields = collectTextFields(
			{ title: "keep", impact: "   ", proof: 42, steps: ["a", null, ""] },
			QUICK_WIN_FIELDS,
		);
		expect(fields).toEqual([{ path: ["title"], text: "keep" }, { path: ["steps", 0], text: "a" }]);
	});
});

describe("block round trip", () => {
	it("returns the translations in the original field order", () => {
		const fields: ToolTextField[] = collectTextFields(card, QUICK_WIN_FIELDS);
		const block = formatBlocks(fields);
		expect(block.startsWith("<<<0>>>\n")).toBe(true);
		expect(block).toContain("<<<5>>>\nTranslate the result instead");

		const parsed = parseBlocks(
			"Here you go:\n<<<0>>>\nPřeložit kartu quick win\n<<<1>>>\nUživatel vidí kartu česky\n<<<2>>>\nA\n<<<3>>>\nB\n<<<4>>>\nC\n<<<5>>>\nD\n",
			6,
		);
		expect(parsed?.[0]).toBe("Přeložit kartu quick win");
		expect(parsed?.[1]).toBe("Uživatel vidí kartu česky");
		expect(parsed?.[2]).toBe("A");
	});

	it("rejects a block set with a missing marker instead of guessing", () => {
		// Partial output used to be returned with holes the caller could apply; the
		// contract is all-or-nothing, so a short answer leaves the card English.
		expect(parseBlocks("<<<0>>>\nprvní", 3)).toBeNull();
	});

	it("rejects numbering that starts at 1 (off-by-one marker)", () => {
		// The dangerous failure: N blocks, every one in the wrong field. The card
		// would show the impact line under the title and leave one field English.
		expect(
			parseBlocks("<<<1>>>\na\n<<<2>>>\nb\n", 2),
		).toBeNull();
		expect(
			parseBlocks("<<<0>>>\na\n<<<2>>>\nb\n", 2),
		).toBeNull();
	});

	it("rejects duplicated and out-of-order markers", () => {
		expect(parseBlocks("<<<0>>>\na\n<<<0>>>\nb\n", 2)).toBeNull();
		expect(parseBlocks("<<<1>>>\na\n<<<0>>>\nb\n", 2)).toBeNull();
	});

	it("rejects an empty block that would overwrite real card text", () => {
		expect(parseBlocks("<<<0>>>\n   \n<<<1>>>\nb\n", 2)).toBeNull();
	});

	it("keeps multi-line translations inside their block", () => {
		const parsed = parseBlocks("<<<0>>>\nprvní řádek\ndruhý řádek\n<<<1>>>\nx", 2);
		expect(parsed?.[0]).toBe("první řádek\ndruhý řádek");
		expect(parsed?.[1]).toBe("x");
	});
});

describe("input mutation", () => {
	it("writes translations back in place and leaves the enum alone", () => {
		const input = structuredClone(card);
		const fields = collectTextFields(input, QUICK_WIN_FIELDS);
		const translations = [
			"Přeložit kartu quick win",
			"Uživatel vidí kartu česky",
			"Přidat hook",
			"Spustit testy",
			"npm test",
			"Přeložit výsledek",
		];
		const applied = applyTranslations(input, fields, translations);

		expect(applied).toBe(fields.length);
		expect(input.title).toBe("Přeložit kartu quick win");
		expect(input.steps).toEqual(["Přidat hook", "Spustit testy"]);
		expect(input.effort).toBe("hour");
	});

	it("counts only the fields it could actually write", () => {
		const input: Record<string, unknown> = { title: "t", steps: ["s"] };
		const fields: ToolTextField[] = [
			{ path: ["title"], text: "t" },
			{ path: ["steps", 0], text: "s" },
			{ path: ["steps", 5], text: "gone" },
		];
		expect(applyTranslations(input, fields, ["t1", "s1", "x"])).toBe(2);
	});
});

describe("tool-UI targeting", () => {
	it("defaults to the quick-win tools", () => {
		state.config = normalizeConfig({});
		expect(state.config.translateToolUi).toBe(true);
		expect(isToolUiTarget("quick_win")).toBe(true);
		expect(isToolUiTarget("quick_win_done")).toBe(true);
		expect(isToolUiTarget("bash")).toBe(false);
	});

	it("ignores unknown tool names from a persisted config", () => {
		state.config = normalizeConfig({ toolUiTools: ["quick_win", "mystery_tool"] });
		expect(isToolUiTarget("mystery_tool")).toBe(false);
		expect(state.config.toolUiTools).toHaveLength(2);
	});

	it("falls back to the default list when the config clears it", () => {
		state.config = normalizeConfig({ toolUiTools: [] });
		expect(state.config.toolUiTools).toEqual([]);
		expect([...DEFAULT_TOOL_UI_TARGETS]).toContain("quick_win");
	});
});
