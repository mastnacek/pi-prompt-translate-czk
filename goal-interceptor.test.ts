/**
 * The AgentSession.prototype.prompt patch that /goal translation depends on.
 *
 * The interesting case is a /reload: pi drops the extension cache, re-imports the
 * module (fresh `state`, fresh `sessionCtx`) and keeps the same
 * AgentSession.prototype. The wrapper therefore has to be idempotent AND has to be
 * re-pointed at the new module instance's state, or /goal silently stops
 * translating for the rest of the process.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installPromptInterceptor, uninstallPromptInterceptor } from "./goal.js";
import { state } from "./state.js";

const proto = AgentSession.prototype as unknown as Record<PropertyKey, unknown>;
const pristinePrompt = proto.prompt;

function fakeSessionCtx(): never {
	return { hasUI: false, sessionManager: { getSessionId: () => "s" } } as never;
}

describe("prompt interceptor lifecycle", () => {
	beforeEach(() => {
		// Simulate the engine's own prototype, independent of the running extension.
		proto.prompt = pristinePrompt;
		delete proto[Symbol.for("pi-prompt-translate.prompt-interceptor")];
		delete proto[Symbol.for("pi-prompt-translate.prompt-original")];
		delete proto[Symbol.for("pi-prompt-translate.prompt-handler")];
	});

	it("installs a wrapper that delegates to the engine prompt", async () => {
		const seen: string[] = [];
		proto.prompt = async function (text: string) {
			seen.push(text);
			return "done";
		};
		installPromptInterceptor();
		expect(proto.prompt).not.toBe(pristinePrompt);

		state.config = { enabled: false } as never;
		const session = Object.create(AgentSession.prototype);
		await (proto.prompt as (t: string, o?: unknown) => Promise<unknown>).call(
			session,
			"/goal something",
		);
		expect(seen).toEqual(["/goal something"]);
	});

	it("is idempotent: installing twice does not double-wrap", async () => {
		let calls = 0;
		proto.prompt = async function () {
			calls++;
			return "done";
		};
		installPromptInterceptor();
		const wrapper = proto.prompt;
		installPromptInterceptor();
		expect(proto.prompt).toBe(wrapper);

		state.config = { enabled: false } as never;
		await (wrapper as (t: string, o?: unknown) => Promise<unknown>).call(null, "x");
		expect(calls).toBe(1);
	});

	it("re-points the existing wrapper at a reloaded module's state", async () => {
		// First "load": the wrapper captures a session context, then the run ends.
		proto.prompt = async function () {
			return "done";
		};
		installPromptInterceptor();
		const firstWrapper = proto.prompt;
		state.sessionCtx = fakeSessionCtx();
		state.config = { enabled: true } as never;

		// /reload: session_shutdown clears the context, then the module graph is
		// rebuilt against the same prototype.
		state.sessionCtx = undefined;
		installPromptInterceptor();
		// Same wrapper (no re-wrap), but it must now read the new state.
		expect(proto.prompt).toBe(firstWrapper);

		state.sessionCtx = fakeSessionCtx();
		const restored = (proto[
			Symbol.for("pi-prompt-translate.prompt-handler")
		] as (t: string, o?: unknown) => Promise<string>).call(
			null,
			"/goal oprav ten bug",
		);
		// No live ctx -> text passes through unchanged, but it reaches the *new*
		// state (no throw on a stale/undefined ctx).
		await expect(restored).resolves.toBe("/goal oprav ten bug");
	});

	it("restores the pristine prompt on uninstall", async () => {
		const original = async function () {
			return "done";
		};
		proto.prompt = original;
		installPromptInterceptor();
		expect(proto.prompt).not.toBe(original);

		uninstallPromptInterceptor();
		expect(proto.prompt).toBe(original);
		expect(
			proto[Symbol.for("pi-prompt-translate.prompt-interceptor")],
		).toBeUndefined();
		expect(
			proto[Symbol.for("pi-prompt-translate.prompt-handler")],
		).toBeUndefined();
	});

	it("passes the text through when a stale handler throws", async () => {
		const seen: string[] = [];
		proto.prompt = async function (text: string) {
			seen.push(text);
			return "done";
		};
		installPromptInterceptor();
		proto[Symbol.for("pi-prompt-translate.prompt-handler")] = async () => {
			throw new Error("stale ctx");
		};
		await (proto.prompt as (t: string, o?: unknown) => Promise<unknown>).call(
			null,
			"/goal x",
		);
		expect(seen).toEqual(["/goal x"]);
	});
});
