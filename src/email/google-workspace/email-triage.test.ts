import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/pipeline-config.js', () => ({
  getBucketForDomain: vi.fn(() => null),
  getBucketNames: vi.fn(() => ['Alpha', 'Beta']),
  getBucketPriority: vi.fn(() => ({ Alpha: 0, Beta: 1 })),
  loadPipelineConfig: vi.fn(() => ({ buckets: { domains: [] } })),
}));

import { getBucketNames } from '../../lib/pipeline-config.js';
import {
  computeLabelsToApply,
  configuredBucket,
  newLabelCounts,
} from './email-triage.js';

describe('configuredBucket', () => {
  it('keeps a configured bucket', () => {
    expect(configuredBucket('Beta')).toBe('Beta');
  });

  it('drops unknown, empty and missing buckets', () => {
    expect(configuredBucket('Retired')).toBeNull();
    expect(configuredBucket('')).toBeNull();
    expect(configuredBucket(null)).toBeNull();
    expect(configuredBucket(undefined)).toBeNull();
  });
});

describe('newLabelCounts', () => {
  it('has a zero counter for receipt, junk and each configured bucket', () => {
    expect(newLabelCounts()).toEqual({
      receipt: 0,
      junk: 0,
      Alpha: 0,
      Beta: 0,
    });
  });

  it('follows the config, with no built-in bucket names', () => {
    vi.mocked(getBucketNames).mockReturnValueOnce([]);
    expect(newLabelCounts()).toEqual({ receipt: 0, junk: 0 });
  });
});

describe('computeLabelsToApply', () => {
  it('labels receipt, junk and the bucket unless already applied', () => {
    expect(
      computeLabelsToApply({
        receiptCandidate: true,
        junkCandidate: true,
        bucket: 'Alpha',
      }),
    ).toEqual(['receipt', 'junk', 'Alpha']);
    expect(
      computeLabelsToApply({
        receiptCandidate: true,
        junkCandidate: false,
        bucket: 'Alpha',
        labelApplied: { Alpha: 't', receipt: 't' },
      }),
    ).toEqual([]);
  });
});
