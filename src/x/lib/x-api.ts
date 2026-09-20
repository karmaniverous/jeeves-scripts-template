/**
 * @module x-api
 *
 * Shared X API v2 client wrapping @xdevplatform/xdk with pipeline conventions.
 *
 * Every X entry-point script imports this module for OAuth credential I/O,
 * authenticated client creation, user lookup, tweet polling, and write actions
 * (post, like, repost). Results feed into runner queues or disk via callers.
 *
 * Reads OAuth2 JSON files from {@link X_OAUTH_DIR} (derived from constants).
 * If credentials are missing or lack an access_token the affected call is
 * skipped with a console warning.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ApiError, Client, OAuth2 } from '@xdevplatform/xdk';

import { X_ACCOUNTS, X_OAUTH_DIR } from '../../lib/constants.js';

// ── Handle resolution ──────────────────────────────────────────────

/**
 * Parse the X account handle from CLI args. Logs a skip message and
 * calls `process.exit(0)` if no handle is provided. When used at
 * module top level, the `never` return ensures TS narrows correctly.
 */
export function requireXHandle(scriptName: string): string {
  const handle = process.argv[2];
  if (!handle) {
    console.log(
      `[skip] No X account handle provided. Usage: tsx ${scriptName} <handle>`,
    );
    process.exit(0);
  }
  return handle;
}

/**
 * Resolve the X account content directory from X_ACCOUNTS. Logs a skip
 * message and calls `process.exit(0)` if the handle is not configured.
 */
export function requireAccountDir(handle: string): string {
  const dir = X_ACCOUNTS[handle];
  if (!dir) {
    console.log(
      `[skip] X account '${handle}' not configured in X_ACCOUNTS (constants.ts)`,
    );
    process.exit(0);
  }
  return dir;
}

// ── OAuth JSON helpers ─────────────────────────────────────────────

export interface XOAuthCredentials {
  provider: string;
  account: string;
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  obtained_at?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Resolve the path to the OAuth2 JSON credential file for a handle.
 * Format: `{X_OAUTH_DIR}/x-{handle}-oauth2.json`
 */
export function getOAuthPath(handle: string): string {
  return path.join(X_OAUTH_DIR, `x-${handle}-oauth2.json`);
}

/**
 * Read OAuth2 credentials from the server-managed JSON file.
 */
export function readOAuthCredentials(handle: string): XOAuthCredentials | null {
  const filePath = getOAuthPath(handle);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as XOAuthCredentials;
  } catch {
    console.log(`x-api: failed to parse ${filePath}`);
    return null;
  }
}

/**
 * Write OAuth2 credentials back to the server-managed JSON file.
 */
export function writeOAuthCredentials(
  handle: string,
  creds: XOAuthCredentials,
): void {
  const filePath = getOAuthPath(handle);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2) + '\n', 'utf8');
}

// ── User-ID cache ──────────────────────────────────────────────────

const userIdCache = new Map<string, string>();

// ── Client factory ─────────────────────────────────────────────────

/**
 * Create an X API client for the given handle.
 *
 * Reads OAuth2 credentials from the server-managed JSON file at
 * `{X_OAUTH_DIR}/x-{handle}-oauth2.json`.
 */
export function createXClient(handle: string): Client | null {
  const creds = readOAuthCredentials(handle);
  if (!creds) {
    console.log(`[skip] X OAuth2 credentials not found for @${handle}`);
    return null;
  }
  if (!creds.access_token) {
    console.log(`[skip] No access_token in credentials for @${handle}`);
    return null;
  }

  return new Client({ accessToken: creds.access_token });
}

// ── Auto-refresh wrapper ────────────────────────────────────────────

/**
 * Execute an API call with automatic token refresh on 401.
 *
 * Creates a client, runs `fn`. If the call throws a 401 ApiError, refreshes
 * the OAuth2 token and retries once with a fresh client.
 */
export async function withAutoRefresh<T>(
  handle: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = createXClient(handle);
  if (!client) throw new Error(`No X credentials for @${handle}`);

  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.log(`x-api: 401 for @${handle}, refreshing token...`);
      const refreshed = await refreshOAuth2Token(handle);
      if (!refreshed) throw err;

      const newClient = new Client({ accessToken: refreshed.accessToken });
      return await fn(newClient);
    }
    throw err;
  }
}

// ── User lookup ────────────────────────────────────────────────────

/** Resolve a handle to a user ID, caching the result. */
export async function lookupUser(
  client: Client,
  handle: string,
): Promise<string | null> {
  const cached = userIdCache.get(handle);
  if (cached) return cached;

  const res = await client.users.getByUsername(handle);
  const id = res.data?.id;
  if (!id) {
    console.log(`x-api: could not resolve user @${handle}`);
    return null;
  }
  userIdCache.set(handle, id);
  return id;
}

// ── Tweet type ─────────────────────────────────────────────────────

export interface XTweet {
  id: string;
  createdAt: string;
  text: string;
  authorId?: string;
}

// ── Standard tweet fields for all poll calls ───────────────────────

const TWEET_FIELDS = ['id', 'text', 'created_at', 'author_id'];

interface TweetLike {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
}

function normaliseTweets(data: TweetLike[] | undefined): XTweet[] {
  if (!data) return [];
  return data
    .filter((t): t is TweetLike & { id: string } => !!t.id)
    .map((t) => ({
      id: t.id,
      createdAt: t.created_at ?? '',
      text: t.text ?? '',
      authorId: t.author_id,
    }));
}

// ── Poll helpers ───────────────────────────────────────────────────

export interface PollOptions {
  maxResults?: number;
  sinceId?: string;
}

/** Fetch recent tweets authored by a handle. */
export async function pollUserTweets(
  client: Client,
  handle: string,
  options?: PollOptions,
): Promise<XTweet[]> {
  const userId = await lookupUser(client, handle);
  if (!userId) return [];

  const res = await client.users.getPosts(userId, {
    maxResults: options?.maxResults ?? 50,
    sinceId: options?.sinceId,
    tweetFields: TWEET_FIELDS,
  });
  return normaliseTweets(res.data);
}

/** Fetch recent mentions of a handle. */
export async function pollUserMentions(
  client: Client,
  handle: string,
  options?: PollOptions,
): Promise<XTweet[]> {
  const userId = await lookupUser(client, handle);
  if (!userId) return [];

  const res = await client.users.getMentions(userId, {
    maxResults: options?.maxResults ?? 50,
    sinceId: options?.sinceId,
    tweetFields: TWEET_FIELDS,
  });
  return normaliseTweets(res.data);
}

/** Fetch the home timeline for a handle. */
export async function pollHomeTimeline(
  client: Client,
  handle: string,
  options?: PollOptions,
): Promise<XTweet[]> {
  const userId = await lookupUser(client, handle);
  if (!userId) return [];

  const res = await client.users.getTimeline(userId, {
    maxResults: options?.maxResults ?? 50,
    sinceId: options?.sinceId,
    tweetFields: TWEET_FIELDS,
  });
  return normaliseTweets(res.data);
}

/** Fetch tweets liked by a handle. */
export async function pollLikedTweets(
  client: Client,
  handle: string,
  options?: PollOptions,
): Promise<XTweet[]> {
  const userId = await lookupUser(client, handle);
  if (!userId) return [];

  const res = await client.users.getLikedPosts(userId, {
    maxResults: options?.maxResults ?? 50,
    tweetFields: TWEET_FIELDS,
  });
  return normaliseTweets(res.data);
}

/** Fetch bookmarked tweets for a handle. */
export async function pollBookmarks(
  client: Client,
  handle: string,
  options?: PollOptions,
): Promise<XTweet[]> {
  const userId = await lookupUser(client, handle);
  if (!userId) return [];

  const res = await client.users.getBookmarks(userId, {
    maxResults: options?.maxResults ?? 50,
    tweetFields: TWEET_FIELDS,
  });
  return normaliseTweets(res.data);
}

// ── Write actions ──────────────────────────────────────────────────

/** Create a tweet, reply, or quote tweet. */
export async function createPost(
  client: Client,
  text: string,
  options?: { inReplyToTweetId?: string; quoteTweetId?: string },
): Promise<{ id?: string }> {
  const body: Record<string, unknown> = { text };
  if (options?.inReplyToTweetId)
    body.reply = { in_reply_to_tweet_id: options.inReplyToTweetId };
  if (options?.quoteTweetId) body.quote_tweet_id = options.quoteTweetId;

  const res = await client.posts.create(body);
  return {
    id: res.data?.id,
  };
}

/** Like a tweet on behalf of a handle. */
export async function likePost(
  client: Client,
  handle: string,
  tweetId: string,
): Promise<boolean> {
  const userId = await lookupUser(client, handle);
  if (!userId) return false;

  await client.users.likePost(userId, { tweetId });
  return true;
}

/** Remove a like from a tweet on behalf of a handle. */
export async function unlikePost(
  client: Client,
  handle: string,
  tweetId: string,
): Promise<boolean> {
  const userId = await lookupUser(client, handle);
  if (!userId) return false;

  await client.users.unlikePost(userId, tweetId);
  return true;
}

/** Repost (retweet) a tweet on behalf of a handle. */
export async function repostPost(
  client: Client,
  handle: string,
  tweetId: string,
): Promise<boolean> {
  const userId = await lookupUser(client, handle);
  if (!userId) return false;

  await client.users.repostPost(userId, { tweetId });
  return true;
}

/** Remove a repost on behalf of a handle. */
export async function unrepostPost(
  client: Client,
  handle: string,
  tweetId: string,
): Promise<boolean> {
  const userId = await lookupUser(client, handle);
  if (!userId) return false;

  await client.users.unrepostPost(userId, tweetId);
  return true;
}

// ── Token refresh ──────────────────────────────────────────────────

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
}

/**
 * Refresh OAuth2 token for a handle using credentials from the JSON file.
 * Reads client ID/secret and refresh token from the same file,
 * refreshes via the X API, and writes the updated tokens back.
 */
export async function refreshOAuth2Token(
  handle: string,
): Promise<TokenRefreshResult | null> {
  const creds = readOAuthCredentials(handle);
  if (!creds) {
    console.log(`[skip] OAuth2 credentials not found for @${handle}`);
    return null;
  }

  const { refresh_token: rt, clientId, clientSecret } = creds;
  if (!rt || !clientId || !clientSecret) {
    console.log(
      `[skip] Missing refresh token or client credentials for @${handle}`,
    );
    return null;
  }

  const oauth2 = new OAuth2({
    clientId,
    clientSecret,
    redirectUri: 'https://localhost',
  });

  const tokens = await oauth2.refreshToken(rt);

  // Write updated tokens back to the JSON file.
  const updated: XOAuthCredentials = {
    ...creds,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? rt,
    token_type: tokens.token_type,
    scope: tokens.scope,
    expires_in: tokens.expires_in,
    obtained_at: new Date().toISOString(),
  };
  writeOAuthCredentials(handle, updated);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? rt,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    expiresIn: tokens.expires_in,
  };
}
