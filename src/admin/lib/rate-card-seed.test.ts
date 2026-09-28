import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureRateCard } from './rate-card-seed.js';

const SEED = {
  updatedAt: '2026-09-28T00:00:00Z',
  source: 'SEED test',
  unit: '$/MTok',
  models: {
    'anthropic/claude-opus-5-5': {
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    },
  },
};

describe('ensureRateCard', () => {
  let dir: string;
  let seedPath: string;
  let ratesPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-card-seed-'));
    seedPath = path.join(dir, 'seed.json');
    // Nested, not-yet-existing directory, as on a fresh instance.
    ratesPath = path.join(dir, 'state', 'token-metrics', 'token-rates.json');
    fs.writeFileSync(seedPath, JSON.stringify(SEED));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the directory and copies the seed when the card is missing', () => {
    expect(ensureRateCard(ratesPath, seedPath)).toEqual({ seeded: true });
    expect(JSON.parse(fs.readFileSync(ratesPath, 'utf8'))).toEqual(SEED);
  });

  it('never overwrites an existing rate card', () => {
    fs.mkdirSync(path.dirname(ratesPath), { recursive: true });
    const live = { ...SEED, source: 'live card' };
    fs.writeFileSync(ratesPath, JSON.stringify(live));

    expect(ensureRateCard(ratesPath, seedPath)).toEqual({ seeded: false });
    expect(JSON.parse(fs.readFileSync(ratesPath, 'utf8'))).toEqual(live);
  });

  it('leaves an existing invalid card alone (does not mask it with the seed)', () => {
    fs.mkdirSync(path.dirname(ratesPath), { recursive: true });
    fs.writeFileSync(ratesPath, 'not json');

    expect(ensureRateCard(ratesPath, seedPath)).toEqual({ seeded: false });
    expect(fs.readFileSync(ratesPath, 'utf8')).toBe('not json');
  });

  it('is idempotent', () => {
    ensureRateCard(ratesPath, seedPath);
    expect(ensureRateCard(ratesPath, seedPath)).toEqual({ seeded: false });
  });

  it('throws when the card is missing and the seed is missing', () => {
    fs.rmSync(seedPath);
    expect(() => ensureRateCard(ratesPath, seedPath)).toThrow(/not readable/);
    expect(fs.existsSync(ratesPath)).toBe(false);
  });

  it('throws and writes nothing when the seed is invalid', () => {
    fs.writeFileSync(seedPath, JSON.stringify({ ...SEED, models: {} }));
    expect(() => ensureRateCard(ratesPath, seedPath)).toThrow(/no models/);
    expect(fs.existsSync(ratesPath)).toBe(false);
  });
});
