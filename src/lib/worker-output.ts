/**
 * @module worker-output
 *
 * Recover an LLM worker's final reply after a dispatch. spawn-worker.ts
 * only reports the session key (WORKER_RESULT line) on stdout, so the
 * job script reads the final assistant message back through the
 * gateway's `chat.history` RPC. Job scripts use this to verify the
 * worker's structured result instead of trusting its exit code.
 *
 * The reply must arrive whole: the `sessions_history` tool caps each
 * text block at 4000 characters, which cut long replies (and their
 * closing `slack-posts` fence). `chat.history` takes a per-request
 * `maxChars`; a reply the gateway still marks as truncated is an error.
 *
 * Config dependencies: none (the gateway RPC caller is injected).
 */

import type { GatewayRpc } from './gateway-rpc.js';
import { parseResultLine } from './spawn-worker.js';

/** Number of trailing history messages to fetch. */
const HISTORY_LIMIT = 20;

/** Largest per-message text limit `chat.history` accepts (its schema max). */
export const HISTORY_MAX_CHARS = 500_000;

/** Text `chat.history` substitutes for an oversized message. */
const OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Find the worker session key in spawn-worker stdout.
 *
 * @param stdout - Captured worker stdout.
 * @returns The session key from the last WORKER_RESULT line, or null.
 */
export function findWorkerSessionKey(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseResultLine(lines[i]);
    if (parsed) return parsed.sessionKey;
  }
  return null;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isRecord(part) &&
        part['type'] === 'text' &&
        typeof part['text'] === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/** The last assistant message that has any text, with that text. */
interface FinalAssistant {
  message: Record<string, unknown>;
  text: string;
}

function findFinalAssistant(messages: unknown): FinalAssistant | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg: unknown = messages[i];
    if (!isRecord(msg) || msg['role'] !== 'assistant') continue;
    const text = messageText(msg['content']).trim();
    if (text) return { message: msg, text };
  }
  return null;
}

/**
 * Extract the text of the last assistant message that has any text.
 *
 * @param messages - History messages (oldest first).
 * @returns The final assistant text, or null when there is none.
 */
export function extractFinalAssistantText(messages: unknown): string | null {
  return findFinalAssistant(messages)?.text ?? null;
}

/** Why the gateway cut this message, or null when it arrived whole. */
function truncationReason({ message, text }: FinalAssistant): string | null {
  const meta = message['__openclaw'];
  if (isRecord(meta) && meta['truncated'] === true) {
    return typeof meta['reason'] === 'string' ? meta['reason'] : 'truncated';
  }
  return text.includes(OMITTED_PLACEHOLDER) ? 'message too large' : null;
}

/**
 * Read the worker's final reply for a completed dispatch.
 *
 * @param stdout - Captured spawn-worker stdout.
 * @param rpc - Gateway RPC caller (gateway-rpc.ts gatewayRpc).
 * @returns The full final assistant text, or null when the session key or
 *   any assistant text is missing.
 * @throws Error if the gateway call fails, or `worker reply truncated by
 *   gateway` if the final reply did not arrive whole.
 */
export async function readWorkerFinalText(
  stdout: string,
  rpc: GatewayRpc,
): Promise<string | null> {
  const sessionKey = findWorkerSessionKey(stdout);
  if (!sessionKey) return null;
  const result = await rpc('chat.history', {
    sessionKey,
    limit: HISTORY_LIMIT,
    maxChars: HISTORY_MAX_CHARS,
  });
  const final = findFinalAssistant(
    isRecord(result) ? result['messages'] : undefined,
  );
  if (!final) return null;
  const reason = truncationReason(final);
  if (reason) {
    throw new Error(
      `worker reply truncated by gateway (session ${sessionKey}: ${reason})`,
    );
  }
  return final.text;
}
