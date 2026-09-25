/**
 * Language detection: the Czech/Slovak and English word tables, plus the detector
 * that decides whether a prompt is already English or code and can skip translation.
 * Split out of `translate.ts`.
 */


const CZECH_SLOVAK_DIACRITICS_RE =
	/[áčďéěíňóřšťúůýžľĺŕôäöüßąćęłńśźżàâçèéêëîïôùûüÿñáéíóúÁČĎÉĚÍŇÓŘŠŤÚŮÝŽĽĹŔÔÄÖÜẞĄĆĘŁŃŚŹŻÀÂÇÈÉÊËÎÏÔÙÛÜŸÑÁÉÍÓÚ]/;

const CZECH_ASCII_WORDS = new Set([
	"ahoj",
	"cau",
	"prosim",
	"dekuji",
	"diky",
	"jak",
	"proc",
	"kde",
	"kdy",
	"kdo",
	"co",
	"chci",
	"potrebuji",
	"udelat",
	"udelej",
	"oprav",
	"opravit",
	"vytvor",
	"vytvorit",
	"napis",
	"napiste",
	"najdi",
	"hledej",
	"zkus",
	"zkuste",
	"muzes",
	"muzete",
	"pro",
	"nebo",
	"takze",
	"protoze",
	"kter",
	"ktera",
	"ktere",
	"ktery",
	"ktereho",
	"kterou",
	"tento",
	"tato",
	"toto",
	"tyto",
	"sem",
	"tam",
	"jeste",
	"uz",
	"vse",
	"vsechno",
	"soubor",
	"soubory",
	"funkce",
	"trida",
	"kod",
	"chyba",
	"chybu",
	"funguje",
	"nefunguje",
	"prikaz",
	"spust",
	"smaz",
	"pridej",
	"uprav",
	"zmen",
	"zobraz",
	"ukaz",
	"vypis",
	"podle",
	"zadost",
	"ukol",
	"vyres",
	"zkontroluj",
	"nainstaluj",
	"preloz",
	"preklad",
]);

const ENGLISH_COMMON_WORDS = new Set([
	"the",
	"be",
	"to",
	"of",
	"and",
	"a",
	"in",
	"that",
	"have",
	"i",
	"it",
	"for",
	"not",
	"on",
	"with",
	"he",
	"as",
	"you",
	"do",
	"at",
	"this",
	"but",
	"his",
	"by",
	"from",
	"they",
	"we",
	"say",
	"her",
	"she",
	"or",
	"an",
	"will",
	"my",
	"one",
	"all",
	"would",
	"there",
	"their",
	"what",
	"so",
	"up",
	"out",
	"if",
	"about",
	"who",
	"get",
	"which",
	"go",
	"me",
	"when",
	"make",
	"can",
	"like",
	"time",
	"no",
	"just",
	"him",
	"know",
	"take",
	"people",
	"into",
	"year",
	"your",
	"good",
	"some",
	"could",
	"them",
	"see",
	"other",
	"than",
	"then",
	"now",
	"look",
	"only",
	"come",
	"its",
	"over",
	"think",
	"also",
	"back",
	"after",
	"use",
	"two",
	"how",
	"our",
	"work",
	"first",
	"well",
	"way",
	"even",
	"new",
	"want",
	"because",
	"any",
	"these",
	"give",
	"day",
	"most",
	"us",
	"is",
	"are",
	"was",
	"were",
	"been",
	"has",
	"had",
	"does",
	"did",
	"please",
	"fix",
	"create",
	"write",
	"implement",
	"update",
	"refactor",
	"test",
	"build",
	"run",
	"check",
	"remove",
	"add",
	"delete",
	"show",
	"find",
	"search",
	"replace",
	"modify",
	"file",
	"files",
	"function",
	"class",
	"code",
	"bug",
	"error",
	"issue",
	"prompt",
	"review",
]);

export function detectLanguageOrCode(text: string): {
	isEnglishOrCode: boolean;
	reason: string;
} {
	const trimmed = text.trim();
	if (!trimmed) return { isEnglishOrCode: true, reason: "empty" };

	// 1. Slash commands, shell/repl prefixes
	if (
		trimmed.startsWith("/") ||
		trimmed.startsWith("$ ") ||
		trimmed.startsWith("> ") ||
		trimmed.startsWith("#!")
	) {
		return { isEnglishOrCode: true, reason: "command_or_script" };
	}

	// 1b. Standalone URL
	if (/^(?:https?|git\+https?|ftp|file):\/\/[^\s]+$/.test(trimmed)) {
		return { isEnglishOrCode: true, reason: "url_only" };
	}

	// 2. Code blocks (```...```) or pure structured formats (JSON, diff)
	if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
		return { isEnglishOrCode: true, reason: "code_block" };
	}
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			JSON.parse(trimmed);
			return { isEnglishOrCode: true, reason: "json" };
		} catch {
			/* not valid json */
		}
	}
	if (
		trimmed.startsWith("diff --git") ||
		(trimmed.includes("--- a/") && trimmed.includes("+++ b/"))
	) {
		return { isEnglishOrCode: true, reason: "git_diff" };
	}

	// 3. Czech / Slovak / European non-English diacritics
	if (CZECH_SLOVAK_DIACRITICS_RE.test(trimmed)) {
		return { isEnglishOrCode: false, reason: "diacritics" };
	}

	// 4. Tokenize words
	const words = trimmed
		.toLowerCase()
		.split(/[^a-zA-Z]+/)
		.filter((w) => w.length > 1);
	if (words.length === 0) {
		return { isEnglishOrCode: true, reason: "symbols_only" };
	}

	let czechCount = 0;
	let englishCount = 0;
	for (const w of words) {
		if (CZECH_ASCII_WORDS.has(w)) czechCount++;
		if (ENGLISH_COMMON_WORDS.has(w)) englishCount++;
	}

	if (czechCount > 0 && czechCount >= englishCount) {
		return { isEnglishOrCode: false, reason: "czech_ascii_words" };
	}
	if (englishCount > 0 && englishCount >= czechCount) {
		return { isEnglishOrCode: true, reason: "english_detected" };
	}

	// 5. Code syntax indicators (keywords, imports, declarations)
	const codeIndicators =
		/[{}();=><!&|]|\b(import|export|const|let|var|function|class|return|def|fn|pub|struct|impl|async|await|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE)\b/;
	if (codeIndicators.test(trimmed)) {
		return { isEnglishOrCode: true, reason: "code_syntax" };
	}

	return { isEnglishOrCode: false, reason: "default" };
}
