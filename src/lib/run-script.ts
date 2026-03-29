/**
 * Shared crash-handler wrapper for all runner scripts.
 * Catches uncaught errors, logs them, and exits with code 1.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Default directory for crash logs. Override via the `crashDir` parameter.
 * Set this to a path that makes sense for your deployment.
 */
const DEFAULT_CRASH_DIR = './crash-logs';

export function runScript(
  name: string,
  fn: () => void | Promise<void>,
  crashDir = DEFAULT_CRASH_DIR,
): void {
  const execute = (): void => {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        handleCrash(name, err, crashDir);
      });
    }
  };

  try {
    execute();
  } catch (err: unknown) {
    handleCrash(name, err, crashDir);
  }
}

function handleCrash(name: string, err: unknown, crashDir: string): never {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  const entry = `[${new Date().toISOString()}] CRASH (${name}): ${message}\n`;

  try {
    fs.mkdirSync(crashDir, { recursive: true });
    fs.appendFileSync(path.join(crashDir, '_crash.log'), entry);
  } catch {
    // Best effort — don't crash the crash handler.
  }

  console.error(entry);
  process.exit(1);
}
