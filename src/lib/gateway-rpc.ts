/**
 * @module gateway-rpc
 *
 * Call an OpenClaw gateway RPC method (e.g. `chat.history`) through the
 * documented `openclaw gateway call <method> --json --params <json>`
 * helper. Use this for gateway methods that are not exposed as HTTP
 * tools (gateway-client.ts `/tools/invoke`), or whose tool wrapper
 * applies limits the RPC lets a caller override.
 *
 * The CLI runs under the current Node binary (no shell), so the JSON
 * params reach it as one argv entry on every platform. It resolves the
 * gateway URL and token from the local OpenClaw config.
 *
 * Config dependencies: the global openclaw install (resolve-openclaw-dist.ts).
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

import { resolveOpenClawDist } from '../admin/lib/resolve-openclaw-dist.js';

/** Gateway RPC caller: resolves with the method's result payload. */
export type GatewayRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Wall-clock limit for one CLI call (CLI startup is several seconds). */
const CALL_TIMEOUT_MS = 120_000;

/** Largest stdout accepted from one CLI call. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Path to the global `openclaw.mjs` CLI entry point. */
export function resolveOpenClawCli(): string {
  return path.join(path.dirname(resolveOpenClawDist()), 'openclaw.mjs');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Pull `error.message` out of a `{ ok: false, error }` CLI response. */
function cliErrorMessage(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || parsed['ok'] !== false) return undefined;
  const error = parsed['error'];
  if (isRecord(error) && typeof error['message'] === 'string') {
    return error['message'];
  }
  return 'unknown gateway error';
}

/**
 * Call a gateway RPC method.
 *
 * @param method - Gateway method name (e.g. `chat.history`).
 * @param params - Method params (sent as JSON).
 * @param cliPath - Path to `openclaw.mjs` (resolved from the global install
 *   when omitted).
 * @returns The method's result payload.
 * @throws Error when the CLI fails, the gateway rejects the call, or the
 *   output is not JSON.
 */
export function gatewayRpc(
  method: string,
  params: Record<string, unknown>,
  cliPath: string = resolveOpenClawCli(),
): Promise<unknown> {
  const args = [
    cliPath,
    'gateway',
    'call',
    method,
    '--json',
    '--params',
    JSON.stringify(params),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: CALL_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const parsed = parseJson(stdout);
        const gatewayError = cliErrorMessage(parsed);
        if (gatewayError) {
          reject(new Error(`gateway ${method} failed: ${gatewayError}`));
          return;
        }
        if (err) {
          const detail = stderr.trim() || err.message;
          reject(new Error(`gateway ${method} failed: ${detail}`));
          return;
        }
        if (parsed === undefined) {
          reject(new Error(`gateway ${method} returned invalid JSON`));
          return;
        }
        resolve(parsed);
      },
    );
  });
}
