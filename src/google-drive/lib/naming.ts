/**
 * @module google-drive/lib/naming
 *
 * Local filename/path rules for the Google Drive sync (spec §3.1,
 * §3.2): the Drive-ID tag scheme, sibling collision lengthening,
 * stem/extension splitting by conversion class, NFC sanitization,
 * byte-budget truncation on UTF-8 boundaries, and tag parsing.
 *
 * Pure functions only: no filesystem or network access, so this
 * module is fully unit-testable.
 */

import { createHash } from 'node:crypto';

/** Versioned tag scheme identifier (spec §3.1: "pinned scheme"). */
export const TAG_SCHEME = 'sha256-b32-8';

/** Lowercase RFC 4648 base32 alphabet (no padding). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Segment name byte budget (ext4 NAME_MAX). */
export const MAX_SEGMENT_BYTES = 255;

/** Collision-lengthening tag lengths tried in order. */
const TAG_LENGTHS = [8, 12, 16] as const;

/**
 * Encode bytes as lowercase RFC 4648 base32 (no padding characters).
 */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** Full lowercase base32(sha256(id)) string, cached per id by callers as needed. */
export function hashId(id: string): string {
  const digest = createHash('sha256').update(id, 'utf8').digest();
  return base32Encode(digest);
}

/** The tag for an id at a given length (spec §3.1: first N characters). */
export function tagFor(id: string, length: number): string {
  return hashId(id).slice(0, length);
}

/**
 * Resolve unique tags for a set of sibling Drive ids (spec §3.1
 * collision fallback): start every id at 8 characters; any ids that
 * collide at a given length all move together to the next length
 * (12, then 16). Deterministic given the same sibling set.
 *
 * @throws If two distinct ids still collide at the longest length
 * (not expected in practice: 16 chars is 80 bits).
 */
export function resolveSiblingTags(
  ids: string[],
  /** Injectable for testing collision lengthening without a real sha256 collision. */
  hashFn: (id: string, length: number) => string = tagFor,
): Map<string, string> {
  const result = new Map<string, string>();
  let pending = [...new Set(ids)];

  for (const length of TAG_LENGTHS) {
    if (pending.length === 0) break;
    const byTag = new Map<string, string[]>();
    for (const id of pending) {
      const tag = hashFn(id, length);
      const group = byTag.get(tag) ?? [];
      group.push(id);
      byTag.set(tag, group);
    }
    const stillColliding: string[] = [];
    for (const [tag, group] of byTag) {
      if (group.length === 1) {
        result.set(group[0], tag);
      } else {
        stillColliding.push(...group);
      }
    }
    pending = stillColliding;
  }

  if (pending.length > 0) {
    throw new Error(
      `naming: unresolved tag collision among sibling ids at 16 characters: ${pending.join(', ')}`,
    );
  }

  return result;
}

/**
 * Parse the Drive-ID tag out of a local segment name (spec §3.1):
 * the token after the last ` - `, `[a-z2-7]{8,}`, ending at the first
 * `.` that follows it. Returns null if the name has no parseable tag.
 */
export function parseTag(segmentName: string): string | null {
  const match = /(?: - )([a-z2-7]{8,})(?:\.[^/]*)?$/.exec(segmentName);
  return match ? match[1] : null;
}

/** Conversion class, used to pick the stem/extension split rule (§3.2). */
export type NamingClass =
  'google-native' | 'native-text' | 'converted-binary' | 'folder';

/** A valid "last extension" per spec §3.2: `^\.[A-Za-z0-9]{1,10}$`. */
const LAST_EXT_PATTERN = /\.[A-Za-z0-9]{1,10}$/;

/** The name's last extension as written (`.DOCX`), or '' when it has none. */
export function lastExtension(name: string): string {
  return LAST_EXT_PATTERN.exec(name)?.[0] ?? '';
}

/** MIME type → fallback extension for native-text files with no extension. */
const MIME_EXTENSION_FALLBACK: Record<string, string> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/x-yaml': '.yaml',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/x-yaml': '.yaml',
  'application/javascript': '.js',
};

/**
 * Split a Drive item's name into stem and extension per its
 * conversion class (spec §3.2 table).
 */
export function splitStemExt(
  name: string,
  cls: NamingClass,
  mimeType?: string,
): { stem: string; ext: string } {
  if (cls === 'folder') return { stem: name, ext: '' };

  if (cls === 'google-native') {
    // The whole name is the stem, never split; always exported .md.
    return { stem: name, ext: '.md' };
  }

  const lastExt = lastExtension(name) || null;
  const stem = lastExt ? name.slice(0, -lastExt.length) : name;

  if (cls === 'converted-binary') {
    const sourceExt = lastExt ?? '';
    return { stem, ext: `${sourceExt}.md` };
  }

  // native-text
  if (lastExt) return { stem, ext: lastExt };
  const fallback = mimeType ? MIME_EXTENSION_FALLBACK[mimeType] : undefined;
  return { stem, ext: fallback ?? '.txt' };
}

/**
 * Sanitize a single path segment (spec §3.1 "Sanitization"): NFC
 * normalize, replace `/`, NUL and control characters with `_`, trim
 * leading/trailing whitespace and dots, `untitled` if empty.
 */
export function sanitizeSegment(name: string): string {
  const normalized = name.normalize('NFC');
  let replaced = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    replaced += ch === '/' || code <= 0x1f ? '_' : ch;
  }
  const trimmed = replaced.replace(/^[\s.]+|[\s.]+$/g, '');
  return trimmed.length > 0 ? trimmed : 'untitled';
}

/**
 * Build the final segment name `<stem> - <tag><ext>` (spec §3.1),
 * truncating the stem on a UTF-8 code-point boundary so the whole
 * segment fits `maxSegmentBytes` (default 255, ext4 `NAME_MAX`), and
 * respecting an optional tighter `maxNameBytes` readability cap.
 */
export function buildSegmentName(
  stem: string,
  tag: string,
  ext: string,
  options: { maxNameBytes?: number | null; maxSegmentBytes?: number } = {},
): string {
  const maxSegmentBytes = options.maxSegmentBytes ?? MAX_SEGMENT_BYTES;
  const sanitizedStem = sanitizeSegment(stem);
  const suffix = ` - ${tag}${ext}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let nameBudget = maxSegmentBytes - suffixBytes;
  if (options.maxNameBytes != null) {
    nameBudget = Math.min(nameBudget, options.maxNameBytes);
  }
  if (nameBudget < 1) {
    throw new Error(
      `naming: tag/extension suffix "${suffix}" alone exceeds the segment byte budget (${String(maxSegmentBytes)})`,
    );
  }

  const truncatedStem = truncateUtf8(sanitizedStem, nameBudget);
  const finalStem = truncatedStem.replace(/[\s.]+$/g, '') || 'untitled';
  return `${finalStem}${suffix}`;
}

/** Truncate a string to fit within `maxBytes` UTF-8 bytes, on a code-point boundary. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const chars = Array.from(value);
  let result = '';
  let bytes = 0;
  for (const ch of chars) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    result += ch;
    bytes += chBytes;
  }
  return result;
}

/** Identity root segment: verbatim email, lowercased (spec §3.1, Q2). */
export function identityRootSegment(email: string): string {
  return email.toLowerCase();
}
