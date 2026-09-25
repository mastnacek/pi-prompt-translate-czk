/**
 * Small message helpers shared by the translation pipeline.
 * Split out of `translate.ts`.
 */
import type {
	Api,
	AssistantMessage,
	Model,
	TextContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import { TRANSLATE_REASONING_BUDGET, TRANSLATE_REASONING_LEVEL } from "./config";

export function getText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function hasToolCall(message: AssistantMessage): boolean {
	return message.content.some(
		(part): part is ToolCall => part.type === "toolCall",
	);
}

export function withSingleText(
	message: AssistantMessage,
	text: string,
): AssistantMessage {
	const nextContent = message.content.filter((part) => part.type !== "text");
	return {
		...message,
		content: [...nextContent, { type: "text", text }],
	};
}

export function estimateTranslationMaxTokens(
	model: Model<Api>,
	text: string,
	reasoning = false,
): number {
	// Reasoning + answer share the max_tokens budget on most providers. Reserve
	// headroom for thinking when enabled so the actual translation isn't truncated.
	const hardCap = reasoning ? 16000 : 8192;
	const modelLimit = Math.max(1, Math.min(model.maxTokens ?? 4096, hardCap));
	const reasonBudget = reasoning
		? (TRANSLATE_REASONING_BUDGET[TRANSLATE_REASONING_LEVEL] ?? 640)
		: 0;
	const estimatedOutput = Math.ceil(text.length / 2) + 96 + reasonBudget;
	return Math.max(64, Math.min(modelLimit, estimatedOutput));
}
