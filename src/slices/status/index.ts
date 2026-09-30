// status/index.ts — the status slice barrel.
//
// The composition root calls registerStatusSlice() once; from then on the rest of
// the plugin reaches the footer through shared/status-bus.ts instead of importing
// this slice, which is what keeps the slice isolated.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerStatusSink } from "../../shared/status-bus.js";
import {
	refreshBalanceStatus,
	updateTranslateStatus,
} from "./render.js";

/**
 * Publish the footer renderer to the kernel seam. Idempotent and side-effect free
 * beyond the registration, so it is safe to call on every load or reload.
 */
export function registerStatusSlice(): void {
	registerStatusSink({
		update: (ctx: ExtensionContext) => updateTranslateStatus(ctx),
		refresh: (ctx: ExtensionContext) => refreshBalanceStatus(ctx),
	});
}
