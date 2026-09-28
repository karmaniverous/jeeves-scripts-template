/**
 * @module openclaw-db/channel-from-meta
 *
 * Channel naming for OpenClaw 2026.9+ transcripts. The channel comes from
 * the session's recorded metadata (session key plus origin/delivery-context
 * names; see SessionMeta). The legacy transcript-text rules
 * (channel-mapper.ts) are used only when that metadata is absent or
 * doesn't identify the channel, because 2026.9 injects runtime-context text
 * into transcripts that the text rules misread. Every result is sanitized
 * (whitespace collapsed, trailing punctuation stripped).
 *
 * Keys keep the JSONL-era vocabulary: slack:channel:#name (or the
 * upper-case channel id when no name is known), slack:dm:<person-slug>,
 * subagent:label:<label>, subagent:for:<channel>, meta-<phase>.
 * New for 2026.9: cron:<label> and telegram:<kind>:<name>.
 */

import {
  type ChannelResult,
  detectChannel,
  detectMetaPhase,
  slugify,
} from '../channel-mapper.js';
import type { SessionMeta } from './types.js';

/** Longest label kept in a key (same cap as the text rules). */
const MAX_LABEL = 60;

/** Collapse whitespace and strip trailing punctuation. */
export function cleanPart(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?'"`]+$/, '');
}

/** Sanitize a channel result's key and name. */
export function sanitizeChannel(result: ChannelResult): ChannelResult {
  const key = cleanPart(result.key);
  const name = cleanPart(result.name);
  return { key: key || 'unknown', name: name || key || 'Unknown' };
}

function subagentChannel(meta: SessionMeta): ChannelResult | null {
  const label = meta.label ? cleanPart(meta.label) : '';
  if (label) {
    const phase = detectMetaPhase(label);
    if (phase) return phase;
    if (label.includes('jeeves-meta-synthesis'))
      return { key: 'meta-synthesis', name: 'Meta Synthesis' };
    const value = cleanPart(label.slice(0, MAX_LABEL));
    return { key: `subagent:label:${value}`, name: `Subagent: label ${value}` };
  }
  const parent = meta.parent ? channelFromMeta(meta.parent) : null;
  if (parent?.key.startsWith('slack:')) {
    const target = parent.key.replace(/^slack:(channel:)?/, '');
    return { key: `subagent:for:${target}`, name: `Subagent: for ${target}` };
  }
  return null;
}

/**
 * Derive the channel from session metadata alone.
 *
 * @param meta - Session metadata from the agent DB.
 * @returns The channel, or null when the metadata doesn't identify it.
 */
export function channelFromMeta(meta: SessionMeta): ChannelResult | null {
  const rest = /^agent:[^:]+:(.+)$/.exec(meta.sessionKey)?.[1] ?? '';
  const [kind = '', sub = '', id = ''] = rest.split(':');

  if (kind === 'slack' && sub === 'channel' && id) {
    if (meta.channelName) {
      const name = meta.channelName.startsWith('#')
        ? meta.channelName
        : `#${meta.channelName}`;
      return { key: `slack:channel:${name}`, name };
    }
    const upper = id.toUpperCase();
    return { key: `slack:channel:${upper}`, name: `#${upper}` };
  }
  if (kind === 'slack' && sub === 'direct' && id) {
    const peer = meta.peerName ? cleanPart(meta.peerName) : '';
    const slug = peer ? slugify(peer) : '';
    const upper = id.toUpperCase();
    return slug
      ? { key: `slack:dm:${slug}`, name: `DM: ${peer}` }
      : { key: `slack:dm:${upper}`, name: `DM: ${upper}` };
  }
  if (kind === 'telegram' && sub && id) {
    const name = cleanPart(meta.channelName ?? id);
    return { key: `telegram:${sub}:${name}`, name: `Telegram: ${name}` };
  }
  if (kind === 'subagent') return subagentChannel(meta);
  if (kind === 'cron') {
    const label = meta.label
      ? cleanPart(meta.label.replace(/^cron:\s*/i, ''))
      : '';
    return label
      ? { key: `cron:${label}`, name: `Cron: ${label}` }
      : { key: 'cron', name: 'Cron' };
  }
  return null;
}

/**
 * Resolve a transcript's channel: metadata first, then the legacy text
 * rules over the transcript head; the result is always sanitized.
 *
 * @param meta - Session metadata, if the store has it.
 * @param headLines - First JSON lines of the transcript.
 * @returns The sanitized channel.
 */
export function resolveChannel(
  meta: SessionMeta | undefined,
  headLines: string[],
): ChannelResult {
  const fromMeta = meta ? channelFromMeta(meta) : null;
  return sanitizeChannel(fromMeta ?? detectChannel(headLines));
}
