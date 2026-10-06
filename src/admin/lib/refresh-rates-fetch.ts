/**
 * @module refresh-rates-fetch
 *
 * Bounded fetching for refresh-token-rates: many OpenRouter lookups with
 * limited concurrency under one overall time budget, so stalled requests
 * can't push the job past its runner timeout before the card is written.
 */

import type { ModelRates } from './rate-card-schema.js';

/** Parallel OpenRouter requests. */
export const FETCH_CONCURRENCY = 4;

/**
 * Overall time budget for fetching, in ms. With the 15 s per-request
 * timeout in openrouter-pricing.ts, the fetch phase ends by ~75 s, well
 * inside the 120 s runner timeout, leaving time to write the card.
 */
export const FETCH_BUDGET_MS = 60_000;

/** Outcome of fetching one model. */
export type FetchOutcome =
  | { id: string; rates: ModelRates }
  | { id: string; rates: null; problem: string };

/**
 * Fetch rates for many models with bounded concurrency and an overall
 * time budget. Models not started before the budget runs out, or still
 * in flight when it does, are reported as problems rather than blocking
 * the run.
 *
 * @param ids - Model ids to fetch.
 * @param fetchRates - Per-model fetch.
 * @param opts - Concurrency, budget and clock.
 * @returns One outcome per id, in input order.
 */
export async function fetchAllRates(
  ids: readonly string[],
  fetchRates: (id: string) => Promise<ModelRates | null>,
  opts: { concurrency: number; budgetMs: number; clock: () => number },
): Promise<FetchOutcome[]> {
  const deadline = opts.clock() + opts.budgetMs;
  const results: FetchOutcome[] = new Array<FetchOutcome>(ids.length);
  let next = 0;

  const fetchOne = async (id: string): Promise<FetchOutcome> => {
    const remaining = deadline - opts.clock();
    if (remaining <= 0)
      return {
        id,
        rates: null,
        problem: 'skipped: fetch time budget exhausted',
      };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<FetchOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ id, rates: null, problem: 'fetch time budget exhausted' });
      }, remaining);
    });
    const attempt = fetchRates(id).then(
      (rates): FetchOutcome =>
        rates
          ? { id, rates }
          : { id, rates: null, problem: 'not found on OpenRouter' },
      (err: unknown): FetchOutcome => ({
        id,
        rates: null,
        problem: errorText(err),
      }),
    );
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const i = next++;
      results[i] = await fetchOne(ids[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, ids.length) }, worker),
  );
  return results;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
