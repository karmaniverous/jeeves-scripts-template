/**
 * @module session-scanner.fixtures
 *
 * Shared test fixtures for session-scanner: JSONL line builders and a
 * per-test temp workspace that re-imports the scanner with its paths
 * pointed at the workspace.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import type { scanAllSessions } from './session-scanner.js';

/** Build an OpenClaw JSONL usage line. */
export function ocLine(opts: {
  tsIso: string;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return JSON.stringify({
    type: 'message',
    timestamp: opts.tsIso,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-6',
      provider: opts.provider ?? 'anthropic',
      usage: {
        input: opts.input ?? 100,
        output: opts.output ?? 50,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        totalTokens:
          (opts.input ?? 100) +
          (opts.output ?? 50) +
          (opts.cacheRead ?? 0) +
          (opts.cacheWrite ?? 0),
      },
    },
  });
}

/** Build an OpenClaw JSONL user message line (for channel detection). */
export function userLine(text: string): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

const RATE_CARD = {
  models: {
    'anthropic/claude-sonnet-4-6': {
      input: 0.003,
      output: 0.015,
      cacheRead: 0.0003,
      cacheWrite: 0.00375,
    },
    'openai/gpt-5.5': {
      input: 0.005,
      output: 0.015,
      cacheRead: 0.0025,
      cacheWrite: 0.00975,
    },
  },
  updatedAt: '2026-06-15T00:00:00Z',
};

/** A temp workspace for one test. */
export interface ScannerFixture {
  tmpDir: string;
  sessionsDir: string;
  /** Write a Claude Code session file with one assistant usage line. */
  writeCCFixture: (tsIso: string) => void;
  /** Re-import session-scanner with its constants pointed at tmpDir. */
  loadScanner: () => Promise<typeof scanAllSessions>;
  /** Restore mocks and delete the workspace. */
  cleanup: () => void;
}

/** Create the workspace (call in beforeEach; call cleanup in afterEach). */
export function createScannerFixture(): ScannerFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  // The missing/empty SESSIONS_DIR guard warns; keep test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  return {
    tmpDir,
    sessionsDir,
    writeCCFixture: (tsIso) => {
      const projectDir = path.join(tmpDir, 'cc-projects', 'D--repos-acme-app');
      fs.mkdirSync(projectDir, { recursive: true });
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: tsIso,
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
      fs.writeFileSync(path.join(projectDir, 'cc-session.jsonl'), line + '\n');
    },
    loadScanner: async () => {
      // A minimal rate card so normalizeUsage doesn't throw.
      const rateCardDir = path.join(tmpDir, 'config');
      fs.mkdirSync(rateCardDir, { recursive: true });
      fs.writeFileSync(
        path.join(rateCardDir, 'token-rates.json'),
        JSON.stringify(RATE_CARD),
      );
      vi.resetModules();
      vi.doMock(
        '../../lib/constants.js',
        async (importOriginal: () => Promise<Record<string, unknown>>) => ({
          ...(await importOriginal()),
          SESSIONS_DIR: sessionsDir,
          CLAUDE_CODE_PROJECTS_DIR: path.join(tmpDir, 'cc-projects'),
          TOKEN_RATES_PATH: path.join(tmpDir, 'config', 'token-rates.json'),
        }),
      );
      const mod = await import('./session-scanner.js');
      return mod.scanAllSessions;
    },
    cleanup: () => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
