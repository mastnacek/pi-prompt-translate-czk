// translate/index.ts — the translation kernel's public surface.
//
// The engine is used by three separate slices (pipeline, goal, and the tool-UI
// card path inside the pipeline), so per the Q3 branch of the slice-membership
// tree it sits in shared/ rather than in any one of them. They import this barrel,
// never each other. Everything below is a thin re-export of a sibling module —
// the implementations are in core/protect/context/text/language.
export { translate } from "./core.js";
export { detectLanguageOrCode } from "./language.js";
export {
	protectPromptSegments,
	protectFinalAnswerSegments,
	restoreProtectedSegments,
	cleanTranslationOutput,
	stripKeepTags,
} from "./protect.js";
export {
	buildEffectiveHeaders,
	hasDeicticReferences,
	extractRecentContext,
	createSourceTag,
	createTranslationContext,
} from "./context.js";
export {
	getText,
	hasToolCall,
	withSingleText,
	estimateTranslationMaxTokens,
} from "./text.js";
