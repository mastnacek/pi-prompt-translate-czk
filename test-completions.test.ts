import { describe, expect, it } from "vitest";
import { getArgumentCompletions } from "./completions.js";

describe("prompt-translate completions", () => {
	it("root completions include --global", () => {
		const items = getArgumentCompletions("");
		expect(items).not.toBeNull();
		const values = items?.map((i) => i.value);
		expect(values).toContain("--global ");
		expect(values).toContain("model ");
		expect(values).toContain("think ");
	});

	it("--global prefix preserves child completions", () => {
		const items = getArgumentCompletions("--global ");
		expect(items).not.toBeNull();
		const values = items?.map((i) => i.value);
		expect(values).toContain("--global model ");
		expect(values).toContain("--global think ");

		const thinkItems = getArgumentCompletions("--global think ");
		expect(thinkItems).not.toBeNull();
		const thinkValues = thinkItems?.map((i) => i.value);
		expect(thinkValues).toContain("--global think on");
		expect(thinkValues).toContain("--global think off");
	});
});
