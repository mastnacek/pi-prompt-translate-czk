# ADR-001: // Resolve the translate model; when a temporary override is broken (n
- **Date:** 2026-09-03 07:45:38
- **Status:** active
- **Context:** let modelAuth: ModelWithAuth;
	try {
		modelAuth = await getModelAndAuth(ctx);
	} catch (error) {
		const effective = getEffectiveTranslateModel().setting;
		if (effective === config.translateMod
- **Decision:** Output ONLY the translation.,
					"Do not wrap your output in <source_text> tags, and do not add commentary.",
					"Keep code, paths, commands, flags, markdown, URLs, JSON, placeholders, XML-like
- **Consequences:** Maintain this implementation to prevent regressions across environments.
