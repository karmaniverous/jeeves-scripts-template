/**
 * @module openclaw-db/real-events-v23
 *
 * Test-only builders for transcript events shaped like real OpenClaw
 * 2026.9.6 agent-DB rows (session header, user message, injected
 * `openclaw.runtime-context` custom message, assistant usage). Shared by
 * the channel-naming tests.
 */

/** Session header event (first row of every transcript). */
export const sessionHeader = (id: string): string =>
  JSON.stringify({
    type: 'session',
    version: 4,
    id,
    timestamp: '2026-09-24T18:13:30.953Z',
    cwd: '/opt/jeeves/workspace',
  });

/** Plain user message. */
export const userMessage = (text: string): string =>
  JSON.stringify({
    type: 'message',
    id: 'u1',
    parentId: null,
    timestamp: '2026-09-24T18:13:30.952Z',
    message: { role: 'user', content: text },
  });

/**
 * The runtime-context block OpenClaw 2026.9 injects before each inbound
 * turn. The "Slack DM from <name>" line is followed by the injected
 * approvals/exec/subagent sections that the legacy DM rule used to absorb.
 */
export const runtimeContext = (senderName: string): string =>
  JSON.stringify({
    type: 'custom_message',
    customType: 'openclaw.runtime-context',
    content: [
      '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>',
      'Conversation info:',
      '```json',
      JSON.stringify({
        chat_id: 'user:U000EXAMPLE2',
        message_id: '1790273602.735929',
        sender: { id: 'U000EXAMPLE2', name: senderName },
        timestamp: 'Thu 2026-09-24 18:13:22 UTC',
        group_space: 'T000EXAMPLE1',
        inbound_event_kind: 'user_request',
      }),
      '```',
      '',
      `System: [2026-09-24 18:13:25 UTC] Slack DM from ${senderName}`,
      '',
      '## Approved executables',
      'none',
      '',
      'Active exec sessions:',
      'none',
      '',
      '## Active Subagents',
      'none',
      '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
    ].join('\n'),
  });

/** Assistant message carrying usage (priced by the test rate card). */
export const assistantUsage = (tsIso: string, input = 100): string =>
  JSON.stringify({
    type: 'message',
    timestamp: tsIso,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + 50,
      },
    },
  });

/** A real-shaped session_nodes.entry_json for a Slack channel session. */
export const slackChannelEntry = (channelId: string, name: string) => ({
  displayName: `slack:t000example2#${name}`,
  chatType: 'channel',
  groupChannel: `#${name}`,
  delivery: {
    kind: 'external',
    route: { channel: 'slack', target: { to: `channel:${channelId}` } },
    origin: {
      label: `slack:channel:${channelId}`,
      provider: 'slack',
      chatType: 'channel',
    },
  },
});

/** A real-shaped session_nodes.entry_json for a Slack DM session. */
export const slackDirectEntry = (userId: string, peer: string) => ({
  chatType: 'direct',
  delivery: {
    kind: 'external',
    route: { channel: 'slack', target: { to: `user:${userId}` } },
    origin: { label: peer, provider: 'slack', chatType: 'direct' },
  },
});
