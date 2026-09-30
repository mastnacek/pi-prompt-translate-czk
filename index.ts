// index.ts — the composition root.
//
// Wiring only: publish the status renderer, arm the /goal patch, register the
// four slices, and drain every subscription on shutdown. All behaviour lives in
// src/slices/*; all shared contracts live in src/shared/*.
//
// Wire order matters in one place only: the status sink is published first,
// because session_start asks the footer to paint itself and the sink is the
// kernel-side seam the rest of the plugin repaints through.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extractLatestConfig } from "./src/shared/config.js";
import { rebuildFinalTranslationMap, setAtWordsRegex, sumSessionCostUsd } from "./src/shared/display.js";
import { state } from "./src/shared/state.js";
import { refreshBalanceStatus, updateTranslateStatus } from "./src/shared/status-bus.js";
import {
	installPromptInterceptor,
	uninstallPromptInterceptor,
} from "./src/slices/goal/index.js";
import { registerPipeline } from "./src/slices/pipeline/index.js";
import { registerStatusSlice } from "./src/slices/status/index.js";
import { registerTranslateCommand } from "./src/slices/commands/index.js";

export default function (pi: ExtensionAPI) {
	// A subagent or child session loads every global extension; the translation
	// pipeline must not run inside a delegated run.
	if (process.env.PI_SUBAGENT === "true" || process.env.PI_CHILD_SESSION)
		return;

	const unsubscribers: Array<() => void> = [];

	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	state.piApi = pi;

	registerStatusSlice();
	installPromptInterceptor();
	registerTranslateCommand(pi);
	registerPipeline(pi, track);

	// Both lifecycle handlers are tracked. session_shutdown is the drainer, so its
	// own unsubscribe is not strictly needed, but registering it keeps the shutdown
	// path symmetric and satisfies the leak invariant (every pi.on() needs a
	// reachable unsubscribe); the engine drops that listener on the way out anyway.
	track(
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			// Re-arm the interceptor on every session start, not just at module load.
			// session_shutdown tears the patch down (lifecycle-clean, see
			// extensions.md §resources), and whether the extension module is
			// re-imported depends on the path that got us here (cancel, reload,
			// session swap, exit). Installing on session_start is idempotent.
			installPromptInterceptor();
			state.sessionCtx = ctx;
			state.config = extractLatestConfig(ctx);
			rebuildFinalTranslationMap(ctx);
			state.sessionCostUsd = sumSessionCostUsd(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pi-prompt-translate input ${state.config.enabled ? "on" : "off"}, responses ${state.config.translateResponses ? "on" : "off"} (target: ${state.config.targetLanguage}, model: ${state.config.translateModel})`,
					"info",
				);
			}
			refreshBalanceStatus(ctx);
			updateTranslateStatus(ctx);
		}),
	);

	// session_shutdown is the drainer itself: every path that ends a run converges
	// here (cancel, reload, session swap, exit).
	track(
		pi.on("session_shutdown", () => {
			while (unsubscribers.length > 0) unsubscribers.pop()?.();
			// Hand the shared AgentSession.prototype back untouched before dropping
			// the sessionCtx the interceptor closure reads. Without this the patch
			// outlives the run that installed it and points at a cleared state.
			uninstallPromptInterceptor();
			state.sessionCtx = undefined;
			state.pending = undefined;
			state.atWords = [];
			setAtWordsRegex(null);
		}),
	);
}
