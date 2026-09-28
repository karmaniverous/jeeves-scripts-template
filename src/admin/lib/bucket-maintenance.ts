/**
 * @module bucket-maintenance
 *
 * Backup and delete hourly bucket files for a set of hours — the
 * destructive half of recalculate/regenerate. Backups are written beside
 * each bucket as `<hour>.backup-<timestamp>.json` (one timestamp per call,
 * `:`/`.` replaced by `-`). Honors `dryRun` (log only, touch nothing).
 * A failed copy throws, so callers that back up before deleting never
 * delete a bucket without its recovery point.
 */

import fs from 'node:fs';
import path from 'node:path';

import { TOKEN_METRICS_DIR } from '../../lib/constants.js';
import { bucketPath } from './bucket-io.js';

/**
 * Copy each existing bucket file in `hours` to a timestamped backup.
 *
 * @returns number of buckets backed up (or that would be, when dry)
 * @throws when a copy fails
 */
export function backupBucketFiles(
  hours: string[],
  dryRun: boolean,
  tag = '[recalc]',
  baseDir: string = TOKEN_METRICS_DIR,
): number {
  let backed = 0;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  for (const hour of hours) {
    const fp = bucketPath(hour, baseDir);
    if (!fs.existsSync(fp)) continue;

    const backupFp = fp.replace(/\.json$/, `.backup-${ts}.json`);
    if (dryRun) {
      console.log(`${tag} Would back up: ${fp}`);
    } else {
      fs.copyFileSync(fp, backupFp, fs.constants.COPYFILE_EXCL);
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
  baseDir: string = TOKEN_METRICS_DIR,
): number {
  let deleted = 0;
  for (const hour of hours) {
    const fp = bucketPath(hour, baseDir);
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
