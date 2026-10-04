/**
 * @module regen-guard
 *
 * Guard for live regenerate-token-metrics runs: never rewrite pre-upgrade
 * history by accident. The instance's OpenClaw upgrade cutoff comes from
 * the OPENCLAW_UPGRADE_CUTOFF environment variable and has no default: a
 * live run refuses when it is unset or not a date, and refuses a --from
 * earlier than it unless --allow-pre-upgrade is set. Scratch (--out) runs
 * cannot rewrite history and are not guarded (see regen-run.ts).
 */

import { OPENCLAW_UPGRADE_CUTOFF_ENV } from '../../lib/constants.js';

/**
 * Check a live regeneration start against the upgrade cutoff.
 *
 * @param fromMs - Requested start (ms since epoch, hour-floored).
 * @param cutoffIso - Configured upgrade cutoff (ISO 8601), or undefined
 *   when unset.
 * @param allowPreUpgrade - True when --allow-pre-upgrade was given. It
 *   overrides the --from check only, never a missing or invalid cutoff.
 * @returns An error message when the run must be refused, else null.
 */
export function checkRegenFrom(
  fromMs: number,
  cutoffIso: string | undefined,
  allowPreUpgrade: boolean,
): string | null {
  if (!cutoffIso)
    return `${OPENCLAW_UPGRADE_CUTOFF_ENV} is not set. Set this environment variable to the first UTC hour this instance ran OpenClaw 2026.9+ (ISO 8601, e.g. YYYY-MM-DDTHH:00:00Z; for an instance that never ran an earlier OpenClaw, its first hour of usage); live regeneration refuses to run without it. Scratch runs (--out) do not need it.`;
  const cutoffMs = Date.parse(cutoffIso);
  if (Number.isNaN(cutoffMs))
    return `Invalid ${OPENCLAW_UPGRADE_CUTOFF_ENV} "${cutoffIso}" (expected an ISO 8601 date-time); refusing to run.`;
  if (fromMs >= cutoffMs || allowPreUpgrade) return null;
  return `--from ${new Date(fromMs).toISOString()} is before the OpenClaw upgrade cutoff ${new Date(cutoffMs).toISOString()} (${OPENCLAW_UPGRADE_CUTOFF_ENV}); pre-upgrade history is never rewritten. Pass --allow-pre-upgrade to override.`;
}
