# lib/

Shared infrastructure consumed by all domain scripts. This is where instance configuration, CLI wrappers, and cross-cutting utilities live.

## Modules

### constants.ts

**The first file to edit on a new instance.** Centralized paths, credentials, and integration-specific values used across all scripts.

Key exports:

- Directory paths: `CONTENT_DIR`, `SCRIPTS_DIR`, `CREDENTIALS_DIR`, `SESSIONS_DIR`, etc.
- GitHub: `GH_BIN`, `GH_CONFIG_DIR`, `GH_ACCOUNT`, `GH_BOT_USER`, `GITHUB_DIR`, `GITHUB_REGISTRY_PATH`
- Google: `GOG_BIN`, `GOG_CONFIG_DIR`, `GOG_CLIENT_PATH`
- Email: `EMAIL_EVENTS_DIR`
- Slack: `PRIMARY_WORKSPACE`, `SLACK_DOMAIN_DIR`, `SLACK_WORKSPACE_CACHE_PATH`
- X/Twitter: `X_OAUTH_DIR`, `X_ACCOUNTS`
- Meetings: `DEFAULT_MEETINGS_DIR`
- Gateway: `GATEWAY_HOST`, `GATEWAY_PORT`, `SPAWN_WORKER_PATH`
- Token metrics: `TOKEN_METRICS_DIR`, `TOKEN_RATES_PATH`, `SESSION_REFRESH_*` thresholds
- Entity types: `ENTITY_TYPES` array with `subdir`, `rejectionKeys`, `maxAgeDays` per type

### dates.ts

Thin wrappers around date-fns. No config dependencies.

- `dayOfWeek(dateStr)` — full weekday name (e.g., "Monday"). Important because LLMs cannot do day-of-week arithmetic reliably.
- `formatDate(dateStr, fmt)` — format a date using date-fns pattern
- `relativeDays(dateStr, referenceStr?)` — human-friendly relative description ("3 days ago", "today")
- Re-exports `format` and `parseISO` from date-fns

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

Google Workspace CLI wrapper with retry. Depends on `GOG_BIN`, `CREDENTIALS_DIR`.

- `gogWithRetry(args, opts?)` — run `gog` command with retry logic for transient network errors (context deadline exceeded, timeouts). Sets `APPDATA` to `CREDENTIALS_DIR` for Windows credential location.

### gateway-client.ts

Gateway HTTP client for OpenClaw tool invocation. Depends on `GATEWAY_HOST`, `GATEWAY_PORT`.

- `loadGatewayToken()` — load bearer token from `~/.openclaw/openclaw.json` or `CLAWDBOT_GATEWAY_TOKEN` env var
- `gatewayInvoke(tool, args, options?)` — invoke an OpenClaw gateway HTTP API tool
- `unwrapResult(r)` — unwrap result from gateway response

### pipeline-config.ts

Zod-validated pipeline configuration loader. Depends on `PIPELINE_CONFIG_PATH`.

- `loadPipelineConfig()` — load and cache config with Zod validation
- `getRef(key)` — get a ref value by dotted key (e.g., `'notion.socialPostsDatabaseId'`); throws if missing
- `tryGetRef(key)` — same as `getRef` but returns an empty string instead of throwing when the key is missing
- `getCalendarAccounts()` — accounts with calendar config
- `getEmailAccounts()` — email addresses with `emailPolling: true`
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

Location: set via `PIPELINE_CONFIG_PATH` in `constants.ts`.

Loaded and validated by `pipeline-config.ts`. Configures accounts, domain-to-bucket routing, external service refs, and email behavior.

**Schema:**

```json
{
  "accounts": [
    {
      "email": "user@company.com",
      "type": "gmail",
      "calendar": { "serviceAccount": "auto" },
      "emailPolling": true
    },
    {
      "email": "user@imap-provider.com",
      "type": "imap",
      "emailPolling": true,
      "imap": {
        "host": "imap.provider.com",
        "port": 993,
        "tls": true,
        "user": "user@imap-provider.com",
        "password": "..."
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
      "forwardJGS": true,
      "sparkReceiptsForwardTo": "receipts@company.com"
    },
    "digest": {
      "slackChannelId": "C0456..."
    }
  }
}
```

**Fields:**

- `accounts` — List of email accounts. Each has `email`, `type` (`"gmail"` or `"imap"`), optional `calendar` config, and `emailPolling` toggle. IMAP accounts require an `imap` connection block; `folders` is optional (defaults to all folders for IMAP, standard Gmail folders for gmail).
- `buckets.domains` — Maps email domains to classification buckets. `pattern` is matched case-insensitively.
- `buckets.priority` — Ordered bucket names (lower index = higher priority).
- `refs` — Named references to external service IDs accessed via `getRef('dotted.key')`.
- `emailConfig.reportOnly` — When `true`, email triage logs actions without executing them.
- `emailConfig.receipt` — Receipt forwarding settings.
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
