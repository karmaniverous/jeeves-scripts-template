import fs from 'node:fs';

import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImapPassword } from '../../lib/imap-secrets.js';
import { imapSecretPath } from '../../lib/imap-secrets.js';
import type { AccountConfig } from '../../lib/pipeline-config.js';
import { pollImapAccount } from './poll.js';

const imap = vi.hoisted(() => ({
  options: [] as unknown[],
  connect: vi.fn<() => Promise<void>>(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: unknown) {
      imap.options.push(options);
    }
    connect(): Promise<void> {
      return imap.connect();
    }
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, default: { ...actual } };
});

const SECRET = 'correct horse';

function account(password: ImapPassword): AccountConfig {
  return {
    email: 'carol@example.com',
    type: 'imap',
    emailPolling: true,
    imap: {
      host: 'imap.example.com',
      port: 993,
      tls: true,
      user: 'carol@example.com',
      password,
    },
  };
}

// Never used: every test stops at connect (auth failure or missing secret).
const client = {} as RunnerClient;

let error: MockInstance<typeof console.error>;

beforeEach(() => {
  imap.options.length = 0;
  imap.connect.mockReset();
  imap.connect.mockRejectedValue(new Error('AUTHENTICATIONFAILED login'));
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pollImapAccount password resolution', () => {
  it('authenticates with the secretRef file content, trimmed', async () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(`${SECRET}\n`);
    await pollImapAccount(account({ secretRef: 'carol' }), client);
    expect(read).toHaveBeenCalledWith(imapSecretPath('carol'), 'utf8');
    expect(imap.options).toEqual([
      expect.objectContaining({
        auth: { user: 'carol@example.com', pass: SECRET },
      }),
    ]);
    // The auth failure is logged without the password.
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('still accepts a literal password', async () => {
    await pollImapAccount(account(SECRET), client);
    expect(imap.options).toEqual([
      expect.objectContaining({
        auth: { user: 'carol@example.com', pass: SECRET },
      }),
    ]);
  });

  it('fails before connecting when the secret file is missing', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    });
    await expect(
      pollImapAccount(account({ secretRef: 'carol' }), client),
    ).rejects.toThrow(
      `IMAP secret "carol" could not be read from ${imapSecretPath('carol')} (ENOENT).`,
    );
    expect(imap.options).toEqual([]);
    expect(imap.connect).not.toHaveBeenCalled();
  });
});
