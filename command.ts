import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { persistConfig, saveConfig } from "./config.js";
import { state } from "./state.js";
import { buildHelpText } from "./status.js";
import { getArgumentCompletions, getCommandDocs } from "./completions.js";
import { handleModelCommands } from "./command-models.js";
import { handleToggleCommands } from "./command-toggles.js";
import { handleMiscCommands } from "./command-misc.js";

export function registerTranslateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prompt-translate", {
		description:
			"pi-prompt-translate: překlad promptů do EN a odpovědí zpět, CZK zůstatek, prompt boost",
		getArgumentCompletions,

		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = state.config;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const writeGlobal = tokens.some((t) => t.toLowerCase() === "--global");
			const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");
			const subcommand = (cleanTokens[0] ?? "").toLowerCase();
			const rest = cleanTokens.slice(1);
			const persist = () => {
				persistConfig(pi);
				saveConfig(config, writeGlobal, ctx.cwd);
			};

			if (!subcommand || subcommand === "help") {
				ctx.ui.notify(buildHelpText(config, state.sessionCostUsd), "info");
				return;
			}

			const handledModel = await handleModelCommands(subcommand, rest, ctx, persist, writeGlobal);
			if (handledModel) return;

			const handledToggle = handleToggleCommands(subcommand, rest, ctx, persist, writeGlobal);
			if (handledToggle) return;

			const handledMisc = await handleMiscCommands(subcommand, rest, ctx, persist, writeGlobal);
			if (handledMisc) return;

			ctx.ui.notify("Unknown command. Use: /prompt-translate help", "warning");
		},
	});
}

export { getCommandDocs };
