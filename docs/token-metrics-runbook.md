# Token Metrics Operational Runbook

## How the Pipeline Works

The token metrics pipeline has three stages:

### 1. Collection (`collect-token-metrics.ts`)

Runs on a 97-minute cron cycle. Scans two data sources:

- **OpenClaw gateway transcripts** — JSONL files in `~/.openclaw/agents/main/sessions/`
- **Claude Code project sessions** — JSONL files under `~/.claude/projects/`

For each file, the collector:

1. Reads from the last byte-offset cursor (resumes mid-file).
2. Parses usage records (token counts per model per message).
3. Discards records in the current (incomplete) UTC hour.
4. Computes costs from the rate card (ignores per-message costs from the provider).
5. Merges usage into in-memory hourly buckets keyed by `{hour, channel, model}`.
6. Flushes buckets to disk with **merge-into** semantics — new data is added to any existing bucket file for the same hour.
7. Saves cursor state (byte offsets + last-processed timestamps) in runner SQLite.

If the collector encounters a model not in the rate card, it **refuses to write any buckets** and triggers a rate card refresh job.

If `SESSIONS_DIR` is missing or holds no transcript files (OpenClaw 2026.9+ moved transcripts into its agent SQLite store), the collector logs a warning, skips OpenClaw sources, keeps collecting Claude Code, and exits 0.

### 2. Bucket Files (on-disk format)

Each bucket file is a JSON file at:

```
/opt/jeeves/state/jeeves-runner/token-metrics/{YYYY}/{MM}/{YYYY-MM-DDTHH}.json
```

Schema:

```json
{
  "hour": "2026-06-01T14",
  "channels": {
    "slack:channel:C12345": {
      "models": {
        "anthropic/claude-sonnet-4-6": {
          "input": { "count": 50000, "cost": 0.15 },
          "output": { "count": 12000, "cost": 0.06 },
          "cacheRead": { "count": 80000, "cost": 0.024 },
          "cacheWrite": { "count": 5000, "cost": 0.01875 }
        }
      }
    }
  }
}
```

Bucket files are **immutable once the hour closes** — the collector only writes to completed hours. The `flushBuckets` function deep-merges new data into existing bucket files (additive, never replaces).

### 3. Query (`token-metrics.ts`)

Reads bucket files for a time range and aggregates into a `Costs` report with:

- Per-channel cost breakdown with per-model sub-breakdown
- Global per-model cost breakdown
- Rate card reference data

CLI usage:

```bash
tsx src/admin/token-metrics.ts --from 2026-06-01 --to 2026-06-03
```

## OpenClaw 2026.9+: agent SQLite source

When `~/.openclaw/agents/main/agent/openclaw-agent.sqlite` exists, the collector reads OpenClaw usage from it instead of `SESSIONS_DIR`:

- The DB is opened **read-only** (one read transaction, busy timeout). Nothing is ever written to it.
- The reader is pinned to a schema version (`PRAGMA user_version`, currently **23**). Any other version makes the collector **exit non-zero** with `expected user_version 23, found N`. It never guesses.
- All schema knowledge lives in `src/admin/lib/openclaw-db/schema-v23.ts` (payload decoding in `schema-v23-payloads.ts`): hot `transcript_events` rows (`event_json` or checksummed zstd `event_zstd`), cold archives (`sessions/cold/*.jsonl.zst` or blob, sha256-verified) and deleted/reset archives (sha256-verified). Legacy `*.jsonl.reset.*` / `*.jsonl.deleted.*` files left in `SESSIONS_DIR` by the migration are read too (`legacy-archives.ts`).
- Each deleted/reset archive **generation** (`session_transcript_archives` is keyed `(session_id, generation)`, seq restarting at 0) is its own transcript with its own cursor (`session:<id>#<generation>`); generations are never merged by seq. An archive continues from the live `session:<id>` cursor it was archived from (matched by the generation stamped in that cursor, from `transcript_rewrite_watermarks`), so usage already counted live is not counted again. A fully read archive (or legacy archive file) is marked `complete` in the cursor and not re-read on later runs.
- The DB reader (and `node:sqlite`, which Node gained in 22.5) is imported only when the agent DB exists, so legacy hosts on older Node 22 releases keep collecting from `SESSIONS_DIR`.
- Channel keys come from the session's **recorded metadata** (`channel-from-meta.ts`, names loaded by `schema-v23-meta.ts`): the session key (`session_windows`, or `session_transcript_archives` for deleted/reset sessions), plus names from `session_nodes` (`groupChannel`, `displayName`, `delivery.origin.label`, `label`, parent session) and `conversations`. This gives `slack:channel:#name` (or the upper-case channel id when no name is recorded), `slack:dm:<person>`, `cron:<label>` and `telegram:<kind>:<name>`.
- **Subagents roll up to the channel that spawned them** (`subagent-rollup.ts`). The parent chain (`session_nodes.parent_session_key` / `spawnedBy`) is followed transitively to the root: a Slack channel/DM, Telegram or cron root gets the subagent's usage. Under a non-channel root (`agent:main:main`, recovered) the topmost subagent names the bucket: runner workers (label `worker-<job>`, the first 8 characters of the job id) become `runner:<job>`, other subagents keep `subagent:label:<label>` (`meta-<phase>` for meta labels). If the chain can't be resolved (no linkage, a deleted subagent parent, a cycle), the subagent keeps its own label-based name. A deleted Slack parent still resolves from its session key.
- The legacy `detectChannel` text rules (first 50 events) are used only when metadata is absent or doesn't identify the channel, e.g. `agent:main:main`, recovered sessions and legacy archive files. 2026.9 injects runtime-context text into transcripts, which those rules used to misread (`slack:dm:<name>-approved-executables-…`), so the DM rule now stops at the end of the line. Every key has its whitespace collapsed and trailing punctuation stripped (no more `subagent:repo:…/jeeves-tools.`).
- Slack DMs whose session recorded no counterpart name (`slack:dm:<USERID>`) are named from `slack-dm-names.json` (beside the buckets), then the Slack poller's cached user map (`src/slack/lib/users.json`, read-only), then the gateway `message` tool (`member-info`); a looked-up name is cached. If nothing resolves the id key is kept.
- Bucket files keep exactly the same format.
- The cursor is `(transcript, seq)`, stored in runner state under `cursors-openclaw-db`. Usage in the still-open hour stops that transcript's cursor, so it's counted on a later run and never dropped. Nothing is counted twice.
- With **no stored DB cursor**, the collector first checks whether OpenClaw usage was ever counted on this host (`fresh-openclaw-history.ts`). It was if the legacy JSONL cursor (`cursors`) has an entry, or if any bucket file (or `.backup-*` copy) under `{YYYY}/{MM}/` has a channel other than a Claude Code `cc:` channel. A bucket that can't be read, or has no `channels` object, counts too, to stay safe. The check stops at the first such bucket, and runs only when there's no DB cursor, so a host that already has one never scans its buckets.
  - **Never counted (fresh instance):** the collector logs one line, starts the DB cursor empty and counts OpenClaw's whole history once. This is correct because nothing was counted before, and cheap because a new instance has little history. The cursor is saved after the flush, as usual. No manual bootstrap is needed.
  - **Counted (upgraded host):** the collector refuses to collect OpenClaw usage and exits non-zero, because counting from zero would double count history. Bootstrap it with `regenerate-token-metrics.ts --from <upgrade hour>` (below). Claude Code collection still runs.
- `recalculate-token-metrics.ts` refuses to run on a DB host. Use `regenerate-token-metrics.ts` instead.

### Regenerate

```bash
# scratch (never touches runner state or the live store; point TOKEN_METRICS_DIR at a dir holding a copied token-rates.json)
tsx src/admin/regenerate-token-metrics.ts --from 2026-09-24T09:00:00Z --out /tmp/regen
# live: rebuild [from, last closed hour), back up + replace buckets, REPLACE the DB cursor (bootstrap / full rebuild)
tsx src/admin/regenerate-token-metrics.ts --from 2026-09-24T09:00:00Z --dry-run
tsx src/admin/regenerate-token-metrics.ts --from 2026-09-24T09:00:00Z
# live: rebuild a closed range from already-counted events (OpenClaw seq <= DB cursor,
# Claude Code bytes before the CC cursor); DB and CC cursors untouched
tsx src/admin/regenerate-token-metrics.ts --from 2026-09-25T00:00:00Z --to 2026-09-26T00:00:00Z
```

Pause the `collect-token-metrics` job while a live regeneration runs.

`--from` earlier than `OPENCLAW_UPGRADE_CUTOFF` (`src/lib/constants/token-metrics.ts`, default `2026-09-24T09:00:00Z`; set it per instance or override it with the env var) is **refused**, because pre-upgrade hours were counted by the JSONL collector and are never rewritten. Pass `--allow-pre-upgrade` only for an owner-approved scratch comparison (step 3 below).

### Switching a host to the DB reader

This is only for hosts **upgraded** to 2026.9 that already have token-metrics history. A fresh instance starts its DB cursor automatically (above).

1. Find the 2026.9 upgrade time: the OpenClaw package install time, `schema_meta.updated_at` for `meta_key = 'primary'`, or `openclaw.json.pre-*` backups.
2. Pick `--from` = the upgrade hour (floor to the hour), and set `OPENCLAW_UPGRADE_CUTOFF` to it. The JSONL collector wrote every bucket before that hour.
3. Run a scratch regeneration (`--out`, `--allow-pre-upgrade`) from a few days before the upgrade, and compare pre-upgrade days with the live store by day × channel × model. OpenClaw deletes transcripts, and the JSONL collector dropped open-hour usage, so pre-upgrade days can legitimately differ. Understand every difference before continuing.
4. Dry-run, then run the live regeneration from the upgrade hour. This bootstraps the cursor.

### Future schema changes (upgrade runbook step)

When OpenClaw bumps the agent schema, the collector exits non-zero naming the expected and found versions. Then:

1. Add `src/admin/lib/openclaw-db/schema-vNN.ts` **beside** `schema-v23.ts` (don't edit v23). Implement the same `OpenClawDbSchema` contract and register it in `open-agent-db.ts`.
2. Add a fixture and tests that use the real vNN DDL.
3. Verify the overlap: scratch-regenerate from before the schema upgrade and compare pre-upgrade days with the live store. They must match, apart from explained differences.
4. Regenerate the live store from the schema-upgrade hour (dry run first). The cursor is keyed by transcript and seq, so if vNN keeps seq numbering, the existing cursor stays valid. If it doesn't, the full rebuild replaces it.

## How to Safely Recalculate

On OpenClaw 2026.9+ hosts (agent DB present) use `regenerate-token-metrics.ts` (above). On legacy hosts, use `recalculate-token-metrics.ts` when bucket data needs correction (e.g., after a rate card fix, a collector bug, or corrupted bucket files).

### Dry run first

Always preview what will change before modifying data:

```bash
tsx src/admin/recalculate-token-metrics.ts --from 2026-06-01 --to 2026-06-03 --dry-run
```

This reports which bucket files would be backed up and deleted, without making changes.

### Execute recalculation

```bash
tsx src/admin/recalculate-token-metrics.ts --from 2026-06-01 --to 2026-06-03
```

The script:

1. **Backs up** all existing bucket files in the range (creates `.backup-{timestamp}.json` copies).
2. **Deletes** the original bucket files for the range.
3. **Resets cursors** — files whose last-processed timestamp falls within the range get their byte offsets reset to 0.
4. **Re-collects** from source transcripts, only emitting records within the specified range.
5. **Flushes** new buckets to disk.
6. **Saves** updated cursor state.

Without `--from`/`--to`, the script recalculates the entire transcript window (all time up to the previous closed UTC hour).

## What NOT to Do

- **Never delete bucket files manually** outside the transcript window. The collector won't regenerate hours it has already processed unless cursors are also reset. Use the recalculation script instead.
- **Never reset cursors without the recalculation script.** Resetting cursors without deleting the corresponding bucket files causes double-counting (merge-into semantics add to existing data).
- **Never edit bucket files by hand.** The merge-into semantics assume buckets are internally consistent. Manual edits can corrupt aggregation.
- **Never delete cursor state from runner SQLite directly.** This forces a full rescan of all transcript files, which will double-count every hour that already has bucket files on disk.

## How `pruneAfter` / `maxEntries` Interact with Data Retention

The bucket file layout is partitioned by `{YYYY}/{MM}/`. There is no automatic pruning built into the collector or query layer — bucket files persist indefinitely unless manually removed.

If you need to implement data retention:

- **Delete old month directories** (e.g., `rm -rf /opt/jeeves/state/jeeves-runner/token-metrics/2025/`) to free disk space. This is safe because the collector never writes to hours in the past.
- **Cursor state does not need pruning** — cursors for deleted/rotated transcript files are inert (the file check skips them).
- **pruneAfter** and **maxEntries** are runner-level settings for job state management, not token metrics settings. They control how long runner job execution history is retained, not bucket data.

## How to Add New Models to the Rate Card

The rate card lives at `/opt/jeeves/state/jeeves-runner/token-metrics/token-rates.json`.

### Seed on fresh instances

The template ships a seed card at `config/token-rates.seed.json` (default instance models plus delivery-mirror at 0, `source` starts with `SEED <date>`). `refresh-token-rates` and `collect-token-metrics` copy it into place (creating the directory) **only when no rate card exists**. An existing card is never overwritten, even if it is invalid. Seeding is atomic: the validated seed is written to a temp file in the same directory and hard-linked into place, so readers never see a partial card and a concurrently created card is never clobbered.

### Failure reporting

`refresh-token-rates` validates the card before dispatching the worker and again after the worker finishes. It exits non-zero (the runner records an error) if the card is missing and can't be seeded, is unreadable or invalid (bad JSON, missing rate category, no models), or if the worker exits non-zero.

The worker's exit code alone is not trusted. Its final reply must end with one result line, which the job reads back through the gateway (`sessions_history`):

- `RESULT: updated` — the card must also have a later `updatedAt` than before the run;
- `RESULT: unchanged` — every rate verified, no change needed;
- `RESULT: failed: <reason>` — recorded as a failed run with the reason.

A missing or malformed result line fails the run. `refresh-token-rates --dry-run` prints the TASK and exits without seeding, reading the card, or dispatching a worker.

### Automatic (recommended)

The `refresh-token-rates.ts` job runs daily at 05:37 UTC (off-peak; `timeout_seconds` 600) and dispatches one paid LLM session to fetch current published API pricing. New models are added automatically when they appear in provider pricing pages.

If the collector encounters an unknown model, it:

1. Refuses to write any buckets for that run.
2. Triggers the rate card refresh job.
3. Exits with code 1.

The next collector run (97 minutes later) will pick up the updated rate card and process the pending data.

### Manual

Edit `token-rates.json` directly. The schema:

```json
{
  "updatedAt": "2026-06-01T00:00:00Z",
  "source": "manual",
  "unit": "$/MTok",
  "models": {
    "anthropic/claude-sonnet-4-6": {
      "input": 3.0,
      "output": 15.0,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    }
  }
}
```

Rates are in **dollars per million tokens** ($/MTok). All four categories (`input`, `output`, `cacheRead`, `cacheWrite`) are required for each model. The model key format is `{provider}/{model}` matching what appears in transcript data.

After adding a model manually, restart the collector or wait for the next cron cycle.
