/**
 * @module rate-card-seed
 *
 * Seed-if-missing for the token rate card. Fresh instances have no
 * token-rates.json, and the refresh-token-rates worker only verifies
 * models already in the card, so it can't bootstrap one. The template
 * ships a seed card (config/token-rates.seed.json) that is copied into
 * place when, and only when, no rate card exists. A live card is never
 * overwritten, even if it is invalid.
 *
 * Config dependencies: TOKEN_RATES_PATH, TOKEN_RATES_SEED_PATH from
 * constants.ts (passed in by callers).
 */

import fs from 'node:fs';
import path from 'node:path';

import { readRateCardFile } from './rate-card-schema.js';

/** Outcome of {@link ensureRateCard}. */
export interface EnsureRateCardResult {
  /** True when the seed was copied into place by this call. */
  seeded: boolean;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}

/**
 * Create the rate card from the seed if it does not exist yet.
 *
 * - Existing card (valid or not): left untouched.
 * - Missing card: the seed is validated, the parent directory is
 *   created, and the seed is copied with an exclusive-create flag so a
 *   concurrently written card is never clobbered.
 *
 * @param ratesPath - Live rate card path (TOKEN_RATES_PATH).
 * @param seedPath - Seed rate card shipped with the scripts repo.
 * @returns Whether the seed was copied.
 * @throws Error if the card is missing and the seed is missing or invalid.
 */
export function ensureRateCard(
  ratesPath: string,
  seedPath: string,
): EnsureRateCardResult {
  if (fs.existsSync(ratesPath)) return { seeded: false };

  // Validate before copying so a broken seed never becomes the live card.
  readRateCardFile(seedPath);

  fs.mkdirSync(path.dirname(ratesPath), { recursive: true });
  try {
    fs.copyFileSync(seedPath, ratesPath, fs.constants.COPYFILE_EXCL);
  } catch (err: unknown) {
    if (isErrnoCode(err, 'EEXIST')) return { seeded: false };
    throw err;
  }

  console.log(`[rate-card] Seeded ${ratesPath} from ${seedPath}`);
  return { seeded: true };
}
