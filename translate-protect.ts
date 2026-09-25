/**
 * Segment protection: the parts of a prompt or final answer that must survive
 * translation untouched (headers, <file> blocks, @ triggers, mentions, paths, URLs,
 * placeholders), and the restore/clean steps that put them back.
 * Split out of `translate.ts`.
 */
import { state } from "./state";
import type { ProtectedSegment, ProtectedText } from "./types";

function shouldProtectTagName(tagName: string): boolean {
	const normalized = tagName.toLowerCase();
	return normalized.includes("action") || normalized === "pi-autoprompt-next";
}

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

	// 10. Protect ? symbol queries (?myFunc, ?varName from pi-at-words)
	protectedText = protectedText.replace(
		/(?<=[ \t([{]|^)\?[A-Za-z0-9_]{2,}/g,
		(match) => addSegment(match),
	);

	// 11. Protect confirmed ?words / symbols from @-mentioned files
	if (knownWords && knownWords.length > 0) {
		const alts = [...knownWords]
			.filter(
				(w): w is string =>
					typeof w === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w),
			)
			.sort((a, b) => b.length - a.length)
			.join("|");
		if (alts) {
			const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])`, "g");
			protectedText = protectedText.replace(re, (match) => addSegment(match));
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

export function restoreProtectedSegments(
	text: string,
	segments: ProtectedSegment[],
): string {
	let restored = text;
	for (const segment of segments) {
		if (restored.includes(segment.placeholder)) {
			restored = restored.split(segment.placeholder).join(segment.value);
		} else {
			// Fallback: handle slight model formatting mutations (e.g. missing underscores or spaces)
			const fuzzyRegex = new RegExp(
				segment.placeholder.replace(/_/g, "[_\\s]?"),
				"i",
			);
			if (fuzzyRegex.test(restored)) {
				restored = restored.replace(fuzzyRegex, segment.value);
			} else {
				// Safety recovery: if the placeholder was completely dropped by the model,
				// append the protected payload to ensure critical code, links, or files are not lost.
				restored = `${restored.trimEnd()}\n\n${segment.value}`;
			}
		}
	}
	return restored;
}

export function cleanTranslationOutput(text: string): string {
	let cleaned = text.trim();
	const tagMatch = cleaned.match(
		/^<(?:source_text|translation)>\s*([\s\S]*?)\s*<\/(?:source_text|translation)>$/i,
	);
	if (tagMatch) {
		cleaned = tagMatch[1].trim();
	}
	// Strip accidental echoing of conversation_context if any
	cleaned = cleaned
		.replace(/<conversation_context>[\s\S]*?<\/conversation_context>/gi, "")
		.trim();
	return cleaned;
}
