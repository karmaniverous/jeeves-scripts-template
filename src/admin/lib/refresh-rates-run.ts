/**
 * @module refresh-rates-run
 *
 * Orchestration for the refresh-token-rates job, with its side effects
 * injected so the decisions are testable.
 *
 * For every model on the rate card (except internal routing entries, see
 * {@link isInternalModel}, and `manual` entries, which are maintained by
 * hand) it fetches base-tier prices from OpenRouter
 * (openrouter-pricing.ts) and updates entries whose prices differ.
 *
 * It also adds new models. When collect-token-metrics meets a model that
 * isn't on the card, it refuses to flush, records the id in the pending
 * file (TOKEN_RATES_PENDING_PATH) and triggers this job. Each pending id
 * is fetched the same way and added once OpenRouter returns valid prices;
 * after the card is written the pending file is re-read and only ids now
 * on the card are dropped, so ids the collector adds mid-run are kept.
 *
 * The card is written once if anything changed (advancing updatedAt and
 * appending a dated note to `source`) and re-validated.
 *
 * The job fails (throws, so runScript exits non-zero and the runner
 * records an error) when:
 * - the rate card is missing and can't be seeded, or is unreadable or
 *   invalid;
 * - any looked-up card model or pending model is unknown to
 *   OpenRouter (404) or its fetch fails. Everything resolvable is still
 *   applied first, so one bad model never blocks the rest;
 * - the card is invalid after writing.
 *
 * Fetches (refresh-rates-fetch.ts) run {@link FETCH_CONCURRENCY} at a time
 * under an overall {@link FETCH_BUDGET_MS} budget, so stalled requests
 * can't push the job past the runner timeout before the card is written.
 *
 * `--dry-run` fetches and reports changes without writing the card or the
 * pending file.
 */

import type { ModelRates, RateCardConfig } from './rate-card-schema.js';
import {
  FETCH_BUDGET_MS,
  FETCH_CONCURRENCY,
  fetchAllRates,
} from './refresh-rates-fetch.js';

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

/** Pending ids still to resolve: not on the card and not internal. */
function unresolved(
  ids: readonly string[],
  models: Readonly<Record<string, ModelRates>>,
): string[] {
  return ids.filter((id) => !(id in models) && !isInternalModel(id));
}

/** Card entries to look up: everything except internal and manual ones. */
function lookupTargets(card: RateCardConfig): [string, ModelRates][] {
  return Object.entries(card.models).filter(
    ([id, rates]) => !isInternalModel(id) && rates.manual !== true,
  );
}

/** The dated note appended to the card's `source` for these changes. */
function refreshNote(changes: readonly RateChange[], now: string): string {
  const added = changes.filter((c) => !c.before).map((c) => c.model);
  const updated = changes.filter((c) => c.before).map((c) => c.model);
  const parts = [
    updated.length ? `${updated.join(', ')} updated` : '',
    added.length ? `${added.join(', ')} added` : '',
  ].filter(Boolean);
  return `OpenRouter refresh ${now.slice(0, 10)}: ${parts.join('; ')} from openrouter.ai/api/v1/model (base tier).`;
}

/** Write the updated card, then re-read it; throws if it no longer validates. */
function commitCard(
  deps: RefreshRatesDeps,
  card: RateCardConfig,
  models: Record<string, ModelRates>,
  changes: readonly RateChange[],
): void {
  const now = deps.now();
  const note = refreshNote(changes, now);
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
}

/**
 * Drop pending ids that are now on the card. Re-reads the file (the
 * collector may have added ids while we were fetching) and runs after the
 * card write, so an added model is never dropped from both and a
 * concurrently added id is never lost.
 */
function prunePending(
  deps: RefreshRatesDeps,
  models: Readonly<Record<string, ModelRates>>,
): void {
  const current = deps.readPending();
  const keep = unresolved(current, models);
  if (keep.length !== current.length) deps.writePending(keep);
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
  const manual = ids.filter((id) => card.models[id].manual === true);
  const pending = unresolved([...new Set(deps.readPending())], card.models);
  log(
    `[refresh-token-rates] Rate card OK (${String(ids.length)} models, ${String(manual.length)} manual, ${String(pending.length)} pending); checking OpenRouter`,
  );

  const changes: RateChange[] = [];
  const problems: string[] = [];
  const models: Record<string, ModelRates> = { ...card.models };

  const targets: [string, ModelRates | null][] = [
    ...lookupTargets(card),
    ...pending.map((id): [string, null] => [id, null]),
  ];

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
    commitCard(deps, card, models, changes);
    log(
      `[refresh-token-rates] Rate card updated (${String(changes.length)} model(s))`,
    );
  } else {
    log('[refresh-token-rates] All rates unchanged');
  }

  if (!options.dryRun) prunePending(deps, models);

  if (problems.length) {
    throw new Error(
      `refresh-token-rates could not verify ${String(problems.length)} model(s): ${problems.join('; ')}`,
    );
  }
  return { outcome, models: Object.keys(models).length, changes };
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
