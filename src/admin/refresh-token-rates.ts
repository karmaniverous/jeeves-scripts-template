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
 * After the worker finishes, its final reply must end with a
 * `RESULT: updated|unchanged|failed: <reason>` line (read back through
 * the gateway RPC `chat.history`; see lib/refresh-rates-dispatch.ts), and
 * the card is validated again; "updated" also requires updatedAt to
 * advance. Anything else exits non-zero so the runner records the run as
 * an error.
 *
 * `--dry-run` prints the TASK and exits without dispatching.
 *
 * Config dependencies: TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH,
 * SPAWN_WORKER_PATH from constants.ts.
 */

import { runScript } from '@karmaniverous/jeeves';

import { TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH } from '../lib/constants.js';
import { readRateCardFile } from './lib/rate-card-schema.js';
import { ensureRateCard } from './lib/rate-card-seed.js';
import { dispatchRefreshWorker } from './lib/refresh-rates-dispatch.js';
import { refreshTokenRatesMain } from './lib/refresh-rates-run.js';
import { buildRefreshRatesTask } from './lib/refresh-rates-task.js';

runScript('admin/refresh-token-rates', async () => {
  const task = buildRefreshRatesTask(TOKEN_RATES_PATH);

  await refreshTokenRatesMain(process.argv, task, {
    ensure: () => {
      ensureRateCard(TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH);
    },
    verify: () => readRateCardFile(TOKEN_RATES_PATH),
    dispatch: () => dispatchRefreshWorker(task),
  });
});
