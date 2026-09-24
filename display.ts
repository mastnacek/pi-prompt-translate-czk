import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	FINAL_TRANSLATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	type FinalTranslationRecord,
	type TranslationUsage,
} from "./types.js";

const AT_WORDS_PINK = "\x1b[1m\x1b[38;2;255;95;215m";
const AT_WORDS_PINK_OFF = "\x1b[22m\x1b[39m";
const AT_WORDS_GREEN = "\x1b[1m\x1b[38;2;0;255;102m";
const AT_WORDS_GREEN_OFF = "\x1b[22m\x1b[39m";

export const AT_WORDS_MENTION_SRC = String.raw`@"[^"\n]+"|@[\w][\w./-]*`;
let atWordsRe: RegExp | null = null;

export function setAtWordsRegex(re: RegExp | null): void {
	atWordsRe = re;
}

export function styleAtWords(text: string): string {
	if (atWordsRe === null) return text;
	return text.replace(atWordsRe, (m) =>
		m.startsWith("@")
			? `${AT_WORDS_GREEN}${m}${AT_WORDS_GREEN_OFF}`
			: `${AT_WORDS_PINK}${m}${AT_WORDS_PINK_OFF}`,
	);
}

let finalTranslationByDisplayedText = new Map<string, string>();

export function getFinalTranslationMap(): Map<string, string> {
	return finalTranslationByDisplayedText;
}

export function rebuildFinalTranslationMap(ctx: ExtensionContext): void {
	const next = new Map<string, string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== FINAL_TRANSLATION_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}
		const record = entry.data as Partial<FinalTranslationRecord>;
		if (
			typeof record.translated === "string" &&
			typeof record.english === "string"
		) {
			next.set(record.translated, record.english);
		}
	}
	finalTranslationByDisplayedText = next;
}

export function rememberFinalTranslation(
	pi: ExtensionAPI,
	record: FinalTranslationRecord,
): void {
	finalTranslationByDisplayedText.set(record.translated, record.english);
	pi.appendEntry(FINAL_TRANSLATION_ENTRY_TYPE, record);
}

export function replaceDisplayedAssistantTextWithEnglish(
	message: ContextEvent["messages"][number],
): ContextEvent["messages"][number] {
	if (message.role !== "assistant") return message;
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text") return part;
		const english = finalTranslationByDisplayedText.get(part.text.trim());
		if (!english) return part;
		changed = true;
		return { ...part, text: english };
	});
	return changed ? { ...message, content } : message;
}

export function sumSessionCostUsd(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;
		if (
			entry.customType !== STATE_ENTRY_TYPE &&
			entry.customType !== FINAL_TRANSLATION_ENTRY_TYPE
		)
			continue;
		const usage = (entry.data as { usage?: TranslationUsage } | undefined)?.usage;
		const cost = usage?.cost?.total;
		if (typeof cost === "number") total += cost;
	}
	return total;
}
