/**
 * Guard: the template must stay instance-agnostic.
 *
 * jeeves-scripts-template is consumed by many Jeeves instances, each with
 * its own local scripts repo. Per-instance values (owner email accounts,
 * Slack channels, hosts, date windows, local paths) belong in the
 * instance's config, never in the template. This test scans every
 * git-tracked text file the template ships and fails, listing
 * `file:line: [rule] match`, when instance-specific data lands in it.
 *
 * To extend coverage for a new instance or customer, add its identifier to
 * {@link INSTANCE_DENYLIST}. Placeholders that look like real identifiers
 * belong in the explicit allowlists below.
 *
 * @module instance-agnostic.test
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Known instance / customer identifiers. Each entry carries its own flags:
 * names are matched case-insensitively; the short org acronyms used as
 * bucket / label names are matched case-sensitively as whole words, so
 * ordinary lower-case text (`vcs`, `.vc`) and identifiers that merely
 * contain the letters do not trip the guard. Extendable: add a new entry
 * whenever a new instance or customer name must never appear in the
 * template.
 */
export const INSTANCE_DENYLIST: readonly RegExp[] = [
  /bcofa/i,
  /\bbca\b/i,
  /johngalt/i,
  /jscroft/i,
  /veterancrowd/i,
  /credit-?genius/i,
  /bidbuild/i,
  /williscroft/i,
  /tribify/i,
  /\bVC\b/,
  /\bJGS\b/,
];

/**
 * Email domains reserved for documentation (RFC 2606 / RFC 6761), matched
 * as the domain itself or any subdomain. Any other domain is real data.
 */
export const RESERVED_EMAIL_DOMAINS: readonly string[] = [
  'example.com',
  'example.org',
  'example.net',
  'example',
  'test',
  'invalid',
  'localhost',
];

/**
 * Well-known third-party sender addresses that scripts match on (vendor
 * notification senders). These are product constants, not instance data.
 */
export const THIRD_PARTY_EMAIL_ALLOWLIST: readonly string[] = [
  'gemini-notes@google.com',
  'noreply@fathom.video',
  'support@apollo.io',
  'voice-noreply@google.com',
];

/**
 * Placeholder Slack IDs that are allowed to appear in the template. New
 * fixtures should prefer the `<kind>000EXAMPLE<n>` form.
 */
export const SLACK_ID_ALLOWLIST: readonly string[] = [
  'C000EXAMPLE1',
  'C000EXAMPLE2',
  'C000EXAMPLE3',
  'D000EXAMPLE1',
  'T000EXAMPLE1',
  'T000EXAMPLE2',
  'U000EXAMPLE',
  'U000EXAMPLE1',
  'U000EXAMPLE2',
  'U000EXAMPLE3',
  'C0123456789',
  'C0NAMEDXX',
  'C0OTHER1234',
  'C0XXXXXXXX',
  'C0XXXXXXXXX',
  'D0ABCDEFGH',
  'G0ABCDEF12',
  'U0ABCDEFGH',
  'U0MAPPED01',
  'U0SOMEONE1',
  'U0UNKNOWN1',
  'W0ABCDEF12',
  'W0ENTERPRISE',
];

/**
 * Per-line escape hatch. A line containing this marker (followed by a
 * reason) is exempt, as is the line after it, so a standalone comment can
 * cover the next line. Every use is listed by the test; prefer zero.
 */
export const ALLOW_MARKER = 'instance-agnostic-allow:';

/** Directories whose tracked files are scanned. */
const SCANNED_DIRS = ['src/', 'jobs/', 'config/', 'docs/', '.github/'];

/** Root-level files that are scanned (docs and config templates). */
const SCANNED_ROOT_FILE = /^(README[^/]*|[^/]+\.json|[^/]+\.template)$/i;

/** Tracked files never scanned: lockfiles and generated changelogs. */
const EXCLUDED_FILE = /(^|\/)(package-lock\.json|CHANGELOG\.md)$/i;

/** This file necessarily spells out the denylist. */
const SELF = 'src/instance-agnostic.test.ts';

interface Violation {
  file: string;
  line: number;
  rule: string;
  match: string;
}

type LineCheck = (line: string) => { rule: string; match: string }[];

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function isReservedEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return RESERVED_EMAIL_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}

function allMatches(line: string, re: RegExp): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return [...line.matchAll(new RegExp(re.source, flags))];
}

const checkEmails: LineCheck = (line) =>
  allMatches(
    line,
    /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/,
  )
    .filter(
      (m) =>
        !isReservedEmailDomain(m[1]) &&
        !THIRD_PARTY_EMAIL_ALLOWLIST.includes(m[0].toLowerCase()),
    )
    .map((m) => ({ rule: 'email', match: m[0] }));

const checkIdentifiers: LineCheck = (line) => [
  ...INSTANCE_DENYLIST.flatMap((re) =>
    allMatches(line, re).map((m) => ({ rule: 'identifier', match: m[0] })),
  ),
  // Any concrete `<name>.jeeves.id` host. Placeholder forms such as
  // `<instance>.jeeves.id`, `{instance}.jeeves.id` and `${instance}.jeeves.id`
  // never match because the label is not directly followed by `.jeeves.id`.
  ...allMatches(line, /(?<![\w-])[A-Za-z0-9-]+\.jeeves\.id\b/i).map((m) => ({
    rule: 'instance-host',
    match: m[0],
  })),
];

// Case-insensitive: OpenClaw session keys carry lower-cased Slack IDs
// (`agent:main:slack:channel:c0...`). `T` covers workspace (team) IDs.
const slackAllow = new Set(SLACK_ID_ALLOWLIST.map((id) => id.toUpperCase()));

const checkSlackIds: LineCheck = (line) =>
  allMatches(line, /\b[CUGWDBT]0[A-Z0-9]{7,}\b/i)
    .filter((m) => !slackAllow.has(m[0].toUpperCase()))
    .map((m) => ({ rule: 'slack-id', match: m[0] }));

const checkLocalPaths: LineCheck = (line) => [
  // Standard system install locations (e.g. `C:\Program Files`) are not
  // instance-specific; anything else under a drive letter is.
  ...allMatches(line, /\b[A-Za-z]:\\(?!\\?Program Files)/).map((m) => ({
    rule: 'windows-path',
    match: m[0],
  })),
  // `/home/jeeves/` is the platform service account, not a person.
  ...allMatches(line, /\/home\/([^/\s'"`]+)\//)
    .filter((m) => m[1] !== 'jeeves')
    .map((m) => ({ rule: 'home-path', match: m[0] })),
];

const checkInstanceRepoLinks: LineCheck = (line) => [
  ...allMatches(line, /karmaniverous\/jeeves-scripts(?![\w-])/).map((m) => ({
    rule: 'instance-repo',
    match: m[0],
  })),
  ...allMatches(line, /(?<![\w/-])jeeves-scripts#\d+/).map((m) => ({
    rule: 'instance-repo',
    match: m[0],
  })),
];

const CHECKS: readonly LineCheck[] = [
  checkEmails,
  checkIdentifiers,
  checkSlackIds,
  checkLocalPaths,
  checkInstanceRepoLinks,
];

function scannedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter(
      (f) =>
        SCANNED_DIRS.some((d) => f.startsWith(d)) || SCANNED_ROOT_FILE.test(f),
    )
    .filter((f) => !EXCLUDED_FILE.test(f) && f !== SELF);
}

interface ScanResult {
  violations: Violation[];
  allowed: string[];
}

function scanFile(file: string): ScanResult {
  const buf = readFileSync(path.join(repoRoot, file));
  if (buf.includes(0)) return { violations: [], allowed: [] }; // binary
  const lines = buf.toString('utf8').split(/\r?\n/);
  const result: ScanResult = { violations: [], allowed: [] };
  lines.forEach((text, i) => {
    const found = CHECKS.flatMap((check) => check(text));
    if (found.length === 0) return;
    const marked =
      text.includes(ALLOW_MARKER) ||
      (lines[i - 1]?.includes(ALLOW_MARKER) ?? false);
    const entries = found.map((v) => ({ file, line: i + 1, ...v }));
    if (marked)
      result.allowed.push(
        ...entries.map((v) => `${format(v)} (${ALLOW_MARKER})`),
      );
    else result.violations.push(...entries);
  });
  return result;
}

function format(v: Violation): string {
  return `${v.file}:${String(v.line)}: [${v.rule}] ${v.match}`;
}

/** Accepted escape-hatch uses; any new marker must be reviewed here. */
const EXPECTED_ALLOWED: readonly string[] = [
  'src/admin/lib/openclaw-db/channel-from-meta.test.ts:152: [windows-path] X:\\ (instance-agnostic-allow:)',
];

describe('template is instance-agnostic', () => {
  it('scans a non-trivial set of tracked files', () => {
    const files = scannedFiles();
    expect(files).toContain('README.md');
    expect(files.some((f) => f.startsWith('src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('jobs/'))).toBe(true);
  });

  it('contains no instance-specific data in tracked files', () => {
    const report = scannedFiles()
      .flatMap((f) => scanFile(f).violations)
      .map(format);
    expect(report).toEqual([]);
  });

  it('lists every escape-hatch use', () => {
    const allowed = scannedFiles().flatMap((f) => scanFile(f).allowed);
    expect(allowed).toEqual(EXPECTED_ALLOWED);
  });

  it('flags each rule on representative samples', () => {
    const flagged = (line: string) =>
      CHECKS.flatMap((check) => check(line)).map((v) => v.rule);
    expect(flagged('owner@gmail.com')).toEqual(['email']);
    expect(flagged('gemini-notes@google.com')).toEqual([]);
    expect(flagged('a@example.com b@mail.test c@x.invalid')).toEqual([]);
    expect(flagged('BCA and JohnGalt')).toEqual(['identifier', 'identifier']);
    expect(flagged('abcd.jeeves.id')).toEqual(['instance-host']);
    expect(flagged('<instance>.jeeves.id {instance}.jeeves.id')).toEqual([]);
    expect(flagged('channel C0123ABCDEF')).toEqual(['slack-id']);
    expect(flagged('channel C000EXAMPLE1')).toEqual([]);
    expect(flagged('slack:channel:c0123abcdef')).toEqual(['slack-id']);
    expect(flagged('slack:channel:c000example1')).toEqual([]);
    expect(flagged('D:\\repos and /home/alice/x')).toEqual([
      'windows-path',
      'home-path',
    ]);
    expect(flagged('/home/jeeves/x')).toEqual([]);
    expect(flagged("'C:\\Program Files\\Google'")).toEqual([]);
    expect(flagged('karmaniverous/jeeves-scripts#12 jeeves-scripts#3')).toEqual(
      ['instance-repo', 'instance-repo'],
    );
    expect(flagged('karmaniverous/jeeves-scripts-template#89')).toEqual([]);
  });
});
