#!/usr/bin/env tsx
/**
 * @module patch-subagent-message-tool
 *
 * Re-enable the `message` tool for sub-agents spawned via
 * `sessions_spawn` (e.g. runner-dispatched LLM workers that read Slack
 * or post results). OpenClaw blocks it in two layers; both are patched:
 *
 * 1. Spawn flag: `disableMessageTool: true` → `false` in the sub-agent
 *    launch request (anchored on `lane: AGENT_LANE_SUBAGENT`).
 * 2. Deny list: `"message"` removed from `SUBAGENT_TOOL_DENY_ALWAYS`.
 *
 * Chunks are located by content across `.js` and `.mjs` (OpenClaw
 * 2026.9.6+ ships hashed `.mjs` chunks). Each layer must match exactly
 * once across the whole dist; zero or multiple matches abort that layer.
 *
 * - Idempotent: already-patched layers are reported and left alone.
 * - `--dry-run`: print file, line, before/after; write nothing.
 * - Designed to run after every `npm install -g openclaw@latest`
 *   (restart the gateway afterwards to load the patched code).
 *
 * Usage: tsx src/admin/patch-subagent-message-tool.ts [--dry-run]
 */

import { runScript } from '@karmaniverous/jeeves';

import { applyDistPlan, findChunks, isDryRun } from './lib/dist-patch-io.js';
import { resolveOpenClawDist } from './lib/resolve-openclaw-dist.js';
import {
  DENY_LIST_PREFILTER,
  patchDenyList,
  patchSpawnFlag,
  SPAWN_FLAG_PREFILTER,
} from './lib/subagent-message-patches.js';
import { planAcrossFiles, type TextPatchResult } from './lib/text-patch.js';

const TAG = 'patch-subagent-message-tool';

const LAYERS: {
  label: string;
  prefilter: string;
  patch: (content: string) => TextPatchResult;
}[] = [
  {
    label: 'spawn flag (disableMessageTool)',
    prefilter: SPAWN_FLAG_PREFILTER,
    patch: patchSpawnFlag,
  },
  {
    label: 'deny list (SUBAGENT_TOOL_DENY_ALWAYS)',
    prefilter: DENY_LIST_PREFILTER,
    patch: patchDenyList,
  },
];

function patchSubagentMessageTool(): void {
  const dryRun = isDryRun();
  const distDir = resolveOpenClawDist();
  console.log(
    `[${TAG}] ${dryRun ? 'DRY RUN — ' : ''}OpenClaw dist: ${distDir}`,
  );

  let ok = true;
  for (const layer of LAYERS) {
    const results = findChunks(distDir, layer.prefilter).map((c) => ({
      file: c.file,
      result: layer.patch(c.content),
    }));
    ok =
      applyDistPlan(
        TAG,
        layer.label,
        distDir,
        planAcrossFiles(results),
        dryRun,
      ) && ok;
  }

  if (!ok) process.exitCode = 1;
}

runScript(TAG, patchSubagentMessageTool);
