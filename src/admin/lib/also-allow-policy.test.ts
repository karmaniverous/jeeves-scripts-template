import { describe, expect, it } from 'vitest';

import {
  classifyAlsoAllowPolicy,
  LEGACY_PATCHED,
  LEGACY_UNPATCHED,
  patchLegacyAlsoAllow,
} from './also-allow-policy.js';
import { TOOL_POLICY_HAS_RESTRICTIVE } from './openclaw-dist-fixtures.js';

const LEGACY_IMPORT =
  'import { t as IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW } from "./sandbox-tool-policy-x.js";';

describe('classifyAlsoAllowPolicy', () => {
  it('recognises the upstream fix in v2026.9.6', () => {
    expect(classifyAlsoAllowPolicy(TOOL_POLICY_HAS_RESTRICTIVE)).toEqual({
      state: 'upstream-fixed',
      line: 2,
    });
  });

  it('recognises legacy unpatched and patched bodies', () => {
    expect(classifyAlsoAllowPolicy(`x\n${LEGACY_UNPATCHED}\n`).state).toBe(
      'legacy-unpatched',
    );
    expect(classifyAlsoAllowPolicy(`${LEGACY_PATCHED}\n`).state).toBe(
      'legacy-patched',
    );
  });

  it('reports absent when the function is not defined', () => {
    expect(
      classifyAlsoAllowPolicy('export { hasRestrictiveAllowPolicy as t };')
        .state,
    ).toBe('absent');
  });

  it('reports unknown for unrecognised bodies or duplicates', () => {
    expect(
      classifyAlsoAllowPolicy(
        'function hasRestrictiveAllowPolicy(policy) {\n\treturn true;\n}',
      ).state,
    ).toBe('unknown');
    expect(
      classifyAlsoAllowPolicy(
        `${TOOL_POLICY_HAS_RESTRICTIVE}\n${TOOL_POLICY_HAS_RESTRICTIVE}`,
      ).state,
    ).toBe('unknown');
  });
});

describe('patchLegacyAlsoAllow', () => {
  it('adds the early bail on legacy builds and is idempotent', () => {
    const content = `${LEGACY_IMPORT}\n${LEGACY_UNPATCHED}\n`;
    const r = patchLegacyAlsoAllow(content);
    expect(r.status).toBe('patch');
    if (r.status !== 'patch') return;
    expect(r.content).toBe(`${LEGACY_IMPORT}\n${LEGACY_PATCHED}\n`);
    expect(patchLegacyAlsoAllow(r.content).status).toBe('already-patched');
  });

  it('refuses when the marker symbol is not in scope', () => {
    expect(patchLegacyAlsoAllow(LEGACY_UNPATCHED).status).toBe('ambiguous');
  });

  it('does not match the upstream-fixed body', () => {
    const content = `${LEGACY_IMPORT}\n${TOOL_POLICY_HAS_RESTRICTIVE}`;
    expect(patchLegacyAlsoAllow(content).status).toBe('not-found');
  });
});
