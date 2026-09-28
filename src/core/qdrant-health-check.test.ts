import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponse,
  healthzResponse,
  makeCollectionInfo,
  okResponse,
  TEST_URL,
} from './qdrant-health-check.fixtures.js';
import {
  checkHealthz,
  fetchJson,
  isCollectionHealthy,
} from './qdrant-health-check.js';

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

  it('the healthz fixture body is not JSON (as from real Qdrant)', async () => {
    await expect(healthzResponse().json()).rejects.toThrow(SyntaxError);
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
