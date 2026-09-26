/**
 * @module patch-tool-order-utils
 *
 * Pure helpers for patch-tool-order: parse/format the toolOrder array and
 * evaluate the insert-above-anchor patch against one chunk's content as a
 * {@link TextPatchResult} (no filesystem access).
 */

import { allMatches, lineOf, type TextPatchResult } from './text-patch.js';

/** Cheap substring filter: only chunks containing this are evaluated. */
export const TOOL_ORDER_PREFILTER = 'toolOrder';

/** Every `toolOrder = [` assignment (same shape parseToolOrder matches). */
const TOOL_ORDER_SITE = /toolOrder\s*=\s*\[/g;

/**
 * Parse the toolOrder array from file content.
 * Returns the full match string, any declaration keyword prefix, and the
 * parsed tool names.
 */
export function parseToolOrder(content: string): {
  match: string;
  prefix: string;
  tools: string[];
} | null {
  // Capture an optional declaration keyword (const/let/var) before toolOrder.
  const re = /(?:(const|let|var)\s+)?toolOrder\s*=\s*\[([\s\S]*?)\]/;
  const m = re.exec(content);

  if (!m) return null;

  const prefix = m[1] ? `${m[1]} ` : '';
  const tools = m[2]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  return { match: m[0], prefix, tools };
}

/**
 * Build the patched toolOrder array string, preserving the original
 * formatting (tab-indented, one tool per line).
 */
export function buildToolOrderString(prefix: string, tools: string[]): string {
  const entries = tools.map((t) => `\t\t"${t}"`).join(',\n');
  return `${prefix}toolOrder = [\n${entries}\n\t]`;
}

/**
 * Evaluate the toolOrder patch for one chunk: insert `toolsToInsert`
 * immediately before `insertBefore`. Exactly one toolOrder assignment
 * may exist; zero is not-found, several (or an unparseable array or a
 * missing anchor) is ambiguous so the caller fails closed. All tools
 * already present counts as already patched (idempotent).
 */
export function evaluateToolOrderPatch(
  content: string,
  toolsToInsert: readonly string[],
  insertBefore: string,
): TextPatchResult {
  const sites = allMatches(content, TOOL_ORDER_SITE);
  if (sites.length === 0) return { status: 'not-found' };
  if (sites.length > 1) {
    return {
      status: 'ambiguous',
      detail: `${String(sites.length)} toolOrder arrays (expected exactly 1)`,
    };
  }

  const parsed = parseToolOrder(content);
  if (!parsed) {
    return {
      status: 'ambiguous',
      detail: 'toolOrder array could not be parsed',
    };
  }

  const index = content.indexOf(parsed.match);
  const line = lineOf(content, index);

  if (toolsToInsert.every((t) => parsed.tools.includes(t))) {
    return { status: 'already-patched', line, snippet: parsed.match };
  }

  const cleaned = parsed.tools.filter((t) => !toolsToInsert.includes(t));
  const anchor = cleaned.indexOf(insertBefore);
  if (anchor === -1) {
    return {
      status: 'ambiguous',
      detail: `anchor tool "${insertBefore}" not found in toolOrder`,
    };
  }

  const after = buildToolOrderString(parsed.prefix, [
    ...cleaned.slice(0, anchor),
    ...toolsToInsert,
    ...cleaned.slice(anchor),
  ]);
  return {
    status: 'patch',
    content:
      content.slice(0, index) +
      after +
      content.slice(index + parsed.match.length),
    line,
    before: parsed.match,
    after,
  };
}
