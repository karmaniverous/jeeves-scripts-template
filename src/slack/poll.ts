#!/usr/bin/env tsx
/**
 * @module slack/poll
 *
 * Polls Slack channels for new messages across configured workspaces.
 *
 * Called by jeeves-runner on a schedule. Auto-discovers channels the bot
 * has joined, fetches history and thread replies via the Slack API, and
 * writes individual JSON files per message to silo-routed directories.
 * Depends on PRIMARY_WORKSPACE, SLACK_DOMAIN_DIR, and
 * SLACK_WORKSPACE_CACHE_PATH from constants for workspace routing.
 *
 * Read positions (newest `ts` per channel) are instance state, kept in
 * SLACK_CURSORS_PATH; `channels.json` holds curated channel config only.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  getChannelWorkspace,
  runScript,
  saveCache,
} from '@karmaniverous/jeeves';

import {
  PRIMARY_WORKSPACE,
  SCRIPTS_DIR,
  SLACK_CURSORS_PATH,
  SLACK_DOMAIN_DIR,
  SLACK_WORKSPACE_CACHE_PATH,
} from '../lib/constants.js';
import { getBasePathForSlackWorkspace } from '../lib/silo-router.js';
import {
  type Cursors,
  loadPollCursors,
  saveChannels,
  saveCursors,
} from './lib/cursors.js';
import {
  discoverChannels,
  fetchHistory,
  fetchReplies,
  slackApi,
  type SlackFileMetadata,
  type SlackMessage,
  sleep,
} from './lib/slack-api.js';

const CHANNELS_FILE = path.join(SCRIPTS_DIR, 'src/slack/lib/channels.json');
const USERS_FILE = path.join(SCRIPTS_DIR, 'src/slack/lib/users.json');
const RATE_LIMIT_MS = 1200;

/** File types whose content can be fetched and inlined as text/markdown. */
const TEXT_EXTRACTABLE_TYPES = new Set(['text', 'post', 'snippet']);

interface ChannelInfo {
  name: string;
  type: string;
  isPrivate?: boolean;
  isArchived?: boolean;
  /** Legacy read position; migrated to SLACK_CURSORS_PATH, never written. */
  lastTs?: string;
  metadata?: Record<string, unknown>;
  isSlackConnect?: boolean;
  sharedTeams?: string[];
  participants?: string[];
  _autoDiscovered?: string;
  _account?: string;
}

interface OpenClawConfig {
  channels?: {
    slack?: {
      botToken?: string;
      accounts?: Record<string, { botToken?: string }>;
    };
  };
}

function getTokens(): Record<string, string> {
  if (process.env.SLACK_BOT_TOKEN)
    return { default: process.env.SLACK_BOT_TOKEN };

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const primary = path.join(home, '.openclaw', 'openclaw.json');
  const fallback = path.join(home, '.clawdbot', 'clawdbot.json');

  const cfgPath = fs.existsSync(primary)
    ? primary
    : fs.existsSync(fallback)
      ? fallback
      : undefined;

  if (!cfgPath) {
    throw new Error(
      `No Slack config file found. Searched:\n  - ${primary}\n  - ${fallback}`,
    );
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as OpenClawConfig;

  const tokens: Record<string, string> = {};

  // Multi-account layout: channels.slack.accounts.<name>.botToken
  const accounts = cfg.channels?.slack?.accounts;
  if (accounts) {
    for (const [name, account] of Object.entries(accounts)) {
      if (account.botToken) tokens[name] = account.botToken;
    }
  }

  // Flat layout fallback: channels.slack.botToken
  if (Object.keys(tokens).length === 0) {
    const token = cfg.channels?.slack?.botToken;
    if (token) tokens['default'] = token;
  }

  if (Object.keys(tokens).length === 0)
    throw new Error('No Slack bot tokens found');
  return tokens;
}

async function getTeamId(token: string): Promise<string> {
  const resp = await slackApi('auth.test', {}, token);
  if (!resp.team_id || typeof resp.team_id !== 'string') {
    throw new Error(
      `auth.test did not return a valid team_id (got ${JSON.stringify(resp.team_id)})`,
    );
  }
  return resp.team_id;
}

async function resolveChannelToken(
  channelId: string,
  channelInfo: ChannelInfo,
  tokensByAccount: Record<string, string>,
  teamToAccount: Record<string, string>,
): Promise<string> {
  // 1. Explicit account tag from prior discovery or resolution
  if (channelInfo._account && tokensByAccount[channelInfo._account]) {
    return tokensByAccount[channelInfo._account];
  }

  // 2. Check sharedTeams metadata against known workspaces
  if (channelInfo.sharedTeams) {
    for (const teamId of channelInfo.sharedTeams) {
      const account = teamToAccount[teamId];
      if (account && tokensByAccount[account]) {
        channelInfo._account = account;
        return tokensByAccount[account];
      }
    }
  }

  // 3. Try getChannelWorkspace with each token until one resolves
  let lastError: unknown;
  for (const [account, token] of Object.entries(tokensByAccount)) {
    try {
      await sleep(RATE_LIMIT_MS);
      const teamId = await getChannelWorkspace(channelId, token, {
        cachePath: SLACK_WORKSPACE_CACHE_PATH,
        defaultWorkspace: PRIMARY_WORKSPACE,
      });
      const resolvedAccount = teamToAccount[teamId] ?? account;
      channelInfo._account = resolvedAccount;
      return tokensByAccount[resolvedAccount] ?? token;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not_in_channel|channel_not_found|missing_scope/i.test(msg)) {
        console.error(
          `Unexpected error resolving channel ${channelId} with account "${account}": ${msg}`,
        );
      }
      continue;
    }
  }

  if (lastError instanceof Error) {
    console.error(
      `Could not resolve token for channel ${channelId}, falling back. Last error: ${lastError.message}`,
    );
  } else if (lastError) {
    console.error(
      `Could not resolve token for channel ${channelId}, falling back.`,
    );
  }

  // 4. Fallback to default or first available token
  return tokensByAccount['default'] ?? Object.values(tokensByAccount)[0];
}

function tsToDate(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString();
}

function loadUsers(): Record<string, string> {
  if (fs.existsSync(USERS_FILE)) {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) as Record<
      string,
      string
    >;
  }
  return {};
}

/**
 * Fetch text content for extractable file types via Slack's url_private_download.
 * Mutates file entries in place, adding `markdown` field.
 * Canvas content requires `canvases:read` scope (jeeves-tools #95) — skipped.
 */
async function enrichFileContent(
  msg: SlackMessage,
  token: string,
): Promise<void> {
  if (!msg.files || msg.files.length === 0) return;

  for (const file of msg.files) {
    // Skip if already has content (re-poll guard)
    if (file.markdown) continue;

    if (!TEXT_EXTRACTABLE_TYPES.has(file.filetype)) continue;

    // Fetch file info to get url_private_download
    try {
      await sleep(RATE_LIMIT_MS);
      const info = await slackApi('files.info', { file: file.id }, token);
      const fileInfo = info.file as Record<string, unknown> | undefined;
      const downloadUrl = fileInfo?.url_private_download as string | undefined;

      if (!downloadUrl) continue;

      // Fetch the raw content
      const resp = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) continue;

      let content = await resp.text();

      // Wrap code snippets in fenced code block
      if (file.filetype === 'snippet') {
        const lang =
          (fileInfo?.pretty_type as string | undefined)
            ?.toLowerCase()
            .replace(/\s+/g, '') ?? '';
        content = `\`\`\`${lang}\n${content}\n\`\`\``;
      }

      file.markdown = content;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[slack/poll] Failed to fetch content for file ${file.id}: ${errMsg}`,
      );
    }
  }
}

function writeMessage(
  channelDir: string,
  channelId: string,
  channelInfo: ChannelInfo,
  msg: SlackMessage,
  userMap: Record<string, string>,
): boolean {
  fs.mkdirSync(channelDir, { recursive: true });

  const filePath = path.join(channelDir, `${msg.ts}.json`);
  if (fs.existsSync(filePath)) return false;

  const doc: Record<string, unknown> = {
    ts: msg.ts,
    channelId,
    channelName: channelInfo.name,
    channelType: channelInfo.type,
    user: msg.user ?? msg.bot_id ?? 'unknown',
    userName:
      (msg.user ? userMap[msg.user] : undefined) ??
      msg.username ??
      msg.bot_id ??
      'unknown',
    text: msg.text ?? '',
    date: tsToDate(msg.ts),
    participants: channelInfo.participants,
  };

  if (msg.thread_ts && msg.thread_ts !== msg.ts) doc.threadTs = msg.thread_ts;
  if (msg.reply_count) doc.replyCount = msg.reply_count;
  if (msg.subtype) doc.subtype = msg.subtype;
  if (msg.bot_id) doc.botId = msg.bot_id;
  if (msg.files && msg.files.length > 0) {
    doc.hasFiles = true;
    doc.files = msg.files.map((f: SlackFileMetadata) => {
      const entry: SlackFileMetadata = {
        id: f.id,
        name: f.name,
        filetype: f.filetype,
        mimetype: f.mimetype,
        ...(f.size != null ? { size: f.size } : {}),
      };

      // Persist voice memo / audio transcripts from Slack's native transcription
      const raw = f as unknown as Record<string, unknown>;
      const transcription = raw['transcription'] as
        { status?: string; preview?: { content?: string } } | undefined;
      if (
        transcription?.status === 'complete' &&
        transcription.preview?.content
      ) {
        entry.transcript = transcription.preview.content;
      }

      // Inline text content fetched during enrichment
      if (f.markdown) {
        entry.markdown = f.markdown;
      }

      return entry;
    });
  }
  if (msg.reactions)
    doc.reactions = msg.reactions.map((r) => ({
      name: r.name,
      count: r.count,
    }));

  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
  return true;
}

async function resolveChannelDir(
  channelId: string,
  channelName: string,
  token: string,
): Promise<string> {
  const teamId = await getChannelWorkspace(channelId, token, {
    cachePath: SLACK_WORKSPACE_CACHE_PATH,
    defaultWorkspace: PRIMARY_WORKSPACE,
  });
  const basePath = getBasePathForSlackWorkspace(teamId);
  const slackRoot = path.join(basePath, 'slack');
  const targetDirName = `${channelName} (${channelId})`;
  const targetDir = path.join(slackRoot, targetDirName);

  if (fs.existsSync(slackRoot)) {
    const suffix = `(${channelId})`;
    for (const entry of fs.readdirSync(slackRoot)) {
      if (entry.endsWith(suffix) && entry !== targetDirName) {
        const oldDir = path.join(slackRoot, entry);
        fs.renameSync(oldDir, targetDir);
        console.log(`RENAMED: ${entry} -> ${targetDirName}`);
        return targetDir;
      }
    }
  }

  return targetDir;
}

async function pollChannel(
  channelId: string,
  channelInfo: ChannelInfo,
  token: string,
  userMap: Record<string, string>,
  cursors: Cursors,
): Promise<number> {
  const channelDir = await resolveChannelDir(
    channelId,
    channelInfo.name,
    token,
  );
  const oldest = cursors[channelId] ?? '0';

  const { messages, newestTs } = await fetchHistory(channelId, oldest, token);

  let written = 0;
  let maxTs = newestTs;

  for (const msg of messages) {
    // Enrich text-extractable file attachments before writing
    if (msg.files && msg.files.length > 0) {
      await enrichFileContent(msg, token);
    }
    if (writeMessage(channelDir, channelId, channelInfo, msg, userMap)) {
      written++;
    }
    if (msg.ts > maxTs) maxTs = msg.ts;

    // Fetch thread replies
    if (msg.reply_count && msg.reply_count > 0) {
      const replies = await fetchReplies(channelId, msg.ts, oldest, token);
      for (const reply of replies) {
        if (reply.files && reply.files.length > 0) {
          await enrichFileContent(reply, token);
        }
        if (writeMessage(channelDir, channelId, channelInfo, reply, userMap)) {
          written++;
        }
        if (reply.ts > maxTs) maxTs = reply.ts;
      }
    }
  }

  if (maxTs > oldest) {
    cursors[channelId] = maxTs;
  }

  return written;
}

async function autoDiscover(
  channels: Record<string, ChannelInfo>,
  token: string,
  account: string,
): Promise<number> {
  const allChannels = await discoverChannels(token);
  let added = 0;

  for (const ch of allChannels) {
    if (!ch.is_member && !ch.is_im) continue;
    if (ch.id in channels) continue;

    const entry: ChannelInfo = {
      name: ch.name ?? (ch.is_im ? `dm-${ch.user ?? ch.id}` : `mpim-${ch.id}`),
      type: ch.is_im ? 'dm' : ch.is_mpim ? 'mpim' : 'channel',
      isPrivate: ch.is_private ?? ch.is_im ?? false,
      isArchived: false,
      metadata: {},
      _autoDiscovered: new Date().toISOString(),
      _account: account,
    };
    if (ch.is_ext_shared) entry.isSlackConnect = true;
    if (ch.shared_team_ids && ch.shared_team_ids.length > 1)
      entry.sharedTeams = ch.shared_team_ids;

    channels[ch.id] = entry;
    console.log(
      `DISCOVERED: ${ch.id} -> ${entry.name} (${entry.type}, account: ${account}${entry.isSlackConnect ? ', Slack Connect' : ''})`,
    );
    added++;
  }

  return added;
}

async function main(): Promise<void> {
  if (!fs.existsSync(SLACK_DOMAIN_DIR)) {
    console.log('[skip] Slack domain directory not configured');
    return;
  }

  const tokensByAccount = getTokens();
  const accountNames = Object.keys(tokensByAccount);
  console.log(
    `Loaded ${String(accountNames.length)} Slack account(s): ${accountNames.join(', ')}`,
  );

  // Build teamId → account mapping via auth.test
  const teamToAccount: Record<string, string> = {};
  for (const [account, token] of Object.entries(tokensByAccount)) {
    try {
      await sleep(RATE_LIMIT_MS);
      const teamId = await getTeamId(token);
      teamToAccount[teamId] = account;
      console.log(`Account "${account}" -> workspace ${teamId}`);
    } catch (err) {
      console.error(
        `Failed auth.test for account "${account}" (skipping): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')) as Record<
    string,
    ChannelInfo
  >;
  const userMap = loadUsers();
  const { cursors, migrated } = loadPollCursors(SLACK_CURSORS_PATH, channels);
  if (migrated > 0) {
    console.log(
      `Migrated ${String(migrated)} legacy read position(s) from channels.json to ${SLACK_CURSORS_PATH}`,
    );
  }

  // Auto-discover new channels per token
  let totalDiscovered = 0;
  for (const [account, token] of Object.entries(tokensByAccount)) {
    try {
      const discovered = await autoDiscover(channels, token, account);
      if (discovered > 0) {
        console.log(
          `Auto-discovered ${String(discovered)} new channel(s) for account "${account}"`,
        );
      }
      totalDiscovered += discovered;
    } catch (err) {
      console.error(
        `Channel discovery failed for account "${account}" (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (totalDiscovered > 0) {
    saveChannels(CHANNELS_FILE, channels);
  }

  let totalWritten = 0;

  for (const [id, info] of Object.entries(channels)) {
    await sleep(RATE_LIMIT_MS);
    try {
      const token = await resolveChannelToken(
        id,
        info,
        tokensByAccount,
        teamToAccount,
      );
      const written = await pollChannel(id, info, token, userMap, cursors);
      if (written > 0) {
        console.log(`${id} (${info.name}): ${String(written)} new`);
        totalWritten += written;
      }
    } catch (err) {
      console.error(
        `ERROR ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Persist read positions (state), then channel config, then workspace cache
  saveCursors(SLACK_CURSORS_PATH, cursors);
  saveChannels(CHANNELS_FILE, channels);
  saveCache();

  if (totalWritten > 0) {
    console.log(`Total: ${String(totalWritten)} new messages`);
  }
}

runScript('slack/poll', () => {
  main().catch((err: unknown) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
});
