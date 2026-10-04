import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    // "a@b.co" -> YUBiLmNv (no padding); "a@b.c" -> YUBiLmM= (padded)
    expect(serviceAccountFileName('a@b.co')).toBe('sa-YUBiLmNv.json');
    expect(serviceAccountFileName('a@b.c')).toBe('sa-YUBiLmM.json');
  });
});

describe('serviceAccountKeyPath', () => {
  it('lives under <config>/data, not the config root', () => {
    expect(serviceAccountKeyPath('a@b.co', '/x/gogcli')).toBe(
      path.join('/x/gogcli', 'data', 'sa-YUBiLmNv.json'),
    );
  });
});

describe('findServiceAccountFile', () => {
  it('finds a registration in data/', () => {
    const p = writeSa('me@example.com');
    expect(findServiceAccountFile('me@example.com', dir)).toBe(p);
  });

  it('ignores a registration in the config root (old wrong location)', () => {
    fs.writeFileSync(
      path.join(dir, serviceAccountFileName('me@example.com')),
      '{}',
    );
    expect(findServiceAccountFile('me@example.com', dir)).toBeNull();
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
  });
});
