/**
 * @module jsonl-cursor
 *
 * Byte-offset walking of append-only JSONL session files, shared by the
 * OpenClaw and Claude Code token scanners.
 *
 * {@link jsonlLines} yields each line with its byte span. A
 * {@link ResumeCursor} works out where the next scan resumes, so that every
 * record is counted exactly once (#61):
 *
 * - a scan that stops at a record (e.g. the first in the still-open hour)
 *   resumes at that record;
 * - otherwise it resumes after the last complete line. The unterminated
 *   last line counts as complete only once it has been consumed (it parsed
 *   and was counted), so a half-written line is re-read on the next scan.
 */

/** One line of a JSONL file and its byte span. */
export interface JsonlLine {
  /** Line text, without the newline. */
  text: string;
  /** Byte offset of the line's first byte. */
  start: number;
  /** Byte offset just past the line's newline (where the next line starts). */
  end: number;
  /** True for the text after the last newline (possibly empty). */
  isTail: boolean;
}

/**
 * Yield the lines of `content` that start at or after byte `from` and
 * before byte `to`.
 */
export function* jsonlLines(
  content: string,
  from: number,
  to = Infinity,
): Generator<JsonlLine> {
  const lines = content.split('\n');
  let pos = 0;
  for (const [i, text] of lines.entries()) {
    const start = pos;
    pos += Buffer.byteLength(text, 'utf8') + 1;
    if (start < from) continue;
    if (start >= to) return;
    yield { text, start, end: pos, isTail: i === lines.length - 1 };
  }
}

/** Tracks the byte offset a scan should resume from. */
export class ResumeCursor {
  #completeEnd: number;
  #stoppedAt: number | null = null;

  /** @param from - offset the scan started at. */
  constructor(from: number) {
    this.#completeEnd = from;
  }

  /** Call for every line reached, before parsing it. */
  reach(line: JsonlLine): void {
    if (!line.isTail) this.#completeEnd = line.end;
  }

  /** Call once a line's record has been counted. */
  consume(line: JsonlLine): void {
    if (line.isTail) this.#completeEnd = line.end;
  }

  /** Call when the scan stops at `line` without counting it. */
  stopAt(line: JsonlLine): void {
    this.#stoppedAt = line.start;
  }

  /** Where the next scan resumes. */
  get offset(): number {
    return this.#stoppedAt ?? this.#completeEnd;
  }
}
