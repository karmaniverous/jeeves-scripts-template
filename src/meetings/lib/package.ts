/**
 * @module package
 *
 * Creates and updates meeting package directories and their artifacts.
 *
 * Called by extract and migration scripts to write per-meeting directories
 * under the silo meetings path (defaulting to {@link DEFAULT_MEETINGS_DIR}).
 * Writes metadata, manifests, and extracted content, and maintains the
 * runner-state index so downstream steps can discover packages.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, nowIso, readJson } from '@karmaniverous/jeeves';
import type { RunnerClient } from '@karmaniverous/jeeves-runner';

import { DEFAULT_MEETINGS_DIR } from '../../lib/constants.js';
import { getBasePathForEmailDomain } from '../../lib/silo-router.js';
import {
  checkHasTranscript,
  computeSortTimestamp,
  writeMeetingMeta,
} from './meeting-schema.js';

export function getMeetingsDir(account: string): string {
  const domain = (account || '').split('@')[1];
  if (!domain) return DEFAULT_MEETINGS_DIR;
  const basePath = getBasePathForEmailDomain(domain);
  return path.join(basePath, 'meetings');
}

interface ManifestSource {
  key: string;
  type: string;
  threadId: string;
  messageId: string;
  account: string;
  from: string;
  subject: string;
  extractedAt: string;
}

export interface MeetingData {
  meetingId: string;
  account: string;
  threadId: string;
  messageId: string;
  subject: string;
  normalizedTitle: string;
  meetingDate: string;
  source: string;
  from: string;
  participants: string[];
  geminiLink: string | null;
  bodyText: string;
  bodyHtml: string;
  extractedAt: string;
  internalDateMs?: number | null;
  fathomKind?: 'share' | 'call';
  fathomUrl?: string;
}

interface LegacyManifest {
  meetingId?: string;
  title?: string;
  normalizedTitle?: string;
  date?: string;
  participants?: string[];
  sources?: ManifestSource[];
  artifacts?: string[];
  hasTranscript?: boolean;
  createdAt?: string;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export function updateMeetingPackage(
  meeting: MeetingData,
  client: RunnerClient,
): { isNew: boolean; meetingId: string } {
  const meetingsDir = getMeetingsDir(meeting.account);
  const meetingDir = path.join(meetingsDir, meeting.meetingId);
  ensureDir(meetingDir);

  const manifestPath = path.join(meetingDir, 'meeting.json');
  const manifest = readJson<LegacyManifest>(manifestPath, {
    meetingId: meeting.meetingId,
    title: meeting.subject,
    normalizedTitle: meeting.normalizedTitle,
    date: meeting.meetingDate,
    participants: [],
    sources: [],
    artifacts: [],
    createdAt: nowIso(),
    updatedAt: null,
  });

  // Dedup by source key
  const sourceKey = `${meeting.source}:${meeting.threadId}:${meeting.messageId}`;
  const sources = manifest.sources ?? [];
  if (sources.find((s) => s.key === sourceKey)) {
    return { isNew: false, meetingId: meeting.meetingId };
  }

  sources.push({
    key: sourceKey,
    type: meeting.source,
    threadId: meeting.threadId,
    messageId: meeting.messageId,
    account: meeting.account,
    from: meeting.from,
    subject: meeting.subject,
    extractedAt: meeting.extractedAt,
  });
  manifest.sources = sources;

  // Merge participants
  const allParticipants = new Set(manifest.participants ?? []);
  for (const p of meeting.participants) allParticipants.add(p);
  manifest.participants = Array.from(allParticipants);

  // Write body artifacts
  const artifacts = manifest.artifacts ?? [];
  const slug = `${meeting.source}-${(meeting.messageId || meeting.threadId).slice(-8)}`;
  if (meeting.bodyText) {
    const p = path.join(meetingDir, `${slug}.txt`);
    fs.writeFileSync(p, meeting.bodyText, 'utf8');
    if (!artifacts.includes(`${slug}.txt`)) artifacts.push(`${slug}.txt`);
  }
  if (meeting.bodyHtml) {
    const p = path.join(meetingDir, `${slug}.html`);
    fs.writeFileSync(p, meeting.bodyHtml, 'utf8');
    if (!artifacts.includes(`${slug}.html`)) artifacts.push(`${slug}.html`);
  }

  // Gemini link
  if (meeting.geminiLink) {
    const p = path.join(meetingDir, 'gemini_link.txt');
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, meeting.geminiLink + '\n', 'utf8');
      if (!artifacts.includes('gemini_link.txt'))
        artifacts.push('gemini_link.txt');
    }
  }

  // Fathom link + metadata
  if (meeting.fathomUrl) {
    const linkPath = path.join(meetingDir, 'fathom_link.txt');
    fs.writeFileSync(linkPath, meeting.fathomUrl + '\n', 'utf8');
    if (!artifacts.includes('fathom_link.txt'))
      artifacts.push('fathom_link.txt');
  }

  manifest.artifacts = artifacts;

  // Compute sort timestamp per spec section 3.3
  const { sortTimestampMs, sortSource } = computeSortTimestamp({
    emailInternalDateMs: meeting.internalDateMs,
  });

  // Write via canonical writeMeetingMeta
  writeMeetingMeta(meetingDir, {
    ...manifest,
    meetingId: meeting.meetingId,
    source: meeting.source,
    date: meeting.meetingDate,
    sortTimestampMs,
    sortSource,
    hasTranscript: checkHasTranscript(meetingDir),
    title: meeting.subject,
    ...(meeting.fathomKind ? { fathomKind: meeting.fathomKind } : {}),
    ...(meeting.fathomUrl ? { fathomUrl: meeting.fathomUrl } : {}),
  });

  // Update runner state index
  client.setItem(
    'meetings',
    'index',
    meeting.meetingId,
    JSON.stringify({
      title: manifest.title ?? meeting.subject,
      normalizedTitle: manifest.normalizedTitle ?? meeting.normalizedTitle,
      date: meeting.meetingDate,
      participantCount: (manifest.participants ?? []).length,
      sourceCount: sources.length,
      artifactCount: artifacts.length,
      hasTranscript: checkHasTranscript(meetingDir),
      meetingsDir,
      updatedAt: nowIso(),
    }),
  );

  return { isNew: true, meetingId: meeting.meetingId };
}
