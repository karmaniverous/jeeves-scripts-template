import { describe, expect, it } from 'vitest';

import {
  parseRefreshOutcome,
  RESULT_LINE_INSTRUCTIONS,
} from './refresh-rates-outcome.js';

describe('parseRefreshOutcome', () => {
  it.each([
    ['Summary...\n\nRESULT: updated', { status: 'updated' }],
    ['All verified.\nRESULT: unchanged\n\n', { status: 'unchanged' }],
    ['result: UNCHANGED', { status: 'unchanged' }],
    ['Done.\n`RESULT: updated`', { status: 'updated' }],
    ['Done.\n**RESULT: unchanged**', { status: 'unchanged' }],
    [
      'Could not fetch.\nRESULT: failed: pricing page 403',
      { status: 'failed', reason: 'pricing page 403' },
    ],
    ['RESULT: failed', { status: 'failed', reason: 'no reason given' }],
  ])('parses %j', (text, expected) => {
    expect(parseRefreshOutcome(text)).toEqual(expected);
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['no result line', 'I updated the card.'],
    ['result line not last', 'RESULT: updated\nThanks!'],
    ['unknown status', 'RESULT: partial'],
    ['detail on a success status', 'RESULT: updated: 3 models'],
    ['I could not write the file (no marker)', 'Sorry, no write tool.'],
  ])('rejects %s', (_name, text) => {
    expect(parseRefreshOutcome(text)).toBeNull();
  });

  it('documents every status in the TASK instructions', () => {
    for (const s of [
      'RESULT: updated',
      'RESULT: unchanged',
      'RESULT: failed',
    ]) {
      expect(RESULT_LINE_INSTRUCTIONS).toContain(s);
    }
  });
});
