/**
 * @module openclaw-db/schema-v23-meta
 *
 * Schema-23 channel metadata for token-metrics channel naming. Reads (never
 * writes) the session key of each transcript and the names OpenClaw keeps
 * in its session/conversation records:
 * - `session_windows`: session_id -> session_key;
 * - `session_transcript_archives.session_key` for deleted/reset sessions;
 * - `session_nodes`: `label` plus `entry_json` (`groupChannel`,
 *   `displayName`, `delivery.origin.label`, `parentSessionKey` /
 *   `spawnedBy`); parents are linked transitively (bounded, cycle-safe)
 *   so subagents can roll up to their root spawner;
 * - `conversations`: native Slack channel id -> label (`slack:<team>#name`).
 */

import type { DatabaseSync } from 'node:sqlite';

import { MAX_ROLLUP_DEPTH } from './subagent-rollup.js';
import type { SessionMeta } from './types.js';

interface NodeInfo {
  label?: string;
  groupChannel?: string;
  displayName?: string;
  originLabel?: string;
  parentKey?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** `#name` from a display label like `slack:t0abc#ops-ceo`, else undefined. */
export function channelNameFromLabel(
  label: string | undefined,
): string | undefined {
  const m = label ? /^slack:[^#\s]*#([a-z0-9._-]+)$/i.exec(label) : null;
  return m ? `#${m[1]}` : undefined;
}

/** Parse one `session_nodes` row. Malformed entry JSON yields no names. */
export function parseNodeEntry(
  label: string | null,
  entryJson: string,
  parentColumn: string | null,
): NodeInfo {
  let entry: unknown;
  try {
    entry = JSON.parse(entryJson);
  } catch {
    entry = {};
  }
  const e = isRecord(entry) ? entry : {};
  const delivery = isRecord(e['delivery']) ? e['delivery'] : {};
  const origin = isRecord(delivery['origin']) ? delivery['origin'] : {};
  return {
    label: str(label) ?? str(e['label']),
    groupChannel: str(e['groupChannel']),
    displayName: str(e['displayName']),
    originLabel: str(origin['label']),
    parentKey:
      str(parentColumn) ?? str(e['parentSessionKey']) ?? str(e['spawnedBy']),
  };
}

const SLACK_CHANNEL_ID = /:slack:channel:([a-z0-9]+)/i;

/** Builds {@link SessionMeta} for schema-23 transcripts. */
export interface V23MetaIndex {
  /** Metadata for a live (hot/cold) session id. */
  forSession: (sessionId: string) => SessionMeta | undefined;
  /** Metadata for a session key (e.g. from an archive row). */
  forKey: (sessionKey: string) => SessionMeta;
}

/** Load the metadata index from an open schema-23 DB. */
export function loadV23Meta(db: DatabaseSync): V23MetaIndex {
  const nodes = new Map<string, NodeInfo>();
  const rows = db
    .prepare(
      'SELECT session_key, label, entry_json, parent_session_key FROM session_nodes',
    )
    .all() as {
    session_key: string;
    label: string | null;
    entry_json: string;
    parent_session_key: string | null;
  }[];
  for (const r of rows)
    nodes.set(
      r.session_key,
      parseNodeEntry(r.label, r.entry_json, r.parent_session_key),
    );

  const channelNames = new Map<string, string>();
  const convs = db
    .prepare(
      'SELECT native_channel_id, label FROM conversations WHERE native_channel_id IS NOT NULL',
    )
    .all() as { native_channel_id: string; label: string | null }[];
  for (const c of convs) {
    const name = channelNameFromLabel(c.label ?? undefined);
    if (name) channelNames.set(c.native_channel_id.toLowerCase(), name);
  }
  for (const [key, n] of nodes) {
    const id = SLACK_CHANNEL_ID.exec(key)?.[1].toLowerCase();
    const name = n.groupChannel?.startsWith('#')
      ? n.groupChannel
      : channelNameFromLabel(n.displayName);
    if (id && name && !channelNames.has(id)) channelNames.set(id, name);
  }

  const windows = new Map<string, string>();
  const wrows = db
    .prepare('SELECT session_id, session_key FROM session_windows')
    .all() as { session_id: string; session_key: string }[];
  for (const w of wrows) windows.set(w.session_id, w.session_key);

  const build = (sessionKey: string, seen: Set<string>): SessionMeta => {
    const node = nodes.get(sessionKey);
    const n = node ?? {};
    const meta: SessionMeta = { sessionKey };
    if (!node) meta.missing = true;
    if (n.label) meta.label = n.label;
    const id = SLACK_CHANNEL_ID.exec(sessionKey)?.[1].toLowerCase();
    const channelName =
      (n.groupChannel?.startsWith('#') ? n.groupChannel : undefined) ??
      channelNameFromLabel(n.displayName) ??
      (id ? channelNames.get(id) : undefined);
    if (channelName) meta.channelName = channelName;
    if (sessionKey.includes(':telegram:') && n.originLabel)
      meta.channelName = n.originLabel.replace(/\s+id:.*$/, '');
    if (
      sessionKey.includes(':direct:') &&
      n.originLabel &&
      !/^[a-z]+:/i.test(n.originLabel)
    )
      meta.peerName = n.originLabel;
    if (
      n.parentKey &&
      !seen.has(n.parentKey) &&
      n.parentKey !== sessionKey &&
      seen.size < MAX_ROLLUP_DEPTH
    )
      meta.parent = build(n.parentKey, new Set(seen).add(sessionKey));
    return meta;
  };

  return {
    forSession: (sessionId) => {
      const key = windows.get(sessionId);
      return key ? build(key, new Set()) : undefined;
    },
    forKey: (sessionKey) => build(sessionKey, new Set()),
  };
}
