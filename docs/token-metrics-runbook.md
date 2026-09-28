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

## How to Safely Recalculate

Use `recalculate-token-metrics.ts` when bucket data needs correction (e.g., after a rate card fix, a collector bug, or corrupted bucket files).

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
