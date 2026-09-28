#!/usr/bin/env tsx
/**
 * @module refresh-token-rates
 *
 * Dispatcher: Refresh token rate card.
 *
 * Spawns an LLM session to fetch current published API pricing
 * from provider pricing pages and update the rate card config.
 * Runs daily and can be triggered on-demand by the collector
 * when it encounters an unknown model.
 *
 * Before dispatching, the rate card is seeded from
 * config/token-rates.seed.json if it doesn't exist, then validated.
 * After the worker finishes, the card is validated again. Any failure
 * (no card, unreadable/invalid card, worker non-zero exit) exits
 * non-zero so the runner records the run as an error.
 *
 * Config dependencies: TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH,
 * SPAWN_WORKER_PATH from constants.ts.
 */

import { runScript } from '@karmaniverous/jeeves';
import { dispatchSession, runDispatcher } from '@karmaniverous/jeeves-runner';

import {
  SPAWN_WORKER_PATH,
  TOKEN_RATES_PATH,
  TOKEN_RATES_SEED_PATH,
} from '../lib/constants.js';
import { readRateCardFile } from './lib/rate-card-schema.js';
import { ensureRateCard } from './lib/rate-card-seed.js';
import { runRefreshTokenRates } from './lib/refresh-rates-run.js';

const JOB_ID = 'refresh-token-rates';

const TASK = `You are updating the token pricing rate card.

Read the current rate card at ${TOKEN_RATES_PATH}.

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
1. Update ${TOKEN_RATES_PATH} with any changes
2. Update the "updatedAt" timestamp to now
3. Update the "source" field to describe what was verified
4. Report a summary of what changed (or "no changes needed")

IMPORTANT: Only update rates you can verify from official pricing pages. If a pricing page is unavailable or you can't find rates for a model, leave that model's rates unchanged and note it in your summary.

Do NOT add models speculatively — only add models that appear on official pricing pages AND are actually used by this installation (check the model keys already in the rate card for the naming pattern).`;

const DISPATCH_OPTIONS = { jobId: JOB_ID, thinking: 'low' } as const;

runScript('admin/refresh-token-rates', async () => {
  // --dry-run: print the task and exit without touching the rate card.
  if (process.argv.includes('--dry-run')) {
    runDispatcher(TASK, DISPATCH_OPTIONS, SPAWN_WORKER_PATH);
    return;
  }

  await runRefreshTokenRates({
    ensure: () => {
      ensureRateCard(TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH);
    },
    verify: () => readRateCardFile(TOKEN_RATES_PATH),
    dispatch: () => dispatchSession(TASK, DISPATCH_OPTIONS, SPAWN_WORKER_PATH),
  });
});
