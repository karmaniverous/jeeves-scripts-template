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
 * - Unrecognised layouts fail loudly so drift gets reviewed.
 * - `--dry-run`: preview only.
 *
 * Usage: tsx src/admin/patch-also-allow-policy.ts [--dry-run]
 */

import { runScript } from '@karmaniverous/jeeves';

import {
  ALSO_ALLOW_PREFILTER,
  classifyAlsoAllowPolicy,
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

  const chunks = findChunks(distDir, ALSO_ALLOW_PREFILTER)
    .map((c) => ({ ...c, ...classifyAlsoAllowPolicy(c.content) }))
    .filter((c) => c.state !== 'absent');

  if (chunks.length === 0) {
    console.error(
      `[${TAG}] FAILED — hasRestrictiveAllowPolicy definition not found in any .js/.mjs chunk.`,
    );
    process.exitCode = 1;
    return;
  }

  for (const c of chunks) {
    console.log(`[${TAG}] ${c.file}:${String(c.line ?? '?')} — ${c.state}`);
  }

  const unknown = chunks.filter((c) => c.state === 'unknown');
  if (unknown.length > 0) {
    console.error(
      `[${TAG}] FAILED — unrecognised hasRestrictiveAllowPolicy in ${unknown.map((c) => c.file).join(', ')}. OpenClaw may have changed; review before patching.`,
    );
    process.exitCode = 1;
    return;
  }

  const legacy = chunks.filter((c) => c.state === 'legacy-unpatched');
  if (legacy.length === 0) {
    const fixed = chunks.every((c) => c.state === 'upstream-fixed');
    console.log(
      fixed
        ? `[${TAG}] Not needed: upstream hasRestrictiveAllowPolicy already treats alsoAllow ("*" + extras) as non-restrictive. No changes.`
        : `[${TAG}] Already patched — nothing to do.`,
    );
    return;
  }

  let ok = true;
  for (const c of legacy) {
    const plan = planAcrossFiles([
      { file: c.file, result: patchLegacyAlsoAllow(c.content) },
    ]);
    ok = applyDistPlan(TAG, 'legacy early bail', distDir, plan, dryRun) && ok;
  }
  if (!ok) process.exitCode = 1;
}

runScript(TAG, patchAlsoAllowPolicy);
