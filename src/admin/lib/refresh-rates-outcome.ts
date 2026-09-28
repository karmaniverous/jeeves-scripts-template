/**
 * @module refresh-rates-outcome
 *
 * The refresh-token-rates worker contract: the worker must end its final
 * reply with exactly one structured result line, which the job parses
 * instead of trusting the worker process exit code (spawn-worker exits 0
 * whenever the LLM session ends normally, even if the task failed).
 *
 * Result line (last non-empty line of the final reply):
 *   RESULT: updated
 *   RESULT: unchanged
 *   RESULT: failed: <reason>
 */

/** Parsed worker outcome. */
export type RefreshOutcome =
  | { status: 'updated' }
  | { status: 'unchanged' }
  | { status: 'failed'; reason: string };

/** TASK text that tells the worker how to report its outcome. */
export const RESULT_LINE_INSTRUCTIONS = `End your final reply with exactly one result line as its LAST line, with nothing after it:
- "RESULT: updated" if you changed the rate card (rates, models, updatedAt, or source),
- "RESULT: unchanged" if every rate was verified and no change was needed (leave the file untouched),
- "RESULT: failed: <reason>" if you could not complete the verification or could not write the file.
The job fails unless this line is present and consistent with the rate card on disk.`;

const RESULT_LINE = /^RESULT:\s*(updated|unchanged|failed)\s*(?::\s*(.*))?$/i;

/**
 * Parse the worker's result line from its final reply.
 *
 * Only the last non-empty line is considered. Markdown emphasis or code
 * ticks wrapping the line are tolerated.
 *
 * @param finalText - The worker's final assistant reply, or null.
 * @returns The outcome, or null when no valid result line is present.
 */
export function parseRefreshOutcome(
  finalText: string | null,
): RefreshOutcome | null {
  if (!finalText) return null;
  const lines = finalText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines.at(-1);
  if (!last) return null;

  const match = RESULT_LINE.exec(last.replace(/^[`*_]+|[`*_]+$/g, ''));
  if (!match) return null;

  const status = match[1].toLowerCase();
  const detail = match.at(2)?.trim() ?? '';
  if (status === 'failed') {
    return { status: 'failed', reason: detail || 'no reason given' };
  }
  if (detail) return null; // "updated: …" / "unchanged: …" is malformed
  return status === 'updated' ? { status: 'updated' } : { status: 'unchanged' };
}
