/**
 * @module regen-guard
 *
 * Guard for regenerate-token-metrics: never rewrite pre-upgrade history by
 * accident. A --from earlier than the configured OpenClaw upgrade cutoff
 * (OPENCLAW_UPGRADE_CUTOFF) is refused unless --allow-pre-upgrade is set.
 */

/**
 * Check a regeneration start against the upgrade cutoff.
 *
 * @param fromMs - Requested start (ms since epoch, hour-floored).
 * @param cutoffIso - Configured upgrade cutoff (ISO 8601).
 * @param allowPreUpgrade - True when --allow-pre-upgrade was given.
 * @returns An error message when the run must be refused, else null.
 */
export function checkRegenFrom(
  fromMs: number,
  cutoffIso: string,
  allowPreUpgrade: boolean,
): string | null {
  const cutoffMs = Date.parse(cutoffIso);
  if (Number.isNaN(cutoffMs))
    return `Invalid OPENCLAW_UPGRADE_CUTOFF "${cutoffIso}"; refusing to run.`;
  if (fromMs >= cutoffMs || allowPreUpgrade) return null;
  return `--from ${new Date(fromMs).toISOString()} is before the OpenClaw upgrade cutoff ${new Date(cutoffMs).toISOString()}; pre-upgrade history is never rewritten. Pass --allow-pre-upgrade to override.`;
}
