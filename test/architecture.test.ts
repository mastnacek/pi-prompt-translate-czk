/**
 * Architecture invariants.
 *
 * These are the rules the vertical-slice refactor exists to enforce, and they are
 * the kind of thing that rots silently: nothing at runtime notices when a slice
 * reaches into a sibling. So they are asserted here, over the real tree, and fail
 * the build instead.
 *
 * The rules (see AGENTS.md):
 *   1. no slice imports another slice
 *   2. src/shared/ never imports a slice
 *   3. the import graph is acyclic
 *   4. no source file exceeds the 400-line hard limit
 *   5. the composition root imports slices and shared, never a file inside a slice
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HARD_LINE_LIMIT = 400;

const IMPORT_RE = /from\s+"(\.[^"]+)"/g;
const BARREL_RE = /(?:^|\s)(?:register|install|uninstall)[A-Z]\w*/;

type Layer = "root" | "shared" | "slice" | "test";

/** Every .ts file in the repo except node_modules, as repo-relative posix paths. */
function tsFiles(dir = ROOT, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".git" || entry === "dist")
			continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) tsFiles(full, out);
		else if (entry.endsWith(".ts"))
			out.push(relative(ROOT, full).split(/[\\/]/).join("/"));
	}
	return out;
}

/** Which slice a file belongs to, by path. */
function layer(file: string): Layer {
	if (file === "index.ts") return "root";
	if (file.startsWith("test/")) return "test";
	if (file.startsWith("src/shared/")) return "shared";
	if (file.startsWith("src/slices/")) return "slice";
	return "test";
}

/** The slice name ("pipeline") a file belongs to. */
function sliceName(file: string): string {
	return file.split("/")[2] ?? "";
}

function importsOf(file: string): string[] {
	const source = readFileSync(join(ROOT, file), "utf8");
	const dir = dirname(join(ROOT, file));
	const out: string[] = [];
	for (const match of source.matchAll(IMPORT_RE)) {
		const spec = match[1];
		if (!spec) continue;
		const abs = resolve(dir, spec).replace(/\.js$/, "");
		out.push(relative(ROOT, abs).split(/[\\/]/).join("/"));
	}
	return out;
}

const FILES = tsFiles().filter((f) => f !== "test/architecture.test.ts");
const GRAPH = new Map(FILES.map((f) => [f, importsOf(f).filter((t) => existsSync(join(ROOT, `${t}.ts`)))]));
const SOURCE_FILES = FILES.filter((f) => layer(f) !== "test");

describe("vertical slice architecture", () => {
	it("finds the expected slices and kernel", () => {
		const slices = new Set(
			SOURCE_FILES.filter((f) => layer(f) === "slice").map(sliceName),
		);
		expect([...slices].sort()).toEqual(["commands", "goal", "pipeline", "status"]);
		// Every slice exposes a barrel, and the root is the only multi-slice importer.
		for (const slice of slices)
			expect(FILES).toContain(`src/slices/${slice}/index.ts`);
	});

	it("rule 1: no slice imports another slice", () => {
		const violations: string[] = [];
		for (const [file, targets] of GRAPH) {
			if (layer(file) !== "slice") continue;
			for (const target of targets) {
				if (layer(target) === "slice" && sliceName(target) !== sliceName(file))
					violations.push(`${file} -> ${target}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("rule 2: shared/ never imports a slice", () => {
		const violations = [...GRAPH].flatMap(([file, targets]) =>
			layer(file) === "shared" && targets.some((t) => layer(t) === "slice")
				? [file]
				: [],
		);
		expect(violations).toEqual([]);
	});

	it("rule 3: the import graph is acyclic", () => {
		const nodes = SOURCE_FILES;
		const state = new Map(nodes.map((n) => [n, 0])); // 0 new, 1 open, 2 done
		const cycles: string[] = [];
		const stack: string[] = [];
		const visit = (node: string): void => {
			state.set(node, 1);
			stack.push(node);
			for (const next of GRAPH.get(node) ?? []) {
				if (!state.has(next)) continue;
				if (state.get(next) === 1)
					cycles.push([...stack.slice(stack.indexOf(next)), next].join(" -> "));
				else if (state.get(next) === 0) visit(next);
			}
			stack.pop();
			state.set(node, 2);
		};
		for (const node of nodes) if (state.get(node) === 0) visit(node);
		expect(cycles).toEqual([]);
	});

	it("rule 4: no source file exceeds the hard line limit", () => {
		const oversized = SOURCE_FILES.map((file) => ({
			file,
			lines: readFileSync(join(ROOT, file), "utf8").split("\n").length,
		})).filter((entry) => entry.lines > HARD_LINE_LIMIT);
		expect(oversized).toEqual([]);
	});

	it("rule 5: the composition root is wiring only", () => {
		const source = readFileSync(join(ROOT, "index.ts"), "utf8");
		for (const target of GRAPH.get("index.ts") ?? []) {
			const isBarrel =
				posix.basename(target) === "index" || layer(target) === "shared";
			expect(`${target}:${isBarrel}`).toBe(`${target}:true`);
		}
		// No feature logic: the root may only call the slice barrels and the
		// kernel, never define a translation/parsing routine of its own.
		expect(source).not.toMatch(/function\s+(translate|protect|parse|render)/);
		expect(BARREL_RE.test(source)).toBe(true);
	});
});
