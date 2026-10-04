import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getBasePathForEmailDomain,
  getBasePathForGitHubOrg,
  getBasePathForJira,
  getBasePathForLinear,
  getBasePathForMeeting,
  getBasePathForSlackWorkspace,
  getCalendarBaseForAccount,
  getConfig,
  getEmailBaseForAccount,
  getEntityDirs,
  resetConfig,
} from './silo-router.js';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  },
}));

const MULTI_SILO_CONFIG = JSON.stringify({
  defaultBasePath: 'C:/content/default',
  silos: {
    acme: {
      emailDomains: ['acme.example', 'ACME.TEST'],
      githubOrgs: [
        'acme-corp',
        { githubOrg: 'acme-labs', relativePath: 'labs' },
      ],
      slackWorkspaces: ['T111111'],
      jira: true,
      linear: true,
      basePath: 'C:/content/acme',
    },
    globex: {
      emailDomains: ['globex.example'],
      githubOrgs: ['globex'],
      slackWorkspaces: ['T222222'],
      basePath: 'C:/content/globex',
    },
  },
});

function loadMultiSiloConfig() {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(MULTI_SILO_CONFIG);
  resetConfig();
}

describe('silo-router', () => {
  afterEach(() => {
    resetConfig();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe('getConfig', () => {
    it('returns default config when routing file does not exist', () => {
      const config = getConfig();
      expect(config.defaultBasePath).toBeDefined();
      expect(config.silos).toEqual({});
    });

    it('caches config on repeated calls', () => {
      const a = getConfig();
      const b = getConfig();
      expect(a).toBe(b);
    });

    it('loads config from file when it exists', () => {
      loadMultiSiloConfig();
      const config = getConfig();
      expect(Object.keys(config.silos)).toEqual(['acme', 'globex']);
    });
  });

  describe('resetConfig', () => {
    it('clears cache so next call reloads', () => {
      const a = getConfig();
      resetConfig();
      const b = getConfig();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('getEntityDirs', () => {
    it('returns default path when no silos configured', () => {
      const dirs = getEntityDirs('meetings');
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/meetings$/);
    });

    it('returns paths for all silos plus default', () => {
      loadMultiSiloConfig();
      const dirs = getEntityDirs('meetings');
      expect(dirs).toHaveLength(3);
      const normalized = dirs.map((d) => d.replace(/\\/g, '/'));
      expect(normalized).toContain('C:/content/default/meetings');
      expect(normalized).toContain('C:/content/acme/meetings');
      expect(normalized).toContain('C:/content/globex/meetings');
    });

    it('deduplicates identical paths', () => {
      const dirs = getEntityDirs('meetings');
      const unique = new Set(dirs);
      expect(dirs.length).toBe(unique.size);
    });
  });

  describe('getBasePathForEmailDomain', () => {
    it('returns silo path for matched domain', () => {
      loadMultiSiloConfig();
      expect(getBasePathForEmailDomain('acme.example')).toBe('C:/content/acme');
    });

    it('matches case-insensitively', () => {
      loadMultiSiloConfig();
      expect(getBasePathForEmailDomain('ACME.EXAMPLE')).toBe('C:/content/acme');
      expect(getBasePathForEmailDomain('Acme.Test')).toBe('C:/content/acme');
    });

    it('returns default for unrecognized domain', () => {
      loadMultiSiloConfig();
      expect(getBasePathForEmailDomain('unknown.example')).toBe(
        'C:/content/default',
      );
    });
  });

  describe('getBasePathForGitHubOrg', () => {
    it('returns silo path for matched org (string spec)', () => {
      loadMultiSiloConfig();
      expect(getBasePathForGitHubOrg('acme-corp')).toBe('C:/content/acme');
    });

    it('returns silo path with relative path for object spec', () => {
      loadMultiSiloConfig();
      expect(getBasePathForGitHubOrg('acme-labs').replace(/\\/g, '/')).toBe(
        'C:/content/acme/labs',
      );
    });

    it('matches case-insensitively', () => {
      loadMultiSiloConfig();
      expect(getBasePathForGitHubOrg('ACME-CORP')).toBe('C:/content/acme');
    });

    it('returns default for unrecognized org', () => {
      loadMultiSiloConfig();
      expect(getBasePathForGitHubOrg('unknown-org')).toBe('C:/content/default');
    });
  });

  describe('getBasePathForSlackWorkspace', () => {
    it('returns silo path for matched workspace', () => {
      loadMultiSiloConfig();
      expect(getBasePathForSlackWorkspace('T111111')).toBe('C:/content/acme');
      expect(getBasePathForSlackWorkspace('T222222')).toBe('C:/content/globex');
    });

    it('returns default for unrecognized workspace', () => {
      loadMultiSiloConfig();
      expect(getBasePathForSlackWorkspace('T999999')).toBe(
        'C:/content/default',
      );
    });
  });

  describe('getBasePathForMeeting', () => {
    it('routes to silo with majority of participants', () => {
      loadMultiSiloConfig();
      const emails = ['a@acme.example', 'b@acme.example', 'c@globex.example'];
      expect(getBasePathForMeeting(emails)).toBe('C:/content/acme');
    });

    it('returns default when tied', () => {
      loadMultiSiloConfig();
      const emails = ['a@acme.example', 'b@globex.example'];
      expect(getBasePathForMeeting(emails)).toBe('C:/content/default');
    });

    it('returns default when no participants match any silo', () => {
      loadMultiSiloConfig();
      const emails = ['x@random.example', 'y@other.example'];
      expect(getBasePathForMeeting(emails)).toBe('C:/content/default');
    });

    it('handles empty participant list', () => {
      loadMultiSiloConfig();
      expect(getBasePathForMeeting([])).toBe('C:/content/default');
    });

    it('handles invalid email addresses gracefully', () => {
      loadMultiSiloConfig();
      expect(getBasePathForMeeting(['not-an-email', ''])).toBe(
        'C:/content/default',
      );
    });
  });

  describe('getBasePathForJira', () => {
    it('returns silo path with jira enabled', () => {
      loadMultiSiloConfig();
      expect(getBasePathForJira()).toBe('C:/content/acme');
    });

    it('returns default when no silo has jira', () => {
      expect(getBasePathForJira()).toBe(getConfig().defaultBasePath);
    });
  });

  describe('getEmailBaseForAccount', () => {
    it('routes to silo email path for known domain', () => {
      loadMultiSiloConfig();
      expect(
        getEmailBaseForAccount('user@acme.example').replace(/\\/g, '/'),
      ).toBe('C:/content/acme/email');
    });

    it('returns default email path for unknown domain', () => {
      loadMultiSiloConfig();
      expect(
        getEmailBaseForAccount('user@unknown.example').replace(/\\/g, '/'),
      ).toBe('C:/content/default/email');
    });

    it('returns default email path for empty account', () => {
      loadMultiSiloConfig();
      expect(getEmailBaseForAccount('').replace(/\\/g, '/')).toBe(
        'C:/content/default/email',
      );
    });
  });

  describe('getCalendarBaseForAccount', () => {
    it('routes to silo calendar path for known domain', () => {
      loadMultiSiloConfig();
      expect(
        getCalendarBaseForAccount('user@globex.example').replace(/\\/g, '/'),
      ).toBe('C:/content/globex/calendar');
    });

    it('returns default calendar path for unknown domain', () => {
      loadMultiSiloConfig();
      expect(
        getCalendarBaseForAccount('user@other.example').replace(/\\/g, '/'),
      ).toBe('C:/content/default/calendar');
    });
  });

  describe('getBasePathForLinear', () => {
    it('returns silo path with linear enabled', () => {
      loadMultiSiloConfig();
      expect(getBasePathForLinear()).toBe('C:/content/acme');
    });

    it('returns default when no silo has linear', () => {
      expect(getBasePathForLinear()).toBe(getConfig().defaultBasePath);
    });
  });
});
