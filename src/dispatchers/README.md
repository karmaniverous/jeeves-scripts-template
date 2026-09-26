# dispatchers/

Framework for autonomous LLM task dispatchers that read Markdown task files and spawn gateway sessions to execute them. This is the mechanism behind daily briefings, social media content generation, and other standing-order operations.

## Scripts

| Script | Description |
| --- | --- |
| `daily-digest.ts` | Reads `{CONTENT_DIR}/digest/TASK.md` and dispatches a gateway session to generate and publish a daily digest. Injects authoritative date context. Prerequisite: TASK.md must exist. |
| `social-posts.ts` | Dynamically builds a task from pipeline-config refs and content paths, then dispatches a session to generate social media posts to a Notion database. Prerequisite: `notion.socialPostsDatabaseId`, `slack.socialChannel`, `slack.operatorDm` refs in pipeline-config. |

## Activation

Dispatchers are **not** included in the `jobs/` manifests. They are registered as runner jobs manually per instance, because each instance's dispatcher configuration (task content, schedule, channels) is unique.

To activate a dispatcher:

1. Ensure prerequisites are met (see each script's module-level JSDoc)
2. For static dispatchers (`daily-digest`): create the TASK.md file with your standing orders
3. For dynamic dispatchers (`social-posts`): populate the required `pipeline-config.json` refs
4. Register as a runner job: `runner_create_job({ id: 'generate-daily-digest', script: 'src/dispatchers/daily-digest.ts', schedule: { freq: 'daily', byhour: 6 }, ... })`

## Creating a New Dispatcher

### Static Task Dispatcher (reads a TASK.md file)

Pattern from `daily-digest.ts` — read a standing-order Markdown file and dispatch it:

```typescript
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';
import { runDispatcher } from '@karmaniverous/jeeves-runner';

import { CONTENT_DIR, SPAWN_WORKER_PATH } from '../lib/constants.js';

const taskFile = path.join(CONTENT_DIR, 'my-domain/TASK.md');

runScript('dispatchers/my-dispatcher', () => {
  if (!fs.existsSync(taskFile)) {
    console.log(`[skip] Not configured — create ${taskFile}`);
    return;
  }

  const task = fs.readFileSync(taskFile, 'utf8');

  runDispatcher(
    task,
    { jobId: 'my-dispatcher-job', thinking: 'low' },
    SPAWN_WORKER_PATH,
  );
});
```

### Dynamic Task Dispatcher (builds task at runtime)

Pattern from `social-posts.ts` — build task text from pipeline-config refs:

```typescript
import { runScript } from '@karmaniverous/jeeves';
import { runDispatcher } from '@karmaniverous/jeeves-runner';

import { SPAWN_WORKER_PATH } from '../lib/constants.js';
import { tryGetRef } from '../lib/pipeline-config.js';

runScript('dispatchers/my-dispatcher', () => {
  const channel = tryGetRef('slack.myChannel');
  if (!channel) {
    console.log(
      '[skip] Not configured — set slack.myChannel in pipeline-config.json',
    );
    return;
  }

  const task = `Do the work. Post results to ${channel}.`;

  runDispatcher(task, { jobId: 'my-job', thinking: 'low' }, SPAWN_WORKER_PATH);
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
| `../lib/spawn-worker.ts` | Gateway session spawner invoked by `runDispatcher()` |
