/**
 * @module google-drive/lib/seed-metas
 *
 * Seed `.meta/` at share roots and share points (spec §7.3), once the
 * directory's subtree holds a written file and it has no `.meta/` yet.
 * Root vs share-point steer comes from config, else the defaults.
 */

import path from 'node:path';

import { hasMeta, subtreeHasFile } from './apply.js';
import type { MetaSyncConfig } from './config.js';
import { defaultSteer, type FetchLike, seedMeta } from './meta-seed.js';

export interface SeedOutcome {
  seeded: number;
  errors: string[];
}

export async function seedShareMetas(
  targetDir: string,
  candidates: string[],
  rootDirs: Set<string>,
  meta: MetaSyncConfig,
  fetchFn?: FetchLike,
): Promise<SeedOutcome> {
  const outcome: SeedOutcome = { seeded: 0, errors: [] };
  if (!meta.seed) return outcome;
  for (const rel of candidates) {
    if (!subtreeHasFile(targetDir, rel) || hasMeta(targetDir, rel)) continue;
    const isRoot = rootDirs.has(rel);
    const label = rel.split('/').at(-1) ?? rel;
    const steer =
      (isRoot ? meta.rootSteer : meta.sharePointSteer) ??
      defaultSteer(isRoot ? 'root' : 'sharePoint', label);
    try {
      const result = await seedMeta(path.join(targetDir, rel), steer, fetchFn);
      if (result === 'created') outcome.seeded++;
    } catch (err) {
      outcome.errors.push(String(err));
    }
  }
  return outcome;
}
