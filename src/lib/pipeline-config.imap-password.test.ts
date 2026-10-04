import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAP_SECRETS_DIR } from './constants.js';
import { loadPipelineConfig, resetPipelineConfig } from './pipeline-config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, default: { ...actual } };
});

const PLAIN_WARNING = `pipeline-config: accounts[].imap.password as a plain string is deprecated; put the password in a file in ${IMAP_SECRETS_DIR} and set imap.password to { "secretRef": "<file name>" }.`;

function imapAccount(email: string, password: unknown) {
  return {
    email,
    type: 'imap',
    emailPolling: true,
    imap: {
      host: 'imap.example.com',
      port: 993,
      tls: true,
      user: email,
      password,
    },
  };
}

function withAccounts(accounts: unknown[]): void {
  vi.spyOn(fs, 'readFileSync').mockReturnValue(
    JSON.stringify({
      accounts,
      buckets: { domains: [], priority: [] },
      refs: {},
      emailConfig: {
        reportOnly: false,
        receipt: { forwardEnabled: false, sparkReceiptsForwardTo: '' },
        digest: { slackChannelId: '' },
      },
    }),
  );
  resetPipelineConfig();
}

function withPasswords(...passwords: unknown[]): void {
  withAccounts(
    passwords.map((p, i) => imapAccount(`user${String(i)}@example.com`, p)),
  );
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPipelineConfig();
});

describe('accounts[].imap.password', () => {
  it('accepts { secretRef } without a warning', () => {
    withPasswords({ secretRef: 'mail-example-com' });
    expect(loadPipelineConfig().accounts[0].imap?.password).toEqual({
      secretRef: 'mail-example-com',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a plain string with one deprecation warning per process', () => {
    withPasswords('hunter2', 'swordfish');
    const accounts = loadPipelineConfig().accounts;
    expect(accounts.map((a) => a.imap?.password)).toEqual([
      'hunter2',
      'swordfish',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(PLAIN_WARNING);
    // The warning never carries the value.
    expect(String(warn.mock.calls[0][0])).not.toMatch(/hunter2|swordfish/);
  });

  it.each([
    ['a path separator', 'imap/carol'],
    ['a backslash', 'imap\\carol'],
    ['..', '..'],
    ['an embedded ..', 'a..b'],
    ['a leading dot', '.hidden'],
    ['an empty name', ''],
    ['an over-long name', 'a'.repeat(65)],
    ['a dot (jeeves-tools secret names have none)', 'mail.example.com'],
  ])('rejects a secretRef with %s', (_label, secretRef) => {
    withPasswords({ secretRef });
    expect(() => loadPipelineConfig()).toThrow(
      /secretRef must be a plain file name/,
    );
  });

  it('rejects extra keys beside secretRef', () => {
    withPasswords({ secretRef: 'ok', value: 'leak' });
    expect(() => loadPipelineConfig()).toThrow(/value/);
  });

  it('rejects a non-string, non-object password', () => {
    withPasswords(42);
    expect(() => loadPipelineConfig()).toThrow(/password/);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('pipeline-config.json.template', () => {
  const template = JSON.parse(
    fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../pipeline-config.json.template',
      ),
      'utf8',
    ),
  ) as { accounts: unknown[]; _imapAccountExample: unknown };

  it('ships no accounts', () => {
    withAccounts(template.accounts);
    expect(loadPipelineConfig().accounts).toEqual([]);
  });

  it('carries a valid secretRef IMAP example', () => {
    withAccounts([template._imapAccountExample]);
    expect(loadPipelineConfig().accounts[0].imap?.password).toEqual({
      secretRef: 'user-example-com',
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
