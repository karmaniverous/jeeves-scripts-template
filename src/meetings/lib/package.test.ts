/**
 * #94: packaging a Gemini meeting records the Doc link only. It must not
 * read `refs.google.docsExportAccount` or shell out to gog; fetch-notes
 * exports the Doc later as the meeting's source mailbox.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { RunnerClient } from '@karmaniverous/jeeves-runner';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRef: vi.fn(),
  spawnSync: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../../lib/constants.js', async (importOriginal) => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    DEFAULT_MEETINGS_DIR: p.join(os.tmpdir(), `pkg94-${String(process.pid)}`),
  };
});
vi.mock('../../lib/pipeline-config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRef: mocks.getRef,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const spied = {
    ...actual,
    spawnSync: mocks.spawnSync,
    execSync: mocks.execSync,
    execFileSync: mocks.execFileSync,
  };
  return { ...spied, default: spied };
});

import { DEFAULT_MEETINGS_DIR } from '../../lib/constants.js';
import * as pkg from './package.js';

afterAll(() => {
  fs.rmSync(DEFAULT_MEETINGS_DIR, { recursive: true, force: true });
});

describe('updateMeetingPackage (Gemini, #94)', () => {
  it('writes gemini_link.txt without reading docsExportAccount or running gog', () => {
    const setItem = vi.fn<RunnerClient['setItem']>();
    const link = 'https://docs.google.com/document/d/abc123/edit';
    const { isNew, meetingId } = pkg.updateMeetingPackage(
      {
        meetingId: 'm94',
        account: 'no-domain', // routes to DEFAULT_MEETINGS_DIR
        threadId: 't1',
        messageId: 'msg00001',
        subject: 'Notes: weekly sync',
        normalizedTitle: 'weekly sync',
        meetingDate: '2026-10-06',
        source: 'gemini',
        from: 'gemini-notes@google.com',
        participants: ['a@example.com'],
        geminiLink: link,
        bodyText: 'body',
        bodyHtml: '',
        extractedAt: '2026-10-06T00:00:00.000Z',
      },
      { setItem },
    );

    expect(isNew).toBe(true);
    const dir = path.join(DEFAULT_MEETINGS_DIR, meetingId);
    expect(fs.readFileSync(path.join(dir, 'gemini_link.txt'), 'utf8')).toBe(
      `${link}\n`,
    );
    expect(fs.existsSync(path.join(dir, 'transcript.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'gemini-notes.txt'))).toBe(false);
    expect(mocks.getRef).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('no longer exports an inline Gemini fetcher', () => {
    expect('fetchGeminiDoc' in pkg).toBe(false);
  });
});
