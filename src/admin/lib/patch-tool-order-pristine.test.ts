import { describe, expect, it } from 'vitest';

import {
  evaluateToolOrderPatch,
  parseToolOrder,
} from './patch-tool-order-utils.js';

/** Tool names as written in the pristine OpenClaw 2026.9.6 toolOrder. */
const PRISTINE_TOKENS = [
  '"read"',
  '"write"',
  '"edit"',
  '"apply_patch"',
  '"grep"',
  '"find"',
  '"ls"',
  '"exec"',
  '"process"',
  '"web_search"',
  '"web_fetch"',
  '"browser"',
  '"screen"',
  '"theme"',
  '"terminal"',
  '"canvas"',
  '"nodes"',
  'AUTOMATIONS_TOOL_NAME',
  '"message"',
  '"conversations_list"',
  '"conversations_send"',
  '"conversations_turn"',
  '"openclaw"',
  '"gateway"',
  '"agents_list"',
  '"sessions_list"',
  '"sessions_history"',
  '"sessions_search"',
  '"sessions_send"',
  '"sessions_spawn"',
  '"sessions_yield"',
  '"subagents"',
  '"session_status"',
  '"skill_workshop"',
  '"view_image"',
  '"image_generate"',
];

const arrayOf = (tokens: readonly string[]): string =>
  `const toolOrder = [\n${tokens.map((t) => `\t\t${t}`).join(',\n')}\n\t]`;

/**
 * Shaped like dist/system-prompt-params-DdCWVctq.mjs (2026.9.6): the
 * array sits inside a function body between tool summaries and its use.
 */
const PRISTINE = [
  '\t\timage_generate: "Generate/edit images"',
  '\t};',
  `\t${arrayOf(PRISTINE_TOKENS)};`,
  '\tconst resolveToolName = (normalized) => visibleTools.get(normalized) ?? normalized;',
  '',
].join('\n');

const INSERT = ['watcher_search', 'watcher_scan'];

describe('evaluateToolOrderPatch against the pristine 2026.9.6 shape', () => {
  it('inserts watcher tools before grep and changes nothing else', () => {
    const r = evaluateToolOrderPatch(PRISTINE, INSERT, 'grep');
    expect(r.status).toBe('patch');
    if (r.status !== 'patch') return;
    const grep = PRISTINE_TOKENS.indexOf('"grep"');
    const expected = [
      ...PRISTINE_TOKENS.slice(0, grep),
      '"watcher_search"',
      '"watcher_scan"',
      ...PRISTINE_TOKENS.slice(grep),
    ];
    expect(r.after).toBe(arrayOf(expected));
    expect(r.content).toBe(
      PRISTINE.replace(arrayOf(PRISTINE_TOKENS), arrayOf(expected)),
    );
  });

  it('keeps AUTOMATIONS_TOOL_NAME as a bare identifier', () => {
    const r = evaluateToolOrderPatch(PRISTINE, INSERT, 'grep');
    if (r.status !== 'patch') throw new Error(r.status);
    expect(r.content).toContain('\t\tAUTOMATIONS_TOOL_NAME,\n');
    expect(r.content).not.toContain('"AUTOMATIONS_TOOL_NAME"');
    expect(parseToolOrder(r.content)!.entries).toContainEqual({
      raw: 'AUTOMATIONS_TOOL_NAME',
      name: 'AUTOMATIONS_TOOL_NAME',
    });
  });

  it('is idempotent: a second pass reports already-patched', () => {
    const r = evaluateToolOrderPatch(PRISTINE, INSERT, 'grep');
    if (r.status !== 'patch') throw new Error(r.status);
    expect(evaluateToolOrderPatch(r.content, INSERT, 'grep').status).toBe(
      'already-patched',
    );
  });
});
