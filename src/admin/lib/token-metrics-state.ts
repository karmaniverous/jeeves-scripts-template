/**
 * @module token-metrics-state
 *
 * Runner-state access for the token-metrics namespace (cursor JSON by
 * key), as a small port so collect/regenerate orchestration can be tested
 * with an in-memory fake.
 */

import { getRunnerClient } from '@karmaniverous/jeeves-runner';

import { TOKEN_METRICS_NAMESPACE } from '../../lib/constants.js';

/** Token-metrics runner state (namespace fixed). */
export interface TokenMetricsState {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  close: () => void;
}

/** Open the runner client for the token-metrics namespace. */
export function openTokenMetricsState(): TokenMetricsState {
  const client = getRunnerClient();
  return {
    get: (key) => client.getState(TOKEN_METRICS_NAMESPACE, key),
    set: (key, value) => {
      client.setState(TOKEN_METRICS_NAMESPACE, key, value);
    },
    close: () => {
      client.close();
    },
  };
}
