/**
 * @module rate-card-seed
 *
 * Seed-if-missing for the token rate card. Fresh instances have no
 * token-rates.json, and refresh-token-rates only refreshes models already
 * in the card (plus pending ids recorded by the collector), so it can't
 * bootstrap a whole card from nothing. The template
 * ships a seed card (config/token-rates.seed.json) that is copied into
 * place when, and only when, no rate card exists. A live card is never
 * overwritten, even if it is invalid.
 *
 * Seeding is atomic: the validated seed is written and fsynced to a
 * temp file in the target directory, then hard-linked to the live path.
 * `link` fails with EEXIST if the target exists, so it never clobbers a
 * concurrently created card, and readers only ever see a complete file.
 * An interrupted run leaves at most a stray temp file, never a partial
 * live card.
 *
 * Config dependencies: TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH from
 * constants.ts (passed in by callers).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readRateCardText } from './rate-card-schema.js';

/** Outcome of {@link ensureRateCard}. */
export interface EnsureRateCardResult {
  /** True when the seed was put into place by this call. */
  seeded: boolean;
}

/** Type guard for Node system errors carrying an errno `code`. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Write text to a new file (exclusive create) and flush it to disk. */
function writeDurable(filePath: string, text: string): void {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create the rate card from the seed if it does not exist yet.
 *
 * - Existing card (valid or not): left untouched.
 * - Missing card: the seed is validated, the parent directory is
 *   created, and the validated bytes are atomically claimed into place
 *   (temp file + hard link), so a concurrently written card is never
 *   clobbered and no reader sees a partial file.
 *
 * @param ratesPath - Live rate card path (TOKEN_RATES_PATH).
 * @param seedPath - Seed rate card shipped with the scripts repo.
 * @returns Whether the seed was put into place by this call.
 * @throws Error if the card is missing and the seed is missing or invalid.
 */
export function ensureRateCard(
  ratesPath: string,
  seedPath: string,
): EnsureRateCardResult {
  if (fs.existsSync(ratesPath)) return { seeded: false };

  // Validate before writing so a broken seed never becomes the live card.
  const { text } = readRateCardText(seedPath);

  const dir = path.dirname(ratesPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(ratesPath)}.${randomUUID()}.tmp`,
  );

  try {
    writeDurable(tmpPath, text);
    fs.linkSync(tmpPath, ratesPath);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      return { seeded: false };
    }
    throw err;
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  console.log(`[rate-card] Seeded ${ratesPath} from ${seedPath}`);
  return { seeded: true };
}
