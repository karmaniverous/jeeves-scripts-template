/**
 * @module refresh-rates-run
 *
 * Orchestration for the refresh-token-rates job, with its side effects
 * injected so the decisions are testable.
 *
 * For every model on the rate card (except internal routing entries, see
 * {@link isInternalModel}) it fetches base-tier prices from OpenRouter
 * (openrouter-pricing.ts) and updates entries whose prices differ.
 *
 * It also adds new models. When collect-token-metrics meets a model that
 * isn't on the card, it refuses to flush, records the id in the pending
 * file (TOKEN_RATES_PENDING_PATH) and triggers this job. Each pending id
 * is fetched the same way and added once OpenRouter returns valid prices;
 * added ids leave the pending file, unresolved ones stay in it.
 *
 * The card is written once if anything changed (advancing updatedAt and
 * appending a dated note to `source`) and re-validated.
 *
 * The job fails (throws, so runScript exits non-zero and the runner
 * records an error) when:
 * - the rate card is missing and can't be seeded, or is unreadable or
 *   invalid;
 * - any non-internal card model or pending model is unknown to
 *   OpenRouter (404) or its fetch fails. Everything resolvable is still
 *   applied first, so one bad model never blocks the rest;
 * - the card is invalid after writing.
 *
 * Fetches run {@link FETCH_CONCURRENCY} at a time under an overall
 * {@link FETCH_BUDGET_MS} budget, so stalled requests can't push the job
 * past the runner timeout before the card is written.
 *
 * `--dry-run` fetches and reports changes without writing the card or the
 * pending file.
 */

import type { ModelRates, RateCardConfig } from './rate-card-schema.js';

/** Parallel OpenRouter requests. */
export const FETCH_CONCURRENCY = 4;

/**
 * Overall time budget for fetching, in ms. With the 15 s per-request
 * timeout in openrouter-pricing.ts, the fetch phase ends by ~75 s, well
 * inside the 120 s runner timeout, leaving time to write the card.
 */
export const FETCH_BUDGET_MS = 60_000;

/** Model-id prefixes for internal routing entries (always priced at 0). */
const INTERNAL_PREFIXES = ['openclaw/', 'clawdbot/'];

/**
 * Whether a rate-card model is an internal routing entry with no provider
 * price (e.g. `openclaw/delivery-mirror`).
 */
export function isInternalModel(modelId: string): boolean {
  return INTERNAL_PREFIXES.some((p) => modelId.startsWith(p));
}

/** Injected side effects for {@link runRefreshTokenRates}. */
export interface RefreshRatesDeps {
  /** Seed the rate card if missing. */
  ensure: () => void;
  /** Read and validate the rate card; throws on any problem. */
  read: () => RateCardConfig;
  /** Fetch base-tier rates; null when the model is unknown upstream. */
  fetchRates: (modelId: string) => Promise<ModelRates | null>;
  /** Write the rate card (atomically). */
  write: (card: RateCardConfig) => void;
  /** Model ids the collector found missing from the card. */
  readPending: () => string[];
  /** Replace the pending ids (an empty list clears the file). */
  writePending: (ids: string[]) => void;
  /** Current time as an ISO string. */
  now: () => string;
  /** Log sink. */
  log?: (line: string) => void;
  /** Monotonic clock in ms (injected for tests). */
  clock?: () => number;
}

/** Outcome of fetching one model. */
type FetchOutcome =
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

/** One changed or added model (`before` is null for an addition). */
export interface RateChange {
  model: string;
  before: ModelRates | null;
  after: ModelRates;
}

/** Result of a run that did not throw. */
export interface RefreshRatesResult {
  outcome: 'updated' | 'unchanged' | 'dry-run';
  models: number;
  changes: RateChange[];
}

const CATEGORIES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function sameRates(a: ModelRates, b: ModelRates): boolean {
  return CATEGORIES.every((k) => a[k] === b[k]);
}

function fmt(r: ModelRates | null): string {
  if (!r) return '(new)';
  return CATEGORIES.map((k) => `${k}=${String(r[k])}`).join(' ');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one refresh.
 *
 * @param deps - Injected side effects.
 * @param options - `dryRun`: report without writing.
 * @returns Outcome, model count and the changes made (or planned).
 * @throws Error when the run must be recorded as failed.
 */
export async function runRefreshTokenRates(
  deps: RefreshRatesDeps,
  options: { dryRun?: boolean } = {},
): Promise<RefreshRatesResult> {
  const log = deps.log ?? console.log;
  if (!options.dryRun) deps.ensure();
  const card = deps.read();
  const ids = Object.keys(card.models);
  const pending = [...new Set(deps.readPending())].filter(
    (id) => !(id in card.models) && !isInternalModel(id),
  );
  log(
    `[refresh-token-rates] Rate card OK (${String(ids.length)} models, ${String(pending.length)} pending); checking OpenRouter`,
  );

  const changes: RateChange[] = [];
  const problems: string[] = [];
  const models: Record<string, ModelRates> = { ...card.models };

  const targets: [string, ModelRates | null][] = [
    ...Object.entries(card.models).filter(([id]) => !isInternalModel(id)),
    ...pending.map((id): [string, null] => [id, null]),
  ];
  const unresolvedPending: string[] = [];

  const outcomes = await fetchAllRates(
    targets.map(([id]) => id),
    deps.fetchRates,
    {
      concurrency: FETCH_CONCURRENCY,
      budgetMs: FETCH_BUDGET_MS,
      clock: deps.clock ?? Date.now,
    },
  );

  targets.forEach(([id, before], i) => {
    const res = outcomes[i];
    if (!res.rates) {
      problems.push(`${id}: ${res.problem}`);
      if (!before) unresolvedPending.push(id);
      return;
    }
    const rates = res.rates;
    if (before && sameRates(before, rates)) return;
    changes.push({ model: id, before, after: rates });
    models[id] = rates;
    log(`[refresh-token-rates] ${id}: ${fmt(before)} -> ${fmt(rates)}`);
  });

  let outcome: RefreshRatesResult['outcome'] = changes.length
    ? 'updated'
    : 'unchanged';

  if (options.dryRun) {
    outcome = 'dry-run';
    log(
      `[refresh-token-rates] dry run: ${String(changes.length)} change(s) not written`,
    );
  } else if (changes.length) {
    const now = deps.now();
    const added = changes.filter((c) => !c.before).map((c) => c.model);
    const updated = changes.filter((c) => c.before).map((c) => c.model);
    const parts = [
      updated.length ? `${updated.join(', ')} updated` : '',
      added.length ? `${added.join(', ')} added` : '',
    ].filter(Boolean);
    const note = `OpenRouter refresh ${now.slice(0, 10)}: ${parts.join('; ')} from openrouter.ai/api/v1/model (base tier).`;
    deps.write({
      ...card,
      updatedAt: now,
      source: card.source ? `${card.source} ${note}` : note,
      models,
    });
    try {
      deps.read();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Rate card invalid after update: ${msg}`, { cause: err });
    }
    log(
      `[refresh-token-rates] Rate card updated (${String(changes.length)} model(s))`,
    );
  } else {
    log('[refresh-token-rates] All rates unchanged');
  }

  // Pending ids: keep only those still unresolved (written after the card,
  // so an added model is never dropped from both).
  if (!options.dryRun && deps.readPending().length) {
    deps.writePending(unresolvedPending);
  }

  if (problems.length) {
    throw new Error(
      `refresh-token-rates could not verify ${String(problems.length)} model(s): ${problems.join('; ')}`,
    );
  }
  return { outcome, models: ids.length, changes };
}

/**
 * Job entry logic.
 *
 * @param argv - Process arguments (`--dry-run` supported).
 * @param deps - Injected side effects.
 */
export async function refreshTokenRatesMain(
  argv: readonly string[],
  deps: RefreshRatesDeps,
): Promise<RefreshRatesResult> {
  return runRefreshTokenRates(deps, { dryRun: argv.includes('--dry-run') });
}
