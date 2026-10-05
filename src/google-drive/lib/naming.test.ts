import { describe, expect, it } from 'vitest';

import {
  buildSegmentName,
  hashId,
  identityRootSegment,
  parseTag,
  resolveSiblingTags,
  sanitizeSegment,
  splitStemExt,
  TAG_SCHEME,
  tagFor,
  truncateUtf8,
} from './naming.js';

describe('naming: tag hashing', () => {
  // Golden value from a real Drive id (it appears as `… - r2nhreg6.md` in the
  // live tree) and matches the README's standalone one-liner. If this fails,
  // every synced path would be renamed: bump TAG_SCHEME deliberately instead.
  it('is pinned: sha256 → RFC 4648 base32 (lowercase) → prefix', () => {
    expect(TAG_SCHEME).toBe('sha256-b32-8');
    const id = '1xEbiQypfxFstQGGHw-D9FI5Z7XwJooUndbwskJlikMA';
    expect(tagFor(id, 8)).toBe('r2nhreg6');
    expect(tagFor(id, 12)).toBe('r2nhreg6mhq6');
    expect(hashId(id)).toMatch(/^r2nhreg6mhq6[a-z2-7]{40}$/);
  });
});

describe('naming: sibling collision lengthening', () => {
  it('assigns 8-char tags when there is no collision', () => {
    const tags = resolveSiblingTags(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      expect(tags.get(id)).toHaveLength(8);
    }
    expect(new Set(tags.values()).size).toBe(3);
  });

  it('lengthens only the colliding group to 12 chars', () => {
    // Fake hash: ids "a1"/"a2" collide at 8 chars but differ at 12.
    const fake = (id: string, length: number): string => {
      const base = id.startsWith('a')
        ? 'aaaaaaaa'
        : `${id}zzzzzzzz`.slice(0, 8);
      return length === 8
        ? base
        : `${base}${id.padEnd(length - 8, 'q')}`.slice(0, length);
    };
    const tags = resolveSiblingTags(['a1', 'a2', 'b'], fake);
    expect(tags.get('a1')).toHaveLength(12);
    expect(tags.get('a2')).toHaveLength(12);
    expect(tags.get('b')).toHaveLength(8);
    expect(tags.get('a1')).not.toBe(tags.get('a2'));
  });

  it('throws when ids still collide at the longest length', () => {
    expect(() => resolveSiblingTags(['p', 'q'], () => 'samesame')).toThrow(
      /unresolved tag collision/,
    );
  });

  it('dedupes repeated ids', () => {
    const tags = resolveSiblingTags(['x', 'x', 'y']);
    expect(tags.size).toBe(2);
  });
});

describe('naming: tag parsing', () => {
  it('recovers the tag after the last " - "', () => {
    expect(parseTag('report - k3v7q2xm.docx.md')).toBe('k3v7q2xm');
    expect(parseTag('Engineering - p5zr2a7d')).toBe('p5zr2a7d');
    expect(parseTag('notes - k3v7q2xm.md')).toBe('k3v7q2xm');
  });

  it('is not confused by " - " inside the stem', () => {
    expect(parseTag('Q3 Plan - Draft - k3v7q2xm.md')).toBe('k3v7q2xm');
  });

  it('returns null when there is no tag-shaped suffix', () => {
    expect(parseTag('mike.blaney@example.com')).toBeNull();
    expect(parseTag('plain-file.txt')).toBeNull();
  });
});

describe('naming: stem/extension split (§3.2)', () => {
  it('google-native: whole name is the stem, extension always .md', () => {
    expect(splitStemExt('Notes v3.5 final', 'google-native')).toEqual({
      stem: 'Notes v3.5 final',
      ext: '.md',
    });
  });

  it('native-text: splits the last extension', () => {
    expect(splitStemExt('notes.md', 'native-text')).toEqual({
      stem: 'notes',
      ext: '.md',
    });
  });

  it('native-text: falls back to a MIME-derived extension when there is none', () => {
    expect(splitStemExt('README', 'native-text', 'text/plain')).toEqual({
      stem: 'README',
      ext: '.txt',
    });
    expect(splitStemExt('notes', 'native-text', 'text/markdown')).toEqual({
      stem: 'notes',
      ext: '.md',
    });
  });

  it('converted-binary: keeps the source extension and appends .md', () => {
    expect(splitStemExt('report.docx', 'converted-binary')).toEqual({
      stem: 'report',
      ext: '.docx.md',
    });
    expect(splitStemExt('spec.pdf', 'converted-binary')).toEqual({
      stem: 'spec',
      ext: '.pdf.md',
    });
  });

  it('multi-dot names: only the last extension is split', () => {
    expect(splitStemExt('report.final.docx', 'converted-binary')).toEqual({
      stem: 'report.final',
      ext: '.docx.md',
    });
    expect(splitStemExt('notes.md.txt', 'native-text')).toEqual({
      stem: 'notes.md',
      ext: '.txt',
    });
    expect(splitStemExt('x.docx.md', 'native-text')).toEqual({
      stem: 'x.docx',
      ext: '.md',
    });
  });

  it('a name with no dot-extension keeps the whole name as stem (native-text, no MIME)', () => {
    expect(splitStemExt('Q3 results.final draft', 'native-text')).toEqual({
      stem: 'Q3 results.final draft',
      ext: '.txt',
    });
  });

  it('folder: no extension, name unchanged', () => {
    expect(splitStemExt('a', 'folder')).toEqual({ stem: 'a', ext: '' });
  });
});

describe('naming: sanitization', () => {
  it('replaces / and control characters with _', () => {
    expect(sanitizeSegment('2026/10/04\u0000x\u007f')).toBe('2026_10_04_x_');
  });

  it('replaces every character Windows forbids, so names are valid cross-platform', () => {
    expect(sanitizeSegment('Q3: plan "v2" <draft> a\\b|c*?')).toBe(
      'Q3_ plan _v2_ _draft_ a_b_c__',
    );
    expect(sanitizeSegment('2026/10/04 13:34 UTC')).toBe(
      '2026_10_04 13_34 UTC',
    );
  });

  it('escapes Windows reserved device names, with or without an extension', () => {
    expect(sanitizeSegment('CON')).toBe('CON_');
    expect(sanitizeSegment('nul.txt')).toBe('nul_.txt');
    expect(sanitizeSegment('com1.tar.gz')).toBe('com1_.tar.gz');
    expect(sanitizeSegment('LPT\u00b9')).toBe('LPT\u00b9_');
    expect(sanitizeSegment('console')).toBe('console');
    expect(sanitizeSegment('com10')).toBe('com10');
  });

  it('trims leading/trailing whitespace and dots', () => {
    expect(sanitizeSegment('  .foo.  ')).toBe('foo');
  });

  it('becomes untitled when empty after trimming', () => {
    expect(sanitizeSegment('   ...   ')).toBe('untitled');
  });

  it('NFC-normalizes', () => {
    const decomposed = 'e\u0301'; // e + combining acute accent
    expect(sanitizeSegment(decomposed)).toBe('e\u0301'.normalize('NFC'));
  });
});

describe('naming: byte-budget truncation', () => {
  it('truncates on a UTF-8 code-point boundary, never splitting a multi-byte char', () => {
    const name = '\u00e9'.repeat(200); // 2 bytes each => 400 bytes
    const truncated = truncateUtf8(name, 255);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(255);
    // every remaining char must be a whole code point
    expect(Array.from(truncated).every((c) => c === '\u00e9')).toBe(true);
    expect(truncateUtf8('short', 255)).toBe('short');
  });

  it('buildSegmentName fits within the 255-byte budget', () => {
    const longStem = 'x'.repeat(300);
    const result = buildSegmentName(longStem, 'k3v7q2xm', '.txt');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(255);
    expect(result.endsWith(' - k3v7q2xm.txt')).toBe(true);
  });

  it('honors an optional tighter maxNameBytes readability cap', () => {
    const result = buildSegmentName(
      'a very long descriptive name here',
      'tagtagtag',
      '.md',
      {
        maxNameBytes: 10,
      },
    );
    const namePart = result.slice(0, result.indexOf(' - '));
    expect(Buffer.byteLength(namePart, 'utf8')).toBeLessThanOrEqual(10);
  });

  it('never leaves a stem empty: falls back to untitled', () => {
    const result = buildSegmentName('   ', 'tagtagtag', '.md');
    expect(result.startsWith('untitled - ')).toBe(true);
  });
});

describe('naming: identity root', () => {
  it('is the verbatim email, lowercased', () => {
    expect(identityRootSegment('odd:name@example.com')).toBe(
      'odd_name@example.com',
    );
    expect(identityRootSegment('Mike.Blaney@Example.com')).toBe(
      'mike.blaney@example.com',
    );
  });
});
