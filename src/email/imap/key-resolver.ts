/**
 * @module key-resolver
 *
 * Resolves thread/message directory names from a NormalizedMessage using
 * JSONPath expressions defined per account type. Evaluates all paths,
 * concatenates the results, then applies an automatic transform:
 *   - Decimal integer string → lowercase hex (BigInt conversion)
 *   - Anything else → SHA-256 truncated to 16 hex chars
 *
 * Input: string[] of JSONPath expressions + NormalizedMessage.
 * Output: a hex string used as the on-disk directory/file name.
 */

import { createHash } from 'node:crypto';

import { JSONPath } from 'jsonpath-plus';

import type { NormalizedMessage } from './normalize.js';

// ── Internal helpers ──────────────────────────────────────────────────

/** Evaluate one JSONPath expression against msg; return string result. */
function evaluatePath(path: string, msg: NormalizedMessage): string {
  // jsonpath-plus 11 types JSONPath() as unknown. Request wrap explicitly so
  // matches always arrive as an array, then narrow before array use.
  const result = JSONPath({
    path,
    json: msg,
    wrap: true,
  });

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`key-resolver: JSONPath "${path}" resolved to nothing`);
  }

  const first: unknown = result[0];
  if (first === null || first === undefined) {
    throw new Error(
      `key-resolver: JSONPath "${path}" resolved to null/undefined`,
    );
  }

  if (
    typeof first !== 'string' &&
    typeof first !== 'number' &&
    typeof first !== 'boolean' &&
    typeof first !== 'bigint'
  ) {
    throw new Error(
      `key-resolver: JSONPath "${path}" resolved to a non-stringifiable value`,
    );
  }

  return String(first);
}

/** Auto-transform: decimal → hex; otherwise → sha256-16. */
export function autoTransform(value: string): string {
  if (/^\d+$/.test(value)) {
    return BigInt(value).toString(16);
  }
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Resolve a key from an array of JSONPath expressions against a
 * NormalizedMessage. Concatenates all resolved values, then auto-transforms.
 */
export function resolveKey(paths: string[], msg: NormalizedMessage): string {
  const parts = paths.map((p) => evaluatePath(p, msg));
  return autoTransform(parts.join(''));
}
