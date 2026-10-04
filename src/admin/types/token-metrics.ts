/**
 * @module token-metrics-types
 *
 * Token metrics types — shared across collector and query layers.
 */

/** Token usage categories tracked per message. */
export type TokenCategory = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** All token categories as a constant array for iteration. */
export const TOKEN_CATEGORIES: TokenCategory[] = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
];

/** Aggregated count + cost for a single token category. */
export interface TokenBucket {
  count: number;
  cost: number;
  costPct: number;
}

/** Token breakdown by category. */
export type Tokens = Record<TokenCategory, TokenBucket>;

/** Aggregated metrics for a single model. */
export interface ModelBucket {
  cost: number;
  costPct: number;
  tokens: Tokens;
}

/** Models keyed by `provider/model` string. */
export type Models = Record<string, ModelBucket>;

/** Aggregated metrics for a single channel. */
export interface ChannelBucket {
  channelName: string;
  cost: number;
  costPct: number;
  models: Models;
}

/** Channels keyed by channel key string. */
export type Channels = Record<string, ChannelBucket>;

/**
 * Pricing reference: the rate card's rates in dollars per million tokens
 * (`$/MTok`) per token category, for every model in the card (used in the
 * range or not). Not usage: token counts are under
 * `models[model].tokens[category].count`.
 */
export interface Ref {
  [model: string]: Record<TokenCategory, number>;
}

/** Top-level cost report returned by `getTokenMetrics`. */
export interface Costs {
  channels: Channels;
  cost: number;
  models: Models;
  ref: Ref;
}

// ---- Hourly bucket (on-disk format) ----

/** Per-category counts stored in hourly bucket files. */
export interface HourlyTokenEntry {
  count: number;
  cost: number;
}

/** Per-model token breakdown in a bucket. */
export type HourlyModelEntry = Record<TokenCategory, HourlyTokenEntry>;

/** Per-channel data in a bucket. */
export interface HourlyChannelEntry {
  models: Record<string, HourlyModelEntry>;
}

/** On-disk hourly bucket file schema. */
export interface HourlyBucket {
  hour: string;
  channels: Record<string, HourlyChannelEntry>;
}

// ---- Cursor state ----

/** Per-file processing cursor stored in runner SQLite. */
export interface FileCursor {
  /** Byte offset into the file (for resume on partial reads). */
  byteOffset: number;
  /** Unix-seconds timestamp boundary up to which data was processed. */
  lastTimestamp: number;
}

/** Full cursor map keyed by filename (not full path). */
export type CursorState = Record<string, FileCursor>;
