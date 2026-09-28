#!/usr/bin/env tsx
/**
 * @module qdrant-health-check
 *
 * Monitors Qdrant vector database health by first confirming the
 * /healthz endpoint is reachable, then inspecting each collection's
 * status and optimizer state via the HTTP API. When Qdrant is
 * unreachable, a collection enters "red" status, or the optimizer
 * reports an error (e.g. stuck file locks preventing segment
 * compaction), attempts to restart the Qdrant system service to clear
 * the condition.
 *
 * /healthz returns plain text ("healthz check passed"), so liveness is
 * judged by HTTP status alone; only the /collections endpoints are
 * parsed as JSON.
 *
 * The restart is privilege-aware: on Linux it runs
 * `systemctl --no-ask-password restart` so it never blocks on a polkit
 * prompt. The job runs as an unprivileged user and no sudoers/polkit
 * rule is assumed for the Qdrant unit, so a denied restart is reported
 * as "restart requires operator" rather than retried.
 *
 * Exits 0 on healthy or successful restart. Exits non-zero when the
 * restart fails or is denied.
 *
 * Config dependencies: QDRANT_API_URL, QDRANT_SERVICE_NAME from constants.ts.
 */

import { execSync } from 'node:child_process';

import { runScript } from '@karmaniverous/jeeves';

import { QDRANT_API_URL, QDRANT_SERVICE_NAME } from '../lib/constants.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape of a single collection's detail response from Qdrant. */
export interface CollectionInfo {
  status: string;
  /**
   * Qdrant returns either the string "ok" when the optimizer is healthy,
   * or an object { error: string } when it is not. Treat any other string
   * value as unhealthy.
   */
  optimizer_status: string | { error: string } | Record<string, unknown>;
  segments_count: number;
  points_count: number;
}

/** Standard Qdrant API envelope. */
interface QdrantResponse<T> {
  result: T;
  status: string;
}

/** Collections list payload. */
interface CollectionsList {
  collections: { name: string }[];
}

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Perform a GET request using the global fetch API, validate HTTP status,
 * and return the parsed JSON body. Throws if the response is not 2xx.
 */
export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Qdrant API error: ${String(response.status)} ${response.statusText}`,
    );
  }
  const data = await response.json();
  return data as T;
}

/**
 * Determine if a collection's optimizer is healthy based on its
 * optimizer_status field. Handles both the string form ("ok") and the
 * object form ({ error: "…" }) returned by the Qdrant API.
 */
export function isCollectionHealthy(info: CollectionInfo): boolean {
  const status = info.optimizer_status;
  if (typeof status === 'string') return status === 'ok';
  if (typeof status === 'object') return !('error' in status);
  return false;
}

/**
 * Check Qdrant liveness via /healthz. The endpoint returns a plain-text
 * body, so only the HTTP status is significant. Throws when the request
 * fails or the status is not 2xx.
 */
export async function checkHealthz(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl}/healthz`);
  if (!response.ok) {
    throw new Error(
      `Qdrant /healthz returned ${String(response.status)} ${response.statusText}`,
    );
  }
  // Drain the (text/plain) body so the connection is released.
  await response.text();
}

/** Patterns that identify a restart refused for lack of privileges. */
const PERMISSION_DENIED_PATTERNS = [
  /interactive authentication required/i,
  /access denied/i,
  /not authorized/i,
  /permission denied/i,
  /authentication is required/i,
  /cannot open .* service/i,
];

/** Render an execSync failure as a single message, including stderr. */
export function describeExecError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const raw: unknown =
    typeof err === 'object' && err !== null && 'stderr' in err
      ? err.stderr
      : undefined;
  const stderr =
    typeof raw === 'string' || Buffer.isBuffer(raw)
      ? raw.toString().trim()
      : '';
  return stderr && !message.includes(stderr)
    ? `${message}: ${stderr}`
    : message;
}

/** True when a restart failure message indicates missing privileges. */
export function isPermissionDenied(message: string): boolean {
  return PERMISSION_DENIED_PATTERNS.some((re) => re.test(message));
}

// ── Service control ───────────────────────────────────────────────────────────

/**
 * Restart the Qdrant system service using the platform-appropriate
 * command. Never prompts: on Linux `--no-ask-password` makes systemctl
 * fail fast when polkit would require interactive authentication.
 */
function restartService(): void {
  const options = {
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  };
  if (process.platform === 'win32') {
    execSync(
      `powershell -NonInteractive -Command "Restart-Service -Name '${QDRANT_SERVICE_NAME}' -Force"`,
      options,
    );
  } else {
    execSync(
      `systemctl --no-ask-password restart ${QDRANT_SERVICE_NAME}`,
      options,
    );
  }
}

/**
 * Attempt to restart the service and log the outcome.
 * Sets process.exitCode = 1 if the restart fails or is denied; never throws.
 *
 * @param condition - Short description of why a restart is needed
 *   (e.g. "down", "unhealthy"), used in the operator-facing error.
 */
function attemptRestart(condition: string): void {
  console.log(`Restarting ${QDRANT_SERVICE_NAME} service...`);
  try {
    restartService();
    console.log(`✓ ${QDRANT_SERVICE_NAME} restarted successfully.`);
  } catch (err: unknown) {
    const msg = describeExecError(err);
    if (isPermissionDenied(msg)) {
      console.error(
        `✗ ${QDRANT_SERVICE_NAME} ${condition}; restart requires operator (this user may not restart ${QDRANT_SERVICE_NAME}): ${msg}`,
      );
    } else {
      console.error(`✗ Failed to restart ${QDRANT_SERVICE_NAME}: ${msg}`);
    }
    process.exitCode = 1;
  }
}

// ── Core check logic (exported for testing) ───────────────────────────────────

/**
 * Run the full Qdrant health check sequence:
 * 1. Check /healthz — restart immediately if unreachable.
 * 2. Inspect each collection — restart if any is unhealthy.
 */
export async function runHealthCheck(apiUrl: string): Promise<void> {
  // Step 1: Basic connectivity / liveness check
  try {
    await checkHealthz(apiUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Qdrant health endpoint unreachable: ${msg}`);
    attemptRestart('down');
    return;
  }

  // Step 2: Enumerate collections
  const collectionsResp = await fetchJson<QdrantResponse<CollectionsList>>(
    `${apiUrl}/collections`,
  );

  const collections = collectionsResp.result.collections;

  if (collections.length === 0) {
    console.log('No collections found.');
    return;
  }

  // Step 3: Inspect each collection
  let needsRestart = false;
  const issues: string[] = [];

  for (const { name } of collections) {
    const detail = await fetchJson<QdrantResponse<CollectionInfo>>(
      `${apiUrl}/collections/${encodeURIComponent(name)}`,
    );

    const info = detail.result;
    const { status, segments_count, points_count } = info;

    if (status === 'red' || !isCollectionHealthy(info)) {
      needsRestart = true;
      const optimizerStatus = info.optimizer_status;
      const optimizerError =
        typeof optimizerStatus === 'object' && 'error' in optimizerStatus
          ? String((optimizerStatus as { error: unknown }).error)
          : null;
      const reason = optimizerError
        ? `optimizer error: ${optimizerError}`
        : `status: ${status}`;
      issues.push(
        `Collection "${name}" unhealthy — ${reason} (${String(points_count)} points, ${String(segments_count)} segments)`,
      );
    } else {
      console.log(
        `Collection "${name}": ${status}, ${String(points_count)} points, ${String(segments_count)} segments — healthy`,
      );
    }
  }

  if (!needsRestart) {
    console.log('All collections healthy.');
    return;
  }

  for (const issue of issues) {
    console.log(`⚠ ${issue}`);
  }

  attemptRestart('unhealthy');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runHealthCheck(QDRANT_API_URL);
}

runScript('core/qdrant-health-check', main);
