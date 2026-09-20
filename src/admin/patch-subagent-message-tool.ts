#!/usr/bin/env tsx
/**
 * @module patch-subagent-message-tool
 *
 * Patch OpenClaw's subagent-spawn code to enable the message tool
 * for subagent sessions. The upstream code hardcodes
 * `disableMessageTool: true` for all sessions_spawn subagents,
 * preventing runner-dispatched workers from reading Slack channels
 * or posting results via the message tool.
 *
 * - Idempotent: no-ops if already patched.
 * - Targeted: only patches the subagent-spawn occurrence in
 *   openclaw-tools-*.js, not crestodian or other internal uses.
 * - Designed to run after every `npm install -g openclaw@latest`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runScript } from '@karmaniverous/jeeves';

import { resolveOpenClawDist } from './lib/resolve-openclaw-dist.js';

// ── Config ─────────────────────────────────────────────────────────────

const SEARCH = 'disableMessageTool: true';
const REPLACE = 'disableMessageTool: false';

/**
 * Target file pattern. The subagent-spawn `disableMessageTool: true`
 * lives in openclaw-tools-*.js. The other occurrence (crestodian) is
 * in chat-engine-*.js, which we leave untouched.
 */
const FILE_PATTERN = /^openclaw-tools-.*\.js$/;

/**
 * Context anchor to verify we're patching the right occurrence.
 * `cleanupBundleMcpOnRunEnd` appears near `disableMessageTool` only
 * in the subagent-spawn path.
 */
const CONTEXT_ANCHOR = 'cleanupBundleMcpOnRunEnd';

// ── Core logic ─────────────────────────────────────────────────────────

function patchSubagentMessageTool(): void {
  const distDir = resolveOpenClawDist();
  console.log(`[patch-subagent-message-tool] OpenClaw dist: ${distDir}`);

  const files = fs.readdirSync(distDir).filter((f) => FILE_PATTERN.test(f));

  if (files.length === 0) {
    console.error(
      '[patch-subagent-message-tool] No openclaw-tools-*.js file found.',
    );
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    const filePath = path.join(distDir, file);
    const content = fs.readFileSync(filePath, 'utf8');

    // Verify context anchor is present (confirms this is the right file).
    if (!content.includes(CONTEXT_ANCHOR)) {
      console.log(
        `[patch-subagent-message-tool] ${file}: no context anchor — skipping.`,
      );
      continue;
    }

    console.log(`[patch-subagent-message-tool] Found target: ${file}`);

    // Check if already patched.
    if (!content.includes(SEARCH)) {
      if (content.includes(REPLACE)) {
        console.log(
          '[patch-subagent-message-tool] Already patched — nothing to do.',
        );
        return;
      }
      console.error(
        '[patch-subagent-message-tool] Neither search nor replace string found. Aborting.',
      );
      process.exitCode = 1;
      return;
    }

    // Count occurrences to ensure we're patching exactly one.
    const count = content.split(SEARCH).length - 1;

    if (count !== 1) {
      console.error(
        `[patch-subagent-message-tool] Expected 1 occurrence of "${SEARCH}" in ${file}, found ${String(count)}. Aborting.`,
      );
      process.exitCode = 1;
      return;
    }

    const newContent = content.replace(SEARCH, REPLACE);

    // Atomic write.
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, newContent, 'utf8');
    fs.renameSync(tmpPath, filePath);

    console.log('[patch-subagent-message-tool] Patched successfully.');
    return;
  }

  console.error(
    '[patch-subagent-message-tool] No matching file with context anchor found.',
  );
  process.exitCode = 1;
}

runScript('patch-subagent-message-tool', patchSubagentMessageTool);
