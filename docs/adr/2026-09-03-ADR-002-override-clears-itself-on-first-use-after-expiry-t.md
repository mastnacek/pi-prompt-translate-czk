# ADR-002: override clears itself on first use after expiry. The footer shows
- **Date:** 2026-09-03 07:53:09
- **Status:** active
- **Context:** section) and prompt notifications.
- **Decision:** Commands


/prompt-translate status                     Show full configuration and resolved model
/prompt-translate stats                      Show telemetry, cache hit rate, and financial saving
- **Consequences:** Maintain this implementation to prevent regressions across environments.
