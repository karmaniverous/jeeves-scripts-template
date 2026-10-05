/**
 * @module google-drive/lib/apply
 *
 * Filesystem side of the sync (spec §6.5, §7.2): scan the owned tree,
 * delete, move, write atomically via the staging directory, and prune
 * directories that fell out of the canonical tree (with their `.meta/`).
 *
 * Every path is resolved under `targetDir` and checked to stay inside
 * it; `targetDir` itself is never removed.
 */

import fs from 'node:fs';
import path from 'node:path';

const META = '.meta';

/** Error codes Windows raises while another process (an indexer, AV) holds a file open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Block the thread for `ms` (the sync's file operations are synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `fs.renameSync`, retried with backoff on Windows' transient sharing
 * errors: replacing a file the watcher is reading fails with `EPERM` /
 * `EBUSY` until the reader closes it. POSIX renames never hit this, so
 * there the first error is thrown.
 */
export function renameWithRetry(
  from: string,
  to: string,
  opts: { retry?: boolean; attempts?: number; baseMs?: number } = {},
): void {
  const retry = opts.retry ?? process.platform === 'win32';
  const attempts = opts.attempts ?? 6;
  const baseMs = opts.baseMs ?? 50;
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!retry || i >= attempts || !TRANSIENT_RENAME_CODES.has(code))
        throw err;
      sleepSync(baseMs * 2 ** (i - 1));
    }
  }
}

/**
 * Refuse a symlink at any existing component of `abs` below `base`
 * (`abs` itself included). Lexical containment isn't enough: a linked
 * directory would redirect scans, writes and deletions outside the tree.
 * `base` itself may be a link (e.g. a mounted content dir).
 */
export function assertNoSymlinks(base: string, abs: string): void {
  let cur = path.resolve(base);
  for (const seg of path
    .relative(cur, path.resolve(abs))
    .split(path.sep)
    .filter(Boolean)) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // the rest doesn't exist yet
    }
    if (st.isSymbolicLink())
      throw new Error(`apply: refusing symlink in the owned tree: ${cur}`);
  }
}

/** Resolve `rel` under `root`, refusing anything that escapes it, lexically or via a symlink. */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${path.sep}`) ||
    path.isAbsolute(back)
  ) {
    throw new Error(`apply: path escapes target dir: ${rel}`);
  }
  assertNoSymlinks(root, path.dirname(abs));
  return abs;
}

export interface TreeScan {
  files: string[];
  metaDirs: string[];
  dirs: string[];
}

/**
 * Walk `targetDir`: files (relative, `.meta/` contents excluded), dirs, and
 * dirs holding a `.meta/`. Other dot-entries (e.g. the `.gitignore` the
 * watcher's VCS exclusion writes) are platform-owned and invisible to the
 * sync; synced names can never start with a dot (sanitization trims it).
 */
export function scanTree(targetDir: string): TreeScan {
  const scan: TreeScan = { files: [], metaDirs: [], dirs: [] };
  if (!fs.existsSync(targetDir)) return scan;
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(targetDir, rel), {
      withFileTypes: true,
    })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === META) {
          if (rel) scan.metaDirs.push(rel);
          continue;
        }
        if (entry.name.startsWith('.')) continue;
        scan.dirs.push(childRel);
        walk(childRel);
      } else if (!entry.name.startsWith('.')) {
        scan.files.push(childRel);
      }
    }
  };
  walk('');
  return scan;
}

export function deleteFiles(targetDir: string, rels: string[]): void {
  for (const rel of rels) fs.rmSync(safeJoin(targetDir, rel), { force: true });
}

export function moveFile(targetDir: string, from: string, to: string): void {
  const dest = safeJoin(targetDir, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  renameWithRetry(safeJoin(targetDir, from), dest);
}

/** Write via a staging file, then rename into place (atomic on one device). */
export function writeAtomic(
  targetDir: string,
  rel: string,
  content: string,
  stagingFile: string,
): void {
  const dest = safeJoin(targetDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(stagingFile, content, 'utf8');
  renameWithRetry(stagingFile, dest);
}

/** Recreate an empty staging directory; verify it shares a device with `targetDir`. */
export function prepareStaging(stagingDir: string, targetDir: string): void {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  if (fs.statSync(stagingDir).dev !== fs.statSync(targetDir).dev) {
    throw new Error(
      `staging dir ${stagingDir} and target dir ${targetDir} are on different filesystems; rename would not be atomic`,
    );
  }
}

/** True when a `.meta/.lock` exists and is younger than `staleMinutes`. */
export function metaLockHeld(
  dirAbs: string,
  staleMinutes: number,
  now = Date.now(),
): boolean {
  const lock = path.join(dirAbs, META, '.lock');
  if (!fs.existsSync(lock)) return false;
  return now - fs.statSync(lock).mtimeMs < staleMinutes * 60_000;
}

export interface PruneResult {
  removedDirs: string[];
  heldLocks: string[];
}

/**
 * Remove directories outside `desiredDirs`, deepest first. A directory
 * holding a `.meta/` is removed only if listed in `metaDeletes` (the
 * guard already approved it) and its lock isn't held; otherwise it stays.
 */
export function pruneDirs(
  targetDir: string,
  desiredDirs: Set<string>,
  metaDeletes: string[],
  lockStaleMinutes: number,
): PruneResult {
  const result: PruneResult = { removedDirs: [], heldLocks: [] };
  const approved = new Set(metaDeletes);
  const dirs = scanTree(targetDir).dirs.sort(
    (a, b) => b.split('/').length - a.split('/').length,
  );
  for (const rel of dirs) {
    if (desiredDirs.has(rel)) continue;
    const abs = safeJoin(targetDir, rel);
    if (!fs.existsSync(abs)) continue;
    const entries = fs.readdirSync(abs);
    const hasMeta = entries.includes(META);
    if (entries.some((e) => e !== META)) continue; // still holds content (incl. dot-entries)
    if (hasMeta) {
      if (!approved.has(rel)) continue;
      if (metaLockHeld(abs, lockStaleMinutes)) {
        result.heldLocks.push(rel);
        continue;
      }
    }
    fs.rmSync(abs, { recursive: true, force: true });
    result.removedDirs.push(rel);
  }
  return result;
}

/** True when any file (outside `.meta/`) exists beneath `rel`. */
export function subtreeHasFile(targetDir: string, rel: string): boolean {
  const abs = safeJoin(targetDir, rel);
  if (!fs.existsSync(abs)) return false;
  return scanTree(abs).files.length > 0;
}

export function hasMeta(targetDir: string, rel: string): boolean {
  return fs.existsSync(path.join(safeJoin(targetDir, rel), META));
}
