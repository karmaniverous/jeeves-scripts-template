/**
 * @module worker-slack/slack-io
 *
 * Job-side Slack I/O through the gateway's `message` tool
 * (`POST /tools/invoke`, see gateway-client.ts). This is the path
 * session-refresh.ts already uses to post, so no raw bot-token calls. On
 * OpenClaw 2026.9 runner LLM workers (sub-agent sessions) have no
 * `message` tool, so the job script does all Slack reads and posts.
 *
 * Message tool calls used (channel `slack`):
 * - `read`: `{ target, limit, threadId? }` → `{ ok, messages: [...] }`
 * - `send`: `{ target, message, threadId? }` → result with the new ts
 * - `pin`: `{ target, messageId }`
 * - `edit`: `{ target, messageId, message }`
 *
 * An optional Slack `accountId` (multi-account gateways, e.g. `vc`) is
 * passed on every call.
 */

import type { GatewayInvoker } from '../worker-output.js';

/** A Slack message as seen by the job. */
export interface SlackMessage {
  /** Message timestamp (Slack message id). */
  ts: string;
  /** Author user id, when present. */
  user?: string;
  /** Message text. */
  text: string;
  /** Parent thread ts for replies. */
  threadTs?: string;
}

/** Messaging layer used by job scripts (mocked in tests). */
export interface SlackIo {
  /** Read recent messages (oldest first) from a channel or thread. */
  read: (
    target: string,
    options?: { limit?: number; threadTs?: string },
  ) => Promise<SlackMessage[]>;
  /** Post a message; resolves to the new message ts when reported. */
  send: (
    target: string,
    text: string,
    threadTs?: string,
  ) => Promise<string | undefined>;
  /** Pin a message. */
  pin: (target: string, messageId: string) => Promise<void>;
  /** Replace the text of an existing message. */
  edit: (target: string, messageId: string, text: string) => Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Candidate payloads in a tool result, in order: `details`, the JSON in
 * the first text content part (2026.9 returns the Slack response there),
 * and the result itself.
 */
export function toolPayloads(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result)) return [];
  const out: Record<string, unknown>[] = [];
  if (isRecord(result['details'])) out.push(result['details']);
  const content = result['content'];
  if (Array.isArray(content)) {
    const first: unknown = content[0];
    if (isRecord(first) && typeof first['text'] === 'string') {
      try {
        const parsed: unknown = JSON.parse(first['text']);
        if (isRecord(parsed)) out.push(parsed);
      } catch {
        // not JSON; skip
      }
    }
  }
  out.push(result);
  return out;
}

/**
 * Throw when the tool result reports `ok: false`.
 *
 * @param action - Message action, for the error message.
 * @param result - Tool result.
 * @returns The result, unchanged.
 */
export function assertOk(action: string, result: unknown): unknown {
  const failed = toolPayloads(result).find((p) => p['ok'] === false);
  if (failed) {
    const err =
      typeof failed['error'] === 'string' ? failed['error'] : 'unknown error';
    throw new Error(`Slack ${action} failed: ${err}`);
  }
  return result;
}

/** Parse Slack messages from a read result, oldest first. */
export function parseMessages(result: unknown): SlackMessage[] {
  const raw = toolPayloads(result)
    .map((p) => p['messages'])
    .find((m) => Array.isArray(m));
  if (!Array.isArray(raw)) return [];
  const out: SlackMessage[] = [];
  for (const m of raw as unknown[]) {
    if (!isRecord(m) || typeof m['ts'] !== 'string') continue;
    const msg: SlackMessage = {
      ts: m['ts'],
      text: typeof m['text'] === 'string' ? m['text'] : '',
    };
    if (typeof m['user'] === 'string') msg.user = m['user'];
    if (typeof m['thread_ts'] === 'string' && m['thread_ts'] !== m['ts'])
      msg.threadTs = m['thread_ts'];
    out.push(msg);
  }
  return out.sort((a, b) => Number(a.ts) - Number(b.ts));
}

function idIn(payload: Record<string, unknown>, depth = 0): string | undefined {
  for (const key of ['messageId', 'message_id', 'ts']) {
    const v = payload[key];
    if (typeof v === 'string' && v) return v;
  }
  const nested = payload['result'];
  return isRecord(nested) && depth < 2 ? idIn(nested, depth + 1) : undefined;
}

/** Find the posted message ts in a send result. */
export function sentMessageId(result: unknown): string | undefined {
  for (const p of toolPayloads(result)) {
    const id = idIn(p);
    if (id) return id;
  }
  return undefined;
}

/**
 * Build the gateway-backed messaging layer.
 *
 * @param invoke - Gateway tool invoker (gatewayInvoke).
 * @param accountId - Optional Slack account id configured in the gateway.
 * @returns Slack I/O over the gateway `message` tool.
 */
export function gatewaySlackIo(
  invoke: GatewayInvoker,
  accountId?: string,
): SlackIo {
  const call = (args: Record<string, unknown>) =>
    invoke('message', {
      channel: 'slack',
      ...(accountId ? { accountId } : {}),
      ...args,
    });
  return {
    read: async (target, options = {}) => {
      const args: Record<string, unknown> = {
        action: 'read',
        target,
        limit: options.limit ?? 20,
      };
      if (options.threadTs) args['threadId'] = options.threadTs;
      return parseMessages(assertOk('read', await call(args)));
    },
    send: async (target, text, threadTs) => {
      const args: Record<string, unknown> = {
        action: 'send',
        target,
        message: text,
      };
      if (threadTs) args['threadId'] = threadTs;
      return sentMessageId(assertOk('send', await call(args)));
    },
    pin: async (target, messageId) => {
      assertOk('pin', await call({ action: 'pin', target, messageId }));
    },
    edit: async (target, messageId, text) => {
      assertOk(
        'edit',
        await call({ action: 'edit', target, messageId, message: text }),
      );
    },
  };
}
