import { describe, expect, it } from 'vitest';

import { checkRegenFrom } from './regen-guard.js';

const CUTOFF = '2026-09-24T09:00:00Z';
const ms = (iso: string) => Date.parse(iso);

describe('checkRegenFrom', () => {
  it('allows --from at the cutoff', () => {
    expect(checkRegenFrom(ms(CUTOFF), CUTOFF, false)).toBeNull();
  });

  it('allows --from after the cutoff', () => {
    expect(
      checkRegenFrom(ms('2026-09-25T00:00:00Z'), CUTOFF, false),
    ).toBeNull();
  });

  it('refuses --from before the cutoff', () => {
    expect(checkRegenFrom(ms('2026-09-24T08:00:00Z'), CUTOFF, false)).toMatch(
      /before the OpenClaw upgrade cutoff 2026-09-24T09:00:00.000Z \(OPENCLAW_UPGRADE_CUTOFF\).*--allow-pre-upgrade/,
    );
  });

  it('allows an earlier --from with --allow-pre-upgrade', () => {
    expect(checkRegenFrom(ms('2026-09-01T00:00:00Z'), CUTOFF, true)).toBeNull();
  });

  it('refuses when the cutoff is not a date, even with --allow-pre-upgrade', () => {
    expect(checkRegenFrom(ms(CUTOFF), 'soon', true)).toBe(
      'Invalid OPENCLAW_UPGRADE_CUTOFF "soon" (expected an ISO 8601 date-time); refusing to run.',
    );
  });

  it.each([undefined, ''])(
    'refuses when the cutoff is unset (%j), naming the setting',
    (cutoff) => {
      for (const allow of [false, true]) {
        expect(checkRegenFrom(ms(CUTOFF), cutoff, allow)).toMatch(
          /^OPENCLAW_UPGRADE_CUTOFF is not set\. Set this environment variable/,
        );
      }
    },
  );
});
