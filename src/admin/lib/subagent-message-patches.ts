/**
 * @module subagent-message-patches
 *
 * Pure patch definitions that re-enable the `message` tool for sessions
 * spawned via `sessions_spawn`. OpenClaw gates it in two independent
 * layers and both must be patched:
 *
 * 1. **Spawn flag** — `buildSubagentLaunchRequest`
 *    (upstream `src/agents/subagents/spawn/subagent-spawn-launch-request.ts`)
 *    hard-codes `disableMessageTool: true` right after
 *    `lane: AGENT_LANE_SUBAGENT`, so the tool is never built.
 * 2. **Deny list** — `SUBAGENT_TOOL_DENY_ALWAYS`
 *    (upstream `src/agents/agent-tools.policy.ts`) contains `"message"`,
 *    so the tool is filtered out even when built. Config can only add to
 *    this list, never remove from it.
 *
 * Collector-mode spawns stay message-less: upstream ORs
 * `disableMessageTool` with `swarmCollector` when building tools.
 */

import {
  allMatches,
  evaluateAnchoredPatch,
  lineOf,
  type TextPatchResult,
} from './text-patch.js';

// ── Layer 1: spawn flag ──────────────────────────────────────────────

/** Cheap substring filter: only files containing this are evaluated. */
export const SPAWN_FLAG_PREFILTER = 'AGENT_LANE_SUBAGENT';

const SPAWN_FLAG_UNPATCHED =
  /lane:\s*AGENT_LANE_SUBAGENT,\s*disableMessageTool:\s*true\b/g;
const SPAWN_FLAG_PATCHED =
  /lane:\s*AGENT_LANE_SUBAGENT,\s*disableMessageTool:\s*false\b/g;

/** Flip the sub-agent launch request's `disableMessageTool` to false. */
export function patchSpawnFlag(content: string): TextPatchResult {
  return evaluateAnchoredPatch(
    content,
    SPAWN_FLAG_UNPATCHED,
    SPAWN_FLAG_PATCHED,
    (m) => m.replace(/true$/, 'false'),
  );
}

// ── Layer 2: deny list ───────────────────────────────────────────────

/** Cheap substring filter: only files containing this are evaluated. */
export const DENY_LIST_PREFILTER = 'SUBAGENT_TOOL_DENY_ALWAYS';

/** The array declaration (no nested brackets in this literal). */
const DENY_DECL =
  /\b(?:const|let|var)\s+SUBAGENT_TOOL_DENY_ALWAYS\s*=\s*\[[^\]]*\]/g;
const MESSAGE_ENTRY = /(["'])message\1/g;

/** Remove the single `"message"` element from an array literal. */
function removeMessageEntry(decl: string): string {
  // First/middle element: drop entry + comma + following whitespace, so the
  // next entry inherits this entry's indentation.
  const withComma = /(["'])message\1\s*,\s*/;
  if (withComma.test(decl)) return decl.replace(withComma, '');
  // Last element: drop preceding comma + entry.
  const last = /\s*,\s*(["'])message\1/;
  if (last.test(decl)) return decl.replace(last, '');
  // Only element.
  return decl.replace(/\s*(["'])message\1\s*/, '');
}

/** Remove `"message"` from `SUBAGENT_TOOL_DENY_ALWAYS`. */
export function patchDenyList(content: string): TextPatchResult {
  const decls = allMatches(content, DENY_DECL);

  if (decls.length === 0) return { status: 'not-found' };
  if (decls.length > 1) {
    return {
      status: 'ambiguous',
      detail: `${String(decls.length)} SUBAGENT_TOOL_DENY_ALWAYS declarations (expected 1)`,
    };
  }

  const [m] = decls;
  const before = m[0];
  const line = lineOf(content, m.index);
  const entries = allMatches(before, MESSAGE_ENTRY).length;

  if (entries === 0)
    return { status: 'already-patched', line, snippet: before };
  if (entries > 1) {
    return {
      status: 'ambiguous',
      detail: `${String(entries)} "message" entries in SUBAGENT_TOOL_DENY_ALWAYS (expected 1)`,
    };
  }

  const after = removeMessageEntry(before);
  return {
    status: 'patch',
    content:
      content.slice(0, m.index) +
      after +
      content.slice(m.index + before.length),
    line,
    before,
    after,
  };
}
