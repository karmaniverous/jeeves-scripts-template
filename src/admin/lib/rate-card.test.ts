import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@karmaniverous/jeeves', () => ({
  readJson: vi.fn(),
}));

import { readJson } from '@karmaniverous/jeeves';

import {
  computeCosts,
  getModelRates,
  loadRateCard,
  resetRateCard,
} from './rate-card.js';

const MOCK_RATE_CARD = {
  updatedAt: '2025-05-01',
  source: 'manual',
  unit: '$/MTok',
  models: {
    'anthropic/claude-opus-4-6': {
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    },
    'anthropic/claude-sonnet-4-5': {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
};

describe('rate-card', () => {
  afterEach(() => {
    resetRateCard();
    vi.mocked(readJson).mockReset();
  });

  describe('loadRateCard', () => {
    it('loads and returns rate card from config', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);

      const card = loadRateCard();
      expect(card.models).toHaveProperty('anthropic/claude-opus-4-6');
      expect(card.unit).toBe('$/MTok');
    });

    it('caches after first load', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);

      loadRateCard();
      loadRateCard();
      expect(readJson).toHaveBeenCalledTimes(1);
    });

    it('throws when config file is missing', () => {
      vi.mocked(readJson).mockReturnValue(null);

      expect(() => loadRateCard()).toThrow(/Token rate card not found/);
    });

    it('throws when the rate card fails schema validation', () => {
      vi.mocked(readJson).mockReturnValue({
        ...MOCK_RATE_CARD,
        models: { 'x/y': { input: 1, output: 1, cacheRead: 0 } },
      });

      expect(() => loadRateCard()).toThrow(/Invalid token rate card/);
    });
  });

  describe('resetRateCard', () => {
    it('clears cache so next call reloads', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);

      loadRateCard();
      resetRateCard();
      loadRateCard();
      expect(readJson).toHaveBeenCalledTimes(2);
    });
  });

  describe('getModelRates', () => {
    it('returns rates for known model', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);

      const rates = getModelRates('anthropic/claude-opus-4-6');
      expect(rates.input).toBe(15);
      expect(rates.output).toBe(75);
      expect(rates.cacheRead).toBe(1.5);
      expect(rates.cacheWrite).toBe(18.75);
    });

    it('returns zero rates for unknown model with warning', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const rates = getModelRates('unknown/model-x');
      expect(rates).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown/model-x'),
      );

      warnSpy.mockRestore();
    });
  });

  describe('computeCosts', () => {
    it('calculates cost per category using $/MTok formula', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);

      const counts = {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 2_000_000,
        cacheWrite: 100_000,
      };

      const costs = computeCosts('anthropic/claude-opus-4-6', counts);
      // input: 1M tokens * $15/MTok = $15
      expect(costs.input).toBeCloseTo(15);
      // output: 0.5M tokens * $75/MTok = $37.50
      expect(costs.output).toBeCloseTo(37.5);
      // cacheRead: 2M tokens * $1.5/MTok = $3
      expect(costs.cacheRead).toBeCloseTo(3);
      // cacheWrite: 0.1M tokens * $18.75/MTok = $1.875
      expect(costs.cacheWrite).toBeCloseTo(1.875);
    });

    it('returns zero costs for unknown model', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const counts = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
      const costs = computeCosts('unknown/model', counts);
      expect(costs.input).toBe(0);
      expect(costs.output).toBe(0);
    });

    it('handles zero token counts', () => {
      vi.mocked(readJson).mockReturnValue(MOCK_RATE_CARD);

      const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const costs = computeCosts('anthropic/claude-opus-4-6', counts);
      expect(costs.input).toBe(0);
      expect(costs.output).toBe(0);
      expect(costs.cacheRead).toBe(0);
      expect(costs.cacheWrite).toBe(0);
    });
  });
});
