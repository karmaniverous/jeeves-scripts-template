/**
 * @module google-drive/lib/fake-runner.test-helper
 *
 * In-memory stand-in for the runner state API the sync uses. Mirrors the
 * runner's foreign key: deleting a state row with items still present
 * throws, so reset ordering is exercised.
 */

import type { RunnerClient } from '@karmaniverous/jeeves-runner';

export interface FakeRunner {
  client: RunnerClient;
  state: Map<string, string | null>;
  items: Map<string, Map<string, string>>;
}

export function fakeRunner(): FakeRunner {
  const state = new Map<string, string | null>();
  const items = new Map<string, Map<string, string>>();
  const k = (ns: string, key: string): string => `${ns}|${key}`;
  const bucket = (ns: string, key: string): Map<string, string> => {
    let b = items.get(k(ns, key));
    if (!b) {
      b = new Map();
      items.set(k(ns, key), b);
    }
    return b;
  };
  const client = {
    getState: (ns: string, key: string) => state.get(k(ns, key)) ?? null,
    setState: (ns: string, key: string, value: string) => {
      state.set(k(ns, key), value);
    },
    deleteState: (ns: string, key: string) => {
      if ((items.get(k(ns, key))?.size ?? 0) > 0) {
        throw new Error('FOREIGN KEY constraint failed');
      }
      state.delete(k(ns, key));
    },
    getItem: (ns: string, key: string, item: string) =>
      items.get(k(ns, key))?.get(item) ?? null,
    setItem: (ns: string, key: string, item: string, value?: string) => {
      if (!state.has(k(ns, key))) state.set(k(ns, key), null);
      bucket(ns, key).set(item, value ?? '');
    },
    deleteItem: (ns: string, key: string, item: string) => {
      items.get(k(ns, key))?.delete(item);
    },
    listItemKeys: (ns: string, key: string) => [
      ...(items.get(k(ns, key))?.keys() ?? []),
    ],
  };
  return { client: client as unknown as RunnerClient, state, items };
}
