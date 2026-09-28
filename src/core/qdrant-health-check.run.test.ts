import { execSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectionsResponse,
  detailResponse,
  healthzResponse,
  TEST_URL,
} from './qdrant-health-check.fixtures.js';
import { runHealthCheck } from './qdrant-health-check.js';

// Replace execSync with a controllable mock for all tests in this file.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('runHealthCheck — restart decision', () => {
  let savedExitCode: number | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode as number | undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.exitCode = savedExitCode;
  });

  it('does not restart when all collections are healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(healthzResponse())
        .mockResolvedValueOnce(collectionsResponse(['vectors']))
        .mockResolvedValueOnce(
          detailResponse({ optimizer_status: 'ok', status: 'green' }),
        ),
    );

    await runHealthCheck(TEST_URL);

    expect(execSync).not.toHaveBeenCalled();
  });

  it('does not restart when collections list is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(healthzResponse())
        .mockResolvedValueOnce(collectionsResponse([])),
    );

    await runHealthCheck(TEST_URL);

    expect(execSync).not.toHaveBeenCalled();
  });

  it('restarts when a collection has optimizer_status "error"', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(healthzResponse())
        .mockResolvedValueOnce(collectionsResponse(['vectors']))
        .mockResolvedValueOnce(detailResponse({ optimizer_status: 'error' })),
    );

    await runHealthCheck(TEST_URL);

    expect(execSync).toHaveBeenCalled();
  });

  it('restarts when a collection has optimizer_status { error: "..." }', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(healthzResponse())
        .mockResolvedValueOnce(collectionsResponse(['vectors']))
        .mockResolvedValueOnce(
          detailResponse({ optimizer_status: { error: 'file lock timeout' } }),
        ),
    );

    await runHealthCheck(TEST_URL);

    expect(execSync).toHaveBeenCalled();
  });

  it('restarts immediately when /healthz returns a non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(healthzResponse(false, 503)),
    );

    await runHealthCheck(TEST_URL);

    // Should restart without ever checking /collections
    expect(execSync).toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('restarts immediately when /healthz fetch rejects (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')),
    );

    await runHealthCheck(TEST_URL);

    expect(execSync).toHaveBeenCalled();
  });

  it('passes a healthy text/plain /healthz without restarting or erroring', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(healthzResponse())
        .mockResolvedValueOnce(collectionsResponse([])),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await runHealthCheck(TEST_URL);

    expect(execSync).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(savedExitCode);
    consoleErrorSpy.mockRestore();
  });
});
