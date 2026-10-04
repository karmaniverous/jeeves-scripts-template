import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBucketForDomain,
  getBucketPriority,
  getCalendarAccounts,
  getEmailAccounts,
  getGmailAccounts,
  getRef,
  loadPipelineConfig,
  resetPipelineConfig,
  tryGetRef,
} from './pipeline-config.js';

const VALID_CONFIG = {
  accounts: [
    {
      email: 'alice@example.com',
      type: 'gmail' as const,
      calendar: { tokenFile: 'token-alice.json' },
      emailPolling: true,
    },
    {
      email: 'bob@example.com',
      type: 'gmail' as const,
      calendar: { serviceAccount: 'auto' as const },
      emailPolling: false,
    },
    {
      email: 'carol@example.com',
      type: 'imap' as const,
      emailPolling: true,
      imap: {
        host: 'imap.example.com',
        port: 993,
        tls: true,
        user: 'carol@example.com',
        password: 'secret',
      },
      folders: ['INBOX', 'Sent'],
    },
  ],
  buckets: {
    domains: [
      { pattern: 'example.com', bucket: 'Example' },
      { pattern: 'other.org', bucket: 'Other' },
    ],
    priority: ['Example', 'Other'],
  },
  refs: {
    'notion.inboxId': 'abc-123',
    'paths.bin': 'C:\\bin\\tool.exe',
  },
  emailConfig: {
    reportOnly: false,
    receipt: { forwardJGS: true, sparkReceiptsForwardTo: '' },
    digest: { slackChannelId: 'C1234' },
  },
};

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, default: { ...actual } };
});

describe('pipeline-config', () => {
  beforeEach(() => {
    resetPipelineConfig();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(VALID_CONFIG));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and validates the config', () => {
    const config = loadPipelineConfig();
    expect(config.accounts).toHaveLength(3);
    expect(config.buckets.priority).toEqual(['Example', 'Other']);
    expect(config.emailConfig.reportOnly).toBe(false);
  });

  it('caches the config on subsequent calls', () => {
    loadPipelineConfig();
    loadPipelineConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  describe('getCalendarAccounts', () => {
    it('returns only accounts with calendar config', () => {
      const accounts = getCalendarAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts[0].email).toBe('alice@example.com');
      expect(accounts[1].email).toBe('bob@example.com');
    });
  });

  describe('getEmailAccounts', () => {
    it('returns emails of accounts with emailPolling enabled', () => {
      const emails = getEmailAccounts();
      expect(emails).toEqual(['alice@example.com', 'carol@example.com']);
    });
  });

  describe('getGmailAccounts', () => {
    it('returns polled accounts without an imap block', () => {
      expect(getGmailAccounts()).toEqual(['alice@example.com']);
    });
  });

  describe('getBucketForDomain', () => {
    it('returns the correct bucket for a known domain', () => {
      expect(getBucketForDomain('example.com')).toBe('Example');
      expect(getBucketForDomain('other.org')).toBe('Other');
    });

    it('is case-insensitive', () => {
      expect(getBucketForDomain('EXAMPLE.COM')).toBe('Example');
    });

    it('returns null for unknown domains', () => {
      expect(getBucketForDomain('unknown.net')).toBeNull();
    });
  });

  describe('getBucketPriority', () => {
    it('returns priority map with correct indices', () => {
      const priority = getBucketPriority();
      expect(priority).toEqual({ Example: 0, Other: 1 });
    });
  });

  describe('getRef', () => {
    it('returns the value for a known key', () => {
      expect(getRef('notion.inboxId')).toBe('abc-123');
      expect(getRef('paths.bin')).toBe('C:\\bin\\tool.exe');
    });

    it('throws for a missing key', () => {
      expect(() => getRef('missing.key')).toThrow(
        'Missing pipeline config ref: missing.key',
      );
    });
  });

  describe('tryGetRef', () => {
    it('returns the value for a known key', () => {
      expect(tryGetRef('notion.inboxId')).toBe('abc-123');
    });

    it('returns empty string for a missing key', () => {
      expect(tryGetRef('missing.key')).toBe('');
    });
  });

  describe('schema validation', () => {
    it('rejects invalid config', () => {
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({ accounts: 'not-an-array' }),
      );
      resetPipelineConfig();
      expect(() => loadPipelineConfig()).toThrow();
    });

    it('rejects account without type', () => {
      const bad = {
        ...VALID_CONFIG,
        accounts: [{ email: 'x@y.com', emailPolling: true }],
      };
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(bad));
      resetPipelineConfig();
      expect(() => loadPipelineConfig()).toThrow();
    });

    it('accepts imap account with connection block and folders', () => {
      const config = loadPipelineConfig();
      const carol = config.accounts.find(
        (a) => a.email === 'carol@example.com',
      );
      expect(carol?.type).toBe('imap');
      expect(carol?.imap?.host).toBe('imap.example.com');
      expect(carol?.folders).toEqual(['INBOX', 'Sent']);
    });

    it('leaves emailConfig.backfill undefined when absent (no defaults)', () => {
      expect(loadPipelineConfig().emailConfig.backfill).toBeUndefined();
    });

    it('accepts a complete emailConfig.backfill', () => {
      const backfill = {
        accounts: ['alice@example.com'],
        lookbackDays: 90,
        windowDays: 7,
      };
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          ...VALID_CONFIG,
          emailConfig: { ...VALID_CONFIG.emailConfig, backfill },
        }),
      );
      resetPipelineConfig();
      expect(loadPipelineConfig().emailConfig.backfill).toEqual(backfill);
    });

    it('rejects an incomplete or invalid emailConfig.backfill', () => {
      for (const backfill of [
        { accounts: [], lookbackDays: 90, windowDays: 7 },
        { accounts: ['a@x.com'], lookbackDays: 90 },
        { accounts: ['a@x.com'], lookbackDays: 90, windowDays: 0 },
      ]) {
        vi.spyOn(fs, 'readFileSync').mockReturnValue(
          JSON.stringify({
            ...VALID_CONFIG,
            emailConfig: { ...VALID_CONFIG.emailConfig, backfill },
          }),
        );
        resetPipelineConfig();
        expect(() => loadPipelineConfig()).toThrow();
      }
    });
  });
});
