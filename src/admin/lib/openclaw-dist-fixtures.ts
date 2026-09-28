/**
 * @module openclaw-dist-fixtures
 *
 * Verbatim snippets from the OpenClaw v2026.9.6 global install
 * (`openclaw/dist/*.mjs`), used as test fixtures for the post-install
 * patch helpers. Do not reformat the string contents: whitespace and
 * punctuation are exactly what the bundler emitted.
 */

/** `tool-policy-*.mjs`: upstream-fixed `hasRestrictiveAllowPolicy`. */
export const TOOL_POLICY_HAS_RESTRICTIVE = [
  '/** Returns true when an allow policy is narrower than all/default plugin tools. */',
  'function hasRestrictiveAllowPolicy(policy) {',
  '\tif (!Array.isArray(policy?.allow)) return false;',
  '\tconst restrictions = readToolAllowlistIntersection(policy.allow);',
  '\tif (restrictions) return restrictions.some((allow) => allow.length === 0 || hasRestrictiveAllowPolicy({ allow }));',
  '\tconst normalizedAllow = policy.allow.map((entry) => normalizeToolPolicyName(entry));',
  '\tif (normalizedAllow.includes("*")) return false;',
  '\treturn normalizedAllow.some((entry) => Boolean(entry) && entry !== "__openclaw_default_plugin_tools__");',
  '}',
].join('\n');
