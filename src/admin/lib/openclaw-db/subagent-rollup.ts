/**
 * @module openclaw-db/subagent-rollup
 *
 * Attributes a subagent session's usage to the session that spawned it,
 * resolved transitively (subagent of a subagent -> root), using the
 * parent linkage OpenClaw 2026.9 records (`parent_session_key` /
 * `spawnedBy`; see schema-v23-meta.ts). Rules:
 *
 * 1. Root is channel-bound (Slack channel/DM, Telegram) or a cron job:
 *    the root's channel.
 * 2. Root is not channel-bound (`agent:<id>:main`, recovered, ...): the
 *    topmost subagent below the root names the bucket. A runner worker
 *    (label `worker-<job>`; spawn-worker keeps the first 8 characters of
 *    the job id) becomes `runner:<job>`; any other subagent keeps its own
 *    label-based name (subagent:label:..., meta-<phase>).
 * 3. The chain cannot be resolved (no linkage recorded, a subagent
 *    ancestor with no session node, a cycle): the session's own
 *    label-based name, as before rollup.
 * Null means the metadata does not decide; the text rules then apply.
 */

import type { ChannelResult } from '../channel-mapper.js';
import type { SessionMeta } from './types.js';

/** Longest parent chain followed (guards malformed linkage). */
export const MAX_ROLLUP_DEPTH = 16;

type Resolver = (meta: SessionMeta) => ChannelResult | null;

/** True for `agent:<id>:subagent:...` session keys. */
export function isSubagentKey(sessionKey: string): boolean {
  return /^agent:[^:]+:subagent:/.test(sessionKey);
}

/** `runner:<job>` for a runner-worker label (`worker-<job>`), else null. */
export function runnerChannel(label: string | undefined): ChannelResult | null {
  const job = label ? /^worker-(\S+)$/.exec(label.trim())?.[1] : undefined;
  return job ? { key: `runner:${job}`, name: `Runner: ${job}` } : null;
}

/**
 * Resolve a subagent session's rolled-up channel.
 *
 * @param meta - The subagent session's metadata (parents linked).
 * @param rootChannel - Channel of a non-subagent session.
 * @param ownChannel - A subagent's own label-based channel.
 * @returns The channel, or null when metadata does not decide.
 */
export function rollupSubagent(
  meta: SessionMeta,
  rootChannel: Resolver,
  ownChannel: Resolver,
): ChannelResult | null {
  let top = meta;
  for (let depth = 0; depth < MAX_ROLLUP_DEPTH; depth++) {
    const parent = top.parent;
    if (!parent) break;
    if (isSubagentKey(parent.sessionKey)) {
      if (parent.missing) break;
      top = parent;
      continue;
    }
    return rootChannel(parent) ?? runnerChannel(top.label) ?? ownChannel(top);
  }
  return ownChannel(meta);
}
