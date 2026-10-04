import { beforeEach, describe, expect, it, vi } from 'vitest';

const refs = vi.hoisted(() => {
  const value: Record<string, string> = {};
  return { value };
});

vi.mock('../../lib/pipeline-config.js', () => ({
  tryGetRef: (key: string) => refs.value[key] ?? '',
}));

import { DIGEST_TIMEZONE_REF, digestTimeZone } from './digest-timezone.js';

describe('digestTimeZone', () => {
  beforeEach(() => {
    refs.value = {};
  });

  it('returns the configured zone', () => {
    refs.value = { [DIGEST_TIMEZONE_REF]: 'America/Chicago' };
    expect(digestTimeZone()).toBe('America/Chicago');
  });

  it('fails, naming the ref, when no zone is configured', () => {
    expect(() => digestTimeZone()).toThrow(
      'No time zone configured: set refs["digest.timezone"] in pipeline-config.json',
    );
  });

  it('fails on an invalid zone', () => {
    refs.value = { [DIGEST_TIMEZONE_REF]: 'Nope/Zone' };
    expect(() => digestTimeZone()).toThrow(
      'Invalid time zone "Nope/Zone" in refs["digest.timezone"]',
    );
  });
});
