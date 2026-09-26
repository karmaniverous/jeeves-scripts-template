#!/usr/bin/env tsx
/**
 * @module patch-also-allow-policy
 *
 * Ensure OpenClaw's `hasRestrictiveAllowPolicy` does not treat
 * `tools.alsoAllow`-only config (e.g. `["group:plugins"]`) as a
 * restrictive allowlist. Otherwise HTTP-spawned children (e.g. jeeves-meta
 * synthesis) inherit an incomplete allowlist and lose core tools.
 *
 * - OpenClaw ≥ 2026.9.x fixed this upstream (wildcard bail): the script
 *   verifies that and exits 0 without touching anything.
 * - Older builds get the legacy early-bail on
 *   `IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW`.
 * - Zero or multiple definitions, or unrecognised layouts, fail loudly so
 *   drift gets reviewed (nothing is patched).
 * - `--dry-run`: preview only.
 *
 * Usage: tsx src/admin/patch-also-allow-policy.ts [--dry-run]
 */

import { runScript } from '@karmaniverous/jeeves';

import {
  ALSO_ALLOW_PREFILTER,
  classifyAlsoAllowPolicy,
  decideAlsoAllow,
  patchLegacyAlsoAllow,
} from './lib/also-allow-policy.js';
import { applyDistPlan, findChunks, isDryRun } from './lib/dist-patch-io.js';
import { resolveOpenClawDist } from './lib/resolve-openclaw-dist.js';
import { planAcrossFiles } from './lib/text-patch.js';

const TAG = 'patch-also-allow-policy';

function patchAlsoAllowPolicy(): void {
  const dryRun = isDryRun();
  const distDir = resolveOpenClawDist();
  console.log(
    `[${TAG}] ${dryRun ? 'DRY RUN — ' : ''}OpenClaw dist: ${distDir}`,
  );

  const chunks = findChunks(distDir, ALSO_ALLOW_PREFILTER).map((c) => ({
    ...c,
    ...classifyAlsoAllowPolicy(c.content),
  }));

  for (const c of chunks.filter((c) => c.state !== 'absent')) {
    console.log(`[${TAG}] ${c.file}:${String(c.line ?? '?')} — ${c.state}`);
  }

  const decision = decideAlsoAllow(chunks);
  if (decision.action === 'fail') {
    console.error(`[${TAG}] FAILED — ${decision.message}`);
    process.exitCode = 1;
    return;
  }
  if (decision.action === 'noop') {
    console.log(`[${TAG}] ${decision.message}`);
    return;
  }

  const target = chunks.find((c) => c.file === decision.file);
  const plan = planAcrossFiles(
    target
      ? [{ file: target.file, result: patchLegacyAlsoAllow(target.content) }]
      : [],
  );
  if (!applyDistPlan(TAG, 'legacy early bail', distDir, plan, dryRun)) {
    process.exitCode = 1;
  }
}

runScript(TAG, patchAlsoAllowPolicy);
