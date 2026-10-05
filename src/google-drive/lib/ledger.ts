/**
 * @module google-drive/lib/ledger
 *
 * The per-account file ledger and run summary in jeeves-runner state
 * (spec §6.1): collection `google-drive` / `files:<account>` keyed by
 * Drive file id, and scalar `google-drive` / `run:<account>`.
 *
 * In dry-run mode the store is read-only: writes are dropped, so a dry
 * run never changes runner state (spec §6.5).
 *
 * Reset (`--reset-state`) deletes every item before the parent row:
 * `state_items` has a foreign key to `state` with no `ON DELETE
 * CASCADE`, so a bare `deleteState` fails while items exist.
 */

import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { z } from 'zod';

export const NAMESPACE = 'google-drive';

export const SkipReasonSchema = z.enum([
  'non-convertible',
  'oversize',
  'export-limit',
  'invalid-utf8',
  'path-too-long',
]);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

export const LedgerRecordSchema = z.object({
  /** Where the written copy currently is, relative to targetDir. */
  localPath: z.string().nullable(),
  written: z
    .object({
      contentKey: z.string(),
      modifiedTime: z.string().nullable(),
      kind: z.string(),
      at: z.string(),
    })
    .nullable(),
  skipped: z.object({ reason: SkipReasonSchema, key: z.string() }).nullable(),
  pendingSince: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  retryAfter: z.string().nullable(),
  /** Parked after maxAttempts; retried only when the probe key changes. */
  parked: z.object({ key: z.string() }).nullable(),
  pathResolved: z.boolean(),
  shareIds: z.array(z.string()),
});
export type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

/** A blank record for a newly seen file. */
export function emptyRecord(): LedgerRecord {
  return {
    localPath: null,
    written: null,
    skipped: null,
    pendingSince: null,
    attempts: 0,
    lastError: null,
    retryAfter: null,
    parked: null,
    pathResolved: false,
    shareIds: [],
  };
}

export interface LedgerStore {
  load(): Map<string, LedgerRecord>;
  put(id: string, record: LedgerRecord): void;
  remove(id: string): void;
  loadRunState(): unknown;
  saveRunState(state: unknown): void;
  /** Delete all items, then the parent row and run state. Returns item count. */
  reset(): number;
}

/** Runner-backed ledger. `live: false` drops every write. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createLedgerStore(
  client: RunnerClient,
  account: string,
  live: boolean,
): LedgerStore {
  const filesKey = `files:${account}`;
  const runKey = `run:${account}`;

  return {
    load: () => {
      const records = new Map<string, LedgerRecord>();
      for (const id of client.listItemKeys(NAMESPACE, filesKey)) {
        const raw = client.getItem(NAMESPACE, filesKey, id);
        if (raw === null) continue;
        // An unreadable record is treated as absent: the item re-syncs.
        const parsed = LedgerRecordSchema.safeParse(parseJson(raw));
        if (parsed.success) records.set(id, parsed.data);
        else
          console.warn(`google-drive ledger: ignoring unreadable record ${id}`);
      }
      return records;
    },
    put: (id, record) => {
      if (live) client.setItem(NAMESPACE, filesKey, id, JSON.stringify(record));
    },
    remove: (id) => {
      if (live) client.deleteItem(NAMESPACE, filesKey, id);
    },
    loadRunState: () => {
      const raw = client.getState(NAMESPACE, runKey);
      return raw === null ? null : parseJson(raw);
    },
    saveRunState: (state) => {
      if (live) client.setState(NAMESPACE, runKey, JSON.stringify(state));
    },
    reset: () => {
      const keys = client.listItemKeys(NAMESPACE, filesKey);
      if (!live) return keys.length;
      for (const id of keys) client.deleteItem(NAMESPACE, filesKey, id);
      client.deleteState(NAMESPACE, filesKey);
      client.deleteState(NAMESPACE, runKey);
      return keys.length;
    },
  };
}
