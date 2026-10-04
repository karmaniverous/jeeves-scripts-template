import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GOG_CLIENT_PATH } from './constants.js';
import {
  detectGogCredentials,
  findServiceAccountFile,
  requireGogCredentials,
  serviceAccountFileName,
  serviceAccountKeyPath,
} from './gog-credentials.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-creds-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeSa(email: string): string {
  const p = serviceAccountKeyPath(email, dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{}');
  return p;
}

describe('serviceAccountFileName', () => {
  it('base64-encodes the email and strips padding', () => {
    // "ab@x.test" -> YWJAeC50ZXN0 (no padding); "a@x.test" -> YUB4LnRlc3Q= (padded)
    expect(serviceAccountFileName('ab@x.test')).toBe('sa-YWJAeC50ZXN0.json');
    expect(serviceAccountFileName('a@x.test')).toBe('sa-YUB4LnRlc3Q.json');
  });
});

describe('serviceAccountKeyPath', () => {
  it('lives under <config>/data, not the config root', () => {
    expect(serviceAccountKeyPath('ab@x.test', '/x/gogcli')).toBe(
      path.join('/x/gogcli', 'data', 'sa-YWJAeC50ZXN0.json'),
    );
  });
});

describe('findServiceAccountFile', () => {
  it('finds a registration in data/', () => {
    const p = writeSa('me@example.com');
    expect(findServiceAccountFile('me@example.com', dir)).toBe(p);
  });

  it('finds a registration in the config root (gog v0.9.x layout)', () => {
    const p = path.join(dir, serviceAccountFileName('me@example.com'));
    fs.writeFileSync(p, '{}');
    expect(findServiceAccountFile('me@example.com', dir)).toBe(p);
  });

  it('prefers data/ when both locations have a registration', () => {
    fs.writeFileSync(
      path.join(dir, serviceAccountFileName('me@example.com')),
      '{}',
    );
    const p = writeSa('me@example.com');
    expect(findServiceAccountFile('me@example.com', dir)).toBe(p);
  });

  it('returns null for an unregistered email', () => {
    writeSa('other@example.com');
    expect(findServiceAccountFile('me@example.com', dir)).toBeNull();
  });
});

describe('detectGogCredentials', () => {
  it('SA-only: no OAuth client, one sa-* registration', () => {
    writeSa('me@example.com');
    expect(detectGogCredentials(dir)).toEqual({
      oauthClient: false,
      serviceAccount: true,
      any: true,
    });
  });

  it('SA-only in the config root (gog v0.9.x layout)', () => {
    fs.writeFileSync(
      path.join(dir, serviceAccountFileName('me@example.com')),
      '{}',
    );
    expect(detectGogCredentials(dir)).toEqual({
      oauthClient: false,
      serviceAccount: true,
      any: true,
    });
  });

  it('SA in both data/ and the config root', () => {
    fs.writeFileSync(
      path.join(dir, serviceAccountFileName('root@example.com')),
      '{}',
    );
    writeSa('data@example.com');
    expect(detectGogCredentials(dir).serviceAccount).toBe(true);
    expect(findServiceAccountFile('root@example.com', dir)).toBe(
      path.join(dir, serviceAccountFileName('root@example.com')),
    );
    expect(findServiceAccountFile('data@example.com', dir)).toBe(
      serviceAccountKeyPath('data@example.com', dir),
    );
  });

  it('OAuth-only: credentials.json, no data/', () => {
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{}');
    expect(detectGogCredentials(dir)).toEqual({
      oauthClient: true,
      serviceAccount: false,
      any: true,
    });
  });

  it('none: empty config dir, or data/ without sa-* files', () => {
    expect(detectGogCredentials(dir).any).toBe(false);
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'token.json'), '{}');
    expect(detectGogCredentials(dir)).toEqual({
      oauthClient: false,
      serviceAccount: false,
      any: false,
    });
  });
});

describe('requireGogCredentials', () => {
  const none = { oauthClient: false, serviceAccount: false, any: false };
  const sa = { oauthClient: false, serviceAccount: true, any: true };
  const oauth = { oauthClient: true, serviceAccount: false, any: true };

  it('returns false when no accounts need gog, even without credentials', () => {
    expect(requireGogCredentials('job', 0, none)).toBe(false);
  });

  it('returns true for SA-only and OAuth-only', () => {
    expect(requireGogCredentials('job', 2, sa)).toBe(true);
    expect(requireGogCredentials('job', 2, oauth)).toBe(true);
  });

  it('throws when accounts are configured but there are no credentials', () => {
    expect(() => requireGogCredentials('email/poll', 2, none)).toThrow(
      /email\/poll: 2 Google account\(s\) configured but no gog credentials/,
    );
    expect(() => requireGogCredentials('email/poll', 2, none)).toThrow(/ or /);
  });
});

describe('detectGogCredentials with the default config dir', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks GOG_CLIENT_PATH for the OAuth client', () => {
    const exists = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => p === GOG_CLIENT_PATH);
    expect(detectGogCredentials()).toEqual({
      oauthClient: true,
      serviceAccount: false,
      any: true,
    });
    expect(exists).toHaveBeenCalledWith(GOG_CLIENT_PATH);
  });
});
