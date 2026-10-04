# dispatchers/

Framework for autonomous LLM task dispatchers that read Markdown task files and spawn gateway sessions to execute them. This is the mechanism behind daily briefings, social media content generation, and other standing-order operations.

## Scripts

| Script | Description |
| --- | --- |
| `daily-digest.ts` | Reads `{CONTENT_DIR}/digest/TASK.md` and dispatches a gateway session to generate and publish a daily digest. Injects authoritative date context. The script posts to the optional `slack.digestChannel` / `slack.operatorDm` refs. Prerequisite: TASK.md must exist. |
| `social-posts.ts` | Dynamically builds a task from pipeline-config refs and content paths, then dispatches a session to generate social media posts to a Notion database. The script posts the worker's summaries to Slack. Prerequisite: `notion.socialPostsDatabaseId`, `slack.socialChannel`, `slack.operatorDm` refs (Slack IDs) in pipeline-config. |

## Activation

Dispatchers are **not** included in the `jobs/` manifests. They are registered as runner jobs manually per instance, because each instance's dispatcher configuration (task content, schedule, channels) is unique.

To activate a dispatcher:

1. Ensure prerequisites are met (see each script's module-level JSDoc)
2. For static dispatchers (`daily-digest`): create the TASK.md file with your standing orders
3. For dynamic dispatchers (`social-posts`): populate the required `pipeline-config.json` refs
4. Register as a runner job: `runner_create_job({ id: 'generate-daily-digest', script: 'src/dispatchers/daily-digest.ts', schedule: { freq: 'daily', byhour: 6 }, ... })`

## Slack: the job script does it, not the worker

On OpenClaw 2026.9, sub-agent sessions (runner LLM workers) have **no `message` tool**, so a worker cannot read or post Slack. Every dispatcher that needs Slack uses `dispatchWithSlack` (`../lib/worker-slack/`):

1. **Reads:** before dispatch, the script reads the configured channels/threads through the gateway `message` tool and appends them to the TASK under "Slack context".
2. **Posts:** the TASK ends with the output contract. The worker returns its intended posts in one fenced `slack-posts` block (JSON array of `{channel, text, thread_ts?, pin?, edit_ts?}`, `[]` for none; `edit_ts` replaces an existing message's text). The script validates the whole block, checking every target against the job's allowlist and every operation against that target's permissions (`editTs`: the exact message ids it may edit; `pin: true`: it may pin), then posts (and pins / edits) them itself. An invalid block, a disallowed target, or an edit/pin the target does not permit posts nothing and fails the job. The Slack config itself is validated with a Zod schema (`worker-slack-config.ts`) before any gateway call, and a read whose response lacks a valid `messages` array fails the job instead of being treated as an empty channel.
3. **Flags:** `--dry-run` dispatches but prints the posts instead of posting. `--print-task` reads Slack, prints the full TASK and stops without dispatching.

Pass `accountId` in the Slack config when the gateway has several Slack accounts (e.g. `vc`). TASK text must never tell the worker to use the message tool; describe _what_ to post and _where_ (by purpose) and let the contract do the rest. Targets are Slack IDs (`C…`, `G…`, `D…`, `U…`), never `#names`.

```typescript
await dispatchWithSlack(
  task,
  { jobId: 'my-job', thinking: 'low', timeout: 600 },
  {
    reads: [{ target: 'C000EXAMPLE1', label: '#ops-ceo', limit: 30 }],
    posts: [
      {
        target: 'C000EXAMPLE1',
        purpose: "today's agenda (pin it), plus the quick-links edit",
        pin: true,
        editTs: ['1789000000.000100'], // the pinned quick-links message only
      },
    ],
  },
);
```

## Creating a New Dispatcher

### Static Task Dispatcher (reads a TASK.md file)

Pattern from `daily-digest.ts` — read a standing-order Markdown file and dispatch it:

```typescript
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';

import { CONTENT_DIR } from '../lib/constants.js';
import { dispatchWithSlack } from '../lib/worker-slack/run.js';

const taskFile = path.join(CONTENT_DIR, 'my-domain/TASK.md');

runScript('dispatchers/my-dispatcher', async () => {
  if (!fs.existsSync(taskFile)) {
    console.log(`[skip] Not configured — create ${taskFile}`);
    return;
  }

  const task = fs.readFileSync(taskFile, 'utf8');

  await dispatchWithSlack(
    task,
    { jobId: 'my-dispatcher-job', thinking: 'low' },
    { posts: [{ target: 'C0123456789', purpose: 'the result summary' }] },
  );
});
```

### Dynamic Task Dispatcher (builds task at runtime)

Pattern from `social-posts.ts` — build task text from pipeline-config refs:

```typescript
import { runScript } from '@karmaniverous/jeeves';

import { tryGetRef } from '../lib/pipeline-config.js';
import { dispatchWithSlack } from '../lib/worker-slack/run.js';

runScript('dispatchers/my-dispatcher', async () => {
  const channel = tryGetRef('slack.myChannel');
  if (!channel) {
    console.log(
      '[skip] Not configured — set slack.myChannel in pipeline-config.json',
    );
    return;
  }

  const task = 'Do the work, then return a results summary as a Slack post.';

  await dispatchWithSlack(
    task,
    { jobId: 'my-job', thinking: 'low' },
    { posts: [{ target: channel, purpose: 'the results summary' }] },
  );
});
```

### Date Context Injection

When a dispatcher needs an authoritative date reference (e.g. daily digests), inject it as a quoted block at the top of the task:

```typescript
const tz = 'UTC';
const now = new Date();
const dayName = now.toLocaleDateString('en-US', {
  weekday: 'long',
  timeZone: tz,
});
const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz });
task =
  `> **Today is ${dayName}, ${dateStr} (${tz}).** Use this as the authoritative date reference.\n\n` +
  task;
```

## TASK File Anatomy

A TASK file is a Markdown document containing standing orders for an LLM session. It defines:

- **What to do** — the goal of the session (generate a digest, write social posts, etc.)
- **Data sources** — which files/directories/APIs to read
- **Output destinations** — where to write results (Notion, Slack, filesystem)
- **Rules and constraints** — content guidelines, formatting requirements, routing instructions

Example location: `{CONTENT_DIR}/digest/TASK.md`

## Prerequisites

- Gateway API accessible (`GATEWAY_HOST`, `GATEWAY_PORT`)
- `SPAWN_WORKER_PATH` pointing to `spawn-worker.ts`
- Per-dispatcher prerequisites documented in each script's module-level JSDoc

## Key Files

| File | Purpose |
| --- | --- |
| `../lib/constants.ts` | Provides `CONTENT_DIR`, `SPAWN_WORKER_PATH` |
| `../lib/pipeline-config.ts` | Provides `getRef()` / `tryGetRef()` for external service IDs |
| `../lib/spawn-worker.ts` | Gateway session spawner invoked by `dispatchSession()` |
| `../lib/worker-slack/` | Job-side Slack I/O for workers: reads, `slack-posts` contract, posting |
