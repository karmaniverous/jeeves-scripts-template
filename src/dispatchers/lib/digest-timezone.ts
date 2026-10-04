/**
 * @module dispatchers/lib/digest-timezone
 *
 * The time zone the daily digest dates itself in: the pipeline-config ref
 * `digest.timezone` (an IANA zone such as `America/Chicago`, or `UTC`).
 * Required, no default: a missing or invalid value fails the run.
 */

import { requireTimeZone } from '../../lib/dates.js';
import { tryGetRef } from '../../lib/pipeline-config.js';

/** pipeline-config ref holding the digest's time zone. */
export const DIGEST_TIMEZONE_REF = 'digest.timezone';

/**
 * Read and validate `refs["digest.timezone"]`.
 *
 * @throws When the ref is missing (or pipeline-config.json is) or not a
 *   valid time zone.
 */
export function digestTimeZone(): string {
  return requireTimeZone(
    tryGetRef(DIGEST_TIMEZONE_REF),
    `refs["${DIGEST_TIMEZONE_REF}"] in pipeline-config.json`,
  );
}
