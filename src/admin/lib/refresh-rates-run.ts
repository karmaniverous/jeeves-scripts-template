/**
 * @module refresh-rates-run
 *
 * Orchestration for the refresh-token-rates job, with its side effects
 * injected so the success/failure decision is testable.
 *
 * The job fails (throws, so runScript exits non-zero and the runner
 * records an error) when:
 * - the rate card is missing and can't be seeded, or is unreadable or
 *   invalid before dispatch (the worker is not spawned);
 * - the worker process exits non-zero;
 * - the worker's final reply has no valid RESULT line, or reports
 *   `RESULT: failed` (the exit code alone is not trusted);
 * - the rate card is missing, unreadable or invalid after the worker
 *   finishes;
 * - the worker reports `RESULT: updated` but the card's updatedAt did
 *   not advance.
 */

import type { RateCardConfig } from './rate-card-schema.js';
import { parseRefreshOutcome } from './refresh-rates-outcome.js';

/** What the job learns from one worker dispatch. */
export interface WorkerRun {
  /** Worker process exit code. */
  exitCode: number;
  /** The worker's final assistant reply, or null if unavailable. */
  finalText: string | null;
}

/** Injected side effects for {@link runRefreshTokenRates}. */
export interface RefreshRatesDeps {
  /** Seed the rate card if missing. */
  ensure: () => void;
  /** Read and validate the rate card; throws on any problem. */
  verify: () => RateCardConfig;
  /** Dispatch the LLM worker and recover its final reply. */
  dispatch: () => Promise<WorkerRun>;
}

/** Result of a successful refresh. */
export interface RefreshRatesResult {
  /** Model count of the verified card after the worker finished. */
  models: number;
  /** What the worker reported. */
  outcome: 'updated' | 'unchanged';
}

function verifyAfter(deps: RefreshRatesDeps): RateCardConfig {
  try {
    return deps.verify();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Rate card invalid after worker run: ${msg}`, {
      cause: err,
    });
  }
}

/**
 * Run one refresh: pre-check, dispatch, outcome check, post-check.
 *
 * @param deps - Injected side effects.
 * @returns Model count and the worker's reported outcome.
 * @throws Error when the run must be recorded as failed.
 */
export async function runRefreshTokenRates(
  deps: RefreshRatesDeps,
): Promise<RefreshRatesResult> {
  deps.ensure();
  const before = deps.verify();
  console.log(
    `[refresh-token-rates] Rate card OK (${String(Object.keys(before.models).length)} models); dispatching worker`,
  );

  const { exitCode, finalText } = await deps.dispatch();
  if (exitCode !== 0) {
    throw new Error(
      `refresh-token-rates worker exited with code ${String(exitCode)}`,
    );
  }

  const outcome = parseRefreshOutcome(finalText);
  if (!outcome) {
    throw new Error(
      'refresh-token-rates worker did not end its reply with a valid RESULT line',
    );
  }
  if (outcome.status === 'failed') {
    throw new Error(`refresh-token-rates worker failed: ${outcome.reason}`);
  }

  const after = verifyAfter(deps);
  if (
    outcome.status === 'updated' &&
    !(Date.parse(after.updatedAt) > Date.parse(before.updatedAt))
  ) {
    throw new Error(
      `refresh-token-rates worker reported "updated" but updatedAt did not advance (${before.updatedAt} -> ${after.updatedAt})`,
    );
  }

  const models = Object.keys(after.models).length;
  console.log(
    `[refresh-token-rates] Rate card verified after worker run (${outcome.status}, ${String(models)} models)`,
  );
  return { models, outcome: outcome.status };
}

/**
 * Job entry logic. `--dry-run` prints the TASK and returns without
 * seeding, reading the card, or dispatching anything.
 *
 * @param argv - Process arguments.
 * @param task - Worker TASK text.
 * @param deps - Injected side effects.
 * @param print - Output sink for --dry-run.
 */
export async function refreshTokenRatesMain(
  argv: readonly string[],
  task: string,
  deps: RefreshRatesDeps,
  print: (text: string) => void = console.log,
): Promise<RefreshRatesResult | null> {
  if (argv.includes('--dry-run')) {
    print(task);
    return null;
  }
  return runRefreshTokenRates(deps);
}
