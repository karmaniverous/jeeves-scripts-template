/**
 * @module refresh-rates-task
 *
 * TASK prompt for the refresh-token-rates LLM worker. The prompt ends
 * with the structured RESULT-line contract that the job parses (see
 * refresh-rates-outcome.ts).
 */

import { RESULT_LINE_INSTRUCTIONS } from './refresh-rates-outcome.js';

/**
 * Build the worker TASK.
 *
 * @param ratesPath - Live rate card path (TOKEN_RATES_PATH).
 * @returns The TASK prompt.
 */
export function buildRefreshRatesTask(ratesPath: string): string {
  return `You are updating the token pricing rate card.

Read the current rate card at ${ratesPath}.

For EACH model in the rate card, verify the rates against the provider's official pricing page:
- Anthropic models: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI models: https://developers.openai.com/api/docs/pricing
- Google models: https://ai.google.dev/gemini-api/docs/pricing
- xAI models: https://docs.x.ai/docs/models#models-and-pricing (or search "xAI Grok API pricing")

Use web_fetch to read each pricing page. Extract the per-MTok (per million token) rates for:
- input (base input tokens)
- output (output tokens)
- cacheRead (cache hits / prompt cache reads)
- cacheWrite (cache writes, if applicable — use the 5-minute TTL tier for Anthropic)

If cacheRead/cacheWrite are not offered by the provider, set them to 0.

Also check if any NEW models have appeared on these pricing pages that aren't in the rate card yet. Common patterns:
- A new Claude version (e.g. claude-opus-4-7, claude-sonnet-4-7)
- A new GPT version (e.g. gpt-5.5)
- A new Gemini version
- A new Grok version

For delivery-mirror models (openclaw/delivery-mirror, clawdbot/delivery-mirror), keep rates at 0 — these are internal routing, not billed.

After verification:
- If anything changed: update ${ratesPath} with the changes, set "updatedAt" to now, and update "source" to describe what was verified.
- If nothing changed: leave ${ratesPath} untouched.
- Report a short summary of what changed (or that no changes were needed).

IMPORTANT: Only update rates you can verify from official pricing pages. If a pricing page is unavailable or you can't find rates for a model, leave that model's rates unchanged and note it in your summary.

Do NOT add models speculatively — only add models that appear on official pricing pages AND are actually used by this installation (check the model keys already in the rate card for the naming pattern).

${RESULT_LINE_INSTRUCTIONS}`;
}
