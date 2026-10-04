/**
 * @module trim-jsonl
 *
 * Age-based trimming of the email event logs (`<account>.jsonl` etc.)
 * in EMAIL_EVENTS_DIR. Lines whose `at` timestamp is older than the
 * cutoff are dropped; unparseable lines are kept; `_runs-*.jsonl` run
 * logs are never trimmed.
 *
 * Called by email/poll.ts after each run.
 */

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Drop lines older than `maxDays` from every `*.jsonl` file in `dir`
 * except `_runs-*.jsonl`. A missing directory is a no-op.
 */
export function trimJsonlFiles(
  dir: string,
  maxDays: number,
  now: number = Date.now(),
): void {
  if (!fs.existsSync(dir)) return;
  const cutoff = now - maxDays * DAY_MS;

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.jsonl')) continue;
    if (entry.startsWith('_runs-')) continue;

    const filePath = path.join(dir, entry);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const kept: string[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { at?: string };
        if (obj.at && new Date(obj.at).getTime() >= cutoff) {
          kept.push(line);
        }
      } catch {
        kept.push(line);
      }
    }

    fs.writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '');
  }
}
