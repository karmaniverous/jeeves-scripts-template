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
 * - the rate card is missing, unreadable or invalid after the worker
 *   finishes.
 */

import type { RateCardConfig } from './rate-card-schema.js';

/** Injected side effects for {@link runRefreshTokenRates}. */
export interface RefreshRatesDeps {
  /** Seed the rate card if missing. */
  ensure: () => void;
  /** Read and validate the rate card; throws on any problem. */
  verify: () => RateCardConfig;
  /** Dispatch the LLM worker; resolves with the worker exit code. */
  dispatch: () => Promise<{ exitCode: number }>;
}

/**
 * Run one refresh: pre-check, dispatch, post-check.
 *
 * @param deps - Injected side effects.
 * @returns Model count of the verified card after the worker finished.
 * @throws Error when the run must be recorded as failed.
 */
export async function runRefreshTokenRates(
  deps: RefreshRatesDeps,
): Promise<{ models: number }> {
  deps.ensure();
  const before = deps.verify();
  console.log(
    `[refresh-token-rates] Rate card OK (${String(Object.keys(before.models).length)} models); dispatching worker`,
  );

  const { exitCode } = await deps.dispatch();
  if (exitCode !== 0) {
    throw new Error(
      `refresh-token-rates worker exited with code ${String(exitCode)}`,
    );
  }

  let after: RateCardConfig;
  try {
    after = deps.verify();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Rate card invalid after worker run: ${msg}`, {
      cause: err,
    });
  }

  const models = Object.keys(after.models).length;
  console.log(
    `[refresh-token-rates] Rate card verified after worker run (${String(models)} models)`,
  );
  return { models };
}
