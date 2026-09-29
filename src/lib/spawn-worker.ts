#!/usr/bin/env tsx
/**
 * @module spawn-worker
 *
 * Spawn Worker — invoke sessions_spawn via Gateway HTTP API.
 *
 * Usage: echo "task" | tsx spawn-worker.ts --job-id=<id> [--label=<label>] [--thinking=<level>]
 *
 * Spawns a worker session and waits until the gateway reports its run
 * ended (session-row `status`); the runner job timeout is the upper
 * bound. On success, outputs a JSON summary line (token usage from the
 * session row) for async-wrapper to parse; a failed/killed/timed-out run
 * exits 1.
 *
 * Output format (last line of stdout):
 *   WORKER_RESULT:{"sessionKey":"...","tokens":12345,"durationMs":123000}
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ── Inlined from gateway-client.ts ─────────────────────────────────
// This file is executed by jeeves-runner dispatchSession() with plain
// node (not tsx), which cannot resolve .js → .ts imports.
// Constants and gateway helpers are inlined here to avoid import resolution issues.

const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 18789;

interface GatewayInvokeResult {
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

function loadGatewayToken(): string | null {
  if (process.env['CLAWDBOT_GATEWAY_TOKEN']) {
    return process.env['CLAWDBOT_GATEWAY_TOKEN'];
  }

  const home = process.env['USERPROFILE'] ?? os.homedir();
  const configPaths = [
    path.join(home, '.openclaw', 'openclaw.json'),
    path.join(home, '.clawdbot', 'clawdbot.json'),
  ];

  for (const configPath of configPaths) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (
        raw &&
        typeof raw === 'object' &&
        'gateway' in raw &&
        raw.gateway &&
        typeof raw.gateway === 'object' &&
        'auth' in raw.gateway &&
        raw.gateway.auth &&
        typeof raw.gateway.auth === 'object' &&
        'token' in raw.gateway.auth &&
        typeof raw.gateway.auth.token === 'string'
      ) {
        return raw.gateway.auth.token;
      }
    } catch {
      /* continue */
    }
  }

  return null;
}

function sharedGatewayInvoke(
  tool: string,
  args: Record<string, unknown>,
  options?: { sessionKey?: string },
): Promise<unknown> {
  const token = loadGatewayToken();
  if (!token) throw new Error('No gateway token found');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      tool,
      args,
      ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}),
    });
    const req = http.request(
      {
        hostname: GATEWAY_HOST,
        port: GATEWAY_PORT,
        path: '/tools/invoke',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const resp = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(resp);
          } catch {
            reject(new Error(`Gateway invalid JSON: ${resp}`));
            return;
          }
          const typed = parsed as GatewayInvokeResult;
          if (res.statusCode === 200 && typed.ok) {
            resolve(typed.result);
            return;
          }
          reject(new Error(typed.error?.message ?? resp));
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── End inlined gateway-client ─────────────────────────────────────

/**
 * Log a warning (never a completion) when a running session has not
 * updated for this long.
 */
const QUIET_WARNING_MS = 60_000;

/** Session-row run statuses that mean the run failed. */
const FAILED_STATUSES = ['failed', 'killed', 'timeout'];

/** Maximum number of spawn retry attempts before giving up. */
export const SPAWN_MAX_RETRIES = 3;
/** Base backoff delay in ms between spawn retries (doubles each attempt). */
export const SPAWN_BACKOFF_BASE_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────────

export interface ParsedArgs {
  [key: string]: string;
}

interface SpawnArgs {
  task: string;
  label: string;
  thread: boolean;
  thinking?: string;
}

interface GatewayResponse {
  ok?: boolean;
  result?: GatewayResult;
  details?: GatewayResult;
  sessions?: GatewaySession[];
  error?: { message?: string };
}

interface GatewayResult {
  details?: GatewayDetails;
  sessions?: GatewaySession[];
}

interface GatewayDetails {
  sessions?: GatewaySession[];
  childSessionKey?: string;
  sessionKey?: string;
}

/** One `sessions_list` row (only the fields used here). */
export interface GatewaySession {
  key: string;
  /** Run status: running | done | failed | killed | timeout. */
  status?: string;
  updatedAt?: number;
  totalTokens?: number;
  transcriptPath?: string;
  model?: string;
}

export interface SessionStatus {
  completed: boolean;
  /** Set when the run ended unsuccessfully. */
  error?: string;
}

/** Injectable I/O for {@link waitForWorkerCompletion}. */
export interface WaitDeps {
  findSession: (sessionKey: string) => Promise<GatewaySession | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  tokensFor: (session: GatewaySession) => number;
}

interface WorkerCompletion {
  success: boolean;
  durationMs: number;
  tokens: number;
  model?: string;
}

// ── Pure helpers ───────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

/**
 * Decide whether a worker run has ended, from the gateway's own run
 * status on its `sessions_list` row (never from transcript inactivity:
 * a worker writing a long final reply persists nothing until it ends).
 *
 * - `done` → completed.
 * - `failed` / `killed` / `timeout` → completed with an error.
 * - anything else (`running`, not yet projected, row missing) → running.
 */
export function isSessionCompleted(
  session: GatewaySession | undefined,
): SessionStatus {
  const status = session?.status;
  if (status === 'done') return { completed: true };
  if (status && FAILED_STATUSES.includes(status)) {
    return { completed: true, error: `Worker run ended: status=${status}` };
  }
  return { completed: false };
}

/**
 * Sum totalTokens from each JSON-Lines entry in a transcript file.
 */
export function getTokensFromTranscript(transcriptPath: string): number {
  try {
    if (!fs.existsSync(transcriptPath)) return 0;

    const lines = fs
      .readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    let total = 0;

    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (
          entry &&
          typeof entry === 'object' &&
          'message' in entry &&
          entry.message &&
          typeof entry.message === 'object' &&
          'usage' in entry.message &&
          entry.message.usage &&
          typeof entry.message.usage === 'object' &&
          'totalTokens' in entry.message.usage &&
          typeof entry.message.usage.totalTokens === 'number'
        ) {
          total += entry.message.usage.totalTokens;
        }
      } catch {
        /* skip non-JSON lines */
      }
    }

    return total;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[${new Date().toISOString()}] Failed to read transcript: ${msg}`,
    );
    return 0;
  }
}

/**
 * Parse WORKER_RESULT lines from spawn-worker output.
 */
export function parseResultLine(line: string): {
  sessionKey: string;
  tokens: number;
  durationMs: number;
  model?: string;
} | null {
  const prefix = 'WORKER_RESULT:';
  if (!line.startsWith(prefix)) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(prefix.length));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'sessionKey' in parsed &&
      'tokens' in parsed &&
      'durationMs' in parsed
    ) {
      const r = parsed as {
        sessionKey: string;
        tokens: number;
        durationMs: number;
        model?: string;
      };
      return r;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Gateway I/O ───────────────────────────────────────────────────────

async function invokeGateway(
  tool: string,
  toolArgs: Record<string, unknown>,
): Promise<GatewayResponse> {
  const result = await sharedGatewayInvoke(tool, toolArgs);
  return { ok: true, result: result as GatewayResult };
}

// ── Session helpers ───────────────────────────────────────────────────

function getSessionsDir(): string {
  const home = process.env['USERPROFILE'] ?? os.homedir();
  const configDirs = [
    path.join(home, '.openclaw'),
    path.join(home, '.clawdbot'),
  ];
  for (const dir of configDirs) {
    const sessDir = path.join(dir, 'agents', 'main', 'sessions');
    if (fs.existsSync(sessDir)) return sessDir;
  }
  return path.join(home, '.openclaw', 'agents', 'main', 'sessions');
}

/** Resolve a session row's token count (transcript usage preferred). */
function sessionTokens(session: GatewaySession): number {
  let totalTokens = session.totalTokens ?? 0;
  if (session.transcriptPath) {
    const fullPath = path.isAbsolute(session.transcriptPath)
      ? session.transcriptPath
      : path.join(getSessionsDir(), session.transcriptPath);
    const transcriptTokens = getTokensFromTranscript(fullPath);
    if (transcriptTokens > 0) totalTokens = transcriptTokens;
  }
  return totalTokens;
}

/** Fetch one session's `sessions_list` row by exact key. */
async function findSession(
  sessionKey: string,
): Promise<GatewaySession | undefined> {
  const result = await invokeGateway('sessions_list', {
    search: sessionKey,
    limit: 20,
  });
  const sessions: GatewaySession[] =
    result.result?.details?.sessions ??
    result.result?.sessions ??
    result.sessions ??
    [];
  return sessions.find((s) => s.key === sessionKey);
}

const defaultWaitDeps: WaitDeps = {
  findSession,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  tokensFor: sessionTokens,
};

/**
 * Poll the worker session until the gateway reports its run ended. The
 * runner job timeout (which kills this process) is the upper bound.
 *
 * @throws Error when the run ends failed/killed/timeout.
 */
export async function waitForWorkerCompletion(
  sessionKey: string,
  startTime: number,
  deps: WaitDeps = defaultWaitDeps,
): Promise<WorkerCompletion> {
  const pollInterval = 5000;

  // Initial delay to let the session start
  await deps.sleep(3000);

  for (;;) {
    let session: GatewaySession | undefined;
    try {
      session = await deps.findSession(sessionKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Poll failed: ${msg}`);
    }

    const status = isSessionCompleted(session);
    if (status.error) throw new Error(status.error);

    if (status.completed && session) {
      const durationMs = deps.now() - startTime;
      const tokens = deps.tokensFor(session);
      console.log(
        `[${new Date().toISOString()}] Session run done: tokens=${String(tokens)}, model=${session.model ?? 'unknown'}`,
      );
      return { success: true, durationMs, tokens, model: session.model };
    }

    const label = session?.status ?? (session ? 'none' : 'not found');
    const quietMs = session?.updatedAt ? deps.now() - session.updatedAt : 0;
    const quiet =
      quietMs > QUIET_WARNING_MS
        ? ` (warning: no update for ${String(Math.round(quietMs / 1000))}s; still waiting for run end)`
        : '';
    console.log(
      `[${new Date().toISOString()}] Session still running (status: ${label})${quiet}`,
    );

    await deps.sleep(pollInterval);
  }
}

// ── Spawn with retry ──────────────────────────────────────────────────

async function spawnWithRetry(
  spawnArgs: SpawnArgs,
): Promise<{ result: GatewayResponse; sessionKey: string }> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < SPAWN_MAX_RETRIES; attempt++) {
    try {
      const result = await invokeGateway(
        'sessions_spawn',
        spawnArgs as unknown as Record<string, unknown>,
      );

      // Check for gateway timeout in the response body text
      const resultText = JSON.stringify(result);
      if (/gateway timeout/i.test(resultText)) {
        const waitMs = SPAWN_BACKOFF_BASE_MS * 2 ** attempt;
        console.log(
          `[${new Date().toISOString()}] Spawn attempt ${String(attempt + 1)}/${String(SPAWN_MAX_RETRIES)} failed: gateway timeout in response. Retrying in ${String(waitMs / 1000)}s...`,
        );
        lastError = new Error('gateway timeout in response body');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      const spawnResult = result.result?.details ?? result.details ?? result;
      const sessionKey =
        (spawnResult as GatewayDetails).childSessionKey ??
        (spawnResult as GatewayDetails).sessionKey;

      if (!sessionKey) {
        throw new Error(
          `No sessionKey in spawn result: ${JSON.stringify(result).slice(0, 500)}`,
        );
      }

      return { result, sessionKey };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(msg);

      if (/timeout/i.test(msg) && attempt < SPAWN_MAX_RETRIES - 1) {
        const waitMs = SPAWN_BACKOFF_BASE_MS * 2 ** attempt;
        console.log(
          `[${new Date().toISOString()}] Spawn attempt ${String(attempt + 1)}/${String(SPAWN_MAX_RETRIES)} failed: ${msg}. Retrying in ${String(waitMs / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error('Spawn failed after all retries');
}

// ── CLI entry point ───────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args['job-id']) {
    console.error(
      'Usage: echo "task" | tsx spawn-worker.ts --job-id=<id> [--label=<label>] [--thinking=<level>]',
    );
    process.exit(1);
  }

  const taskInput = await readStdin();
  if (!taskInput) {
    console.error('Error: No task provided on stdin');
    process.exit(1);
  }

  const jobId = args['job-id'];
  const startTime = Date.now();
  const spawnArgs: SpawnArgs = {
    task: taskInput,
    label: args['label'] ?? `worker-${jobId.slice(0, 8)}`,
    thread: false,
  };

  if (args['thinking']) {
    spawnArgs.thinking = args['thinking'];
  }

  console.log(
    `[${new Date().toISOString()}] Spawning worker for job ${jobId.slice(0, 8)}`,
  );
  console.log(`  Label: ${spawnArgs.label}`);

  try {
    const { result, sessionKey } = await spawnWithRetry(spawnArgs);
    console.log(`[${new Date().toISOString()}] Worker spawned successfully`);
    console.log(
      `[${new Date().toISOString()}] Raw spawn result: ${JSON.stringify(result).slice(0, 500)}`,
    );

    console.log(
      `[${new Date().toISOString()}] Waiting for worker to complete (session: ${sessionKey})...`,
    );

    const completion = await waitForWorkerCompletion(sessionKey, startTime);

    if (!completion.success) {
      console.error(`[${new Date().toISOString()}] Worker failed`);
      process.exit(1);
    }

    console.log(`[${new Date().toISOString()}] Worker completed successfully`);
    console.log(`  Duration: ${(completion.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens: ${String(completion.tokens)}`);

    console.log(
      `WORKER_RESULT:${JSON.stringify({
        sessionKey,
        tokens: completion.tokens,
        durationMs: completion.durationMs,
        model: completion.model,
      })}`,
    );

    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toISOString()}] Worker failed: ${msg}`);
    process.exit(1);
  }
}

// Run main when executed directly (not imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('spawn-worker.ts') ||
    process.argv[1].endsWith('spawn-worker.js'));

if (isDirectExecution) {
  main().catch(() => process.exit(1));
}
