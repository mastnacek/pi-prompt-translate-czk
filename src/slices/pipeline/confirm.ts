// pipeline/confirm.ts — the pre-send confirmation dialog for a translated prompt.
//
// Lives with the pipeline because the confirm gate is that slice's feature: it is
// the input handler that decides whether to ask. Pure formatting over values the
// caller already holds (source, translation, usage, cost), so it needs no kernel.

import { ANSI_BOLD, ANSI_BRIGHT_GREEN, ANSI_CYAN, ANSI_DIM, ANSI_GREEN, ANSI_LAVENDER, ANSI_RESET, ANSI_YELLOW, formatCost } from "../../shared/format.js";
import type { BoostLevel, TranslationUsage } from "../../shared/types.js";

export function formatConfirmationBody(options: {
	source: string;
	english: string;
	boost?: BoostLevel;
	conversationContext?: string;
	usage?: TranslationUsage;
	costUsd?: number;
	costCzk?: number;
	styleSource?: (text: string) => string;
}): string {
	const {
		source,
		english,
		boost,
		conversationContext,
		usage,
		costUsd,
		costCzk,
		styleSource = (t) => t,
	} = options;

	const boostBadge = boost && boost !== "off" ? ` [boost: ${boost}]` : "";
	const historyBadge = conversationContext ? " [history: attached]" : "";
	const tokStr =
		usage?.totalTokens === undefined
			? ""
			: ` · ${usage.totalTokens} tok (in: ${usage.input}, out: ${usage.output})`;
	const costStr =
		costUsd === undefined ? "" : ` · ${formatCost(costUsd, costCzk)}`;

	const header = `${ANSI_BOLD}${ANSI_CYAN}🔄 Prompt Translation Diff${boostBadge}${historyBadge}${ANSI_RESET}${ANSI_DIM}${tokStr}${costStr}${ANSI_RESET}`;
	const originalSection = `${ANSI_BOLD}${ANSI_YELLOW}Original (CZ):${ANSI_RESET}\n${styleSource(source)}`;
	const englishSection = `${ANSI_BOLD}${ANSI_GREEN}Enhanced (EN):${ANSI_RESET}\n${ANSI_BRIGHT_GREEN}${english}${ANSI_RESET}`;
	const historySection = conversationContext
		? `\n\n${ANSI_BOLD}${ANSI_LAVENDER}Attached History Context:${ANSI_RESET}\n${ANSI_DIM}${conversationContext}${ANSI_RESET}`
		: "";
	const question = `\n\n${ANSI_BOLD}${ANSI_CYAN}Odeslat tento překlad agentovi?${ANSI_RESET} ${ANSI_DIM}(Ne = odeslat původní text bez překladu)${ANSI_RESET}`;

	return `${header}\n\n${originalSection}\n\n${englishSection}${historySection}${question}`;
}
