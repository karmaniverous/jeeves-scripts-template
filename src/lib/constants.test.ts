/**
 * Pins the path constants to the layout jeeves-tools provisions on managed
 * instances (karmaniverous/jeeves-tools#178, `src/api/remote-paths.ts`):
 *
 * - content root `/opt/jeeves/<contentDir>` with `contentDir` defaulting to
 *   `content`: the only root the watcher indexes and the server serves;
 * - gog home `/opt/jeeves/config/gogcli`: where deploy writes the
 *   service-account key and keyring, and what the gateway unit and the
 *   runner drop-in export as `GOG_HOME`;
 * - scripts checkout and gh config, where deploy clones the scripts repo
 *   and provisions gh.
 *
 * @module constants.test
 */

import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ConstantsModule from './constants.js';

type Constants = typeof ConstantsModule;

/** Re-evaluate the constants barrel under the current environment. */
async function loadConstants(): Promise<Constants> {
  vi.resetModules();
  return import('./constants.js');
}

/** True when `child` is `root` or lies beneath it (POSIX semantics). */
function isUnder(child: string, root: string): boolean {
  const rel = path.posix.relative(root, child.split(path.sep).join('/'));
  return !rel.startsWith('..') && !path.posix.isAbsolute(rel);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('content root', () => {
  it('is the root jeeves-tools indexes and serves', async () => {
    const c = await loadConstants();
    expect(c.CONTENT_DIR).toBe('/opt/jeeves/content');
  });

  it('contains every content-derived pipeline output directory', async () => {
    const c = await loadConstants();
    const derived = {
      GITHUB_DIR: c.GITHUB_DIR,
      DEFAULT_MEETINGS_DIR: c.DEFAULT_MEETINGS_DIR,
      SLACK_DOMAIN_DIR: c.SLACK_DOMAIN_DIR,
      JIRA_DIR: c.JIRA_DIR,
      LINEAR_DIR: c.LINEAR_DIR,
    };
    const outside = Object.entries(derived)
      .filter(([, dir]) => !isUnder(dir, '/opt/jeeves/content'))
      .map(([name]) => name);
    expect(outside).toEqual([]);
  });
});

describe('provisioned paths', () => {
  it.each([
    ['SCRIPTS_DIR', '/opt/jeeves/jeeves-scripts'],
    ['PIPELINE_CONFIG_PATH', '/opt/jeeves/jeeves-scripts/pipeline-config.json'],
    ['GH_CONFIG_DIR', '/opt/jeeves/config/gh-cli'],
  ] as const)('%s is where jeeves-tools deploy puts it', async (name, want) => {
    const c = await loadConstants();
    expect(c[name]).toBe(want);
  });
});

describe('gog home', () => {
  it('defaults to the directory jeeves-tools deploy provisions', async () => {
    vi.stubEnv('GOG_HOME', undefined);
    const c = await loadConstants();
    expect(c.GOG_CONFIG_DIR).toBe('/opt/jeeves/config/gogcli');
    expect(isUnder(c.GOG_CLIENT_PATH, c.GOG_CONFIG_DIR)).toBe(true);
  });

  it('follows GOG_HOME when the unit sets it', async () => {
    vi.stubEnv('GOG_HOME', '/srv/gog');
    const c = await loadConstants();
    expect(c.GOG_CONFIG_DIR).toBe('/srv/gog');
    expect(isUnder(c.GOG_CLIENT_PATH, '/srv/gog')).toBe(true);
  });
});

describe('IMAP secrets directory', () => {
  it('is where jeeves-tools deploy writes IMAP password files', async () => {
    const c = await loadConstants();
    expect(c.IMAP_SECRETS_DIR.split(path.sep).join('/')).toBe(
      '/opt/jeeves/config/credentials/imap',
    );
  });
});

describe('OpenClaw upgrade cutoff', () => {
  it.each([undefined, ''])(
    'has no default when the env var is %j',
    async (v) => {
      vi.stubEnv('OPENCLAW_UPGRADE_CUTOFF', v);
      const c = await loadConstants();
      expect(c.OPENCLAW_UPGRADE_CUTOFF).toBeUndefined();
    },
  );

  it('reads OPENCLAW_UPGRADE_CUTOFF as given', async () => {
    vi.stubEnv('OPENCLAW_UPGRADE_CUTOFF', '2030-01-02T03:00:00Z');
    const c = await loadConstants();
    expect(c.OPENCLAW_UPGRADE_CUTOFF).toBe('2030-01-02T03:00:00Z');
  });
});
