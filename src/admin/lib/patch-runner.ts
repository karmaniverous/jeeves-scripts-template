/**
 * @module patch-runner
 *
 * Run a list of patch scripts independently: a failure in one never
 * skips the rest. The actual process spawning is injected so the
 * sequencing and reporting logic stays pure and testable.
 */

/** Outcome of one patch script. */
export interface PatchRunResult {
  script: string;
  ok: boolean;
  exitCode: number | null;
  error?: string;
}

/** Runs one script; may throw or return a result. */
export type PatchScriptRunner = (script: string) => PatchRunResult;

/** Run every script, converting throws into failed results. */
export function runAllPatches(
  scripts: readonly string[],
  runOne: PatchScriptRunner,
): PatchRunResult[] {
  return scripts.map((script) => {
    try {
      return runOne(script);
    } catch (err) {
      return {
        script,
        ok: false,
        exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Narrow an unknown child-process failure (e.g. from `execSync`) into an
 * exit code and a one-line cause. Never throws, whatever was thrown.
 */
export function describeExecFailure(err: unknown): {
  exitCode: number | null;
  error: string;
} {
  const props: Record<string, unknown> =
    typeof err === 'object' && err !== null ? { ...err } : {};
  const { status, signal } = props;
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n')[0].trim() || 'unknown error';
  return {
    exitCode: typeof status === 'number' ? status : null,
    error:
      typeof signal === 'string' && signal ? `killed by ${signal}` : firstLine,
  };
}

/** Human-readable per-patch summary lines. */
export function formatPatchSummary(
  results: readonly PatchRunResult[],
): string[] {
  const lines = results.map((r) => {
    const status = r.ok ? 'OK    ' : 'FAILED';
    const code = r.exitCode === null ? '' : ` (exit ${String(r.exitCode)})`;
    const err = r.error ? ` — ${r.error}` : '';
    return `  ${status} ${r.script}${r.ok ? '' : code}${err}`;
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    failed === 0
      ? `  All ${String(results.length)} patches succeeded.`
      : `  ${String(failed)} of ${String(results.length)} patches FAILED.`,
  );
  return lines;
}
