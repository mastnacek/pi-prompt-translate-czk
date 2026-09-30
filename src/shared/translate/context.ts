/**
 * Request context: provider headers, deictic-reference detection and the recent
 * conversation context that gets attached to a translation.
 * Split out of `translate.ts`.
 */
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export function buildEffectiveHeaders(
	provider: string,
	sessionId?: string,
	baseHeaders?: Record<string, string | null>,
): Record<string, string> {
	const result: Record<string, string> = {};
	if (baseHeaders) {
		for (const [k, v] of Object.entries(baseHeaders)) {
			if (v !== null && v !== undefined) {
				result[k] = v;
			}
		}
	}
	if (provider === "openrouter") {
		result["HTTP-Referer"] =
			"https://github.com/mastnacek/pi-prompt-translate-czk";
		result["X-Title"] = "Pi Prompt Translate";
		if (sessionId && sessionId.trim().length > 0) {
			result["x-session-id"] = sessionId.trim();
		}
	}
	return result;
}

export function hasDeicticReferences(text: string): boolean {
	const normalized = text.toLowerCase();
	return /(?<![\p{L}\p{N}_])(to|ten|ta|ti|ty|tento|tato|toto|tyto|tohle|tamto|tamten|taky|také|stejně|stejný|stejnou|druhou|druhý|druhé|další|předchozí|výše|minulý|minulou|minule|stále|pořád)(?![\p{L}\p{N}_])/iu.test(
		normalized,
	);
}

export function extractRecentContext(
	ctx: ExtensionContext,
	maxTurns = 2,
	maxChars = 600,
): string | undefined {
	const sessionManager = ctx.sessionManager;
	if (!sessionManager) return undefined;

	let entries: unknown[];
	try {
		if (typeof sessionManager.buildContextEntries === "function") {
			entries = sessionManager.buildContextEntries();
		} else if (typeof sessionManager.getEntries === "function") {
			entries = sessionManager.getEntries();
		} else {
			return undefined;
		}
	} catch {
		return undefined;
	}

	const messages: Array<{ role: string; text: string }> = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as {
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		if (e.type !== "message" || !e.message) continue;
		const role = e.message.role;
		if (role !== "user" && role !== "assistant") continue;

		let text = "";
		if (typeof e.message.content === "string") {
			text = e.message.content;
		} else if (Array.isArray(e.message.content)) {
			text = e.message.content
				.filter(
					(part: { type?: string; text?: string }) =>
						part && part.type === "text" && typeof part.text === "string",
				)
				.map((part: { text: string }) => part.text)
				.join(" ");
		}
		const cleanText = text.trim().replace(/\s+/g, " ");
		if (cleanText) {
			messages.push({ role, text: cleanText });
		}
	}

	if (messages.length === 0) return undefined;

	const recent = messages.slice(-maxTurns * 2);
	const lines = recent.map((m) => {
		const label = m.role === "user" ? "User" : "Assistant";
		const snippet =
			m.text.length > maxChars ? `${m.text.slice(0, maxChars)}…` : m.text;
		return `${label}: ${snippet}`;
	});

	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * A per-request tag name for the source payload.
 *
 * The tag used to be the literal `source_text`, so a prompt containing
 * `</source_text>` closed the wrapper early and the rest of the input was read as
 * part of the surrounding structure. The system prompt says "do not wrap your
 * output in <source_text> tags", but a word in a prompt is not a structural
 * guarantee. A random tag cannot be guessed from the input, so an injected closing
 * tag is just text.
 */
export function createSourceTag(): string {
	return `source_text_${randomUUID().replace(/-/g, "")}`;
}

function escapeForTag(value: string, tag: string): string {
	// Defence in depth. The random tag is already unguessable from the input, but
	// the payload must not carry a raw closing tag for *any* name we use either:
	// `</source_text>` and friends are the legacy contract the model has seen in
	// training, and one of them in the payload is an invitation to close the block
	// early.
	const names = new Set([tag, "source_text", "translation", "conversation_context"]);
	let escaped = value;
	for (const name of names) {
		escaped = escaped
			.split(`</${name}>`)
			.join(`&lt;/${name}&gt;`)
			.split(`<${name}>`)
			.join(`&lt;${name}&gt;`);
	}
	return escaped;
}

export function createTranslationContext(
	systemPrompt: string,
	text: string,
	conversationContext?: string,
	tag: string = "source_text",
): Context {
	const body = escapeForTag(text, tag);
	const userContent =
		conversationContext && conversationContext.trim().length > 0
			? `<conversation_context>\n${escapeForTag(conversationContext.trim(), "conversation_context")}\n</conversation_context>\n\n<${tag}>\n${body}\n</${tag}>`
			: `<${tag}>\n${body}\n</${tag}>`;

	return {
		systemPrompt,
		// Omit volatile timestamps from translation-only requests to improve provider prompt-cache hits.
		messages: [
			{
				role: "user",
				content: userContent,
			} as never,
		],
		tools: undefined,
	};
}

// Retry-worthy errors: rate limits, server errors, network/timeouts. Not 400 (e.g. mandatory reasoning).

export function isTransientError(msg?: string): boolean {
	if (!msg) return true;
	return /(429|5\d\d|overload|rate.?limit|timeout|timed out|temporar|econnreset|etimedout|unavailable)/i.test(
		msg,
	);
}
