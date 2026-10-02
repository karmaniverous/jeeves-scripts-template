/**
 * @module claude-code-scanner
 *
 * Claude Code session scanner — reads ~/.claude/projects JSONL files
 * and extracts Anthropic usage records for the token metrics pipeline.
 *
 * Claude Code uses Anthropic-native field names (input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens) and bare model names
 * (claude-opus-4-6) without a provider prefix.
 *
 * Config dependencies: CLAUDE_CODE_PROJECTS_DIR from constants.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLAUDE_CODE_PROJECTS_DIR } from '../../lib/constants.js';
import type { TokenCategory } from '../types/token-metrics.js';

/** Prefix of every Claude Code channel key (`cc:<project>`). */
export const CC_CHANNEL_PREFIX = 'cc:';

/** Map of Claude Code project directory names to channel keys. */
const PROJECT_CHANNEL_MAP: Record<string, { key: string; name: string }> = {};

/**
 * Derive a channel key from a Claude Code project directory name.
 *
 * Directory names look like `D--repos-myorg-my-project`.
 * We extract a human-readable project name and prefix with `cc:`.
 */
export function projectToChannel(dirName: string): {
  key: string;
  name: string;
} {
  if (dirName in PROJECT_CHANNEL_MAP) return PROJECT_CHANNEL_MAP[dirName];

  // Strip drive prefix and common container directories
  // (e.g. D--repos-myorg-my-project → myorg-my-project, J--jeeves → jeeves).
  // We keep the full remaining name including the org segment because
  // org-project boundary is ambiguous for hyphenated org names.
  const name = dirName.replace(/^[A-Z]--(?:repos-|projects-)?/, '');

  const result = { key: `${CC_CHANNEL_PREFIX}${name}`, name: `CC: ${name}` };
  PROJECT_CHANNEL_MAP[dirName] = result;
  return result;
}

/**
 * Map a bare Claude Code model name to a provider-prefixed rate-card key.
 *
 * Claude Code logs use bare names like `claude-opus-4-6`.
 * The rate card uses `anthropic/claude-opus-4-6`.
 */
function mapModelKey(rawModel: string): string | null {
  if (rawModel === '<synthetic>') return null;

  // Known Anthropic models — add provider prefix
  if (rawModel.startsWith('claude-')) {
    // Handle dated snapshot names (e.g. claude-sonnet-4-20250514 → claude-sonnet-4-5)
    const datedMatch = rawModel.match(/^claude-(\w+)-(\d+)-(\d{8})$/);
    if (datedMatch) {
      // Map known dated snapshots
      const snapshots: Record<string, string> = {
        'claude-sonnet-4-20250514': 'anthropic/claude-sonnet-4-5',
      };
      return snapshots[rawModel] ?? `anthropic/${rawModel}`;
    }

    return `anthropic/${rawModel}`;
  }

  // Unknown model — return as-is, let the unknown-model gate catch it
  return rawModel;
}

/** Anthropic-native usage shape from Claude Code transcripts. */
interface CCUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Parsed usage record from a Claude Code session line. */
export interface CCUsageRecord {
  tsMs: number;
  modelKey: string;
  usage: Record<TokenCategory, number>;
}

/**
 * Parse a single JSONL line from a Claude Code session.
 * Returns null if the line has no extractable usage.
 */
export function parseCCLine(line: string): CCUsageRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.type !== 'assistant') return null;

  const msg = parsed.message as Record<string, unknown> | undefined;
  if (!msg?.usage) return null;

  const rawModel = typeof msg.model === 'string' ? msg.model : '';
  const modelKey = mapModelKey(rawModel);
  if (!modelKey) return null; // Skip <synthetic> etc.

  const rawUsage = msg.usage as CCUsage;

  // Must have at least some token count
  const totalTokens =
    (rawUsage.input_tokens ?? 0) +
    (rawUsage.output_tokens ?? 0) +
    (rawUsage.cache_read_input_tokens ?? 0) +
    (rawUsage.cache_creation_input_tokens ?? 0);
  if (totalTokens === 0) return null;

  // Extract timestamp from the row (ISO string at row level)
  const rawTs = parsed.timestamp;
  let tsMs: number;
  if (typeof rawTs === 'string') {
    tsMs = new Date(rawTs).getTime();
  } else if (typeof rawTs === 'number') {
    tsMs = rawTs > 1e12 ? rawTs : rawTs * 1000;
  } else {
    return null;
  }
  if (isNaN(tsMs)) return null;

  return {
    tsMs,
    modelKey,
    usage: {
      input: rawUsage.input_tokens ?? 0,
      output: rawUsage.output_tokens ?? 0,
      cacheRead: rawUsage.cache_read_input_tokens ?? 0,
      cacheWrite: rawUsage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** A Claude Code session file with its project context. */
export interface CCSessionFile {
  /** Full filesystem path. */
  filePath: string;
  /** Relative key for cursor tracking (e.g. `D--repos-myorg-my-project/abc123.jsonl`). */
  cursorKey: string;
  /** Channel key for bucket attribution. */
  channelKey: string;
  /** Channel display name. */
  channelName: string;
}

/**
 * List all Claude Code session files across all projects.
 * Returns empty array if the projects directory doesn't exist.
 */
export function listCCSessionFiles(): CCSessionFile[] {
  if (!fs.existsSync(CLAUDE_CODE_PROJECTS_DIR)) return [];

  const results: CCSessionFile[] = [];
  const dirs = fs.readdirSync(CLAUDE_CODE_PROJECTS_DIR);

  for (const dirName of dirs) {
    const dirPath = path.join(CLAUDE_CODE_PROJECTS_DIR, dirName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const channel = projectToChannel(dirName);

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      results.push({
        filePath: path.join(dirPath, file),
        cursorKey: `${dirName}/${file}`,
        channelKey: channel.key,
        channelName: channel.name,
      });
    }
  }

  return results;
}
