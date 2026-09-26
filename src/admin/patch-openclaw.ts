#!/usr/bin/env tsx
/**
 * @module patch-openclaw
 *
 * Orchestrator: run all OpenClaw post-install patches.
 *
 * Designed to run after every `npm install -g openclaw@latest`. Each patch
 * script runs as its own child process; a failure in one does not skip
 * the others. Prints a per-patch summary and exits non-zero if any patch
 * failed. `--dry-run` is forwarded to every patch (nothing is written).
 *
 * Restart the gateway after a live run so it loads the patched dist.
 *
 * Usage: tsx src/admin/patch-openclaw.ts [--dry-run]
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '@karmaniverous/jeeves';

import { isDryRun } from './lib/dist-patch-io.js';
import {
  describeExecFailure,
  formatPatchSummary,
  type PatchRunResult,
  runAllPatches,
} from './lib/patch-runner.js';

// ── Config ─────────────────────────────────────────────────────────────

/** Patch scripts to run, in order. */
const PATCHES = [
  'patch-tool-order.ts',
  'patch-also-allow-policy.ts',
  'patch-subagent-message-tool.ts',
];

// ── Core logic ─────────────────────────────────────────────────────────

function runPatchScript(
  adminDir: string,
  script: string,
  args: string[],
): PatchRunResult {
  const scriptPath = path.join(adminDir, script);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[patch-openclaw] Running: ${script} ${args.join(' ')}`);
  console.log('─'.repeat(60));

  try {
    const flags = args.map((a) => ` ${a}`).join('');
    execSync(`tsx "${scriptPath}"${flags}`, {
      stdio: 'inherit',
    });
    return { script, ok: true, exitCode: 0 };
  } catch (err) {
    return { script, ok: false, ...describeExecFailure(err) };
  }
}

function patchOpenClaw(): void {
  const adminDir = path.dirname(fileURLToPath(import.meta.url));
  const args = isDryRun() ? ['--dry-run'] : [];

  const results = runAllPatches(PATCHES, (script) =>
    runPatchScript(adminDir, script, args),
  );

  console.log(`\n${'─'.repeat(60)}`);
  console.log(
    `[patch-openclaw] Summary${args.length > 0 ? ' (DRY RUN — nothing written)' : ''}:`,
  );
  for (const line of formatPatchSummary(results)) console.log(line);

  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

runScript('patch-openclaw', patchOpenClaw);
