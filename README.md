# jeeves-runner-scripts

TypeScript runner scripts for [jeeves-runner](https://github.com/karmaniverous/jeeves-runner). This repo provides a structured home for your scheduled jobs: shared infrastructure in `src/lib/`, domain scripts organized by folder, and a full quality-gate pipeline.

## Setup

```bash
npm install
```

Then register this repo in your jeeves-runner config under the `runners` map so the runner knows where to find your scripts:

```jsonc
{
  "runners": {
    "scripts": {
      "root": "/path/to/this/repo",
      "command": "npx tsx"
    }
  }
}
```

## Repo Structure

```text
src/
  lib/            Shared infrastructure (constants, runner client, shell, fs utils)
  example/        Sample script — delete when you start building
  {domain}/       Your scripts, organized by domain (e.g. github/, email/, slack/)
```

- **`src/lib/`** — Generic, reusable modules. The runner client factory, crash-handler wrapper, shell execution helpers, and filesystem utilities live here. Add shared logic here when multiple scripts need it.
- **`src/{domain}/`** — Scripts grouped by domain. Each script is a standalone entry point executed directly via `tsx`.
- **`src/example/hello.ts`** — A minimal working script demonstrating the standard pattern. Delete it once you've written your first real script.

## Writing a Script

Every script follows the same pattern:

```typescript
import { runScript } from '../lib/run-script.js';
import { getRunnerClient } from '../lib/runner-client.js';

runScript('my-script', async () => {
  const client = getRunnerClient();

  // Use client.getState / client.setState for persistent key-value state.
  // Use client.enqueue / client.claim for work queues.

  // ... your logic here ...

  client.close();
});
```

- **`runScript()`** wraps your logic in a crash handler that logs failures and exits with code 1.
- **`getRunnerClient()`** creates a typed client connected to the runner's SQLite database. Honors the `JR_DB_PATH` env var for test overrides.

## Quality Gates

| Gate | Command | What it checks |
|------|---------|----------------|
| Typecheck | `npm run typecheck` | TypeScript strict mode, no emit |
| Lint | `npm run lint` | ESLint strict + Prettier formatting |
| Test | `npm run test` | Vitest test suite |
| Knip | `npm run knip` | Unused exports and dependencies |
| **STAN** | `npx stan run --sequential --no-archive` | Runs all of the above in sequence |

Run STAN before committing to catch all issues in one pass.

## Runner Integration

The runner spawns scripts as child processes using the configured command (typically `npx tsx`). Each job definition in jeeves-runner points to a script path relative to the runner root:

```jsonc
{
  "id": "my-job",
  "name": "My Scheduled Job",
  "schedule": "every 1h",
  "script": "src/my-domain/my-script.ts",
  "source_type": "path"
}
```

The runner provides:

- **State API** — persistent key-value storage scoped by namespace
- **Queue API** — FIFO work queues with claim/complete/fail semantics
- **Scheduling** — cron expressions or human-readable intervals

Scripts access these through the runner client created by `getRunnerClient()`.

## Assistant Instructions

> This section is for LLM coding assistants working in this repo.

When asked to create a new runner script:

1. **Use `runScript()` wrapper** for every script entry point. This provides crash handling and structured logging.
2. **Use `getRunnerClient()`** for state and queue access. Never construct the client manually.
3. **Add shared logic to `src/lib/`**, keep script entry points thin. A script should orchestrate; utilities should do the work.
4. **Write tests for lib modules**, not for script entry points. Lib modules are pure-ish functions; scripts are side-effectful orchestrators.
5. **All files under 300 LOC.** If a file is getting long, extract a module.
6. **Run STAN before committing:** `npx stan run --sequential --no-archive`. Zero errors AND zero warnings.
7. **No `eslint-disable` comments.** Fix the code, don't suppress the warning.
8. **Organize by domain.** New scripts go in `src/{domain}/`, not in the root `src/` directory.
9. **Update `src/lib/constants.ts`** when adding deployment-specific paths or config values. Keep them centralized.
