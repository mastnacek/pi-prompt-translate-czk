// state.ts — shared mutable state held in one object so every module reads and
// writes the same live values (rebinding via exported `let` is not assignable
// from importers; a single object sidesteps that).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	type PendingTranslation,
	type TranslateConfig,
} from "./types";

export interface TelemetryStats {
	totalRequests: number;
	promptRequests: number;
	answerRequests: number;
	openRouterRequests: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	cacheHitTurns: number;
	savedCostUsd: number;
}

export const state = {
	config: { ...DEFAULT_CONFIG } as TranslateConfig,
	/** Set when a prompt was translated; drives final-answer translation. */
	pending: undefined as PendingTranslation | undefined,
	/** Latest extension context, used by the AgentSession.prompt interceptor (which
	 *  runs outside any extension event) to reach the model registry and UI. */
	sessionCtx: undefined as ExtensionContext | undefined,
	piApi: undefined as ExtensionAPI | undefined,
	/** Guard against double-translation if a future pi version ever routes /goal
	 *  commands through the input event again after our prompt interceptor ran. */
	lastGoalTransform: undefined as
		| { from: string; to: string; at: number }
		| undefined,
	/** Translation USD cost accumulated in this session (recomputed on session_start). */
	sessionCostUsd: 0,
	/** Confirmed words/symbols synchronized from pi-at-words. */
	atWords: [] as string[],
	/** Optimization, routing, and cache telemetry accumulated this session. */
	telemetry: {
		totalRequests: 0,
		promptRequests: 0,
		answerRequests: 0,
		openRouterRequests: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		cacheHitTurns: 0,
		savedCostUsd: 0,
	} as TelemetryStats,
};

export function resetPending(): void {
	state.pending = undefined;
}
