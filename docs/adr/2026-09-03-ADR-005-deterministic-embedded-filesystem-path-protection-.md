# ADR-005: Deterministic embedded filesystem path protection in prompt and response translation
- **Date:** 2026-09-03 09:31:15
- **Status:** active
- **Context:** When images are inserted from clipboard or file paths are embedded in prompts without backticks or @mentions, translation models could alter backslashes, translate folder names, or drop path references.
- **Decision:** Add deterministic segment protection for Windows drive paths, UNC network paths, Unix system/home paths, relative paths, and clipboard temp image patterns in protectPromptSegments and protectFinalAnswerSegments.
- **Consequences:** Windows, UNC, Unix, and clipboard image paths are protected with placeholder tokens before translation and restored after. Prevents LLM translation models from translating path components, corrupting backslashes, or dropping embedded file references.
