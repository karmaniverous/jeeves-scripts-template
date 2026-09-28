import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRateCard, readRateCardFile } from './rate-card-schema.js';

const REPO_SEED_PATH = path.resolve(
  import.meta.dirname,
  '../../../config/token-rates.seed.json',
);

const VALID = {
  updatedAt: '2026-09-28T00:00:00Z',
  unit: '$/MTok',
  models: {
    'openai/gpt-5.6-sol': {
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
    },
  },
};

describe('parseRateCard', () => {
  it('accepts a valid card', () => {
    expect(parseRateCard(VALID, 'x').models).toHaveProperty(
      'openai/gpt-5.6-sol',
    );
  });

  it('defaults unit to $/MTok for older cards that omit it', () => {
    const legacy: Partial<typeof VALID> = { ...VALID };
    delete legacy.unit;
    expect(parseRateCard(legacy, 'x').unit).toBe('$/MTok');
  });

  it.each([
    ['empty models', { ...VALID, models: {} }, /no models/],
    [
      'missing category',
      { ...VALID, models: { m: { input: 1, output: 1, cacheRead: 0 } } },
      /models\.m\.cacheWrite/,
    ],
    [
      'negative rate',
      {
        ...VALID,
        models: { m: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      },
      /models\.m\.input/,
    ],
    ['not an object', 'nope', /Invalid token rate card/],
  ])('rejects %s', (_name, raw, pattern) => {
    expect(() => parseRateCard(raw, 'card.json')).toThrow(pattern);
  });
});

describe('readRateCardFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-card-schema-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws when the file does not exist', () => {
    expect(() => readRateCardFile(path.join(dir, 'missing.json'))).toThrow(
      /not readable/,
    );
  });

  it('throws when the file is not JSON', () => {
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{');
    expect(() => readRateCardFile(p)).toThrow(/not valid JSON/);
  });

  it('reads a valid file', () => {
    const p = path.join(dir, 'ok.json');
    fs.writeFileSync(p, JSON.stringify(VALID));
    expect(readRateCardFile(p)).toEqual(VALID);
  });
});

describe('shipped seed (config/token-rates.seed.json)', () => {
  const seed = readRateCardFile(REPO_SEED_PATH);

  it('is marked as a dated seed', () => {
    expect(seed.source).toMatch(/^SEED \d{4}-\d{2}-\d{2}/);
    expect(Number.isNaN(Date.parse(seed.updatedAt))).toBe(false);
    expect(seed.unit).toBe('$/MTok');
  });

  it.each([
    'anthropic/claude-opus-5-5',
    'openai/gpt-5.6-sol',
    'google/gemini-3.1-pro-preview',
  ])('covers default instance model %s with non-zero rates', (model) => {
    expect(Object.keys(seed.models)).toContain(model);
    expect(seed.models[model].input).toBeGreaterThan(0);
    expect(seed.models[model].output).toBeGreaterThan(0);
  });

  it('prices delivery-mirror models at zero', () => {
    for (const model of [
      'openclaw/delivery-mirror',
      'clawdbot/delivery-mirror',
    ]) {
      expect(seed.models[model]).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });
});
