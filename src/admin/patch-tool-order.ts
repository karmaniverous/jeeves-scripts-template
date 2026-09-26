#!/usr/bin/env tsx
/**
 * @module patch-tool-order
 *
 * Patch OpenClaw's toolOrder array to insert Jeeves component tools
 * (watcher_search, watcher_scan) above `grep`, so the model sees
 * semantic search tools before filesystem discovery tools.
 *
 * - Locates the array by content across every `.js` / `.mjs` chunk;
 *   zero or multiple toolOrder assignments abort (fail closed).
 * - Idempotent: no-ops if already patched.
 * - Safe: uninstalled tools are filtered out at prompt-build time.
 * - `--dry-run`: print file, line, before/after; write nothing.
 * - Designed to run after every `npm install -g openclaw@latest`.
 *
 * Usage: tsx src/admin/patch-tool-order.ts [--dry-run]
 */

import { runScript } from '@karmaniverous/jeeves';

import { applyDistPlan, findChunks, isDryRun } from './lib/dist-patch-io.js';
import {
  evaluateToolOrderPatch,
  TOOL_ORDER_PREFILTER,
} from './lib/patch-tool-order-utils.js';
import { resolveOpenClawDist } from './lib/resolve-openclaw-dist.js';
import { planAcrossFiles } from './lib/text-patch.js';

const TAG = 'patch-tool-order';

/** Tools to insert, in order. */
const TOOLS_TO_INSERT = ['watcher_search', 'watcher_scan'];

/** Insert before this tool in the toolOrder array. */
const INSERT_BEFORE = 'grep';

function patchToolOrder(): void {
  const dryRun = isDryRun();
  const distDir = resolveOpenClawDist();
  console.log(
    `[${TAG}] ${dryRun ? 'DRY RUN — ' : ''}OpenClaw dist: ${distDir}`,
  );

  const results = findChunks(distDir, TOOL_ORDER_PREFILTER).map((c) => ({
    file: c.file,
    result: evaluateToolOrderPatch(c.content, TOOLS_TO_INSERT, INSERT_BEFORE),
  }));

  const ok = applyDistPlan(
    TAG,
    'toolOrder',
    distDir,
    planAcrossFiles(results),
    dryRun,
  );
  if (!ok) process.exitCode = 1;
}

runScript(TAG, patchToolOrder);
