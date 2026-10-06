import { describe, expect, it, vi } from 'vitest';

import {
  fetchOpenRouterRates,
  OPENROUTER_MODEL_URL,
  perTokenToPerMTok,
  toOpenRouterId,
} from './openrouter-pricing.js';

describe('perTokenToPerMTok', () => {
  it('converts per-token strings to $/MTok without float noise', () => {
    expect(perTokenToPerMTok('0.000002', 'x')).toBe(2);
    expect(perTokenToPerMTok('0.0000002', 'x')).toBe(0.2);
    expect(perTokenToPerMTok('0.000000375', 'x')).toBe(0.375);
    expect(perTokenToPerMTok(0.00001, 'x')).toBe(10);
  });

  it('maps an absent price to 0', () => {
    expect(perTokenToPerMTok(undefined, 'x')).toBe(0);
    expect(perTokenToPerMTok(null, 'x')).toBe(0);
  });

  it('rejects malformed prices', () => {
    expect(() => perTokenToPerMTok('abc', 'f')).toThrow(
      'invalid OpenRouter price for f',
    );
    expect(() => perTokenToPerMTok('-1', 'f')).toThrow();
    expect(() => perTokenToPerMTok('', 'f')).toThrow();
    expect(() => perTokenToPerMTok('  ', 'f')).toThrow();
  });

  it('rejects non-string, non-number JSON types', () => {
    expect(() => perTokenToPerMTok(false, 'f')).toThrow(
      'invalid OpenRouter price for f: false',
    );
    expect(() => perTokenToPerMTok(true, 'f')).toThrow();
    expect(() => perTokenToPerMTok(['0.1'], 'f')).toThrow();
    expect(() => perTokenToPerMTok([], 'f')).toThrow();
    expect(() => perTokenToPerMTok({ v: '0.1' }, 'f')).toThrow();
    expect(() => perTokenToPerMTok(Number.NaN, 'f')).toThrow();
  });
});

describe('toOpenRouterId', () => {
  it('maps the xai/ provider prefix to x-ai/', () => {
    expect(toOpenRouterId('xai/grok-4.20')).toBe('x-ai/grok-4.20');
  });

  it('leaves other ids unchanged', () => {
    for (const id of [
      'anthropic/claude-opus-5-5',
      'openai/gpt-5.6-sol',
      'x-ai/grok-4.20',
      'xai-labs/m',
      'no-slash',
    ])
      expect(toOpenRouterId(id)).toBe(id);
  });
});

describe('fetchOpenRouterRates', () => {
  it('requests xai/ models under x-ai/', async () => {
    const fetchJson = vi.fn().mockResolvedValue({ status: 404, body: null });
    await expect(
      fetchOpenRouterRates('xai/grok-4.20', fetchJson),
    ).resolves.toBeNull();
    expect(fetchJson).toHaveBeenCalledWith(
      `${OPENROUTER_MODEL_URL}x-ai/grok-4.20`,
    );
  });

  it('returns base-tier rates and the resolved id', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        data: {
          id: 'anthropic/claude-opus-5.5',
          pricing: {
            prompt: '0.000004',
            completion: '0.00002',
            input_cache_read: '0.0000002',
            input_cache_write: '0.000005',
            input_cache_write_1h: '0.000008',
            overrides: [{ min_prompt_tokens: 200000, prompt: '0.000008' }],
          },
        },
      },
    });
    await expect(
      fetchOpenRouterRates('anthropic/claude-opus-5-5', fetchJson),
    ).resolves.toEqual({
      resolvedId: 'anthropic/claude-opus-5.5',
      rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    });
    expect(fetchJson).toHaveBeenCalledWith(
      `${OPENROUTER_MODEL_URL}anthropic/claude-opus-5-5`,
    );
  });

  it('maps missing cache prices to 0', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        data: {
          id: 'm/x',
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      },
    });
    await expect(fetchOpenRouterRates('m/x', fetchJson)).resolves.toMatchObject(
      {
        rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    );
  });

  it('returns null on 404', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ status: 404, body: { error: {} } });
    await expect(fetchOpenRouterRates('nope/x', fetchJson)).resolves.toBeNull();
  });

  it('throws on other statuses and malformed bodies', async () => {
    await expect(
      fetchOpenRouterRates(
        'm/x',
        vi.fn().mockResolvedValue({ status: 500, body: null }),
      ),
    ).rejects.toThrow('HTTP 500');
    await expect(
      fetchOpenRouterRates(
        'm/x',
        vi.fn().mockResolvedValue({ status: 200, body: { data: {} } }),
      ),
    ).rejects.toThrow('has no pricing');
    await expect(
      fetchOpenRouterRates(
        'm/x',
        vi.fn().mockResolvedValue({
          status: 200,
          body: { data: { pricing: { prompt: '0.1' } } },
        }),
      ),
    ).rejects.toThrow('lacks prompt/completion');
  });

  it('rejects a response whose prices are booleans or arrays', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      status: 200,
      body: { data: { pricing: { prompt: false, completion: ['0.1'] } } },
    });
    await expect(fetchOpenRouterRates('m/x', fetchJson)).rejects.toThrow(
      'invalid OpenRouter price for m/x.prompt: false',
    );
  });
});
