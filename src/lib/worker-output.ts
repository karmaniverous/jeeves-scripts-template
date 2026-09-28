/**
 * @module worker-output
 *
 * Recover an LLM worker's final reply after a dispatch. spawn-worker.ts
 * only reports the session key (WORKER_RESULT line) on stdout, so the
 * job script reads the final assistant message back through the
 * gateway's sessions_history tool. Job scripts use this to verify the
 * worker's structured result instead of trusting its exit code.
 *
 * Config dependencies: none (the gateway invoker is injected).
 */

import { parseResultLine } from './spawn-worker.js';

/** Gateway tool invoker (see gateway-client.ts gatewayInvoke). */
export type GatewayInvoker = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Number of trailing history messages to fetch. */
const HISTORY_LIMIT = 20;

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

/**
 * Extract the text of the last assistant message that has any text.
 *
 * @param messages - sessions_history messages (oldest first).
 * @returns The final assistant text, or null when there is none.
 */
export function extractFinalAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg: unknown = messages[i];
    if (!isRecord(msg) || msg['role'] !== 'assistant') continue;
    const text = messageText(msg['content']).trim();
    if (text) return text;
  }
  return null;
}

/** Pull the messages array out of a sessions_history tool result. */
function historyMessages(result: unknown): unknown {
  if (!isRecord(result)) return undefined;
  const details = result['details'];
  if (isRecord(details) && Array.isArray(details['messages'])) {
    return details['messages'];
  }
  return result['messages'];
}

/**
 * Read the worker's final reply for a completed dispatch.
 *
 * @param stdout - Captured spawn-worker stdout.
 * @param invoke - Gateway tool invoker.
 * @returns The final assistant text, or null when the session key or
 *   any assistant text is missing.
 * @throws Error if the gateway call fails.
 */
export async function readWorkerFinalText(
  stdout: string,
  invoke: GatewayInvoker,
): Promise<string | null> {
  const sessionKey = findWorkerSessionKey(stdout);
  if (!sessionKey) return null;
  const result = await invoke('sessions_history', {
    sessionKey,
    limit: HISTORY_LIMIT,
    includeTools: false,
  });
  return extractFinalAssistantText(historyMessages(result));
}
