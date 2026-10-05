/**
 * @module google-drive/lib/classify
 *
 * Decide how (or whether) a Drive file becomes text (spec §5): by MIME
 * type first, then by extension. Built-in tables can be extended (never
 * replaced) through `conversion.*` config.
 */

import type { ConversionConfig } from './config.js';
import { lastExtension, type NamingClass } from './naming.js';
import type { DriveFile } from './types.js';

/** How a file is materialised as text. */
export type ConversionKind =
  'gdoc' | 'gsheet' | 'gslides' | 'text' | 'pdf' | 'docx' | 'xlsx' | 'office';

export type Classification =
  | { kind: ConversionKind; namingClass: NamingClass }
  | { kind: 'skip'; reason: 'non-convertible' };

const GOOGLE_NATIVE = new Map<string, ConversionKind>(
  Object.entries({
    'application/vnd.google-apps.document': 'gdoc',
    'application/vnd.google-apps.spreadsheet': 'gsheet',
    'application/vnd.google-apps.presentation': 'gslides',
  } satisfies Record<string, ConversionKind>),
);

const BINARY_BY_MIME = new Map<string, ConversionKind>(
  Object.entries({
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      'office',
    'application/vnd.oasis.opendocument.text': 'office',
    'application/vnd.oasis.opendocument.spreadsheet': 'office',
    'application/vnd.oasis.opendocument.presentation': 'office',
    'application/rtf': 'office',
    'text/rtf': 'office',
  } satisfies Record<string, ConversionKind>),
);

const BINARY_BY_EXT = new Map<string, ConversionKind>(
  Object.entries({
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.xlsx': 'xlsx',
    '.pptx': 'office',
    '.odt': 'office',
    '.ods': 'office',
    '.odp': 'office',
    '.rtf': 'office',
  } satisfies Record<string, ConversionKind>),
);

/** Built-in native-text MIME types (besides any `text/*`). */
export const TEXT_MIME_TYPES = [
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'application/toml',
];

/** Built-in native-text extensions (for `application/octet-stream` uploads). */
export const TEXT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.ps1',
  '.sql',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.log',
  '.tex',
  '.rst',
  '.adoc',
  '.org',
];

/** Classify a Drive file for conversion (spec §5). Folders are not files. */
export function classify(
  file: DriveFile,
  conversion: ConversionConfig,
): Classification {
  const mime = file.mimeType;
  if (conversion.skipMimeTypes.includes(mime)) {
    return { kind: 'skip', reason: 'non-convertible' };
  }

  const native = GOOGLE_NATIVE.get(mime);
  if (native) return { kind: native, namingClass: 'google-native' };
  if (mime.startsWith('application/vnd.google-apps.')) {
    return { kind: 'skip', reason: 'non-convertible' };
  }

  const ext = lastExtension(file.name).toLowerCase();
  const binary = BINARY_BY_MIME.get(mime) ?? BINARY_BY_EXT.get(ext);
  if (binary) return { kind: binary, namingClass: 'converted-binary' };

  const textMimes = [...TEXT_MIME_TYPES, ...conversion.textMimeTypes];
  const textExts = [
    ...TEXT_EXTENSIONS,
    ...conversion.textExtensions.map((e) => e.toLowerCase()),
  ];
  if (
    mime.startsWith('text/') ||
    textMimes.includes(mime) ||
    textExts.includes(ext)
  ) {
    return { kind: 'text', namingClass: 'native-text' };
  }
  return { kind: 'skip', reason: 'non-convertible' };
}
