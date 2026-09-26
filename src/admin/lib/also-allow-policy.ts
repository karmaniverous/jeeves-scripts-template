/**
 * @module also-allow-policy
 *
 * Pure detection + legacy patch for OpenClaw's `hasRestrictiveAllowPolicy`.
 *
 * Background: `tools.alsoAllow`-only config used to be classified as a
 * restrictive allowlist, so HTTP-spawned children (e.g. jeeves-meta
 * synthesis) lost core tools. Older OpenClaw builds needed an early bail
 * on the `IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW` marker.
 *
 * Upstream has since fixed this (confirmed in v2026.9.6): alsoAllow-only
 * config becomes `["*", ...alsoAllow]` and `hasRestrictiveAllowPolicy`
 * returns false whenever the allowlist contains `"*"`. On such builds the
 * patch is a no-op; the legacy rewrite is kept for older installs.
 */

import {
  evaluateAnchoredPatch,
  lineOf,
  type TextPatchResult,
} from './text-patch.js';

/** Cheap substring filter: only files containing this are evaluated. */
export const ALSO_ALLOW_PREFILTER = 'function hasRestrictiveAllowPolicy';

/** Legacy (pre-fix) function body, as emitted by the bundler. */
export const LEGACY_UNPATCHED = [
  'function hasRestrictiveAllowPolicy(policy) {',
  '\treturn Array.isArray(policy?.allow) && policy.allow.some((entry) => {',
  '\t\tconst normalized = normalizeToolName(entry);',
  '\t\treturn Boolean(normalized) && normalized !== "*" && normalized !== "__openclaw_default_plugin_tools__";',
  '\t});',
  '}',
].join('\n');

/** Legacy body with our early bail on the alsoAllow provenance marker. */
export const LEGACY_PATCHED = [
  'function hasRestrictiveAllowPolicy(policy) {',
  '\tif (policy?.[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) return false;',
  '\treturn Array.isArray(policy?.allow) && policy.allow.some((entry) => {',
  '\t\tconst normalized = normalizeToolName(entry);',
  '\t\treturn Boolean(normalized) && normalized !== "*" && normalized !== "__openclaw_default_plugin_tools__";',
  '\t});',
  '}',
].join('\n');

/** State of `hasRestrictiveAllowPolicy` in one dist chunk. */
export type AlsoAllowState =
  | 'absent'
  | 'upstream-fixed'
  | 'legacy-patched'
  | 'legacy-unpatched'
  | 'unknown';

const FUNCTION_BODY =
  /function hasRestrictiveAllowPolicy\(policy\) \{[\s\S]*?\n\}/g;
const UPSTREAM_WILDCARD_BAIL =
  /\.includes\(\s*["']\*["']\s*\)\)\s*return false/;
const LEGACY_BAIL =
  'IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) return false';

/** Classify the `hasRestrictiveAllowPolicy` definition in a chunk. */
export function classifyAlsoAllowPolicy(content: string): {
  state: AlsoAllowState;
  line?: number;
} {
  const bodies = [...content.matchAll(FUNCTION_BODY)];
  if (bodies.length === 0) return { state: 'absent' };
  if (bodies.length > 1) return { state: 'unknown' };

  const [m] = bodies;
  const line = lineOf(content, m.index);
  const body = m[0];

  if (body.includes(LEGACY_BAIL)) return { state: 'legacy-patched', line };
  if (UPSTREAM_WILDCARD_BAIL.test(body))
    return { state: 'upstream-fixed', line };
  if (body === LEGACY_UNPATCHED) return { state: 'legacy-unpatched', line };
  return { state: 'unknown', line };
}

/** What the patch script should do given every chunk's classification. */
export type AlsoAllowDecision =
  | { action: 'fail'; message: string }
  | { action: 'noop'; message: string }
  | { action: 'patch'; file: string };

/**
 * Decide the action across all scanned chunks. Exactly one chunk may
 * define `hasRestrictiveAllowPolicy`; zero or several fail closed so a
 * duplicated or unexpected layout is never partially or multiply patched.
 */
export function decideAlsoAllow(
  chunks: readonly { file: string; state: AlsoAllowState }[],
): AlsoAllowDecision {
  const present = chunks.filter((c) => c.state !== 'absent');
  if (present.length === 0) {
    return {
      action: 'fail',
      message:
        'hasRestrictiveAllowPolicy definition not found in any .js/.mjs chunk.',
    };
  }
  if (present.length > 1) {
    return {
      action: 'fail',
      message: `hasRestrictiveAllowPolicy defined in ${String(present.length)} chunks (expected 1): ${present.map((c) => c.file).join(', ')}. Review before patching.`,
    };
  }

  const [c] = present;
  switch (c.state) {
    case 'upstream-fixed':
      return {
        action: 'noop',
        message:
          'Not needed: upstream hasRestrictiveAllowPolicy already treats alsoAllow ("*" + extras) as non-restrictive. No changes.',
      };
    case 'legacy-patched':
      return { action: 'noop', message: 'Already patched — nothing to do.' };
    case 'legacy-unpatched':
      return { action: 'patch', file: c.file };
    default:
      return {
        action: 'fail',
        message: `unrecognised hasRestrictiveAllowPolicy in ${c.file}. OpenClaw may have changed; review before patching.`,
      };
  }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Apply the legacy early-bail patch (only valid for legacy builds). */
export function patchLegacyAlsoAllow(content: string): TextPatchResult {
  if (!content.includes('IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW')) {
    return {
      status: 'ambiguous',
      detail:
        'IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW is not in scope in this chunk',
    };
  }
  return evaluateAnchoredPatch(
    content,
    new RegExp(escape(LEGACY_UNPATCHED), 'g'),
    new RegExp(escape(LEGACY_PATCHED), 'g'),
    () => LEGACY_PATCHED,
  );
}
