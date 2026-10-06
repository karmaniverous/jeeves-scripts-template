/**
 * @module openrouter-pricing
 *
 * Reads per-model token prices from the public OpenRouter model endpoint
 * (`GET https://openrouter.ai/api/v1/model/<id>`, no auth) and converts
 * them to rate-card rates in $/MTok.
 *
 * OpenRouter quotes USD per token as decimal strings. Only the base tier
 * is used: prompt-length `overrides` (higher long-context prices) and the
 * 1-hour cache-write price are ignored, because the rate card holds one
 * price per category (Anthropic `input_cache_write` is the 5-minute tier,
 * matching the card). Missing cache prices mean the provider offers none
 * and map to 0.
 *
 * OpenRouter resolves aliases itself (e.g. `anthropic/claude-opus-5-5`
 * returns `anthropic/claude-opus-5.5`), so card model ids are sent as-is.
 *
 * Token metrics are estimates; they are normalized against provider
 * billing before invoicing, so a reseller price list is accurate enough.
 */

import type { ModelRates } from './rate-card-schema.js';

/** OpenRouter single-model endpoint base. */
export const OPENROUTER_MODEL_URL = 'https://openrouter.ai/api/v1/model/';

/** Per-request timeout for OpenRouter calls, in ms. */
export const OPENROUTER_TIMEOUT_MS = 15_000;

/** HTTP GET returning status and parsed JSON body (null when not JSON). */
export type JsonFetcher = (
  url: string,
) => Promise<{ status: number; body: unknown }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Convert a USD-per-token decimal string to $/MTok, rounded to 6 decimal
 * places to drop floating-point noise.
 *
 * @param value - Per-token price (string or number); absent means 0.
 * @param field - Field name for error messages.
 * @returns Price in $/MTok.
 * @throws Error when the value is present but is not a non-negative
 *   number or numeric string (booleans, arrays and objects are rejected).
 */
export function perTokenToPerMTok(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  // Only strings and numbers are prices; Number() would coerce booleans
  // and single-element arrays into plausible-looking rates.
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else n = Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `invalid OpenRouter price for ${field}: ${JSON.stringify(value)}`,
    );
  }
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

/** Rates for one model, plus the id OpenRouter resolved it to. */
export interface OpenRouterRates {
  resolvedId: string;
  rates: ModelRates;
}

/**
 * Fetch base-tier rates for one model.
 *
 * @param modelId - Rate-card model id (`provider/model`).
 * @param fetchJson - HTTP GET (injected for tests).
 * @returns The rates, or null when OpenRouter does not know the model (404).
 * @throws Error on any other HTTP status or a malformed response.
 */
export async function fetchOpenRouterRates(
  modelId: string,
  fetchJson: JsonFetcher,
): Promise<OpenRouterRates | null> {
  const { status, body } = await fetchJson(
    OPENROUTER_MODEL_URL + modelId.split('/').map(encodeURIComponent).join('/'),
  );
  if (status === 404) return null;
  if (status !== 200) {
    throw new Error(
      `OpenRouter returned HTTP ${String(status)} for ${modelId}`,
    );
  }
  const data = isRecord(body) && isRecord(body['data']) ? body['data'] : null;
  const pricing = data && isRecord(data['pricing']) ? data['pricing'] : null;
  if (!data || !pricing) {
    throw new Error(`OpenRouter response for ${modelId} has no pricing`);
  }
  if (pricing['prompt'] === undefined || pricing['completion'] === undefined) {
    throw new Error(
      `OpenRouter pricing for ${modelId} lacks prompt/completion prices`,
    );
  }
  return {
    resolvedId: typeof data['id'] === 'string' ? data['id'] : modelId,
    rates: {
      input: perTokenToPerMTok(pricing['prompt'], `${modelId}.prompt`),
      output: perTokenToPerMTok(pricing['completion'], `${modelId}.completion`),
      cacheRead: perTokenToPerMTok(
        pricing['input_cache_read'],
        `${modelId}.input_cache_read`,
      ),
      cacheWrite: perTokenToPerMTok(
        pricing['input_cache_write'],
        `${modelId}.input_cache_write`,
      ),
    },
  };
}

/**
 * Production {@link JsonFetcher} using global fetch with a timeout.
 *
 * @param url - URL to GET.
 * @returns Status and parsed JSON body (null when the body is not JSON).
 */
export async function httpGetJson(
  url: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
