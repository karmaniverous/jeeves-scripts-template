/**
 * @module admin/lib/refresh-rates-dispatch
 *
 * Dispatch the refresh-token-rates worker and read back its final reply.
 *
 * The reply is read with `chat.history`, a gateway **RPC method**, so it
 * must go through {@link gatewayRpc}. The HTTP tools-invoke transport
 * (`gatewayInvoke`) has the same call signature but rejects `chat.history`
 * ("Tool not available"), and TypeScript can't tell them apart, which is
 * how #92 happened. The default transport is fixed here and tested.
 */

import { dispatchSession } from '@karmaniverous/jeeves-runner';

import { SPAWN_WORKER_PATH } from '../../lib/constants.js';
import { gatewayRpc } from '../../lib/gateway-rpc.js';
import { readWorkerFinalText } from '../../lib/worker-output.js';
import type { WorkerRun } from './refresh-rates-run.js';

/** Runner dispatch options for the refresh worker. */
export const REFRESH_DISPATCH_OPTIONS = {
  jobId: 'refresh-token-rates',
  thinking: 'low',
} as const;

/** Injectable collaborators (tests). */
export interface RefreshDispatchDeps {
  dispatch: typeof dispatchSession;
  rpc: typeof gatewayRpc;
}

/** Production collaborators: runner dispatch and the gateway RPC transport. */
export const defaultRefreshDispatchDeps: RefreshDispatchDeps = {
  dispatch: dispatchSession,
  rpc: gatewayRpc,
};

/**
 * Dispatch the worker with `task`; on success read its final reply via
 * gateway RPC. A failed dispatch returns `finalText: null`.
 */
export async function dispatchRefreshWorker(
  task: string,
  deps: RefreshDispatchDeps = defaultRefreshDispatchDeps,
): Promise<WorkerRun> {
  const { exitCode, stdout } = await deps.dispatch(
    task,
    REFRESH_DISPATCH_OPTIONS,
    SPAWN_WORKER_PATH,
  );
  const finalText =
    exitCode === 0 ? await readWorkerFinalText(stdout, deps.rpc) : null;
  return { exitCode, finalText };
}
