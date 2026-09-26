# jeeves-scripts

TypeScript scripts for [jeeves-runner](https://github.com/karmaniverous/jeeves-runner). Each script is a standalone `.ts` file executed by the runner on a schedule, via queue drain, or manually via `tsx`.

## Relationship to jeeves-runner

The runner is a scheduler + state manager. It:

- Executes scripts on cron-like schedules (defined in `jobs/*.json` manifests)
- Provides persistent state (`getState`/`setState`), dedup collections (`getItem`/`setItem`), and work queues (`enqueue`/`dequeue`)
- Manages overlap policies, timeouts, and failure alerting

Scripts connect to the runner via `getRunnerClient()`, which reads the `JR_DB_PATH` env var set by the runner executor.

## First Steps

1. **Edit `src/lib/constants.ts`** — this is the one file to configure on a new instance. Fill in paths, credentials, and integration-specific values.
2. **Run `npm install`**
3. **Register runner jobs** — On managed instances, `jeeves-tools deploy` auto-registers core jobs (prerequisite: null) and syncs all job definitions via `npx jeeves-runner sync-jobs`. On standalone instances, read `jobs/*.json` manifests and register via the runner API or onboarding skill.

### Runner Configuration

The runner needs a tsx runner for `.ts` files:

```jsonc
{
  "runners": {
    "ts": "node {scriptsDir}/node_modules/tsx/dist/cli.mjs",
  },
}
```

## Repo Structure

Runner job manifests live in `jobs/` (one JSON file per domain). Scripts are organized by domain under `src/`:

| Domain | Description | README |
| --- | --- | --- |
| `admin/` | Token metrics, session refresh, maintenance | [README](src/admin/README.md) |
| `calendar/` | Google Calendar event polling | [README](src/calendar/README.md) |
| `convert/` | DOCX/PDF → Markdown conversion | [README](src/convert/README.md) |
| `core/` | Housekeeping (orphaned file cleanup) | [README](src/core/README.md) |
| `dispatchers/` | LLM session dispatch framework | [README](src/dispatchers/README.md) |
| `email/` | Gmail polling, download, triage, classification | [README](src/email/README.md) |
| `github/` | Repo sync, issue sync, notifications, collaborator management | [README](src/github/README.md) |
| `jira/` | Jira webhook drain, backfill, field metadata refresh | [README](src/jira/README.md) |
| `linear/` | Linear webhook drain, polling sync, backfill | [README](src/linear/README.md) |
| `lib/` | Shared infrastructure (constants, entity persistence, silo routing, CLI wrappers) | [README](src/lib/README.md) |
| `meetings/` | Meeting extraction (Google Meet, Fathom, Notion) | [README](src/meetings/README.md) |
| `meta/` | Entity lifecycle maintenance | [README](src/meta/README.md) |
| `slack/` | Slack message polling | [README](src/slack/README.md) |
| `x/` | X/Twitter: polling, posting, engagement | [README](src/x/README.md) |

Instance-specific directories (`vc/`, `tp/`) are not part of the template.

## Writing a Script

Every entry-point script wraps its logic in `runScript()` and uses `getRunnerClient()` for state:

```typescript
import { runScript } from '@karmaniverous/jeeves';
import { getRunnerClient } from '@karmaniverous/jeeves-runner';

runScript('domain/my-script', () => {
  const client = getRunnerClient();
  try {
    // Use client.getState / setState for persistent key-value state
    // Use client.enqueue / dequeue for work queues
    // Use client.getItem / setItem for dedup collections
  } finally {
    client.close();
  }
});
```

Scripts that write pipeline output to multi-tenant silos should resolve paths via `silo-router.ts`:

```typescript
import { getBasePathForEmailDomain } from '../lib/silo-router.js';

const basePath = getBasePathForEmailDomain(domain); // returns silo path or default
const outputDir = path.join(basePath, 'email');
```

Single-tenant instances don't need silo routing — all paths resolve to `CONTENT_DIR`.

Scripts that need LLM sessions use the dispatcher pattern:

```typescript
import { runDispatcher } from '@karmaniverous/jeeves-runner';
import { SPAWN_WORKER_PATH } from '../lib/constants.js';

runScript('domain/my-dispatcher', () => {
  runDispatcher(
    task,
    { jobId: 'my-dispatcher', thinking: 'low' },
    SPAWN_WORKER_PATH,
  );
});
```

For file-based task dispatchers, see the `daily-digest.ts` example in `dispatchers/README.md`.

### Prerequisite Guard

Every entry-point script should check its required constants before doing work:

```typescript
runScript('x/poll-posts', () => {
  if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
    console.log('[skip] X API credentials not configured');
    return;
  }
  // ... actual work
});
```

This makes it safe to register a runner job before its prerequisites are configured.

## Entity Pipeline Pattern

Scripts feed into the Jeeves entity pipeline lifecycle:

1. **Ingest** — Scripts poll external sources (Gmail, Calendar, Slack, GitHub, X) and pull raw data into the content directory.
2. **Extract** — Scripts parse ingested data and write structured entities (e.g. `meetings/{id}/meeting.json`). Each extractor is independent.
3. **Store** — The content filesystem is the store. Entities are files in directories.
4. **Discover & Synthesize** — jeeves-meta discovers new entities via `autoSeed` rules and synthesizes metadata.
5. **Merge** — Runner jobs (sweep-duplicates) act on meta cross-ref findings to merge duplicates.

### Adding a New Source to an Existing Entity Type

Write another extractor that produces files matching the same glob pattern. The existing `autoSeed` rule in meta config already covers it.

### Adding a New Entity Type

1. Write extractors that produce files in a new directory structure
2. Add an `autoSeed` entry in meta config with the glob and steer prompt
3. Add an entry to `ENTITY_TYPES` in `constants.ts` for sweep/disable support
4. Create a `jobs/{domain}.json` manifest for the new scripts

The `meetings/` domain is the exemplar: three independent extractors (Google Meet, Fathom, Notion) writing to a shared entity store.

## Quality Gates

This repo uses the [STAN](https://github.com/karmaniverous/stan) toolchain (ESLint, Prettier, TypeScript, Vitest, Knip, Lefthook).

| Gate      | Command             | What it checks                  |
| --------- | ------------------- | ------------------------------- |
| Typecheck | `npm run typecheck` | TypeScript strict mode          |
| Lint      | `npm run lint`      | ESLint + Prettier               |
| Test      | `npm run test`      | Vitest test suite               |
| Knip      | `npm run knip`      | Unused exports and dependencies |

Run all four before committing: `npm run typecheck && npm run lint && npm test && npm run knip`

## Assistant Instructions

> Rules for LLM coding assistants working in this repo.

1. **Use `runScript()` wrapper** for every entry point. Never call `main()` directly.
2. **Use `getRunnerClient()`** for state/queue access. Always close in a `finally` block.
3. **Import from packages**, not local wrappers. Use `@karmaniverous/jeeves` and `@karmaniverous/jeeves-runner`.
4. **Add shared logic to `src/lib/`** or `src/{domain}/lib/`. Keep entry points thin.
5. **Write tests for lib modules**, not entry points. Co-locate test files (`.test.ts`).
6. **All files under 300 LOC.** Extract a module if a file grows beyond this.
7. **Run quality gates before committing.** Zero errors, zero warnings.
8. **No `eslint-disable` comments.** Fix the code.
9. **Organize by domain.** New scripts go in `src/{domain}/`, shared utilities in `src/lib/`.
10. **Update `constants.ts`** when adding paths or config values. Never hardcode instance-specific values in scripts.
11. **Use the dispatcher pattern** for scripts that need LLM sessions.
12. **Add `@module` JSDoc** to every new file per the inline comment standard (spec §9).
13. **Add prerequisite guards** to entry points that depend on optional integrations.
