/**
 * @module dist-patch-io
 *
 * Filesystem side of the OpenClaw post-install patches: locate candidate
 * chunks in the dist directory (both `.js` and `.mjs`, found by content
 * rather than by hashed chunk name) and apply or preview a patch plan.
 */

import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite } from '@karmaniverous/jeeves';

import type { DistPatchPlan } from './text-patch.js';

/** A dist chunk whose content contains a given marker. */
export interface DistChunk {
  file: string;
  filePath: string;
  content: string;
}

/** True when the CLI was invoked with `--dry-run`. */
export function isDryRun(argv: string[] = process.argv): boolean {
  return argv.includes('--dry-run');
}

/** List top-level `.js` / `.mjs` chunks in the dist directory. */
export function listDistChunks(distDir: string): string[] {
  return fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .sort();
}

/** Read every chunk whose content includes `marker`. */
export function findChunks(distDir: string, marker: string): DistChunk[] {
  const out: DistChunk[] = [];
  for (const file of listDistChunks(distDir)) {
    const filePath = path.join(distDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(marker)) out.push({ file, filePath, content });
  }
  return out;
}

const indent = (s: string): string =>
  s
    .split('\n')
    .map((l) => `    | ${l}`)
    .join('\n');

/**
 * Report (and unless dry-run, write) a patch plan. Returns false when the
 * plan is an error so callers can set a non-zero exit code.
 */
export function applyDistPlan(
  tag: string,
  label: string,
  distDir: string,
  plan: DistPatchPlan,
  dryRun: boolean,
): boolean {
  if (plan.status === 'error') {
    console.error(`[${tag}] ${label}: FAILED — ${plan.message}`);
    return false;
  }

  if (plan.status === 'already-patched') {
    console.log(
      `[${tag}] ${label}: already patched (${plan.file}:${String(plan.result.line)}).`,
    );
    return true;
  }

  const { file, result } = plan;
  console.log(
    `[${tag}] ${label}: ${dryRun ? 'WOULD PATCH' : 'patching'} ${file}:${String(result.line)}`,
  );
  console.log(`  before:\n${indent(result.before)}`);
  console.log(`  after:\n${indent(result.after)}`);

  if (!dryRun) {
    atomicWrite(path.join(distDir, file), result.content);
    console.log(`[${tag}] ${label}: patched.`);
  }
  return true;
}
