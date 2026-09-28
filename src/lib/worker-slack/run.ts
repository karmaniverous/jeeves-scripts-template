/**
 * @module worker-slack/run
 *
 * Production wiring for {@link runWorkerSlackJob}: dispatches through
 * jeeves-runner's dispatchSession + spawn-worker.ts, reads the worker's
 * final reply back via sessions_history, and does Slack I/O through the
 * gateway `message` tool.
 *
 * Flags (from process.argv):
 * - `--dry-run`: dispatch, but print the worker's posts instead of posting;
 * - `--print-task`: read Slack, print the full TASK, and stop (no dispatch).
 *
 * Config dependencies: SPAWN_WORKER_PATH (constants.ts); gateway host/port
 * via gateway-client.ts.
 */

import {
  type DispatchOptions,
  dispatchSession,
} from '@karmaniverous/jeeves-runner';

import { SPAWN_WORKER_PATH } from '../constants.js';
import { gatewayInvoke } from '../gateway-client.js';
import { readWorkerFinalText } from '../worker-output.js';
import { gatewaySlackIo } from './slack-io.js';
import {
  runWorkerSlackJob,
  type WorkerSlackConfig,
  type WorkerSlackResult,
} from './worker-slack-job.js';

/**
 * Dispatch a worker with job-side Slack I/O.
 *
 * @param task - Base TASK text.
 * @param options - Runner dispatch options (jobId, thinking, timeout, …).
 * @param slack - Reads and allowed post targets.
 * @param argv - Process arguments (flags).
 * @returns The run result.
 */
export async function dispatchWithSlack(
  task: string,
  options: DispatchOptions,
  slack: WorkerSlackConfig,
  argv: readonly string[] = process.argv,
): Promise<WorkerSlackResult> {
  return runWorkerSlackJob(task, slack, {
    slack: gatewaySlackIo(gatewayInvoke, slack.accountId),
    dryRun: argv.includes('--dry-run'),
    printTask: argv.includes('--print-task'),
    dispatch: async (fullTask) => {
      const { exitCode, stdout } = await dispatchSession(
        fullTask,
        options,
        SPAWN_WORKER_PATH,
      );
      const finalText =
        exitCode === 0
          ? await readWorkerFinalText(stdout, gatewayInvoke)
          : null;
      return { exitCode, finalText };
    },
  });
}
