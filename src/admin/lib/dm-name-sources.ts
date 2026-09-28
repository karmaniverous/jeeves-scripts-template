/**
 * @module dm-name-sources
 *
 * I/O for Slack DM naming (dm-names.ts):
 * - the DM-name cache (user id → name JSON beside the buckets; written only
 *   with names learned from the live lookup);
 * - the cached Slack user map (`src/slack/lib/users.json`), read-only;
 * - the live lookup: the gateway `message` tool's Slack `member-info`
 *   action (real name, then display name, then handle), time-bounded.
 * {@link applyDmNames} wires them together for a bucket map.
 */

import fs from 'node:fs';

import { writeJsonAtomic } from '@karmaniverous/jeeves';
import { z } from 'zod';

import { gatewayInvoke, unwrapResult } from '../../lib/gateway-client.js';
import type { HourlyBucket } from '../types/token-metrics.js';
import type { DmNameLookup } from './dm-names.js';
import { dmUserIds, renameDmChannels, resolveDmNames } from './dm-names.js';

/** DM-name cache file: user id → display name. */
export const dmNameCacheSchema = z.record(z.string(), z.string());

/** Cached Slack user map entry (a name, or the poller's user record). */
const slackUserSchema = z.union([
  z.string(),
  z.object({ alias: z.string().optional(), name: z.string().optional() }),
]);

const slackUsersSchema = z.record(z.string(), slackUserSchema);

/** Bound on one live lookup. */
const LOOKUP_TIMEOUT_MS = 10_000;

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Read the DM-name cache ({} when missing or invalid). */
export function readDmNameCache(filePath: string): Record<string, string> {
  const parsed = dmNameCacheSchema.safeParse(readJsonFile(filePath));
  return parsed.success ? parsed.data : {};
}

/** Read the cached Slack user map as id → name ({} when unusable). */
export function loadSlackUserNames(filePath: string): Record<string, string> {
  const parsed = slackUsersSchema.safeParse(readJsonFile(filePath));
  if (!parsed.success) return {};
  const names: Record<string, string> = {};
  for (const [id, user] of Object.entries(parsed.data)) {
    const name =
      typeof user === 'string' ? user : (user.alias ?? user.name ?? '');
    if (name.trim()) names[id] = name.trim();
  }
  return names;
}

const memberInfoSchema = z.object({
  info: z.object({
    user: z.object({
      name: z.string().optional(),
      real_name: z.string().optional(),
      profile: z
        .object({
          real_name: z.string().optional(),
          display_name: z.string().optional(),
        })
        .optional(),
    }),
  }),
});

/** Gateway tool invoker (injectable for tests). */
export type ToolInvoker = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Look a Slack user's name up through the gateway `message` tool.
 *
 * @returns the name, or undefined when unknown or the call fails/times out
 */
export async function gatewayMemberName(
  userId: string,
  invoke: ToolInvoker = gatewayInvoke,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      invoke('message', { action: 'member-info', channel: 'slack', userId }),
      timeout,
    ]);
    const parsed = memberInfoSchema.safeParse(unwrapResult(result));
    if (!parsed.success) return undefined;
    const { user } = parsed.data.info;
    const name = [
      user.profile?.real_name,
      user.real_name,
      user.profile?.display_name,
      user.name,
    ].find((n) => n?.trim());
    return name?.trim();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Inputs for {@link applyDmNames}. */
export interface ApplyDmNamesParams {
  cachePath: string;
  usersPath: string;
  lookup?: DmNameLookup;
  /** Resolve and rename, but never write the cache. */
  dryRun?: boolean;
  tag?: string;
}

/**
 * Resolve `slack:dm:<USERID>` channels in `buckets` to person names and
 * rename them in place; newly learned names are added to the cache.
 *
 * @returns number of channel entries renamed
 */
export async function applyDmNames(
  buckets: Map<string, HourlyBucket>,
  params: ApplyDmNamesParams,
): Promise<number> {
  const ids = dmUserIds(buckets);
  if (ids.length === 0) return 0;
  const cache = readDmNameCache(params.cachePath);
  const { names, learned } = await resolveDmNames(ids, {
    cache,
    userMap: loadSlackUserNames(params.usersPath),
    lookup: params.lookup,
  });
  if (Object.keys(learned).length > 0 && !params.dryRun)
    writeJsonAtomic(params.cachePath, { ...cache, ...learned });
  const renamed = renameDmChannels(buckets, names);
  const unresolved = ids.filter((id) => !names.has(id));
  console.log(
    `${params.tag ?? '[token-metrics]'} Slack DM names: ${String(names.size)} of ${String(ids.length)} user ids resolved${unresolved.length ? ` (kept as id: ${unresolved.join(', ')})` : ''}`,
  );
  return renamed;
}
