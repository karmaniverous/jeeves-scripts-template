/**
 * Pins the path constants to the layout jeeves-tools provisions on managed
 * instances (karmaniverous/jeeves-tools#178):
 *
 * - content root `/opt/jeeves/<contentDir>` with `contentDir` defaulting to
 *   `content`: the only root the watcher indexes and the server serves;
 * - gog home `/opt/jeeves/config/gogcli`: where deploy writes the
 *   service-account key and keyring, and what the gateway unit and the
 *   runner drop-in export as `GOG_HOME`.
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
  it('is the root jeeves-tools indexes and serves, not the old openclaw path', async () => {
    const c = await loadConstants();
    expect(c.CONTENT_DIR).toBe('/opt/jeeves/content');
    expect(isUnder(c.CONTENT_DIR, '/opt/jeeves/openclaw')).toBe(false);
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

describe('gog home', () => {
  it('defaults to the directory jeeves-tools deploy provisions', async () => {
    vi.stubEnv('GOG_HOME', undefined);
    const c = await loadConstants();
    expect(c.GOG_CONFIG_DIR).toBe('/opt/jeeves/config/gogcli');
    expect(isUnder(c.GOG_CONFIG_DIR, c.CREDENTIALS_DIR)).toBe(false);
  });

  it('follows GOG_HOME when the unit sets it', async () => {
    vi.stubEnv('GOG_HOME', '/srv/gog');
    const c = await loadConstants();
    expect(c.GOG_CONFIG_DIR).toBe('/srv/gog');
    expect(isUnder(c.GOG_CLIENT_PATH, '/srv/gog')).toBe(true);
  });

  it('keeps the OAuth client file inside the gog home', async () => {
    vi.stubEnv('GOG_HOME', undefined);
    const c = await loadConstants();
    expect(isUnder(c.GOG_CLIENT_PATH, '/opt/jeeves/config/gogcli')).toBe(true);
  });
});
