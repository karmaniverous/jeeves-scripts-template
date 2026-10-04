/**
 * @module same-path
 *
 * Whether two paths name the same file-system location once symlinks
 * (and Windows junctions) are followed. A path that does not exist yet is
 * canonicalized through its nearest existing ancestor, so a new directory
 * under a symlinked parent still compares equal to its target.
 *
 * Called by regenerate-token-metrics.ts to keep `--out` off the live
 * bucket store.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Real path of `p`, resolving its nearest existing ancestor. */
function canonicalPath(p: string): string {
  const absolute = path.resolve(p);
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      const real = path.join(fs.realpathSync.native(head), ...tail);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * True when `a` and `b` resolve to the same location (case-insensitive on
 * Windows).
 */
export function isSamePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}
