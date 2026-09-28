import { describe, expect, it, vi } from 'vitest';

import type { SlackIo } from './slack-io.js';
import {
  runWorkerSlackJob,
  type WorkerSlackConfig,
} from './worker-slack-job.js';

const CONFIG: WorkerSlackConfig = {
  reads: [{ target: 'C0B2Z734KSP', label: '#ops-ceo', limit: 10 }],
  posts: [{ target: 'C0B2Z734KSP', purpose: 'the agenda (pin it)' }],
};

const FENCE = '`'.repeat(3);
const reply = (posts: unknown) =>
  `Done.\n\n${FENCE}slack-posts\n${JSON.stringify(posts)}\n${FENCE}`;

function mockSlack(): SlackIo & {
  read: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  pin: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockResolvedValue([
      {
        ts: '1790590000.000100',
        user: 'U1',
        text: 'Add hiring to the agenda',
      },
    ]),
    send: vi.fn().mockResolvedValue('1790600000.000200'),
    pin: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

describe('runWorkerSlackJob', () => {
  it('reads Slack into the TASK, dispatches, posts and pins', async () => {
    const slack = mockSlack();
    const dispatch = vi.fn().mockResolvedValue({
      exitCode: 0,
      finalText: reply([
        { channel: 'C0B2Z734KSP', text: 'Agenda', pin: true },
        {
          channel: 'C0B2Z734KSP',
          thread_ts: '1790590000.000100',
          text: 'Added',
        },
      ]),
    });
    const print = vi.fn();

    const result = await runWorkerSlackJob('Build the agenda.', CONFIG, {
      slack,
      dispatch,
      print,
    });

    expect(slack.read).toHaveBeenCalledWith('channel:C0B2Z734KSP', {
      limit: 10,
      threadTs: undefined,
    });
    const task = dispatch.mock.calls[0][0] as string;
    expect(task.startsWith('Build the agenda.')).toBe(true);
    expect(task).toContain('U1: Add hiring to the agenda');
    expect(task).toContain('- channel:C0B2Z734KSP: the agenda (pin it)');
    expect(task).toMatch(/do not call the message tool/);

    expect(slack.send).toHaveBeenNthCalledWith(
      1,
      'channel:C0B2Z734KSP',
      'Agenda',
      undefined,
    );
    expect(slack.pin).toHaveBeenCalledWith(
      'channel:C0B2Z734KSP',
      '1790600000.000200',
    );
    expect(slack.send).toHaveBeenNthCalledWith(
      2,
      'channel:C0B2Z734KSP',
      'Added',
      '1790590000.000100',
    );
    expect(slack.pin).toHaveBeenCalledTimes(1);
    expect(result.posted).toBe(2);
  });

  it('edits an existing message when edit_ts is given', async () => {
    const slack = mockSlack();
    const result = await runWorkerSlackJob('T', CONFIG, {
      slack,
      print: vi.fn(),
      dispatch: vi.fn().mockResolvedValue({
        exitCode: 0,
        finalText: reply([
          {
            channel: 'C0B2Z734KSP',
            edit_ts: '1789000000.000100',
            text: 'Standing orders v2',
          },
        ]),
      }),
    });
    expect(slack.edit).toHaveBeenCalledWith(
      'channel:C0B2Z734KSP',
      '1789000000.000100',
      'Standing orders v2',
    );
    expect(slack.send).not.toHaveBeenCalled();
    expect(result.posted).toBe(1);
  });

  it('--print-task prints the TASK without dispatching or posting', async () => {
    const slack = mockSlack();
    const dispatch = vi.fn();
    const print = vi.fn();

    const result = await runWorkerSlackJob('T', CONFIG, {
      slack,
      dispatch,
      print,
      printTask: true,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(slack.send).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith(result.task);
  });

  it('--dry-run prints the posts instead of posting', async () => {
    const slack = mockSlack();
    const print = vi.fn();
    const result = await runWorkerSlackJob('T', CONFIG, {
      slack,
      dispatch: vi.fn().mockResolvedValue({
        exitCode: 0,
        finalText: reply([
          { channel: 'C0B2Z734KSP', text: 'Agenda', pin: true },
        ]),
      }),
      print,
      dryRun: true,
    });

    expect(slack.send).not.toHaveBeenCalled();
    expect(slack.pin).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith(
      '[slack dry-run] → channel:C0B2Z734KSP (pin)\nAgenda',
    );
    expect(result).toMatchObject({ posted: 0, posts: [{ text: 'Agenda' }] });
  });

  it('posts nothing when any target is not allowed', async () => {
    const slack = mockSlack();
    await expect(
      runWorkerSlackJob('T', CONFIG, {
        slack,
        print: vi.fn(),
        dispatch: vi.fn().mockResolvedValue({
          exitCode: 0,
          finalText: reply([
            { channel: 'C0B2Z734KSP', text: 'ok' },
            { channel: 'U0SOMEONE1', text: 'sneaky DM' },
          ]),
        }),
      }),
    ).rejects.toThrow(/not an allowed target/);
    expect(slack.send).not.toHaveBeenCalled();
  });

  it('fails when the worker returns no slack-posts block', async () => {
    await expect(
      runWorkerSlackJob('T', CONFIG, {
        slack: mockSlack(),
        print: vi.fn(),
        dispatch: vi.fn().mockResolvedValue({
          exitCode: 0,
          finalText: 'I had no Slack tool, sorry.',
        }),
      }),
    ).rejects.toThrow(/no `slack-posts` block/);
  });

  it('fails when the worker exits non-zero', async () => {
    await expect(
      runWorkerSlackJob('T', CONFIG, {
        slack: mockSlack(),
        print: vi.fn(),
        dispatch: vi.fn().mockResolvedValue({ exitCode: 1, finalText: null }),
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it('fails when a pin is requested but no ts comes back', async () => {
    const slack = mockSlack();
    slack.send.mockResolvedValue(undefined);
    await expect(
      runWorkerSlackJob('T', CONFIG, {
        slack,
        print: vi.fn(),
        dispatch: vi.fn().mockResolvedValue({
          exitCode: 0,
          finalText: reply([{ channel: 'C0B2Z734KSP', text: 'x', pin: true }]),
        }),
      }),
    ).rejects.toThrow(/no message ts to pin/);
  });

  it('rejects a misconfigured read target before dispatch', async () => {
    const dispatch = vi.fn();
    await expect(
      runWorkerSlackJob(
        'T',
        { reads: [{ target: '#ops-ceo', label: 'ops' }] },
        { slack: mockSlack(), dispatch, print: vi.fn() },
      ),
    ).rejects.toThrow(/Invalid Slack target/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('tells the worker it cannot post when no targets are configured', async () => {
    const print = vi.fn();
    const { task } = await runWorkerSlackJob(
      'T',
      {},
      { slack: mockSlack(), dispatch: vi.fn(), print, printTask: true },
    );
    expect(task).toMatch(/does not post to Slack/);
    expect(task).not.toContain('## Slack context');
  });
});
