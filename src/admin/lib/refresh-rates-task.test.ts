import { describe, expect, it } from 'vitest';

import { RESULT_LINE_INSTRUCTIONS } from './refresh-rates-outcome.js';
import { buildRefreshRatesTask } from './refresh-rates-task.js';

describe('buildRefreshRatesTask', () => {
  const task = buildRefreshRatesTask('/state/token-metrics/token-rates.json');

  it('points the worker at the rate card path', () => {
    expect(task).toContain('/state/token-metrics/token-rates.json');
  });

  it('ends with the RESULT-line contract', () => {
    expect(task.endsWith(RESULT_LINE_INSTRUCTIONS)).toBe(true);
  });
});
