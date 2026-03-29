/**
 * Shell execution utilities — typed equivalents of email-lib.js process spawning.
 */

import cp from 'node:child_process';

import { sleepMs } from './fs-utils.js';

export interface RunOptions {
  encoding?: BufferEncoding;
  maxBuffer?: number;
  timeout?: number;
  shell?: boolean;
}

export function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): string {
  const r = cp.spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  if (r.error) throw r.error;
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (r.status !== 0) {
    const msg = (stderr || stdout).trim();
    throw new Error(
      `${cmd} ${args.join(' ')} failed (exit ${String(r.status)}): ${msg}`,
    );
  }
  return stdout.trim();
}

export interface RetryOptions {
  retries?: number;
  backoffMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

export function runWithRetry(
  cmd: string,
  args: string[],
  opts: RetryOptions & RunOptions = {},
): string {
  const { retries = 2, backoffMs = 5000, isRetryable, ...runOpts } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return run(cmd, args, runOpts);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = isRetryable
        ? isRetryable(e)
        : /context deadline exceeded|timed out|timeout/i.test(msg);
      if (!retryable || attempt === retries) throw lastErr;
      sleepMs(backoffMs * Math.pow(2, attempt));
    }
  }

  throw lastErr;
}

export interface GhResult {
  ok: boolean;
  status: number | null;
  out: string;
  err: string;
  error?: string;
}

const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';

export function gh(
  args: string[],
  options: { allowFail?: boolean; json?: boolean } = {},
): GhResult {
  const r = cp.spawnSync(GH, args, { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();

  if (r.error) {
    if (options.allowFail)
      return { ok: false, status: null, out, err, error: String(r.error) };
    throw r.error;
  }
  if (r.status !== 0) {
    if (options.allowFail) return { ok: false, status: r.status, out, err };
    throw new Error(`gh ${args.join(' ')} failed: ${(err || out).trim()}`);
  }

  return { ok: true, status: 0, out, err };
}

export function ghJson(args: string[]): unknown {
  const result = gh(args);
  return result.out ? (JSON.parse(result.out) as unknown) : null;
}

export function ghApi(endpoint: string): unknown {
  return ghJson(['api', endpoint]);
}
