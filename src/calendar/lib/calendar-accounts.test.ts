import { describe, expect, it, vi } from 'vitest';

import type { AccountConfig } from '../../lib/pipeline-config.js';
import {
  type CalendarCredentialDeps,
  resolveCalendarAccounts,
} from './calendar-accounts.js';

function account(
  email: string,
  calendar?: AccountConfig['calendar'],
): AccountConfig {
  return { email, type: 'gmail', emailPolling: false, calendar };
}

const TOKEN = account('oauth@example.com', { tokenFile: 'token.json' });
const SA = account('sa@example.com', { serviceAccount: 'auto' });

function deps(over: Partial<CalendarCredentialDeps> = {}) {
  return {
    oauthClient: true,
    oauthClientPath: '/gog/credentials.json',
    findServiceAccount: vi.fn((email: string) =>
      email === 'sa@example.com' ? '/gog/data/sa-x.json' : null,
    ),
    ...over,
  } satisfies CalendarCredentialDeps;
}

describe('resolveCalendarAccounts', () => {
  it('resolves token-file and service-account accounts', () => {
    expect(resolveCalendarAccounts([TOKEN, SA], deps())).toEqual({
      accounts: [
        { email: 'oauth@example.com', tokenFile: 'token.json' },
        { email: 'sa@example.com', serviceAccount: '/gog/data/sa-x.json' },
      ],
      problems: [],
    });
  });

  it('flags a token-file account when the OAuth client is missing, even if a service account exists', () => {
    const r = resolveCalendarAccounts(
      [TOKEN, SA],
      deps({ oauthClient: false }),
    );
    expect(r.accounts).toEqual([
      { email: 'sa@example.com', serviceAccount: '/gog/data/sa-x.json' },
    ]);
    expect(r.problems).toEqual([
      'oauth@example.com: calendar.tokenFile needs the gog OAuth client at /gog/credentials.json',
    ]);
  });

  it("flags a service-account account without its own mailbox's registration", () => {
    const other = account('other@example.com', { serviceAccount: 'auto' });
    const d = deps();
    const r = resolveCalendarAccounts([other, SA], d);
    expect(d.findServiceAccount).toHaveBeenCalledWith('other@example.com');
    expect(r.accounts.map((a) => a.email)).toEqual(['sa@example.com']);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(
      /^other@example\.com: calendar\.serviceAccount is "auto" but gog has no service-account registration/,
    );
  });

  it('flags an account with no calendar config', () => {
    expect(
      resolveCalendarAccounts([account('none@example.com')], deps()),
    ).toEqual({
      accounts: [],
      problems: ['none@example.com: no calendar config'],
    });
  });
});
