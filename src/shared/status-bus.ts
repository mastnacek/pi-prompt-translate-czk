// status-bus.ts — the seam between the slices and the footer status segment.
//
// The status slice owns *rendering* the footer; four other modules need to ask
// for a repaint (the translate kernel, the pipeline, the goal interceptor, the
// commands slice). Calling into the slice directly would be a slice→slice import,
// which VSA forbids, and duplicating the render would put the same state in two
// places. So the owner registers a sink here at composition time and everyone else
// calls the two verbs below.
//
// Both calls are no-ops until the sink is registered, which is what makes the
// kernel importable from tests without a session.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface StatusSink {
	/** Repaint the status segment from current state. */
	update(ctx: ExtensionContext): void;
	/** Refresh the balance/rate cache, then repaint. */
	refresh(ctx: ExtensionContext): Promise<void>;
}

let sink: StatusSink | undefined;

/** Called once by the composition root, through the status slice's barrel. */
export function registerStatusSink(next: StatusSink): void {
	sink = next;
}

export function updateTranslateStatus(ctx: ExtensionContext): void {
	sink?.update(ctx);
}

export function refreshBalanceStatus(ctx: ExtensionContext): Promise<void> {
	return sink ? sink.refresh(ctx) : Promise.resolve();
}
