/**
 * Segment protection: the parts of a prompt or final answer that must survive
 * translation untouched (headers, <file> blocks, @ triggers, mentions, paths, URLs,
 * placeholders), and the restore/clean steps that put them back.
 * Split out of `translate.ts`.
 */
import { state } from "../state.js";
import type { ProtectedSegment, ProtectedText } from "../types.js";

function shouldProtectTagName(tagName: string): boolean {
	const normalized = tagName.toLowerCase();
	return normalized.includes("action") || normalized === "pi-autoprompt-next";
}

/**
 * Czech case endings a name can pick up in running text (`herder` → `do
 * herderu`, `o herderovi`, `s herderem`). Longest first: JS alternation is
 * ordered, so `ovi` has to precede `o` and `em` before `e`.
 */
const CZ_CASE_ENDINGS = [
	"ovi",
	"ého",
	"ému",
	"ých",
	"ům",
	"ech",
	"ách",
	"ami",
	"emi",
	"em",
	"ou",
	"u",
	"a",
	"e",
	"o",
	"ě",
	"y",
	"ý",
	"i",
	"í",
	"ů",
].join("|");

export function protectPromptSegments(
	text: string,
	knownWords: string[] = state.atWords,
): ProtectedText {
	const segments: ProtectedSegment[] = [];
	let protectedText = text;
	const addSegment = (value: string) => {
		const placeholder = `__PI_PROMPT_TRANSLATE_PROTECTED_${segments.length}__`;
		segments.push({ placeholder, value });
		return placeholder;
	};

	// 1. Protect pi-read-all headers if present
	protectedText = protectedText.replace(/\[pi-read-all\]:[^\n]*\n*/g, (match) =>
		addSegment(match),
	);

	// 2. Protect any <file ...>...</file>, <context>...</context>, <document>...</document>, <code ...>...</code>
	protectedText = protectedText.replace(
		/<(file|context|document|code|snippet)\b[^>]*>[\s\S]*?<\/\1>/gi,
		(match) => addSegment(match),
	);

	// 3. Protect multi-line markdown code blocks and inline code
	protectedText = protectedText.replace(/```[\s\S]*?```/g, (match) =>
		addSegment(match),
	);
	protectedText = protectedText.replace(/`[^`\n]+`/g, (match) =>
		addSegment(match),
	);

	// 4. Protect @! trigger paths (pi-read-all)
	protectedText = protectedText.replace(
		/@!"[^"\n]+"|@![^\s"(){}[\];,]+/g,
		(match) => addSegment(match),
	);

	// 5. Protect standard @ file mentions (@src/file.ts, @"quoted file.ts")
	protectedText = protectedText.replace(/@"[^"\n]+"|@[\w][\w./-]*/g, (match) =>
		addSegment(match),
	);

	// 6. Protect web URLs, git URLs, and file URLs
	protectedText = protectedText.replace(
		/(?:https?|git\+https?|ftp|file):\/\/[^\s<>)"]+?(?=[.,;:!?]*(?:\s|[<>)"]|$))/g,
		(match) => addSegment(match),
	);

	// 7. Protect Windows absolute paths (e.g. C:\foo\bar, D:/foo/bar) and UNC paths (\\server\share\...)
	protectedText = protectedText.replace(
		/\b[A-Za-z]:[\\/](?:[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?])?/g,
		(match) => addSegment(match),
	);
	protectedText = protectedText.replace(
		/\\\\[a-zA-Z0-9_.-]+\\[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?]/g,
		(match) => addSegment(match),
	);

	// 8. Protect Unix absolute paths, home paths, and relative paths (e.g. /tmp/..., ~/..., ./..., ../...)
	protectedText = protectedText.replace(
		/(?<=^|[\s<>"'`{}()[\]])(?:~|\/tmp|\/var|\/home|\/etc|\/usr|\/opt|\/srv|\/root|\/mnt|\/Volumes|\/Users)\/[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?]/g,
		(match) => addSegment(match),
	);
	protectedText = protectedText.replace(
		/(?<=^|[\s<>"'`{}()[\]])(?:\.{1,2}[\\/])[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?]/g,
		(match) => addSegment(match),
	);

	// 9. Protect clipboard image filenames if pasted bare (pi-clipboard-*.png)
	protectedText = protectedText.replace(
		/(?<=^|[\s<>"'`{}()[\]])pi-clipboard-[a-zA-Z0-9-]+\.[a-zA-Z0-9]+(?=[.,;:!?]*(?:\s|[<>"'`{}()[\]]|$))/g,
		(match) => addSegment(match),
	);

	// 10. User-written `!term!` markers: the explicit "do not translate this"
	// syntax. Rewritten into the same <keep> tags rule 12 emits, so there is one
	// restore path (`stripKeepTags`). Placed after rules 1-9 so a marker inside
	// code, a path or a URL is already masked and never reaches this pattern.
	//
	// `[^\s!]+` (no whitespace) is load-bearing, not cosmetic: with `[^!]+` a
	// plain Czech sentence like "Pozor! To je chyba!" would be read as one
	// protected span (" To je chyba") and silently left untranslated.
	// ponytail: single token only, no spaces — so `!a b!` is not a marker; use
	// <keep>a b</keep> for a phrase.
	protectedText = protectedText.replace(
		/!([^\s!]+)!/g,
		(_match, term: string) => `<keep>${term}</keep>`,
	);

	// 11. Protect ? symbol queries (?myFunc, ?varName from pi-at-words)
	protectedText = protectedText.replace(
		/(?<=[ \t([{]|^)\?[A-Za-z0-9_]{2,}/g,
		(match) => addSegment(match),
	);

	// 12. Mark (not mask) confirmed ?words / symbols from @-mentioned files.
	// Rules 1-10 hide opaque payloads the model must not read. These are the
	// opposite: names the model MUST see to understand the sentence, it just
	// must not translate them. A placeholder would erase that context.
	if (knownWords && knownWords.length > 0) {
		const alts = [...knownWords]
			.filter(
				(w): w is string =>
					typeof w === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w),
			)
			.sort((a, b) => b.length - a.length)
			.join("|");
		if (alts) {
			// Without a case ending in the pattern, `?herder` protects the nominative
			// only: "do herderu" slipped through, and the model invented "the herder
			// directory". Match the ending too, but wrap ONLY the stem so the model
			// drops the Czech suffix instead of being handed "herderu".
			// ponytail: fixed ending list, not a Czech morphology engine — add endings
			// here as they turn up; worst case is a term left untranslated.
			const re = new RegExp(
				`(?<![A-Za-z0-9_])(${alts})(?:(${CZ_CASE_ENDINGS}))?(?![A-Za-z0-9_])`,
				"g",
			);
			protectedText = protectedText.replace(
				re,
				(_match, stem: string, ending?: string) =>
					`<keep>${stem}</keep>${ending ?? ""}`,
			);
		}
	}

	return { text: protectedText, segments };
}

export function protectFinalAnswerSegments(text: string): ProtectedText {
	const segments: ProtectedSegment[] = [];
	let protectedText = text;
	const addSegment = (value: string) => {
		const placeholder = `__PI_PROMPT_TRANSLATE_PROTECTED_${segments.length}__`;
		segments.push({ placeholder, value });
		return placeholder;
	};

	protectedText = protectedText.replace(
		/<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g,
		(match, tagName: string) =>
			shouldProtectTagName(tagName) ? addSegment(match) : match,
	);
	protectedText = protectedText.replace(
		/<([A-Za-z][\w:-]*)\b[^>]*\/>/g,
		(match, tagName: string) =>
			shouldProtectTagName(tagName) ? addSegment(match) : match,
	);

	// Protect multi-line markdown code blocks and inline code.
	// Same two rules the prompt path uses. Without them a ```ts sample in an
	// answer goes to the translator unprotected and comes back with renamed
	// identifiers or broken syntax — the prompt path has always guarded these.
	protectedText = protectedText.replace(/```[\s\S]*?```/g, (match) =>
		addSegment(match),
	);
	protectedText = protectedText.replace(/`[^`\n]+`/g, (match) =>
		addSegment(match),
	);

	// Protect standard @ file mentions (@src/file.ts, @"quoted file.ts").
	protectedText = protectedText.replace(/@"[^"\n]+"|@[\w][\w./-]*/g, (match) =>
		addSegment(match),
	);

	// Protect web URLs, git URLs, and file URLs
	protectedText = protectedText.replace(
		/(?:https?|git\+https?|ftp|file):\/\/[^\s<>)"]+?(?=[.,;:!?]*(?:\s|[<>)"]|$))/g,
		(match) => addSegment(match),
	);

	// Protect Windows absolute paths (e.g. C:\foo\bar, D:/foo/bar) and UNC paths
	protectedText = protectedText.replace(
		/\b[A-Za-z]:[\\/](?:[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?])?/g,
		(match) => addSegment(match),
	);
	protectedText = protectedText.replace(
		/\\\\[a-zA-Z0-9_.-]+\\[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?]/g,
		(match) => addSegment(match),
	);

	// Protect Unix absolute paths, home paths, and relative paths
	protectedText = protectedText.replace(
		/(?<=^|[\s<>"'`{}()[\]])(?:~|\/tmp|\/var|\/home|\/etc|\/usr|\/opt|\/srv|\/root|\/mnt|\/Volumes|\/Users)\/[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?]/g,
		(match) => addSegment(match),
	);
	protectedText = protectedText.replace(
		/(?<=^|[\s<>"'`{}()[\]])(?:\.{1,2}[\\/])[^\s<>"'`{}()[\]]*[^\s<>"'`{}()[\].,;:!?]/g,
		(match) => addSegment(match),
	);

	// Protect clipboard image filenames if present
	protectedText = protectedText.replace(
		/(?<=^|[\s<>"'`{}()[\]])pi-clipboard-[a-zA-Z0-9-]+\.[a-zA-Z0-9]+(?=[.,;:!?]*(?:\s|[<>"'`{}()[\]]|$))/g,
		(match) => addSegment(match),
	);

	return { text: protectedText, segments };
}

/**
 * True when the payload's bare text is already present in the restored answer.
 *
 * The segment value keeps its markdown delimiters (`` `code` ``, `*bold*`), but a
 * translation model reliably drops them: it sees `__PI_..._0__`, emits the meaning
 * in prose, and hands back `code` without the backticks. Comparing the delimited
 * form therefore never matches and the recovery re-appends a duplicate of text that
 * is already right there. Only the wrapping delimiters come off — underscores
 * inside an identifier must survive, or `sub_HledejLidyIFX.lss` stops matching.
 *
 * Short values are treated as absent: at three characters an ordinary Czech word
 * would satisfy `includes` by coincidence and the recovery would silently drop
 * genuinely lost content.
 */
const BARE_MIN_LENGTH = 4;

function hasBareValue(restored: string, value: string): boolean {
	const bare = value
		.replace(/`/g, "")
		.replace(/^[*]+|[*]+$/g, "")
		.replace(/^_+|_+$/g, "")
		.trim();
	if (bare.length < BARE_MIN_LENGTH) return false;
	return restored.includes(bare);
}

export function restoreProtectedSegments(
	text: string,
	segments: ProtectedSegment[],
): string {
	let restored = text;
	for (const segment of segments) {
		if (restored.includes(segment.placeholder)) {
			restored = restored.split(segment.placeholder).join(segment.value);
		} else {
			// Fallback: handle slight model formatting mutations (missing underscores
			// or spaces, different casing). Global, because the model repeating one
			// placeholder is legitimate (it references the same file twice) and
			// restoring only the first would hand the agent a literal
			// __PI_PROMPT_TRANSLATE_PROTECTED_0__ in its own answer. The exact-match
			// branch above already replaces every occurrence; this branch must not be
			// the weaker one.
			//
			// Anchored and space-only: the pattern has to match the whole placeholder
			// token. An unanchored `\s` also spans newlines, so a dropped underscore
			// used to match placeholder text split across two lines.
			const fuzzyRegex = new RegExp(
				`(^|[^A-Za-z0-9_])${segment.placeholder.replace(
					/_/g,
					"[_ ]?",
				)}(?![A-Za-z0-9_])`,
				"gi",
			);
			if (fuzzyRegex.test(restored)) {
				restored = restored.replace(fuzzyRegex, `$1${segment.value}`);
			} else if (!hasBareValue(restored, segment.value)) {
				// Safety recovery: if the placeholder was completely dropped by the
				// model, append the protected payload so critical code, links, or files
				// are not lost.
				//
				// Only when the value is genuinely absent. Without this check the
				// recovery re-appends anything the model already emitted on its own —
				// an answer dense in inline code came back with every path, id and URL
				// duplicated as a trailing list, because the model dropped the
				// placeholders but kept their meaning.
				restored = `${restored.trimEnd()}\n\n${segment.value}`;
			}
		}
	}
	return restored;
}

/**
 * Drop the visible <keep> markers added by rule 11, keeping the wrapped term.
 * The term itself is never re-inserted from a segment table: the model already
 * had it in view, so the worst case is a mangled term, not silently lost content.
 */
export function stripKeepTags(text: string): string {
	return text.replace(/<\/?keep>/g, "");
}

export function cleanTranslationOutput(
	text: string,
	tag: string = "source_text",
): string {
	let cleaned = text.trim();
	// Strip the wrapper this request actually used (a random per-request tag), and
	// keep the literal names as a fallback for models that echo the old contract.
	const tagAlternatives = [
		tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		"(?:source_text|translation)",
	].join("|");
	const tagMatch = cleaned.match(
		new RegExp(
			`^<(${tagAlternatives})>\\s*([\\s\\S]*?)\\s*<\\/\\1>$`,
			"i",
		),
	);
	if (tagMatch) {
		cleaned = tagMatch[2].trim();
	}
	// Strip accidental echoing of conversation_context if any
	cleaned = cleaned
		.replace(/<conversation_context>[\s\S]*?<\/conversation_context>/gi, "")
		.trim();
	// Belt and braces: if a per-request tag survives anywhere in the output (the
	// model echoing our scaffolding mid-answer), drop it rather than show the user
	// the internal tag name.
	if (tag !== "source_text") {
		const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		cleaned = cleaned
			.replace(new RegExp(`</?${escaped}>`, "gi"), "")
			.trim();
	}
	return cleaned;
}
