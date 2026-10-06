import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPipelineConfig, resetPipelineConfig } from './pipeline-config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, default: { ...actual } };
});

function withEmailConfig(extra: Record<string, unknown>): void {
  vi.spyOn(fs, 'readFileSync').mockReturnValue(
    JSON.stringify({
      accounts: [],
      buckets: { domains: [], priority: [] },
      refs: {},
      emailConfig: {
        reportOnly: false,
        receipt: { forwardEnabled: false, sparkReceiptsForwardTo: '' },
        digest: { slackChannelId: '' },
        ...extra,
      },
    }),
  );
  resetPipelineConfig();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPipelineConfig();
});

describe('emailConfig.meetings', () => {
  it('is optional', () => {
    withEmailConfig({});
    expect(loadPipelineConfig().emailConfig.meetings).toBeUndefined();
  });

  it('reads archive: false', () => {
    withEmailConfig({ meetings: { archive: false } });
    expect(loadPipelineConfig().emailConfig.meetings).toEqual({
      archive: false,
    });
  });

  it('rejects a block without archive', () => {
    withEmailConfig({ meetings: {} });
    expect(() => loadPipelineConfig()).toThrow();
  });
});
