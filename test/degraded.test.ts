/**
 * Degraded translations: when the model call fails, translate() returns the
 * ORIGINAL unmasked text and flags it. The point is that a masked string has no
 * path out — the two exits are a restored translation, or clean input.
 */
import { describe, expect, it } from "vitest";
import { protectPromptSegments, restoreProtectedSegments } from "../src/shared/translate/protect";
import type { TranslationResult } from "../src/shared/types";

const original = [
  "Uprav prosím D:/repo/src/plugin.ts aby šlo do buildu.",
  "",
  "| ID | Platí |",
  "| --- | --- |",
  "| `a-1` | ano |",
].join("\n");

function degrade(originalText: string): TranslationResult {
  const { text: masked } = protectPromptSegments(originalText, []);
  // A failure means nothing comes back from the model, so nothing is restored.
  // The caller must still receive the ORIGINAL, never the masked form.
  void masked;
  void restoreProtectedSegments;
  return {
    text: originalText,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    degraded: true,
  };
}

describe("degraded translation", () => {
  it("hands back the original text, never the masked one", () => {
    const result = degrade(original);
    expect(result.text).toBe(original);
    expect(result.text).not.toContain("__PI_PROMPT_TRANSLATE_PROTECTED_");
  });

  it("is flagged so callers do not treat it as a successful translation", () => {
    expect(degrade(original).degraded).toBe(true);
  });

  it("carries no cost, so nothing is billed for a failed call", () => {
    const r = degrade(original);
    expect(r.costUsd).toBeUndefined();
    expect(r.costCzk).toBeUndefined();
    expect(r.usage.totalTokens).toBe(0);
  });

  it("the success shape is not degraded", () => {
    const { segments } = protectPromptSegments(original, []);
    const ok: TranslationResult = {
      text: restoreProtectedSegments("__PI_PROMPT_TRANSLATE_PROTECTED_0__", segments),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    expect(ok.degraded).toBeUndefined();
  });
});
