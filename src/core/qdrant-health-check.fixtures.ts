/**
 * @module qdrant-health-check.fixtures
 *
 * Shared test fixtures for the qdrant-health-check test modules: real
 * fetch `Response` objects (so the helpers can't drift from the fetch
 * contract) and exec failure shapes.
 */

import type { CollectionInfo } from './qdrant-health-check.js';

/** Base URL used by all qdrant-health-check tests. */
export const TEST_URL = 'http://localhost:6333';

/** Build a minimal CollectionInfo fixture. */
export function makeCollectionInfo(
  overrides: Partial<CollectionInfo> = {},
): CollectionInfo {
  return {
    status: 'green',
    optimizer_status: 'ok',
    segments_count: 2,
    points_count: 100,
    ...overrides,
  };
}

/** Build a successful JSON fetch Response. */
export function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a failed fetch Response. */
export function errorResponse(
  status = 503,
  statusText = 'Service Unavailable',
): Response {
  return new Response('{}', { status, statusText });
}

/**
 * Build a /healthz Response. Real Qdrant returns text/plain
 * ("healthz check passed"), so `json()` rejects naturally and any
 * attempt to JSON-parse the body fails the test.
 */
export function healthzResponse(ok = true, status = ok ? 200 : 503): Response {
  return new Response('healthz check passed', {
    status,
    statusText: ok ? 'OK' : 'Service Unavailable',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Build an execSync failure shaped like Node's (message + stderr). */
export function execFailure(command: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${command}`), {
    stderr: Buffer.from(stderr),
  });
}

/** /collections response listing the given collection names. */
export function collectionsResponse(names: string[]): Response {
  return okResponse({
    result: { collections: names.map((name) => ({ name })) },
    status: 'ok',
  });
}

/** /collections/{name} detail response. */
export function detailResponse(info: Partial<CollectionInfo> = {}): Response {
  return okResponse({ result: makeCollectionInfo(info), status: 'ok' });
}
