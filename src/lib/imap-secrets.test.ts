import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CREDENTIALS_DIR, IMAP_SECRETS_DIR } from './constants.js';
import {
  imapSecretPath,
  isSafeSecretRef,
  resolveImapPassword,
} from './imap-secrets.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-secrets-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('IMAP_SECRETS_DIR', () => {
  it('is the imap folder under CREDENTIALS_DIR', () => {
    expect(IMAP_SECRETS_DIR).toBe(path.join(CREDENTIALS_DIR, 'imap'));
  });
});

describe('isSafeSecretRef', () => {
  it.each(['carol', 'mail.example.com', 'acct_1-prod'])('accepts %s', (ref) => {
    expect(isSafeSecretRef(ref)).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', '../x', 'a..b', '.env', 'a b'])(
    'rejects %j',
    (ref) => {
      expect(isSafeSecretRef(ref)).toBe(false);
    },
  );
});

describe('imapSecretPath', () => {
  it('defaults to <CREDENTIALS_DIR>/imap/<ref>', () => {
    expect(imapSecretPath('carol')).toBe(
      path.join(CREDENTIALS_DIR, 'imap', 'carol'),
    );
  });

  it('throws on an unsafe ref', () => {
    expect(() => imapSecretPath('../etc/passwd', dir)).toThrow(
      /IMAP secretRef "\.\.\/etc\/passwd": secretRef must be a plain file name/,
    );
  });
});

describe('resolveImapPassword', () => {
  it('returns a literal string unchanged', () => {
    expect(resolveImapPassword('literal', dir)).toBe('literal');
  });

  it('reads the secret file and trims trailing newlines', () => {
    fs.writeFileSync(path.join(dir, 'carol'), 'pa ss\r\n\n');
    expect(resolveImapPassword({ secretRef: 'carol' }, dir)).toBe('pa ss');
  });

  it('keeps a value without a trailing newline as is', () => {
    fs.writeFileSync(path.join(dir, 'carol'), ' x ');
    expect(resolveImapPassword({ secretRef: 'carol' }, dir)).toBe(' x ');
  });

  it('names the ref and path when the file is missing', () => {
    const file = path.join(dir, 'missing');
    expect(() => resolveImapPassword({ secretRef: 'missing' }, dir)).toThrow(
      `IMAP secret "missing" could not be read from ${file} (ENOENT).`,
    );
  });

  it('refuses an empty secret file without echoing content', () => {
    fs.writeFileSync(path.join(dir, 'blank'), '\n');
    expect(() => resolveImapPassword({ secretRef: 'blank' }, dir)).toThrow(
      /IMAP secret "blank" at .* is empty\./,
    );
  });

  it('refuses an unsafe ref before touching the file system', () => {
    expect(() => resolveImapPassword({ secretRef: '../x' }, dir)).toThrow(
      /plain file name/,
    );
  });
});
