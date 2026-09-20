#!/usr/bin/env tsx
/**
 * @module migrate-alignment
 *
 * Brings all existing meeting packages into conformance with the canonical
 * meeting-package contract (spec section 3 / Step 4).
 *
 * Called manually or by the runner as a one-shot migration. Walks every
 * meetings directory, validates and patches metadata, back-fills missing
 * fields, and records changes via runner state. Default: dry-run; pass
 * --live to execute, --max=N to cap the batch.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';
import {
  getRunnerClient,
  type RunnerClient,
} from '@karmaniverous/jeeves-runner';

import {
  buildSortTimestampInput,
  checkHasTranscript,
  computeSortTimestamp,
  meetingMetaSchema,
  writeMeetingMeta,
} from './lib/meeting-schema.js';
import { getMeetingsDirs } from './lib/meetings-dirs.js';
import { parseMigrationArgs } from './lib/migration-args.js';
import {
  backupFile,
  type ChangeRecord,
  generateBatchId,
  writeChangeRecord,
} from './lib/migration-backup.js';

// ── Types ───────────────────────────────────────────────────────────

interface MigrationStats {
  scanned: number;
  alreadyConformant: number;
  updated: number;
  artifactsCopied: number;
  errors: number;
  skippedAlreadyProcessed: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function readMeetingJson(meetingDir: string): Record<string, unknown> | null {
  const metaPath = path.join(meetingDir, 'meeting.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function isConformant(meta: Record<string, unknown>): boolean {
  return meetingMetaSchema.safeParse(meta).success;
}

/** Infer source from existing metadata or directory contents. */
function inferSource(
  meta: Record<string, unknown>,
  meetingDir: string,
): string {
  if (typeof meta.source === 'string' && meta.source) return meta.source;

  // Check sources array
  const sources = meta.sources as Array<Record<string, unknown>> | undefined;
  if (sources?.[0]) {
    const type = sources[0].type ?? sources[0].kind;
    if (typeof type === 'string' && type) return type;
  }

  // Heuristic from files
  try {
    const files = fs.readdirSync(meetingDir);
    if (files.some((f) => f.startsWith('fathom-') && f.endsWith('.html')))
      return 'fathom';
    if (files.includes('gemini_link.txt')) return 'gemini';
    if (files.includes('fathom_link.txt')) return 'fathom';
  } catch {
    // ignore
  }

  return 'unknown';
}

/** Infer date from existing metadata or directory name. */
function inferDate(meta: Record<string, unknown>, meetingId: string): string {
  if (typeof meta.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.date))
    return meta.date;
  if (
    typeof meta.meetingDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(meta.meetingDate)
  )
    return meta.meetingDate;

  // Try parsing from createdAt
  if (typeof meta.createdAt === 'string') {
    const d = new Date(meta.createdAt);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // Try parsing from ingestedAt
  if (typeof meta.ingestedAt === 'string') {
    const d = new Date(meta.ingestedAt);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // Fallback: today
  meetingId;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Materialize canonical artifacts from legacy modality-specific
 * artifacts (spec section 3.2).
 */
function materializeArtifacts(
  meetingDir: string,
  source: string,
  batchId: string,
): { copied: string[]; changes: Record<string, string> } {
  const copied: string[] = [];
  const changes: Record<string, string> = {};

  // gemini-notes.txt -> summary.txt (if summary.txt doesn't exist)
  if (source === 'gemini') {
    const geminiNotes = path.join(meetingDir, 'gemini-notes.txt');
    const summary = path.join(meetingDir, 'summary.txt');
    if (fs.existsSync(geminiNotes) && !fs.existsSync(summary)) {
      backupFile(meetingDir, 'summary.txt', batchId);
      fs.copyFileSync(geminiNotes, summary);
      copied.push('summary.txt');
      changes['summary.txt'] = 'materialized from gemini-notes.txt';
    }
  }

  return { copied, changes };
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const args = parseMigrationArgs(process.argv.slice(2));
  const batchId = generateBatchId('alignment');
  const meetingsDirs = getMeetingsDirs();

  console.log(
    `[migrate-alignment] Mode: ${args.live ? 'LIVE' : 'DRY-RUN'} | Max: ${String(args.max)} | Batch: ${batchId}`,
  );
  console.log(`[migrate-alignment] Scanning: ${meetingsDirs.join(', ')}`);

  const stats: MigrationStats = {
    scanned: 0,
    alreadyConformant: 0,
    updated: 0,
    artifactsCopied: 0,
    errors: 0,
    skippedAlreadyProcessed: 0,
  };

  let client: RunnerClient | null = null;
  if (args.live) {
    client = getRunnerClient();
  }

  try {
    let processed = 0;

    for (const meetingsDir of meetingsDirs) {
      if (!fs.existsSync(meetingsDir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(meetingsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (processed >= args.max) break;

        const meetingId = entry.name;
        const meetingDir = path.join(meetingsDir, meetingId);
        stats.scanned++;

        // Skip already-processed (idempotency)
        if (
          client &&
          client.hasItem('meetings', 'migration-alignment', meetingId)
        ) {
          stats.skippedAlreadyProcessed++;
          continue;
        }

        const existing = readMeetingJson(meetingDir);
        if (!existing) {
          // No meeting.json at all — skip
          continue;
        }

        // Check conformance
        if (isConformant(existing)) {
          stats.alreadyConformant++;
          if (client) {
            client.setItem(
              'meetings',
              'migration-alignment',
              meetingId,
              JSON.stringify({ status: 'conformant', batchId }),
            );
          }
          continue;
        }

        // Compute missing fields
        const source = inferSource(existing, meetingDir);
        const date = inferDate(existing, meetingId);
        const hasTranscript = checkHasTranscript(meetingDir);

        // Compute sort timestamp — full precedence (spec section 3.3)
        const { sortTimestampMs, sortSource } = computeSortTimestamp(
          buildSortTimestampInput(existing, meetingId),
        );

        const updates: Record<string, unknown> = {
          ...existing,
          meetingId,
          source,
          date,
          sortTimestampMs,
          sortSource,
          hasTranscript,
        };

        if (!args.live) {
          // Dry-run: predict which artifacts would be materialized
          const wouldCopy: string[] = [];
          if (source === 'gemini') {
            const geminiNotes = path.join(meetingDir, 'gemini-notes.txt');
            const summary = path.join(meetingDir, 'summary.txt');
            if (fs.existsSync(geminiNotes) && !fs.existsSync(summary)) {
              wouldCopy.push('summary.txt');
            }
          }

          console.log(
            `[migrate-alignment] WOULD_UPDATE ${meetingId} source=${source} date=${date} hasTranscript=${String(hasTranscript)} sortSource=${sortSource}${wouldCopy.length > 0 ? ` artifacts=${wouldCopy.join(',')}` : ''}`,
          );
          processed++;
          continue;
        }

        try {
          // Artifact materialization (live only)
          const { copied, changes } = materializeArtifacts(
            meetingDir,
            source,
            batchId,
          );
          stats.artifactsCopied += copied.length;

          // Backup meeting.json before overwrite
          backupFile(meetingDir, 'meeting.json', batchId);

          // Write change record
          const record: ChangeRecord = {
            meetingId,
            meetingDir,
            timestamp: new Date().toISOString(),
            filesBackedUp: ['meeting.json', ...copied],
            changes: {
              'meeting.json': 'canonical minimum metadata backfill',
              ...changes,
            },
          };
          writeChangeRecord(meetingDir, batchId, record);

          // Write updated meeting.json via canonical path
          writeMeetingMeta(meetingDir, updates);

          // Mark processed in runner state
          client!.setItem(
            'meetings',
            'migration-alignment',
            meetingId,
            JSON.stringify({ status: 'updated', batchId }),
          );

          stats.updated++;
          processed++;

          console.log(
            `[migrate-alignment] UPDATED ${meetingId} source=${source} date=${date}`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[migrate-alignment] ERROR ${meetingId}: ${msg}`);
          stats.errors++;
        }
      }

      if (processed >= args.max) break;
    }

    console.log(
      `[migrate-alignment] Done: scanned=${String(stats.scanned)} conformant=${String(stats.alreadyConformant)} updated=${String(stats.updated)} artifacts=${String(stats.artifactsCopied)} errors=${String(stats.errors)} skipped=${String(stats.skippedAlreadyProcessed)}`,
    );

    if (!args.live) {
      console.log(
        '[migrate-alignment] This was a dry run. Pass --live to execute.',
      );
    }
  } finally {
    client?.close();
  }
}

runScript('meetings/migrate-alignment', main);
