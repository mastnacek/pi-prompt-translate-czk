// balance.ts — USD→CZK rate (ČNB + ECB fallback) and OpenRouter account balance.
// Owns its module-local caches; exports clearBalanceCache for forced refresh.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfiguredModel } from "./config";
import type { BalanceInfo } from "./types";

const CNB_DAILY_URL = "https://api.cnb.cz/cnbapi/exrates/daily?lang=EN";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const BALANCE_TTL_MS = 5 * 60 * 1000;
const FRANKFURTER_URL =
	"https://api.frankfurter.dev/v1/latest?base=USD&symbols=CZK";

let fxCache: { rate: number; date: string } | undefined;
let balanceCache: { info: BalanceInfo; ts: number } | undefined;

export function clearBalanceCache(): void {
	balanceCache = undefined;
}

export async function getUsdToCzkRate(
	signal?: AbortSignal,
): Promise<number | undefined> {
	const today = new Date().toISOString().slice(0, 10);
	if (fxCache && fxCache.date === today) return fxCache.rate;
	// Primary: ČNB daily rates.
	try {
		const res = await fetch(CNB_DAILY_URL, { signal });
		if (res.ok) {
			const data = (await res.json()) as {
				rates?: Array<{ currencyCode: string; amount: number; rate: number }>;
			};
			const usd = data.rates?.find((r) => r.currencyCode === "USD");
			if (usd) {
				const rate = usd.amount > 0 ? usd.rate / usd.amount : usd.rate;
				fxCache = { rate, date: today };
				return rate;
			}
		}
	} catch {
		/* ČNB failed: fall through to fallback */
	}
	// Fallback: frankfurter.app (ECB-based rates, no auth).
	try {
		const res = await fetch(FRANKFURTER_URL, { signal });
		if (res.ok) {
			const data = (await res.json()) as { rates?: { CZK?: number } };
			const rate = data.rates?.CZK;
			if (typeof rate === "number" && rate > 0) {
				fxCache = { rate, date: today };
				return rate;
			}
		}
	} catch {
		/* best-effort */
	}
	return fxCache?.rate;
}

async function getOpenRouterApiKey(
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const envKey = process.env.OPENROUTER_API_KEY;
	if (envKey) return envKey;
	const candidates: Array<{ provider: string; id: string }> = [];
	try {
		const m = await resolveConfiguredModel(ctx);
		const provider = String(m.provider ?? "");
		if (/openrouter/i.test(provider)) candidates.push({ provider, id: m.id });
	} catch {
		/* model resolution optional: fall through to default candidates */
	}
	candidates.push({ provider: "openrouter", id: "openai/gpt-4o-mini" });
	for (const candidate of candidates) {
		try {
			const found = ctx.modelRegistry.find(candidate.provider, candidate.id) as
				| Model<Api>
				| undefined;
			if (!found) continue;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(found);
			if (auth.ok && auth.apiKey) return auth.apiKey;
		} catch {
			/* best-effort key lookup: try next candidate */
		}
	}
	return undefined;
}

export async function getOpenRouterBalance(
	ctx: ExtensionContext,
): Promise<BalanceInfo | undefined> {
	if (balanceCache && Date.now() - balanceCache.ts < BALANCE_TTL_MS)
		return balanceCache.info;
	const apiKey = await getOpenRouterApiKey(ctx);
	if (!apiKey) return undefined;
	try {
		const res = await fetch(OPENROUTER_CREDITS_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: ctx.signal,
		});
		if (!res.ok) return balanceCache?.info;
		const data = (await res.json()) as {
			data?: { total_credits?: number; total_usage?: number };
		};
		const total = data.data?.total_credits ?? 0;
		const used = data.data?.total_usage ?? 0;
		const info: BalanceInfo = { remaining: total - used, total, used };
		balanceCache = { info, ts: Date.now() };
		return info;
	} catch {
		return balanceCache?.info;
	}
}

/** Last cached balance (for status rendering without a fetch). */
export function cachedBalance(): BalanceInfo | undefined {
	return balanceCache?.info;
}
