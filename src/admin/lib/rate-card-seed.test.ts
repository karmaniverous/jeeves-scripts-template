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

  it('leaves no temp files behind after seeding', () => {
    ensureRateCard(ratesPath, seedPath);
    expect(fs.readdirSync(path.dirname(ratesPath))).toEqual([
      'token-rates.json',
    ]);
  });

  it('copies the exact seed bytes', () => {
    const text = JSON.stringify(SEED, null, 2) + '\n';
    fs.writeFileSync(seedPath, text);
    ensureRateCard(ratesPath, seedPath);
    expect(fs.readFileSync(ratesPath, 'utf8')).toBe(text);
  });

  it('does not clobber a card created concurrently before the claim', () => {
    const live = JSON.stringify({ ...SEED, source: 'concurrent writer' });
    const realLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((src, dest) => {
      // Another process wins the race between existsSync and link.
      fs.writeFileSync(dest, live);
      realLink(src, dest);
    });

    expect(ensureRateCard(ratesPath, seedPath)).toEqual({ seeded: false });
    expect(fs.readFileSync(ratesPath, 'utf8')).toBe(live);
    expect(fs.readdirSync(path.dirname(ratesPath))).toEqual([
      'token-rates.json',
    ]);
  });

  it('leaves no live card when the claim fails for another reason', () => {
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' });
    });

    expect(() => ensureRateCard(ratesPath, seedPath)).toThrow(/EIO/);
    expect(fs.existsSync(ratesPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(ratesPath))).toEqual([]);
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
