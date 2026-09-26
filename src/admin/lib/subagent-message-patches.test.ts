import { describe, expect, it } from 'vitest';

import {
  ACP_SPAWN_GATEWAY,
  AGENT_TOOLS_POLICY,
  RECALL_RUN,
  SPAWN_LAUNCH_REQUEST,
} from './openclaw-dist-fixtures.js';
import { patchDenyList, patchSpawnFlag } from './subagent-message-patches.js';

// ── Spawn flag ──────────────────────────────────────────────────────

describe('patchSpawnFlag (v2026.9.6 fixture)', () => {
  it('flips disableMessageTool to false at the AGENT_LANE_SUBAGENT anchor', () => {
    const r = patchSpawnFlag(SPAWN_LAUNCH_REQUEST);
    expect(r.status).toBe('patch');
    if (r.status !== 'patch') return;
    expect(r.before).toBe(
      'lane: AGENT_LANE_SUBAGENT,\n\t\t\tdisableMessageTool: true',
    );
    expect(r.after).toBe(
      'lane: AGENT_LANE_SUBAGENT,\n\t\t\tdisableMessageTool: false',
    );
    expect(r.content).not.toContain('disableMessageTool: true');
    expect(r.content.length).toBe(SPAWN_LAUNCH_REQUEST.length + 1);
    expect(r.line).toBe(23);
  });

  it('is idempotent', () => {
    const first = patchSpawnFlag(SPAWN_LAUNCH_REQUEST);
    if (first.status !== 'patch') throw new Error('expected patch');
    const second = patchSpawnFlag(first.content);
    expect(second.status).toBe('already-patched');
  });

  it('ignores the ACP spawn lane and unrelated disableMessageTool: true', () => {
    expect(patchSpawnFlag(ACP_SPAWN_GATEWAY).status).toBe('not-found');
    expect(patchSpawnFlag(RECALL_RUN).status).toBe('not-found');
    const combined = [ACP_SPAWN_GATEWAY, RECALL_RUN, SPAWN_LAUNCH_REQUEST].join(
      '\n',
    );
    expect(patchSpawnFlag(combined).status).toBe('patch');
  });

  it('reports not-found on zero matches', () => {
    expect(patchSpawnFlag('const x = 1;').status).toBe('not-found');
  });

  it('refuses multiple matches', () => {
    const doubled = `${SPAWN_LAUNCH_REQUEST}\n${SPAWN_LAUNCH_REQUEST}`;
    expect(patchSpawnFlag(doubled).status).toBe('ambiguous');
  });

  it('refuses a mix of patched and unpatched sites', () => {
    const first = patchSpawnFlag(SPAWN_LAUNCH_REQUEST);
    if (first.status !== 'patch') throw new Error('expected patch');
    const mixed = `${first.content}\n${SPAWN_LAUNCH_REQUEST}`;
    expect(patchSpawnFlag(mixed).status).toBe('ambiguous');
  });

  it('tolerates whitespace variations', () => {
    const r = patchSpawnFlag(
      'lane:AGENT_LANE_SUBAGENT,disableMessageTool:true,',
    );
    expect(r).toMatchObject({
      status: 'patch',
      content: 'lane:AGENT_LANE_SUBAGENT,disableMessageTool:false,',
    });
  });
});

// ── Deny list ───────────────────────────────────────────────────────

describe('patchDenyList (v2026.9.6 fixture)', () => {
  it('removes "message" and keeps every other entry', () => {
    const r = patchDenyList(AGENT_TOOLS_POLICY);
    expect(r.status).toBe('patch');
    if (r.status !== 'patch') return;
    expect(r.before).toContain('"message"');
    expect(r.after).not.toContain('"message"');
    expect(r.after).toBe(
      [
        'const SUBAGENT_TOOL_DENY_ALWAYS = [',
        '\t"gateway",',
        '\t"agents_list",',
        '\t"openclaw",',
        '\t"session_status",',
        '\t"progress_card",',
        '\tAUTOMATIONS_TOOL_NAME,',
        '\t"sessions_send",',
        '\t"conversations_list",',
        '\t"conversations_send",',
        '\t"conversations_turn"',
        ']',
      ].join('\n'),
    );
    // Leaf list and spreads untouched.
    expect(r.content).toContain('...SUBAGENT_TOOL_DENY_LEAF');
    expect(r.content).toContain('"sessions_spawn"');
    expect(r.line).toBe(11);
  });

  it('is idempotent', () => {
    const first = patchDenyList(AGENT_TOOLS_POLICY);
    if (first.status !== 'patch') throw new Error('expected patch');
    expect(patchDenyList(first.content).status).toBe('already-patched');
  });

  it.each([
    [
      'last element',
      'const SUBAGENT_TOOL_DENY_ALWAYS = ["a", "message"];',
      'const SUBAGENT_TOOL_DENY_ALWAYS = ["a"];',
    ],
    [
      'first element',
      "const SUBAGENT_TOOL_DENY_ALWAYS = ['message', 'a'];",
      "const SUBAGENT_TOOL_DENY_ALWAYS = ['a'];",
    ],
    [
      'only element',
      'let SUBAGENT_TOOL_DENY_ALWAYS=["message"];',
      'let SUBAGENT_TOOL_DENY_ALWAYS=[];',
    ],
    [
      'compact',
      'var SUBAGENT_TOOL_DENY_ALWAYS=["a","message","b"];',
      'var SUBAGENT_TOOL_DENY_ALWAYS=["a","b"];',
    ],
  ])('handles %s', (_name, input, expected) => {
    const r = patchDenyList(input);
    expect(r).toMatchObject({ status: 'patch', content: expected });
  });

  it('reports not-found when the declaration is absent', () => {
    expect(patchDenyList('return [...SUBAGENT_TOOL_DENY_ALWAYS];').status).toBe(
      'not-found',
    );
  });

  it('refuses multiple declarations', () => {
    const doubled = `${AGENT_TOOLS_POLICY}\n${AGENT_TOOLS_POLICY}`;
    expect(patchDenyList(doubled).status).toBe('ambiguous');
  });

  it('refuses duplicate "message" entries', () => {
    const r = patchDenyList(
      'const SUBAGENT_TOOL_DENY_ALWAYS = ["message", "x", "message"];',
    );
    expect(r.status).toBe('ambiguous');
  });

  it('does not touch entries that merely contain "message"', () => {
    const r = patchDenyList(
      'const SUBAGENT_TOOL_DENY_ALWAYS = ["message_send", "messages"];',
    );
    expect(r.status).toBe('already-patched');
  });
});
