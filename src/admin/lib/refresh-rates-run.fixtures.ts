/**
 * @module refresh-rates-run.fixtures
 *
 * Shared test fixtures for refresh-rates-run: rate and card builders and
 * an in-memory {@link RefreshRatesDeps} that records writes.
 */

import { vi } from 'vitest';

import type { ModelRates, RateCardConfig } from './rate-card-schema.js';
import type { RefreshRatesDeps } from './refresh-rates-run.js';

export const r = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): ModelRates => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

export function card(models: Record<string, ModelRates>): RateCardConfig {
  return {
    updatedAt: '2026-10-01T00:00:00Z',
    source: 'seed.',
    unit: '$/MTok',
    models,
  };
}

export function deps(
  initial: RateCardConfig,
  upstream: Record<string, ModelRates | null | Error>,
  initialPending: string[] = [],
): RefreshRatesDeps & { written: RateCardConfig[]; pending: () => string[] } {
  let current = initial;
  let pending = initialPending;
  const written: RateCardConfig[] = [];
  return {
    written,
    pending: () => pending,
    readPending: vi.fn(() => pending),
    writePending: vi.fn((ids: string[]) => {
      pending = ids;
    }),
    ensure: vi.fn(),
    read: vi.fn(() => current),
    fetchRates: vi.fn((id: string) => {
      const v = upstream[id];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v ?? null);
    }),
    write: vi.fn((c: RateCardConfig) => {
      written.push(c);
      current = c;
    }),
    now: () => '2026-10-06T02:00:00.000Z',
    log: vi.fn(),
  };
}
