# lib/

Shared infrastructure consumed by all domain scripts. This is where instance configuration, CLI wrappers, and cross-cutting utilities live.

## Modules

### constants.ts

**The first file to edit on a new instance.** Centralized paths, credentials, and integration-specific values used across all scripts. `constants.ts` is a barrel; the values live in cohesive modules under `constants/` (`instance.ts`, `integrations.ts`, `trackers.ts`, `token-metrics.ts`). Always import from the barrel.

Key exports:

- Directory paths: `JEEVES_BASE_DIR` (`/opt/jeeves`), `CONFIG_DIR` (`/opt/jeeves/config`), `CONTENT_DIR`, `SCRIPTS_DIR`, `CREDENTIALS_DIR`, `SESSIONS_DIR`, etc. On jeeves-tools-managed instances, `CONTENT_DIR` must be `/opt/jeeves/<contentDir>` (default `/opt/jeeves/content`), the root the watcher indexes and the server serves. The other `/opt/jeeves` paths in `constants/instance.ts` and `constants/integrations.ts` derive from `JEEVES_BASE_DIR` or `CONFIG_DIR`. Pipeline output written anywhere else is not indexed by the watcher or visible in jeeves-server. The template ships `/opt/jeeves/content`; repos created from an older template that used `/opt/jeeves/openclaw/content`, and instances whose config sets a different `contentDir`, must set `CONTENT_DIR` to their content root and commit it.
- Instance (`constants/instance.ts`): `INSTANCE_NAME`, `PIPELINE_CONFIG_PATH` (`<SCRIPTS_DIR>/pipeline-config.json`), `SILO_ROUTING_CONFIG_PATH` (`<CONFIG_DIR>/silo-routing.json`), `QDRANT_API_URL`, `QDRANT_SERVICE_NAME`
- GitHub: `GH_BIN`, `GH_CONFIG_DIR` (`<CONFIG_DIR>/gh-cli`), `GH_ACCOUNT`, `GH_BOT_USER` (both empty in the template; set per instance), `GITHUB_DIR`, `GITHUB_REGISTRY_PATH`
- Google: `GOG_BIN`, `GOG_CONFIG_DIR` (`GOG_HOME` if set, else `/opt/jeeves/config/gogcli`, where jeeves-tools provisions gog), `GOG_CLIENT_PATH` (OAuth client; service-account mailboxes are detected by `gog-credentials.ts` under `<GOG_CONFIG_DIR>/data/` first, then the `<GOG_CONFIG_DIR>` root for older gog builds without `data/`)
- Email: `EMAIL_EVENTS_DIR`, `IMAP_SECRETS_DIR` (`<CREDENTIALS_DIR>/imap`, IMAP password files named by `secretRef`)
- Slack: `PRIMARY_WORKSPACE`, `SLACK_DOMAIN_DIR`, `SLACK_WORKSPACE_CACHE_PATH`
- X/Twitter: `X_OAUTH_DIR` (`<CREDENTIALS_DIR>/oauth`), `X_ACCOUNTS` (map of account handle → that account's output directory; empty in the template)
- Notion: `NOTION_VERSION`, `NOTION_API_KEY_PATH`
- Meetings: `DEFAULT_MEETINGS_DIR`
- Gateway: `GATEWAY_HOST`, `GATEWAY_PORT`, `SPAWN_WORKER_PATH`
- Token metrics: `TOKEN_METRICS_DIR`, `TOKEN_RATES_PATH`, `SESSION_REFRESH_*` thresholds
- Entity types: `ENTITY_TYPES` array with `subdir`, `rejectionKeys`, `maxAgeDays` per type

### dates.ts

Thin wrappers around date-fns. No config dependencies.

- `dayOfWeek(dateStr)` — full weekday name (e.g., "Monday"). Important because LLMs cannot do day-of-week arithmetic reliably.
- `formatDate(dateStr, fmt)` — format a date using date-fns pattern
- `relativeDays(dateStr, referenceStr?)` — human-friendly relative description ("3 days ago", "today")
- `requireTimeZone(value, source)` — validates a time zone read from instance config; throws (naming `source`) when it is empty or not a valid IANA zone. No default zone
- `withDateContext(task, now, timeZone)` — prepends `> **Today is <weekday>, <YYYY-MM-DD> (<zone>).** …` to a worker task (used by `dispatchers/daily-digest.ts`)
- Re-exports `format` and `parseISO` from date-fns

From a shell, run it with `tsx` from the repo root (the repo is TypeScript source with no compiled `.js`, so plain `node -e` importing `./src/lib/dates.js` fails with `ERR_MODULE_NOT_FOUND`):

```bash
tsx -e "import { dayOfWeek } from './src/lib/dates.ts'; console.log(dayOfWeek('2026-06-01'));"
```

### email.ts

Gmail parsing utilities for raw Gmail API payloads. No config dependencies.

- `headerValue(headers, name)` — extract header value (case-insensitive)
- `extractTextFromPayload(payload)` — recursively extract text and HTML from MIME parts, decoding base64
- `extractAttachments(payload)` — recursively extract attachment metadata (filename, mimeType, size, attachmentId)

### gh.ts

GitHub CLI wrappers with typed invocation. Depends on `GH_BIN`, `GH_CONFIG_DIR`.

- `setupGhConfig()` — sets `GH_CONFIG_DIR` env var so `gh` finds correct auth tokens
- `gh(args, options?)` — run `gh` CLI command, return structured `GhResult` (`ok`, `status`, `out`, `err`)
- `ghJson(args)` — run `gh` and parse stdout as JSON
- `ghApi(endpoint)` — call GitHub REST API via `gh api`

### gog.ts

Google Workspace CLI wrapper with retry. Depends on `GOG_BIN`, `GOG_CONFIG_DIR`.

- `gogWithRetry(args, opts?)` — run `gog` command with retry logic for transient network errors (context deadline exceeded, timeouts). Defaults `GOG_HOME` to `GOG_CONFIG_DIR` (an existing `GOG_HOME` is kept), so gog and the scripts use the same home.

### gog-credentials.ts

Single source of truth for which gog credentials exist. Depends on `GOG_CLIENT_PATH`, `GOG_CONFIG_DIR`.

- `gogServiceAccountDirs(configDir?)` — directories searched for service-account mailboxes, in order: `<configDir>/data` (current gog), then `<configDir>` (older gog without `data/`); `gogServiceAccountDir(configDir?)` is the first
- `serviceAccountFileName(email)` / `serviceAccountKeyPath(email, configDir?)` — `sa-<base64(email), padding stripped>.json`, and its path under `data/`
- `findServiceAccountFile(email, configDir?)` — that mailbox's registration in the first directory that has it, or `null`
- `detectGogCredentials(configDir?)` — `{ oauthClient, serviceAccount, any }`: OAuth client file present, any `sa-*.json` present
- `requireGogCredentials(job, accountCount, creds?)` — `false` when `accountCount` is 0 (caller skips), `true` when any credential exists, otherwise throws so the run fails

### imap-secrets.ts

Resolves IMAP passwords. Depends on `IMAP_SECRETS_DIR` (`<CREDENTIALS_DIR>/imap`). Never logs a password or puts one in an error.

- `isSafeSecretRef(ref)` — `true` for a valid secret name, the same rule jeeves-tools uses for instance `secrets`: 1-64 characters, letters, digits, `_` and `-`, starting with a letter or digit (no dots or path separators; used by the pipeline-config schema)
- `imapSecretPath(ref, dir?)` — `<dir>/<ref>`, throwing on an unsafe ref
- `resolveImapPassword(password, dir?)` — a literal string as is; `{ secretRef }` read from its file with trailing newlines removed; throws, naming the ref and path, when the file is missing, unreadable or empty

### gateway-client.ts

Gateway HTTP client for OpenClaw tool invocation. Depends on `GATEWAY_HOST`, `GATEWAY_PORT`.

- `loadGatewayToken()` — load bearer token from `~/.openclaw/openclaw.json` or `CLAWDBOT_GATEWAY_TOKEN` env var
- `gatewayInvoke(tool, args, options?)` — invoke an OpenClaw gateway HTTP API tool
- `unwrapResult(r)` — unwrap result from gateway response

### gateway-rpc.ts

Gateway RPC caller for methods that are not HTTP tools, or whose tool wrapper limits what the RPC allows. Depends on the global openclaw install (`resolve-openclaw-dist.ts`).

- `gatewayRpc(method, params, cliPath?)`: run `openclaw gateway call <method> --json --params <json>` under the current Node binary (no shell) and resolve the result; gateway errors, CLI failures and non-JSON output reject

### pipeline-config.ts

Zod-validated pipeline configuration loader. Depends on `PIPELINE_CONFIG_PATH`. The `emailConfig` schema lives in `pipeline-config-email.ts` and the shared deprecation warner in `pipeline-config-deprecations.ts`; the email config types are re-exported from `pipeline-config.ts`. Deprecated forms (`emailConfig.receipt.forwardJGS`, a literal `imap.password` string) still load, each with a one-line `pipeline-config:` warning logged once per process.

- `loadPipelineConfig()` — load and cache config with Zod validation
- `getRef(key)` — get a ref value by dotted key (e.g., `'notion.socialPostsDatabaseId'`); throws if missing
- `tryGetRef(key)` — same as `getRef` but returns an empty string instead of throwing when the key is missing
- `getCalendarAccounts()` — accounts with calendar config
- `getEmailAccounts()` — email addresses with `emailPolling: true`
- `getBucketNames()` — every configured bucket name (`buckets.priority` order, then domain-only buckets), deduplicated; bucket names are also Gmail labels
- `getGmailAccounts()` — gog-served addresses, deduplicated: `emailPolling` accounts without an `imap` block plus `emailConfig.backfill.accounts`
- `getBucketForDomain(domain)` — match email domain to classification bucket
- `getBucketPriority()` — bucket name to priority index mapping

### silo-router.ts

Multi-tenant data routing by email domain, GitHub org, and Slack workspace. Depends on `SILO_ROUTING_CONFIG_PATH`.

- `getBasePathForEmailDomain(domain)` — resolve email domain to base content path
- `getBasePathForGitHubOrg(org)` — resolve GitHub org to base path (with optional relative path)
- `getBasePathForSlackWorkspace(teamId)` — resolve Slack workspace to base path
- `getBasePathForMeeting(participantEmails)` — resolve meeting to base path via majority-voting on participant email domains
- `getBasePathForJira()` — resolve Jira base path from silo routing config
- `getBasePathForLinear()` — resolve Linear base path from silo routing config
- `getEntityDirs(subdir)` — deduplicated list of entity root directories across all silos
- `getEmailBaseForAccount(account)` / `getCalendarBaseForAccount(account)` — per-account path helpers

Single-tenant instances route everything to `CONTENT_DIR` by default.

### worker-output.ts

Recovers an LLM worker's full final reply after `dispatchSession`: it takes the session key from spawn-worker's `WORKER_RESULT` line and reads the last assistant message via the gateway `chat.history` RPC with `maxChars: 500000` (the `sessions_history` tool caps text at 4000 characters, which cut long replies). A reply the gateway still marks as truncated fails with `worker reply truncated by gateway`. Job scripts use it to verify structured worker results instead of trusting the exit code.

### worker-slack/

Job-side Slack I/O for LLM workers. On OpenClaw 2026.9, sub-agent sessions have no `message` tool, so the job script does all Slack work:

- `worker-slack-config.ts`: Zod 4 schema for the job's `{ accountId?, reads?, posts? }` config (each post target carries `editTs?`, the exact message ids the worker may edit, and `pin?`); types are derived with `z.infer`.
- `run.ts`: `dispatchWithSlack(task, dispatchOptions, { reads, posts })` is the production entry point. It validates the config before any gateway call and supports `--dry-run` (print the posts instead of posting) and `--print-task` (print the TASK, no dispatch).
- `worker-slack-job.ts`: orchestration with injected deps (read → TASK → dispatch → validate → post/pin/edit).
- `worker-posts.ts`: the `slack-posts` output contract (a fenced JSON array, never a bare object, of `{channel, text, thread_ts?, pin?, edit_ts?}`; `edit_ts` replaces the text of an existing message and can't be combined with `thread_ts`/`pin`; edits and pins are allowed only where the target's `editTs` / `pin` permit), the worker instructions, and the Slack context formatting (fenced as untrusted data the worker must never follow as instructions).
- `slack-io.ts`: `read` / `send` / `pin` / `edit` through the gateway `message` tool (`/tools/invoke`). A read response without a valid `messages` array throws (only `messages: []` means an empty channel).
- `slack-target.ts`: normalizes Slack IDs to `channel:…` / `user:…` targets (the prefix must match the ID family: `channel:` C/G/D, `user:` U/W).

### spawn-worker.ts

Gateway session spawner — executable script invoked by `runDispatcher()`.

Usage: `echo "task" | tsx spawn-worker.ts --job-id=<id> [--label=<label>] [--thinking=<level>]`

- Spawns a session via OpenClaw gateway HTTP API
- Polls indefinitely for completion (runner job `timeout_seconds` handles process kill)
- Waits for transcript to flush
- Outputs `WORKER_RESULT:{"sessionKey":"...","tokens":12345,"durationMs":123000}` on last stdout line
- Implements retry with exponential backoff (3 retries, 30s base)

### entity-store.ts

Shared entity persistence — upsert, backfill, and delete entity files with reverse-diff history using `fast-json-patch`. Used by any domain that persists structured entities (Jira, Linear, etc.).

- `upsertEntity(domainDir, type, key, current, now, maxHistory)` — create or update entity file with reverse-diff history; returns file path
- `backfillEntity(domainDir, type, key, current, now)` — write entity file only if it doesn't exist (historical import); returns path or null
- `deleteEntity(domainDir, type, key)` — delete entity file; returns boolean
- `writeUnmatched(domainDir, label, body)` — write unrecognised webhook payload to `_unmatched/` subdirectory
- `readStdinJson()` — read stdin to completion and parse as JSON; used by Event Gateway drain scripts

Entity file structure:

```json
{
  "entityType": "issue",
  "entityKey": "CRE-1",
  "current": { ... },
  "history": [{ "ts": "...", "patch": [...] }],
  "meta": { "firstSeen": "...", "lastWebhook": "...", "lastBackfill": null, "version": 7 }
}
```

History entries are reverse-diff patches (JSON Patch format) — apply newest-to-oldest to reconstruct prior states.

## Configuration Files

Two JSON configuration files control pipeline behavior. Both paths are set via constants in `constants.ts`. On managed instances, these files may be rendered by `jeeves-tools deploy`; for initial setup or standalone instances, the assistant creates them from operator input.

### `pipeline-config.json`

Location: set via `PIPELINE_CONFIG_PATH` in `constants.ts` (`<SCRIPTS_DIR>/pipeline-config.json`, the repo root). The repo ships `pipeline-config.json.template` as a starting point. `pipeline-config.json` itself is gitignored (per-instance, never committed) and holds no secrets: IMAP passwords are `secretRef`s to files in `IMAP_SECRETS_DIR` (see below).

Loaded and validated by `pipeline-config.ts`. Configures accounts, domain-to-bucket routing, external service refs, and email behavior.

**Schema:**

```json
{
  "accounts": [
    {
      "email": "user@example.com",
      "type": "gmail",
      "calendar": { "serviceAccount": "auto" },
      "emailPolling": true
    },
    {
      "email": "user@imap.example.com",
      "type": "imap",
      "emailPolling": true,
      "imap": {
        "host": "imap.provider.com",
        "port": 993,
        "tls": true,
        "user": "user@imap.example.com",
        "password": { "secretRef": "user-imap-example-com" }
      },
      "folders": ["INBOX", "Sent"]
    }
  ],
  "buckets": {
    "domains": [
      { "pattern": "company.com", "bucket": "internal" },
      { "pattern": "vendor.com", "bucket": "vendor" }
    ],
    "priority": ["internal", "vendor", "external"]
  },
  "refs": {
    "notion.socialPostsDatabaseId": "abc123...",
    "slack.adminChannelId": "C0123..."
  },
  "emailConfig": {
    "reportOnly": false,
    "receipt": {
      "forwardEnabled": true,
      "sparkReceiptsForwardTo": "receipts@example.com"
    },
    "digest": {
      "slackChannelId": "C0456..."
    }
  }
}
```

**Fields:**

- `accounts` — List of email accounts. Each has `email`, `type` (`"gmail"` or `"imap"`), optional `calendar` config, and `emailPolling` toggle. `type: "imap"` requires an `imap` connection block; any account with an `imap` block is polled over IMAP (a `gmail` one with Gmail extensions), the rest through gog. `folders` is optional (IMAP only): without it, `gmail` accounts poll `[Gmail]/All Mail`, `[Gmail]/Spam` and `[Gmail]/Trash`, generic IMAP accounts every folder the server lists. `imap.password` is `{ "secretRef": "<name>" }`: the poller reads the password from `<CREDENTIALS_DIR>/imap/<name>` (`IMAP_SECRETS_DIR`) when it connects, and jeeves-tools provisions that file from the instance config's `secrets` map ([jeeves-tools#178](https://github.com/karmaniverous/jeeves-tools/issues/178)). A literal string is still accepted but deprecated (one warning per process). See [email/](../email/README.md#imap-passwords).
- `accounts[].calendar` — Either `{ "serviceAccount": "auto" }` (Workspace mailbox via the service-account registration gog keeps for it) or `{ "tokenFile": "<path relative to CREDENTIALS_DIR>" }` (OAuth refresh token; needs the gog OAuth client). See [calendar/](../calendar/README.md#account-configuration).
- `buckets.domains` — Maps email domains to classification buckets. `pattern` is matched case-insensitively.
- `buckets.priority` — Ordered bucket names (lower index = higher priority).
- `refs` — Named references to external service IDs (and other per-instance values, such as the daily digest's IANA time zone `digest.timezone`) accessed via `getRef('dotted.key')`.

  **Finding the refs an instance needs.** Every ref is read in code with `getRef('…')` (throws when missing) or `tryGetRef('…')` (empty string when missing), either with a literal key or through a `*_REF` constant (e.g. `DIGEST_TIMEZONE_REF = 'digest.timezone'`), so the set of refs is whatever this repo's scripts ask for. List them from the repo root with `grep -rhoE "(try)?[gG]etRef\('[^']+'\)|[A-Z_]+_REF = '[^']+'" src --include='*.ts' --exclude='*.test.ts' | sort -u`, then set a value for each under `refs` (dotted keys become nested objects). Keep the convention when adding a ref: a literal key or a `*_REF` constant, so this list stays complete. Refs are per-instance IDs and settings (Notion database IDs, Slack channel IDs, `digest.timezone`); there are no defaults, and they are not secrets (secrets go in `imap.password` `secretRef` files).

- `emailConfig.reportOnly` — When `true`, email is still ingested but no Gmail mutations happen: poll and backfill-historical enqueue no label actions (classification or curation-signal), meetings-extract enqueues no `meeting` label or archive, and drain-updates applies none. Skipped actions are dropped, not deferred (see [email/](../email/README.md#prerequisites)), except meetings-extract's, which are caught up once `reportOnly` is off (see [meetings/](../meetings/README.md#reportonly-catch-up)).
- `emailConfig.meetings` (optional) — Gmail actions meetings-extract takes on a meeting's source email: `{ "archive": false }` applies only the `meeting` label; `{ "archive": true }` also archives the email out of `INBOX` (never a `watch`ed one). `archive` is required when the block is present. Absent means `archive: true`, the original behaviour. `reportOnly` still overrides both.
- `emailConfig.backfill` (optional) — Paced historical Gmail backfill (`email-backfill-historical` job): `{ "accounts": ["me@example.com"], "lookbackDays": 90, "windowDays": 7 }`. All three fields are required when the block is present; there are no defaults. Each run searches one `windowDays` window per account, walking back until `lookbackDays`, then no-ops. Values can be overridden with `--accounts`, `--lookback-days`, `--window-days`. Backfill accounts are included in `getGmailAccounts()`, so `email-download` and `email-drain-updates` consume what backfill queues even for accounts that are not polled.
- `emailConfig.receipt` — Receipt forwarding settings: `forwardEnabled` (boolean, whether detected receipts are forwarded) and `sparkReceiptsForwardTo` (the address they go to). No script in this template reads these yet; they are validated so instance scripts can rely on them.
- `googleDrive` (optional) — Google Drive sync: a run-wide `budget` and `syncs[]` (`account`, `targetDir`, `pathResolution.domains`, …). This loader passes the block through **unvalidated**; the Drive job validates it (`loadGoogleDriveConfig()` in `src/google-drive/lib/config.ts`), so a mistake in it fails only that job. Fully documented in [google-drive/](../google-drive/README.md#configuration).
- `buckets` — bucket names (from `buckets.priority` and `buckets.domains[].bucket`, see `getBucketNames()`) are also the Gmail labels the classification and backfill scripts apply. No bucket name is hard-coded in code.

**Migration: `emailConfig.receipt.forwardJGS` → `forwardEnabled`.** The old key is still accepted as a deprecated alias: at load time it is mapped to `forwardEnabled` and a one-line warning is logged (`pipeline-config: emailConfig.receipt.forwardJGS is deprecated; rename it to forwardEnabled.`). If both keys are present, `forwardEnabled` wins, the old key is ignored, and the warning says so. Rename the key in your `pipeline-config.json` to silence the warning; the alias will be removed in a future release.

- `emailConfig.digest` — Slack channel for email digest delivery.

### `silo-routing.json`

Location: set via `SILO_ROUTING_CONFIG_PATH` in `constants.ts`.

Loaded and validated by `silo-router.ts`. Routes pipeline output to the correct base content path per tenant. Single-tenant instances can omit this file — `silo-router.ts` defaults to `CONTENT_DIR`.

**Schema:**

```json
{
  "defaultBasePath": "/opt/jeeves/content",
  "silos": {
    "acme": {
      "emailDomains": ["acme.com", "acme.co.uk"],
      "githubOrgs": [
        "acme-corp",
        { "githubOrg": "acme-oss", "relativePath": "oss" }
      ],
      "slackWorkspaces": ["T0ABC123"],
      "jira": true,
      "linear": true,
      "basePath": "/opt/jeeves/content/acme"
    }
  }
}
```

**Fields:**

- `defaultBasePath` — Fallback path when no silo matches. Defaults to `CONTENT_DIR`.
- `silos` — Named tenant configurations. Each silo maps:
  - `emailDomains` — Email domains that belong to this tenant.
  - `githubOrgs` — GitHub orgs for this tenant. Plain strings use the silo's `basePath` directly; objects with `{ "githubOrg": "...", "relativePath": "..." }` append a relative subdirectory.
  - `slackWorkspaces` — Slack team IDs (e.g., `T0ABC123`) for this tenant.
  - `jira` — When `true`, Jira content for this instance routes to this silo.
  - `linear` — When `true`, Linear content for this instance routes to this silo.
  - `basePath` — Absolute base path for all content routed to this silo.
