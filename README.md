# jeeves-scripts

TypeScript scripts for [jeeves-runner](https://github.com/karmaniverous/jeeves-runner). Each script is a standalone `.ts` file executed by the runner on a schedule, via queue drain, or manually via `tsx`.

## Relationship to jeeves-runner

The runner is a scheduler + state manager. It:

- Executes scripts on cron-like schedules (defined in `jobs/*.json` manifests)
- Provides persistent state (`getState`/`setState`), dedup collections (`getItem`/`setItem`), and work queues (`enqueue`/`dequeue`)
- Manages overlap policies, timeouts, and failure alerting

Scripts connect to the runner via `getRunnerClient()`, which reads the `JR_DB_PATH` env var set by the runner executor.

## First Steps

1. **Edit the constants modules under `src/lib/constants/`** (re-exported by the `src/lib/constants.ts` barrel) — this is the one place to configure on a new instance. Fill in paths, credentials, and integration-specific values.
2. **Run `npm install`**
3. **Create `pipeline-config.json`** from `pipeline-config.json.template` (see [Configuration Files](src/lib/README.md#configuration-files)). On jeeves-tools-managed instances, deploy seeds it.
4. **Register runner jobs** — see [Job Manifests](#job-manifests). On jeeves-tools-managed instances, deploy registers the manifest jobs whose `prerequisite` is `null` (see the `jeeves-scripts` skill); register the others yourself once their prerequisite is met. On standalone instances, register every job you need via the runner API.

### Runner Configuration

The runner needs a tsx runner for `.ts` files (standalone example; jeeves-tools renders this on managed instances):

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

Instance repos may add their own domain directories; those are not part of the template.

### Key Paths

On a jeeves-tools-managed instance the repo is checked out at `/opt/jeeves/jeeves-scripts` (`SCRIPTS_DIR`).

| Item | Path (relative to the repo root) |
| --- | --- |
| Constants barrel | `src/lib/constants.ts` (values in `src/lib/constants/`; see [lib/](src/lib/README.md#constantsts)) |
| Instance constants | `src/lib/constants/instance.ts` (`CONTENT_DIR`, `CREDENTIALS_DIR`, `PIPELINE_CONFIG_PATH`, gateway host and port) |
| Integration constants | `src/lib/constants/integrations.ts` (GitHub, Google/gog, Slack, X, Notion) |
| Pipeline config | `pipeline-config.json` (accounts, buckets, refs, emailConfig); gitignored, created from `pipeline-config.json.template` |
| IMAP password files | `/opt/jeeves/config/credentials/imap/<secretRef>` (`IMAP_SECRETS_DIR`, under `CREDENTIALS_DIR`) |
| Job manifests | `jobs/*.json` |
| Shared lib | `src/lib/` |
| Token rate card seed | `config/token-rates.seed.json` |

`pipeline-config.json` is gitignored: it is per-instance and never committed. It holds no secrets: an IMAP account's password is `{ "secretRef": "<name>" }`, and the poller reads it from `IMAP_SECRETS_DIR/<name>` when it connects. On jeeves-tools-managed instances those files are provisioned from the instance config's `secrets` map ([jeeves-tools#178](https://github.com/karmaniverous/jeeves-tools/issues/178)); on standalone instances write them by hand (owner jeeves, mode 0600). A literal `imap.password` string still works but is deprecated and logs a warning. See [IMAP passwords](src/email/README.md#imap-passwords).

## Running Scripts

Scripts are TypeScript run with `tsx`, from the repo root: `tsx src/<domain>/<script>.ts [args]`. Runner jobs use the same entry points. There is no build step and no compiled `.js` beside the sources, so `node` cannot import `./src/...js`; use `tsx` for one-off imports too, e.g. `tsx -e "import { dayOfWeek } from './src/lib/dates.ts'; console.log(dayOfWeek('2026-06-01'));"`.

## Job Manifests

Each `jobs/<domain>.json` is an array of job definitions:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description`, `domain` | Identity and documentation |
| `script` | Entry point, relative to the repo root (e.g. `src/email/poll.ts`) |
| `args` | Optional arguments passed to the script (e.g. `["--live"]`) |
| `schedule` | RRStack schedule: `{ "freq": "minutely", "interval": 11, "timezone": "UTC" }`, `{ "freq": "daily", "byhour": 5, "byminute": 37, "timezone": "UTC" }`, or `{ "timezone": "UTC", "rules": [...] }` |
| `overlap_policy`, `timeout_seconds`, `enabled` | Runner execution settings |
| `prerequisite` | `null` when the job needs nothing beyond the repo; otherwise a description of what must be configured first |

`admin`, `core` and `meta` jobs have `"prerequisite": null`; every `calendar`, `email`, `github`, `jira`, `linear`, `meetings`, `slack` and `x` job carries a prerequisite. The manifests are authoritative for job ids and schedules; each domain README lists its jobs. Dispatchers (`src/dispatchers/`) are not in the manifests: register them per instance (see [dispatchers/](src/dispatchers/README.md#activation)).

When registering a job by hand (e.g. `runner_create_job`), use the absolute script path (`/opt/jeeves/jeeves-scripts/src/...` on managed instances) and a schedule given as an RRStack JSON string like the manifests' or a cron expression.

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
runScript('github/build-registry', () => {
  if (!GH_ACCOUNT) {
    console.log('[skip] GH_ACCOUNT not configured in constants.ts');
    return;
  }
  // ... actual work
});
```

This makes it safe to register a runner job before its prerequisites are configured. The exception is a configured integration that cannot work: when gog accounts are configured but gog has no credentials, for example, the email and calendar scripts fail (non-zero exit) instead of skipping, so the problem is visible.

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

## Instance-Agnostic Template

This template is consumed by many Jeeves instances, each with its own scripts repo. It must never carry instance-specific data: owner or customer email addresses, Slack IDs, instance hosts, local drive or home paths, links to a particular instance's scripts repo, or hard-coded per-instance defaults (accounts, date windows). Per-instance values come from the instance's own config (`pipeline-config.json`, job config, environment); when a value is missing, fail loudly rather than inventing a default.

`src/instance-agnostic.test.ts` enforces this as part of `npm test`. It scans tracked files and fails with `file:line: [rule] match` on non-reserved email domains (use `example.com`, `*.test`, etc.), known instance identifiers, real-looking Slack IDs (use the `<kind>000EXAMPLE<n>` placeholders), absolute Windows or home paths, and `jeeves-scripts` repo links. The denylist and allowlists are exported constants at the top of that file. A per-line `instance-agnostic-allow: <reason>` marker exists for genuine exceptions; every use is pinned in the test, so keep them rare.

### Moving Changes Up to the Template

Each instance's scripts repo is a copy of this template (git remote `template`, `karmaniverous/jeeves-scripts-template`) plus its own customisations and config. Every other instance pulls the template, so a fix hoisted here must not carry anything of the instance it came from.

1. **Check the template first.** Before hoisting, look at the template's current `main`: the fix may already be there, or the code may have drifted from the instance's copy. Port onto the template's code, not the other way round.
2. **Instance-agnostic only.** No instance data: no real email addresses, people, customer or company names, Slack IDs, hostnames, or absolute local paths. Use reserved placeholders (`example.com`, `C000EXAMPLE1`, `Alex Example`).
3. **No defaults for per-instance settings.** Accounts, date windows, lookbacks, buckets, labels and forwarding targets come from the instance's own config (`pipeline-config.json`) or explicit arguments. A missing setting is a clear error, never a fallback to the originating instance's values.
4. **The guard enforces it.** `src/instance-agnostic.test.ts` fails the gates on instance data. When it flags something, replace it with a placeholder or config. When you find a new kind of instance data, extend the denylist (`INSTANCE_DENYLIST`) or the rules. Never weaken the guard, its allowlists or the escape hatch to get a change through.
5. **Template PR first, then the instance's own.** Open a branch and PR on the template and pass its gates. Then mirror the change into the instance's scripts repo as its own PR, keeping that repo's local customisations and config, and note any local adaptation in that PR.
6. **Other instances pull it themselves.** After the template PR merges, each instance pulls `template` into its own repo (merge, keeping its customisations) and sets its own config for any new setting; never set another instance's values for it.

## Quality Gates

Quality tooling: ESLint, Prettier, TypeScript, Vitest, Knip, Lefthook.

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
14. **Keep the template instance-agnostic.** See [Instance-Agnostic Template](#instance-agnostic-template); the guard test must pass.
