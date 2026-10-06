import { describe, expect, it } from 'vitest';

import { jsonlLines, ResumeCursor } from './jsonl-cursor.js';

const spans = (content: string, from = 0, to?: number) =>
  [...jsonlLines(content, from, to)].map(({ text, start, end, isTail }) => [
    text,
    start,
    end,
    isTail,
  ]);

describe('jsonlLines', () => {
  it('yields byte spans, counting multi-byte characters as bytes', () => {
    // 'é' is 2 bytes in UTF-8.
    expect(spans('a\né\nbc')).toEqual([
      ['a', 0, 2, false],
      ['é', 2, 5, false],
      ['bc', 5, 8, true],
    ]);
  });

  it('marks the empty text after a final newline as the tail', () => {
    expect(spans('a\n')).toEqual([
      ['a', 0, 2, false],
      ['', 2, 3, true],
    ]);
  });

  it('starts at the first line at or after `from` and stops before `to`', () => {
    expect(spans('a\nb\nc\nd', 2, 6)).toEqual([
      ['b', 2, 4, false],
      ['c', 4, 6, false],
    ]);
  });
});

/** Run a scan: consume every line except those `stop` picks, which halt it. */
function scan(
  content: string,
  from: number,
  opts: { stop?: (t: string) => boolean; unparsed?: (t: string) => boolean },
): number {
  const resume = new ResumeCursor(from);
  for (const line of jsonlLines(content, from)) {
    resume.reach(line);
    if (!line.text || opts.unparsed?.(line.text)) continue;
    if (opts.stop?.(line.text)) {
      resume.stopAt(line);
      break;
    }
    resume.consume(line);
  }
  return resume.offset;
}

describe('ResumeCursor', () => {
  it('resumes at the end of the file when every line was counted', () => {
    expect(scan('a\nb\n', 0, {})).toBe(4);
  });

  it('resumes at the line the scan stopped at, even with complete lines after it', () => {
    const content = 'a\nOPEN\nc\n';
    const offset = scan(content, 0, { stop: (t) => t === 'OPEN' });
    expect(offset).toBe(2);
    // The next scan starts at the stopped record and counts it.
    expect(spans(content, offset)[0][0]).toBe('OPEN');
  });

  it('counts a tail that parses as complete, ready for the newline to follow', () => {
    // 'b' is complete but its newline isn't written yet; the next line will
    // start one byte past the end of the file.
    expect(scan('a\nb', 0, {})).toBe(4);
  });

  it('re-reads a half-written tail that does not parse', () => {
    const offset = scan('a\n{"half', 0, { unparsed: (t) => t.startsWith('{') });
    expect(offset).toBe(2);
  });

  it('stays at the start offset when nothing new is complete', () => {
    expect(scan('a\n{"half', 2, { unparsed: (t) => t.startsWith('{') })).toBe(
      2,
    );
  });
});
