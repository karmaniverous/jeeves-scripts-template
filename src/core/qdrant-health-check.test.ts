import { execSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkHealthz,
  type CollectionInfo,
  describeExecError,
  fetchJson,
  isCollectionHealthy,
  isPermissionDenied,
  runHealthCheck,
} from './qdrant-health-check.js';

// Replace execSync with a controllable mock for all tests in this file.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_URL = 'http://localhost:6333';

/** Build a minimal CollectionInfo fixture. */
function makeCollectionInfo(
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

/** Build a successful fetch Response stub. */
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Build a failed fetch Response stub. */
function errorResponse(
  status = 503,
  statusText = 'Service Unavailable',
): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

/**
 * Build a /healthz Response stub. Real Qdrant returns text/plain
 * ("healthz check passed"); json() rejects exactly as a real Response
 * would, so any attempt to JSON-parse the body fails the test.
 */
function healthzResponse(ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Service Unavailable',
    text: () => Promise.resolve('healthz check passed'),
    json: () =>
      Promise.reject(
        new SyntaxError(
          'Unexpected token \'h\', "healthz check passed" is not valid JSON',
        ),
      ),
  } as unknown as Response;
}

/** /healthz response. */
const HEALTHZ_OK = healthzResponse();

/** Build an execSync failure shaped like Node's (message + stderr). */
function execFailure(command: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${command}`), {
    stderr: Buffer.from(stderr),
  });
}

/** /collections response with one collection named "vectors". */
function collectionsResponse(names: string[]): Response {
  return okResponse({
    result: { collections: names.map((name) => ({ name })) },
    status: 'ok',
  });
}

/** /collections/{name} detail response. */
function detailResponse(info: Partial<CollectionInfo> = {}): Response {
  return okResponse({ result: makeCollectionInfo(info), status: 'ok' });
}

// ── isCollectionHealthy ───────────────────────────────────────────────────────

describe('isCollectionHealthy', () => {
  it('returns true when optimizer_status is the string "ok"', () => {
    expect(
      isCollectionHealthy(makeCollectionInfo({ optimizer_status: 'ok' })),
    ).toBe(true);
  });

  it('returns false when optimizer_status is any other string', () => {
    expect(
      isCollectionHealthy(makeCollectionInfo({ optimizer_status: 'error' })),
    ).toBe(false);
    expect(
      isCollectionHealthy(makeCollectionInfo({ optimizer_status: 'degraded' })),
    ).toBe(false);
  });

  it('returns false when optimizer_status is an object with an error key', () => {
    expect(
      isCollectionHealthy(
        makeCollectionInfo({ optimizer_status: { error: 'stuck lock' } }),
      ),
    ).toBe(false);
  });

  it('returns true when optimizer_status is an object without an error key', () => {
    expect(
      isCollectionHealthy(makeCollectionInfo({ optimizer_status: {} })),
    ).toBe(true);
    expect(
      isCollectionHealthy(
        makeCollectionInfo({ optimizer_status: { info: 'optimizing' } }),
      ),
    ).toBe(true);
  });
});

// ── fetchJson ─────────────────────────────────────────────────────────────────

describe('fetchJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed JSON body on a 2xx response', async () => {
    const payload = { result: { collections: [] }, status: 'ok' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(payload)));
    const result = await fetchJson(TEST_URL);
    expect(result).toEqual(payload);
  });

  it('throws with status info when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(503, 'Service Unavailable')),
    );
    await expect(fetchJson(TEST_URL)).rejects.toThrow(
      'Qdrant API error: 503 Service Unavailable',
    );
  });
});

// ── checkHealthz ──────────────────────────────────────────────────────────────

describe('checkHealthz', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes on a 2xx text/plain body without parsing JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(healthzResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(checkHealthz(TEST_URL)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`${TEST_URL}/healthz`);
  });

  it('throws on a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(healthzResponse(false, 503)),
    );
    await expect(checkHealthz(TEST_URL)).rejects.toThrow(
      'Qdrant /healthz returned 503',
    );
  });

  it('throws when Qdrant is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(checkHealthz(TEST_URL)).rejects.toThrow('ECONNREFUSED');
  });
});

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

// ── runHealthCheck ────────────────────────────────────────────────────────────

describe('runHealthCheck', () => {
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
        .mockResolvedValueOnce(HEALTHZ_OK)
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
        .mockResolvedValueOnce(HEALTHZ_OK)
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
        .mockResolvedValueOnce(HEALTHZ_OK)
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
        .mockResolvedValueOnce(HEALTHZ_OK)
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
        .mockResolvedValueOnce(HEALTHZ_OK)
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
        .mockResolvedValueOnce(HEALTHZ_OK)
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
