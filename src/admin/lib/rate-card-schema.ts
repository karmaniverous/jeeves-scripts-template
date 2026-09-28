/**
 * @module rate-card-schema
 *
 * Zod schema for the token rate card file (token-rates.json) and a
 * validating reader. The schema is the source of truth; the
 * TypeScript types are derived from it.
 */

import fs from 'node:fs';

import { z } from 'zod';

/** Per-model rates in $/MTok. All four token categories are required. */
export const modelRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

/** Full rate card file schema. `models` must contain at least one entry. */
export const rateCardSchema = z.object({
  updatedAt: z.string().min(1),
  source: z.string().optional(),
  // Older cards may omit the unit; rates are always $/MTok.
  unit: z.string().min(1).default('$/MTok'),
  models: z
    .record(z.string().min(1), modelRatesSchema)
    .refine((models) => Object.keys(models).length > 0, {
      message: 'rate card has no models',
    }),
});

/** Per-model rates in $/MTok. */
export type ModelRates = z.infer<typeof modelRatesSchema>;

/** Full rate card config file. */
export type RateCardConfig = z.infer<typeof rateCardSchema>;

/**
 * Validate an already-parsed rate card value.
 *
 * @param raw - Parsed JSON value.
 * @param label - Path or description used in error messages.
 * @returns The validated rate card.
 * @throws Error describing every schema violation.
 */
export function parseRateCard(raw: unknown, label: string): RateCardConfig {
  const result = rateCardSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid token rate card at ${label}: ${issues}`);
  }
  return result.data;
}

/**
 * Read, parse and validate a rate card file.
 *
 * @param filePath - Absolute path to the rate card JSON file.
 * @returns The validated rate card.
 * @throws Error if the file is missing, unreadable, not JSON, or invalid.
 */
export function readRateCardFile(filePath: string): RateCardConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Token rate card not readable at ${filePath}: ${msg}`, {
      cause: err,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Token rate card at ${filePath} is not valid JSON: ${msg}`,
      {
        cause: err,
      },
    );
  }

  return parseRateCard(raw, filePath);
}
