import { describe, expect, it } from 'vitest';

import { nowIso, uuid } from './fs-utils.js';

describe('fs-utils', () => {
  it('nowIso returns an ISO string', () => {
    const result = nowIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('uuid returns a valid UUID v4', () => {
    const result = uuid();
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
