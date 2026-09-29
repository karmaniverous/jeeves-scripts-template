/**
 * Tests for the production adapter (run.ts): flags are forwarded, the full
 * TASK is dispatched through dispatchSession + spawn-worker, the final
 * reply is read back via readWorkerFinalText, and failures propagate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchSession: vi.fn(),
  readWorkerFinalText: vi.fn(),
  gatewaySlackIo: vi.fn(),
  runWorkerSlackJob:
    vi.fn<
      (task: string, slack: unknown, deps: WorkerSlackDeps) => Promise<unknown>
    >(),
  gatewayInvoke: vi.fn(),
}));

vi.mock('@karmaniverous/jeeves-runner', () => ({
  dispatchSession: mocks.dispatchSession,
}));
vi.mock('../worker-output.js', () => ({
  readWorkerFinalText: mocks.readWorkerFinalText,
}));
vi.mock('../gateway-client.js', () => ({
  gatewayInvoke: mocks.gatewayInvoke,
}));
vi.mock('./slack-io.js', () => ({ gatewaySlackIo: mocks.gatewaySlackIo }));
vi.mock('./worker-slack-job.js', () => ({
  runWorkerSlackJob: mocks.runWorkerSlackJob,
}));

import { SPAWN_WORKER_PATH } from '../constants.js';
import { dispatchWithSlack } from './run.js';
import type { WorkerSlackDeps } from './worker-slack-job.js';

const OPTIONS = { jobId: 'vc-ops-ceo-agenda' };
const SLACK = { accountId: 'vc', posts: [] };
const FAKE_IO = { read: vi.fn(), send: vi.fn(), pin: vi.fn(), edit: vi.fn() };

/** Run the adapter and return the deps it handed to runWorkerSlackJob. */
async function depsFor(argv: string[]): Promise<WorkerSlackDeps> {
  await dispatchWithSlack('Base task', OPTIONS, SLACK, argv);
  const call = mocks.runWorkerSlackJob.mock.calls.at(-1);
  if (!call) throw new Error('runWorkerSlackJob not called');
  expect(call[0]).toBe('Base task');
  expect(call[1]).toEqual(SLACK);
  return call[2];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gatewaySlackIo.mockReturnValue(FAKE_IO);
  mocks.runWorkerSlackJob.mockResolvedValue({
    task: 't',
    posts: [],
    posted: 0,
  });
});

describe('dispatchWithSlack', () => {
  it('wires the gateway Slack layer for the account and forwards flags', async () => {
    const deps = await depsFor(['node', 'job.ts', '--dry-run', '--print-task']);
    expect(mocks.gatewaySlackIo).toHaveBeenCalledWith(
      mocks.gatewayInvoke,
      'vc',
    );
    expect(deps.slack).toBe(FAKE_IO);
    expect(deps.dryRun).toBe(true);
    expect(deps.printTask).toBe(true);

    const plain = await depsFor(['node', 'job.ts']);
    expect(plain.dryRun).toBe(false);
    expect(plain.printTask).toBe(false);
  });

  it('dispatches the full TASK and reads the final reply back', async () => {
    mocks.dispatchSession.mockResolvedValue({
      exitCode: 0,
      stdout: 'WORKER_RESULT:{}',
    });
    mocks.readWorkerFinalText.mockResolvedValue('final reply');
    const deps = await depsFor([]);

    await expect(deps.dispatch('FULL TASK')).resolves.toEqual({
      exitCode: 0,
      finalText: 'final reply',
    });
    expect(mocks.dispatchSession).toHaveBeenCalledWith(
      'FULL TASK',
      OPTIONS,
      SPAWN_WORKER_PATH,
    );
    expect(mocks.readWorkerFinalText).toHaveBeenCalledWith(
      'WORKER_RESULT:{}',
      mocks.gatewayInvoke,
    );
  });

  it('returns no final text for a failed worker and skips the read', async () => {
    mocks.dispatchSession.mockResolvedValue({ exitCode: 1, stdout: '' });
    const deps = await depsFor([]);

    await expect(deps.dispatch('T')).resolves.toEqual({
      exitCode: 1,
      finalText: null,
    });
    expect(mocks.readWorkerFinalText).not.toHaveBeenCalled();
  });

  it('propagates dispatch and reply-read failures', async () => {
    const deps = await depsFor([]);
    mocks.dispatchSession.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(deps.dispatch('T')).rejects.toThrow('spawn failed');

    mocks.dispatchSession.mockResolvedValueOnce({ exitCode: 0, stdout: 'x' });
    mocks.readWorkerFinalText.mockRejectedValueOnce(new Error('no history'));
    await expect(deps.dispatch('T')).rejects.toThrow('no history');
  });

  it.each([
    ['a bad account id', { accountId: 'vc; rm -rf', posts: [] }],
    [
      'a zero read limit',
      { reads: [{ target: 'C0B2Z734KSP', label: 'x', limit: 0 }] },
    ],
    ['a channel name target', { posts: [{ target: '#ops', purpose: 'p' }] }],
  ])('rejects %s before any gateway call', async (_name, slack) => {
    await expect(dispatchWithSlack('T', OPTIONS, slack, [])).rejects.toThrow(
      /Invalid worker-slack config/,
    );
    expect(mocks.gatewaySlackIo).not.toHaveBeenCalled();
    expect(mocks.runWorkerSlackJob).not.toHaveBeenCalled();
    expect(mocks.dispatchSession).not.toHaveBeenCalled();
  });

  it('propagates a failing job run', async () => {
    mocks.runWorkerSlackJob.mockRejectedValueOnce(new Error('bad posts'));
    await expect(dispatchWithSlack('T', OPTIONS, SLACK, [])).rejects.toThrow(
      'bad posts',
    );
  });
});
