/**
 * @module email-state
 *
 * Read and write per-thread and per-account scalar state in the
 * jeeves-runner SQLite store.
 *
 * Used by poll, email-fetch, and backfill scripts to track which threads
 * have been seen, their classification fields, and last-poll timestamps.
 * State is keyed by account + threadId under the `email` namespace.
 *
 * Requires a running jeeves-runner client. State keys use the
 * `.seenThreadIds` suffix convention for thread-level items.
 */

import { nowIso } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';

export interface ThreadState {
  seenAt?: string;
  date?: string;
  messageCount?: number;
  labels?: string[];
  lastInternalDateMs?: number | null;
  seenMessageIds?: Record<string, string>;
  fetchedAt?: string;
  receiptCandidate?: boolean;
  junkCandidate?: boolean;
  bucket?: string | null;
  labelApplied?: Record<string, string>;
}

/**
 * Runner store operations used for per-thread state and the email
 * queues. Narrower than RunnerClient so tests can supply a typed fake.
 */
export type EmailStoreClient = Pick<
  RunnerClient,
  'getState' | 'setState' | 'getItem' | 'setItem' | 'enqueue'
>;

const SEEN_KEY_PREFIX = '.seenThreadIds';

/** Build the SQLite item-group key for an account's seen-thread map. */
export function seenKey(account: string): string {
  return account + SEEN_KEY_PREFIX;
}

/** Load per-account scalar state (last-poll timestamp) from SQLite. */
export function loadScalarState(
  account: string,
  client: Pick<RunnerClient, 'getState'>,
): { account: string; updatedAt: string | null } {
  const stateJson = client.getState('email', account + '.state');
  return stateJson
    ? (JSON.parse(stateJson) as {
        account: string;
        updatedAt: string | null;
      })
    : { account, updatedAt: null };
}

/** Persist per-account scalar state with an updated timestamp. */
export function saveScalarState(
  state: { account: string; updatedAt: string | null },
  client: Pick<RunnerClient, 'setState'>,
): void {
  state.updatedAt = nowIso();
  client.setState('email', state.account + '.state', JSON.stringify(state));
}

/** Read a thread's classification/seen state from SQLite, or null. */
export function getThreadState(
  client: Pick<RunnerClient, 'getItem'>,
  account: string,
  threadId: string,
): ThreadState | null {
  const json = client.getItem('email', seenKey(account), threadId);
  if (!json) return null;
  const obj = JSON.parse(json) as ThreadState;
  return obj;
}

/** Write a thread's classification/seen state to SQLite. */
export function setThreadState(
  client: Pick<RunnerClient, 'setItem'>,
  account: string,
  threadId: string,
  value: ThreadState,
): void {
  client.setItem('email', seenKey(account), threadId, JSON.stringify(value));
}
