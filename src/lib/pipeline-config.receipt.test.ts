import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPipelineConfig, resetPipelineConfig } from './pipeline-config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, default: { ...actual } };
});

function withReceipt(receipt: Record<string, unknown>): void {
  vi.spyOn(fs, 'readFileSync').mockReturnValue(
    JSON.stringify({
      accounts: [],
      buckets: { domains: [], priority: [] },
      refs: {},
      emailConfig: {
        reportOnly: false,
        receipt,
        digest: { slackChannelId: '' },
      },
    }),
  );
  resetPipelineConfig();
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPipelineConfig();
});

describe('emailConfig.receipt', () => {
  it('reads forwardEnabled without a warning', () => {
    withReceipt({
      forwardEnabled: true,
      sparkReceiptsForwardTo: 'r@example.com',
    });
    expect(loadPipelineConfig().emailConfig.receipt).toEqual({
      forwardEnabled: true,
      sparkReceiptsForwardTo: 'r@example.com',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('maps the legacy forwardJGS key to forwardEnabled with one deprecation warning', () => {
    withReceipt({ forwardJGS: true, sparkReceiptsForwardTo: '' });
    const receipt = loadPipelineConfig().emailConfig.receipt;
    expect(receipt).toEqual({
      forwardEnabled: true,
      sparkReceiptsForwardTo: '',
    });
    expect(receipt).not.toHaveProperty('forwardJGS');
    // Cached: a second load does not warn again.
    loadPipelineConfig();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'pipeline-config: emailConfig.receipt.forwardJGS is deprecated; rename it to forwardEnabled.',
    );
  });

  it('prefers forwardEnabled when both keys are present', () => {
    withReceipt({
      forwardJGS: true,
      forwardEnabled: false,
      sparkReceiptsForwardTo: '',
    });
    expect(loadPipelineConfig().emailConfig.receipt).toEqual({
      forwardEnabled: false,
      sparkReceiptsForwardTo: '',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /forwardJGS is deprecated and ignored because forwardEnabled is set/,
      ),
    );
  });

  it('still validates the aliased value', () => {
    withReceipt({ forwardJGS: 'yes', sparkReceiptsForwardTo: '' });
    expect(() => loadPipelineConfig()).toThrow(/forwardEnabled/);
  });

  it('rejects a receipt block with neither key', () => {
    withReceipt({ sparkReceiptsForwardTo: '' });
    expect(() => loadPipelineConfig()).toThrow(/forwardEnabled/);
    expect(warn).not.toHaveBeenCalled();
  });
});
