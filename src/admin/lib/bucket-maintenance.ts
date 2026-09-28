/**
 * @module bucket-maintenance
 *
 * Backup and delete hourly bucket files for a set of hours — the
 * destructive half of recalculate/regenerate. Backups are written beside
 * each bucket as `.backup-{timestamp}.json`. Honors `dryRun`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { bucketPath } from './bucket-io.js';

/** Copy each existing bucket file in `hours` to a timestamped backup. */
export function backupBucketFiles(
  hours: string[],
  dryRun: boolean,
  tag = '[recalc]',
): number {
  let backed = 0;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  for (const hour of hours) {
    const fp = bucketPath(hour);
    if (!fs.existsSync(fp)) continue;

    const backupFp = fp.replace(/\.json$/, `.backup-${ts}.json`);
    if (dryRun) {
      console.log(`${tag} Would back up: ${fp}`);
    } else {
      fs.copyFileSync(fp, backupFp);
      console.log(`${tag} Backed up: ${path.basename(fp)}`);
    }
    backed++;
  }
  return backed;
}

/** Delete each existing bucket file in `hours`. */
export function deleteBucketFiles(
  hours: string[],
  dryRun: boolean,
  tag = '[recalc]',
): number {
  let deleted = 0;
  for (const hour of hours) {
    const fp = bucketPath(hour);
    if (!fs.existsSync(fp)) continue;

    if (dryRun) {
      console.log(`${tag} Would delete bucket: ${path.basename(fp)}`);
    } else {
      fs.unlinkSync(fp);
    }
    deleted++;
  }
  return deleted;
}
