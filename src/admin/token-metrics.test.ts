/**
 * Tests for token metrics query function.
 * Uses fixture bucket files to verify aggregation logic.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TOKEN_METRICS_DIR } from '../lib/constants.js';
import type { HourlyBucket } from './types/token-metrics.js';

// Mock the rate card to avoid requiring a real config file on disk.
vi.mock('./lib/rate-card.js', () => ({
  loadRateCard: () => ({
    updatedAt: '2099-01-01T00:00:00Z',
    unit: '$/MTok',
    models: {
      'anthropic/claude-opus-4-6': {
        input: 15,
        output: 75,
        cacheRead: 1.5,
        cacheWrite: 3.75,
      },
      'openai/gpt-4o': {
        input: 2.5,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
  }),
  resetRateCard: () => {},
  getModelRates: (model: string) => {
    const rates: Record<string, Record<string, number>> = {
      'anthropic/claude-opus-4-6': {
        input: 15,
        output: 75,
        cacheRead: 1.5,
        cacheWrite: 3.75,
      },
      'openai/gpt-4o': {
        input: 2.5,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    return rates[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  },
  computeCosts: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
}));

// We test getTokenMetrics by writing fixture bucket files then querying them.
// To avoid polluting real data, we use a deep future year (2099).

const FIXTURE_YEAR = '2099';
const FIXTURE_MONTH = '01';
const FIXTURE_DIR = path.join(TOKEN_METRICS_DIR, FIXTURE_YEAR, FIXTURE_MONTH);

function writeBucketFixture(bucket: HourlyBucket): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const p = path.join(FIXTURE_DIR, bucket.hour + '.json');
  fs.writeFileSync(p, JSON.stringify(bucket, null, 2), 'utf8');
}

function cleanFixtures(): void {
  try {
    fs.rmSync(path.join(TOKEN_METRICS_DIR, FIXTURE_YEAR), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
}

const HOUR_1 = '2099-01-15T10';
const HOUR_2 = '2099-01-15T11';

const BUCKET_1: HourlyBucket = {
  hour: HOUR_1,
  channels: {
    'slack:channel:#general': {
      models: {
        'anthropic/claude-opus-4-6': {
          input: { count: 100, cost: 0.005 },
          output: { count: 200, cost: 0.01 },
          cacheRead: { count: 5000, cost: 0.0025 },
          cacheWrite: { count: 3000, cost: 0.00375 },
        },
      },
    },
    heartbeat: {
      models: {
        'anthropic/claude-opus-4-6': {
          input: { count: 50, cost: 0.0025 },
          output: { count: 100, cost: 0.005 },
          cacheRead: { count: 2000, cost: 0.001 },
          cacheWrite: { count: 1000, cost: 0.00125 },
        },
      },
    },
  },
};

const BUCKET_2: HourlyBucket = {
  hour: HOUR_2,
  channels: {
    'slack:channel:#general': {
      models: {
        'anthropic/claude-opus-4-6': {
          input: { count: 150, cost: 0.0075 },
          output: { count: 300, cost: 0.015 },
          cacheRead: { count: 8000, cost: 0.004 },
          cacheWrite: { count: 4000, cost: 0.005 },
        },
        'openai/gpt-4o': {
          input: { count: 400, cost: 0.002 },
          output: { count: 600, cost: 0.006 },
          cacheRead: { count: 0, cost: 0 },
          cacheWrite: { count: 0, cost: 0 },
        },
      },
    },
  },
};

beforeAll(() => {
  cleanFixtures();
  writeBucketFixture(BUCKET_1);
  writeBucketFixture(BUCKET_2);
});

afterAll(() => {
  cleanFixtures();
});

describe('getTokenMetrics', () => {
  // Dynamic import to avoid module-level side effects
  const loadModule = async () => import('./token-metrics.js');

  it('aggregates across multiple hours', async () => {
    const { getTokenMetrics } = await loadModule();
    // Time range covering both fixture hours
    const from = new Date('2099-01-15T10:00:00Z').getTime() / 1000;
    const to = new Date('2099-01-15T11:59:59Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    // Grand total should be sum of all costs
    expect(costs.cost).toBeGreaterThan(0);
    expect(costs.cost).toBeCloseTo(
      0.005 +
        0.01 +
        0.0025 +
        0.00375 + // #general hour1
        0.0025 +
        0.005 +
        0.001 +
        0.00125 + // heartbeat hour1
        0.0075 +
        0.015 +
        0.004 +
        0.005 + // #general hour2 opus
        0.002 +
        0.006, // #general hour2 gpt-4o
      6,
    );
  });

  it('returns per-channel breakdowns', async () => {
    const { getTokenMetrics } = await loadModule();
    const from = new Date('2099-01-15T10:00:00Z').getTime() / 1000;
    const to = new Date('2099-01-15T11:59:59Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    expect(costs.channels).toHaveProperty('slack:channel:#general');
    expect(costs.channels).toHaveProperty('heartbeat');

    const general = costs.channels['slack:channel:#general'];
    expect(general).toBeDefined();
    expect(general.cost).toBeGreaterThan(0);
    expect(general.costPct).toBeGreaterThan(0);
    expect(general.costPct).toBeLessThanOrEqual(1);
  });

  it('returns per-model breakdowns', async () => {
    const { getTokenMetrics } = await loadModule();
    const from = new Date('2099-01-15T10:00:00Z').getTime() / 1000;
    const to = new Date('2099-01-15T11:59:59Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    expect(costs.models).toHaveProperty('anthropic/claude-opus-4-6');
    expect(costs.models).toHaveProperty('openai/gpt-4o');

    const opus = costs.models['anthropic/claude-opus-4-6'];
    expect(opus).toBeDefined();
    expect(opus.cost).toBeGreaterThan(0);

    // Token counts should be aggregated
    expect(opus.tokens.input.count).toBe(100 + 50 + 150); // general h1 + heartbeat + general h2
    expect(opus.tokens.output.count).toBe(200 + 100 + 300);
  });

  it('handles empty time range gracefully', async () => {
    const { getTokenMetrics } = await loadModule();
    // Far future range with no data
    const from = new Date('2099-06-01T00:00:00Z').getTime() / 1000;
    const to = new Date('2099-06-01T01:00:00Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    expect(costs.cost).toBe(0);
    expect(Object.keys(costs.channels)).toHaveLength(0);
    expect(Object.keys(costs.models)).toHaveLength(0);
  });

  it('computes costPct values that sum to ~1', async () => {
    const { getTokenMetrics } = await loadModule();
    const from = new Date('2099-01-15T10:00:00Z').getTime() / 1000;
    const to = new Date('2099-01-15T11:59:59Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    // Channel costPcts should sum to ~1
    const chanPctSum = Object.values(costs.channels).reduce(
      (sum, ch) => sum + ch.costPct,
      0,
    );
    expect(chanPctSum).toBeCloseTo(1, 5);

    // Model costPcts should sum to ~1
    const modelPctSum = Object.values(costs.models).reduce(
      (sum, m) => sum + m.costPct,
      0,
    );
    expect(modelPctSum).toBeCloseTo(1, 5);
  });

  it('single hour query returns correct data', async () => {
    const { getTokenMetrics } = await loadModule();
    const from = new Date('2099-01-15T10:00:00Z').getTime() / 1000;
    const to = new Date('2099-01-15T10:59:59Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    // Only hour 1 data — no gpt-4o
    expect(costs.models).not.toHaveProperty('openai/gpt-4o');
    expect(costs.channels).toHaveProperty('heartbeat');
  });

  it('reports ref as the rate card ($/MTok per model), not token usage', async () => {
    const { getTokenMetrics } = await loadModule();
    const from = new Date('2099-01-15T10:00:00Z').getTime() / 1000;
    const to = new Date('2099-01-15T10:59:59Z').getTime() / 1000;
    const costs = getTokenMetrics({ fromTs: from, toTs: to });

    // gpt-4o has no usage in this hour but is in the rate card.
    expect(costs.ref).toEqual({
      'anthropic/claude-opus-4-6': {
        input: 15,
        output: 75,
        cacheRead: 1.5,
        cacheWrite: 3.75,
      },
      'openai/gpt-4o': { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
    });
    // Usage counts live under models[model].tokens[category].count.
    expect(costs.models['anthropic/claude-opus-4-6'].tokens.input.count).toBe(
      150,
    );
  });
});
