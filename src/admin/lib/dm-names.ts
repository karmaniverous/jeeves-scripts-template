/**
 * @module dm-names
 *
 * Names Slack DM channels whose key still holds the raw user id
 * (`slack:dm:U0ABC…`, written when the store recorded no peer name).
 * Each id resolves, in order, through the DM-name cache, the cached Slack
 * user map, then an optional live lookup; resolved buckets are renamed to
 * the usual `slack:dm:<person-slug>` key (merged into an existing entry
 * for that person). Unresolved ids keep the id key. Pure over its inputs;
 * I/O lives in dm-name-sources.ts.
 */

import type { HourlyBucket } from '../types/token-metrics.js';
import { TOKEN_CATEGORIES } from '../types/token-metrics.js';
import { slugify } from './channel-mapper.js';

const DM_ID_KEY = /^slack:dm:([UW][A-Z0-9]{6,})$/;

/** Live user-id → display-name lookup (undefined when unknown). */
export type DmNameLookup = (userId: string) => Promise<string | undefined>;

/** Where DM names come from. */
export interface DmNameSources {
  /** Previously resolved names (user id → name). */
  cache: Record<string, string>;
  /** Cached Slack user map (user id → name), read-only. */
  userMap: Record<string, string>;
  /** Live lookup, tried last. */
  lookup?: DmNameLookup;
}

/** Sorted distinct user ids of `slack:dm:<USERID>` channels in `buckets`. */
export function dmUserIds(buckets: Map<string, HourlyBucket>): string[] {
  const ids = new Set<string>();
  for (const bucket of buckets.values())
    for (const key of Object.keys(bucket.channels)) {
      const id = DM_ID_KEY.exec(key)?.[1];
      if (id) ids.add(id);
    }
  return [...ids].sort();
}

/**
 * Resolve user ids to names. A failed or empty lookup leaves the id
 * unresolved.
 *
 * @returns resolved names, plus the ones learned from the live lookup
 * (to add to the cache)
 */
export async function resolveDmNames(
  ids: string[],
  sources: DmNameSources,
): Promise<{ names: Map<string, string>; learned: Record<string, string> }> {
  const names = new Map<string, string>();
  const learned: Record<string, string> = {};
  for (const id of ids) {
    let name = sources.cache[id] ?? sources.userMap[id];
    if (!name && sources.lookup) {
      try {
        name = (await sources.lookup(id))?.trim() ?? '';
      } catch {
        name = '';
      }
      if (name) learned[id] = name;
    }
    if (name && slugify(name)) names.set(id, name);
  }
  return { names, learned };
}

type Channel = HourlyBucket['channels'][string];

function mergeChannel(into: Channel, from: Channel): void {
  for (const [model, entry] of Object.entries(from.models)) {
    const existing = into.models[model] as typeof entry | undefined;
    if (!existing) {
      into.models[model] = entry;
      continue;
    }
    for (const cat of TOKEN_CATEGORIES) {
      existing[cat].count += entry[cat].count;
      existing[cat].cost += entry[cat].cost;
    }
  }
}

/**
 * Rename `slack:dm:<USERID>` channels to `slack:dm:<person-slug>`,
 * summing into an existing entry for that person.
 *
 * @returns number of channel entries renamed
 */
export function renameDmChannels(
  buckets: Map<string, HourlyBucket>,
  names: Map<string, string>,
): number {
  let renamed = 0;
  for (const bucket of buckets.values()) {
    const next: HourlyBucket['channels'] = {};
    for (const [key, channel] of Object.entries(bucket.channels)) {
      const id = DM_ID_KEY.exec(key)?.[1];
      const name = id ? names.get(id) : undefined;
      const target = name ? `slack:dm:${slugify(name)}` : key;
      if (target !== key) renamed++;
      const into = next[target] as Channel | undefined;
      if (into) mergeChannel(into, channel);
      else next[target] = channel;
    }
    bucket.channels = next;
  }
  return renamed;
}
