import { execSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectionsResponse,
  detailResponse,
  execFailure,
  healthzResponse,
  TEST_URL,
} from './qdrant-health-check.fixtures.js';
import {
  describeExecError,
  isPermissionDenied,
  runHealthCheck,
} from './qdrant-health-check.js';

// Replace execSync with a controllable mock for all tests in this file.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// ── restart error classification ──────────────────────────────────────────────

describe('describeExecError / isPermissionDenied', () => {
  it('appends captured stderr to the exec error message', () => {
    const err = execFailure(
      'systemctl --no-ask-password restart qdrant',
      'Failed to restart qdrant.service: Interactive authentication required.\n',
    );
    expect(describeExecError(err)).toBe(
      'Command failed: systemctl --no-ask-password restart qdrant: Failed to restart qdrant.service: Interactive authentication required.',
    );
  });

  it.each([
    'Failed to restart qdrant.service: Interactive authentication required.',
    'Failed to restart qdrant.service: Access denied',
    "Restart-Service : Cannot open qdrant service on computer '.'.",
  ])('classifies %j as permission denied', (msg) => {
    expect(isPermissionDenied(msg)).toBe(true);
  });

  it('does not classify other failures as permission denied', () => {
    expect(isPermissionDenied('Unit qdrant.service not found.')).toBe(false);
  });
});

// ── restart execution ─────────────────────────────────────────────────────────

describe('runHealthCheck — restart execution', () => {
  let savedExitCode: number | undefined;

  beforeEach(() => {
    savedExitCode = process.exitCode as number | undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.exitCode = savedExitCode;
  });

  it('restarts non-interactively on Linux', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')),
      );

      await runHealthCheck(TEST_URL);

      expect(execSync).toHaveBeenCalledWith(
        'systemctl --no-ask-password restart qdrant',
        expect.objectContaining({ timeout: 30_000 }),
      );
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('reports "restart requires operator" and exits non-zero when the restart is denied', async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw execFailure(
        'systemctl --no-ask-password restart qdrant',
        'Failed to restart qdrant.service: Interactive authentication required.',
      );
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(runHealthCheck(TEST_URL)).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('qdrant down; restart requires operator'),
    );
    consoleErrorSpy.mockRestore();
  });

  it('logs error and sets exitCode=1 when restart fails, without throwing', async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error('Unit qdrant.service not found.');
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(healthzResponse())
        .mockResolvedValueOnce(collectionsResponse(['vectors']))
        .mockResolvedValueOnce(detailResponse({ status: 'red' })),
    );

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(runHealthCheck(TEST_URL)).resolves.not.toThrow();

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to restart'),
    );

    consoleErrorSpy.mockRestore();
  });
});
