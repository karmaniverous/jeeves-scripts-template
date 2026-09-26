#!/usr/bin/env tsx
/**
 * @module patch-tool-order
 *
 * Patch OpenClaw's toolOrder array to insert Jeeves component tools
 * (watcher_search, watcher_scan) above `grep`, so the model sees
 * semantic search tools before filesystem discovery tools.
 *
 * - Idempotent: no-ops if already patched.
 * - Safe: uninstalled tools are filtered out at prompt-build time.
 * - `--dry-run`: report the would-be toolOrder; write nothing.
 * - Designed to run after every `npm install -g openclaw@latest`.
 *
 * Usage: tsx src/admin/patch-tool-order.ts [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite, runScript } from '@karmaniverous/jeeves';

import { isDryRun } from './lib/dist-patch-io.js';
import {
  buildToolOrderString,
  parseToolOrder,
} from './lib/patch-tool-order-utils.js';
import { resolveOpenClawDist } from './lib/resolve-openclaw-dist.js';

// ── Config ─────────────────────────────────────────────────────────────

/** Tools to insert, in order. */
const TOOLS_TO_INSERT = ['watcher_search', 'watcher_scan'];

/** Insert before this tool in the toolOrder array. */
const INSERT_BEFORE = 'grep';

/**
 * Find the dist file containing the toolOrder array.
 * Scans all system-prompt-* files (.js and .mjs).
 */
function findToolOrderFile(distDir: string): string | null {
  const candidates = fs
    .readdirSync(distDir)
    .filter(
      (f) =>
        f.startsWith('system-prompt') &&
        (f.endsWith('.js') || f.endsWith('.mjs')),
    );

  for (const file of candidates) {
    const filePath = path.join(distDir, file);
    const content = fs.readFileSync(filePath, 'utf8');

    if (/toolOrder\s*=\s*\[/.test(content)) {
      return filePath;
    }
  }

  return null;
}

// ── Core logic ─────────────────────────────────────────────────────────

function patchToolOrder(): void {
  const dryRun = isDryRun();
  const distDir = resolveOpenClawDist();
  console.log(
    `[patch-tool-order] ${dryRun ? 'DRY RUN — ' : ''}OpenClaw dist: ${distDir}`,
  );

  const filePath = findToolOrderFile(distDir);

  if (!filePath) {
    console.error(
      '[patch-tool-order] Could not find toolOrder array in any system-prompt file.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[patch-tool-order] Found toolOrder in: ${path.basename(filePath)}`,
  );

  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseToolOrder(content);

  if (!parsed) {
    console.error('[patch-tool-order] Failed to parse toolOrder array.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `[patch-tool-order] Current toolOrder (${String(parsed.tools.length)} entries): ${parsed.tools.join(', ')}`,
  );

  // Check if already patched.
  const alreadyPresent = TOOLS_TO_INSERT.filter((t) =>
    parsed.tools.includes(t),
  );

  if (alreadyPresent.length === TOOLS_TO_INSERT.length) {
    console.log('[patch-tool-order] Already patched — nothing to do.');
    return;
  }

  if (alreadyPresent.length > 0) {
    console.log(
      `[patch-tool-order] Partially patched (found: ${alreadyPresent.join(', ')}). Removing before re-inserting.`,
    );
  }

  // Remove any already-present tools so we can re-insert cleanly.
  const cleaned = parsed.tools.filter((t) => !TOOLS_TO_INSERT.includes(t));

  // Find insertion point.
  const insertIdx = cleaned.indexOf(INSERT_BEFORE);

  if (insertIdx === -1) {
    console.error(
      `[patch-tool-order] Anchor tool "${INSERT_BEFORE}" not found in toolOrder. Aborting.`,
    );
    process.exitCode = 1;
    return;
  }

  // Splice in the new tools.
  const patched = [
    ...cleaned.slice(0, insertIdx),
    ...TOOLS_TO_INSERT,
    ...cleaned.slice(insertIdx),
  ];

  console.log(
    `[patch-tool-order] Patched toolOrder (${String(patched.length)} entries): ${patched.join(', ')}`,
  );

  // Replace in file content.
  const patchedString = buildToolOrderString(parsed.prefix, patched);
  const newContent = content.replace(parsed.match, patchedString);

  if (dryRun) {
    console.log(
      `[patch-tool-order] WOULD PATCH ${path.basename(filePath)} (dry run, nothing written).`,
    );
    return;
  }

  atomicWrite(filePath, newContent);

  console.log('[patch-tool-order] Patched successfully.');
}

runScript('patch-tool-order', patchToolOrder);
