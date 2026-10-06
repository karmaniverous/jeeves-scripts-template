/**
 * @module pipeline-config-deprecations
 *
 * Once-per-process `pipeline-config:` deprecation warnings, shared by the
 * pipeline-config schemas.
 */

const warnedDeprecations = new Set<string>();

/**
 * Log a one-line `pipeline-config:` deprecation warning, at most once per
 * process for each message (cleared by {@link clearDeprecationWarnings}).
 */
export function warnDeprecated(message: string): void {
  if (warnedDeprecations.has(message)) return;
  warnedDeprecations.add(message);
  console.warn(`pipeline-config: ${message}`);
}

/** Forget which warnings were logged (resetPipelineConfig, tests). */
export function clearDeprecationWarnings(): void {
  warnedDeprecations.clear();
}
