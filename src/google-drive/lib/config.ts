/**
 * @module google-drive/lib/config
 *
 * Zod schema and types for the `googleDrive` pipeline-config block
 * (spec §8), and its loader. The main `PipelineConfigSchema`
 * (`src/lib/pipeline-config.ts`) carries the block unvalidated; it is
 * validated here, when the Drive job loads it, so a mistake in it fails
 * only this job and `src/lib/` never depends on this domain.
 *
 * `targetDir` resolution (relative to `CONTENT_DIR`, absolute paths
 * must sit under it) is a separate pure function so it can be unit
 * tested without touching the filesystem or constants.
 */

import path from 'node:path';

import { z } from 'zod';

import { loadPipelineConfig } from '../../lib/pipeline-config.js';

/**
 * A mailbox address that is also a safe single path segment: the account
 * names its staging directory (which is wiped at startup) and keys the
 * ledger, so no separators, no `..`, no leading dot.
 */
export const ACCOUNT_PATTERN =
  /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export const PathResolutionSchema = z.object({
  /** Impersonate owners/sharers in delegated domains to resolve paths (§4.2). */
  impersonate: z.boolean().default(true),
  /** Domains the service account has domain-wide delegation for. */
  domains: z.array(z.string()).default([]),
  /** Identity to impersonate for a shared-drive item shared by someone outside `domains`. */
  sharedDriveFallbackIdentity: z.string().nullable().default(null),
});
export type PathResolutionConfig = z.infer<typeof PathResolutionSchema>;

export const SheetsConversionSchema = z.object({
  maxRowsPerTab: z.number().int().positive().default(5000),
  maxCellChars: z.number().int().positive().default(2000),
});
export type SheetsConversionConfig = z.infer<typeof SheetsConversionSchema>;

export const ConversionConfigSchema = z.object({
  /** Extends the built-in native-text MIME type table (§5). */
  textMimeTypes: z.array(z.string()).default([]),
  /** Extends the built-in native-text extension allowlist (§5). */
  textExtensions: z.array(z.string()).default([]),
  /** Extends the built-in skip-MIME table. */
  skipMimeTypes: z.array(z.string()).default([]),
  sheets: SheetsConversionSchema.prefault({}),
});
export type ConversionConfig = z.infer<typeof ConversionConfigSchema>;

export const MetaSyncConfigSchema = z.object({
  seed: z.boolean().default(true),
  rootSteer: z.string().nullable().default(null),
  sharePointSteer: z.string().nullable().default(null),
  /** Matches jeeves-meta's own STALE_TIMEOUT_MS (30 min) by default. */
  lockStaleMinutes: z.number().int().positive().default(30),
});
export type MetaSyncConfig = z.infer<typeof MetaSyncConfigSchema>;

export const NamingConfigSchema = z.object({
  /** Optional readability cap narrower than the 255-byte filesystem budget. */
  maxNameBytes: z.number().int().positive().nullable().default(null),
  maxPathBytes: z.number().int().positive().default(4000),
});
export type NamingConfig = z.infer<typeof NamingConfigSchema>;

export const DeletionConfigSchema = z.object({
  maxFraction: z.number().min(0).max(1).default(0.2),
  minCount: z.number().int().nonnegative().default(25),
});
export type DeletionConfig = z.infer<typeof DeletionConfigSchema>;

/**
 * The run budget (spec §6.4): one setting for the whole run, shared by
 * every sync. `maxSeconds` runs from process start; `maxItems` and
 * `maxBytes` count downloads across all syncs.
 */
export const BudgetConfigSchema = z.object({
  maxSeconds: z.number().int().positive().default(360),
  maxItems: z.number().int().positive().nullable().default(null),
  maxBytes: z.number().int().positive().nullable().default(null),
  maxAttempts: z.number().int().positive().default(5),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const SyncEntrySchema = z.object({
  /** The Workspace mailbox registered in gog that the sync reads as. */
  account: z.string().regex(ACCOUNT_PATTERN, {
    error:
      'googleDrive.syncs[].account must be a mailbox address (local@domain): it names the staging directory and keys the ledger',
  }),
  /** Relative to CONTENT_DIR, or absolute and under it. */
  targetDir: z.string().min(1).default('google-drive'),
  pathResolution: PathResolutionSchema.prefault({}),
  /** Globs matched against the item's sanitized, untagged Drive path. */
  exclude: z.array(z.string()).default([]),
  maxFileBytes: z.number().int().positive().default(26214400),
  conversion: ConversionConfigSchema.prefault({}),
  meta: MetaSyncConfigSchema.prefault({}),
  naming: NamingConfigSchema.prefault({}),
  deletion: DeletionConfigSchema.prefault({}),
  /** Moved to the top-level `googleDrive.budget`; rejected here so an old config fails loudly. */
  budget: z
    .never({
      error:
        'googleDrive.syncs[].budget is no longer supported: move it to googleDrive.budget (one budget for the whole run)',
    })
    .optional(),
});
export type SyncEntryConfig = z.infer<typeof SyncEntrySchema>;

export const GoogleDriveConfigSchema = z.object({
  budget: BudgetConfigSchema.prefault({}),
  syncs: z
    .array(SyncEntrySchema)
    .min(1)
    .superRefine((syncs, ctx) => {
      // The account keys the ledger and run state: two entries would share them.
      const seen = new Set<string>();
      for (const s of syncs) {
        const account = s.account.toLowerCase();
        if (seen.has(account)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate googleDrive sync account: ${account}`,
          });
        }
        seen.add(account);
      }
    }),
});
export type GoogleDriveConfig = z.infer<typeof GoogleDriveConfigSchema>;

/** The pipeline config's `googleDrive` block, validated (`null` when absent). */
export function loadGoogleDriveConfig(): GoogleDriveConfig | null {
  return parseGoogleDriveConfig(loadPipelineConfig().googleDrive);
}

/**
 * Validate a raw `googleDrive` block; `null` when it is absent.
 *
 * @throws When the block is present but invalid.
 */
export function parseGoogleDriveConfig(raw: unknown): GoogleDriveConfig | null {
  if (raw === undefined || raw === null) return null;
  const parsed = GoogleDriveConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `pipeline-config: invalid googleDrive block: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** True when `rel` (a `path.relative` result) climbs out of its base. */
function escapes(rel: string): boolean {
  return (
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  );
}

/**
 * Resolve a sync's `targetDir` to an absolute path under `contentDir`.
 *
 * @throws When `targetDir` doesn't resolve to a strict subdirectory of
 *   `contentDir` (outside it, or `contentDir` itself).
 */
export function resolveTargetDir(
  targetDir: string,
  contentDir: string,
): string {
  // The sync owns everything under targetDir (and deletes what it didn't
  // write), so it must be a strict subdirectory of CONTENT_DIR: never
  // CONTENT_DIR itself, never outside it (relative `..` included).
  const resolved = path.resolve(contentDir, targetDir);
  const rel = path.relative(contentDir, resolved);
  if (rel === '' || escapes(rel)) {
    throw new Error(
      `googleDrive sync targetDir "${targetDir}" must be a subdirectory of CONTENT_DIR (${contentDir}): the sync owns and prunes that tree.`,
    );
  }
  return resolved;
}

/**
 * Every sync owns (and prunes) its whole target tree, and plans against
 * only its own account's shares, so two targets that are equal or nested
 * would delete each other's files.
 *
 * @throws On equal or nested resolved targets.
 */
export function assertDisjointTargets(
  syncs: SyncEntryConfig[],
  contentDir: string,
): void {
  const targets = syncs.map((s) => ({
    account: s.account,
    dir: resolveTargetDir(s.targetDir, contentDir),
  }));
  for (const [i, a] of targets.entries()) {
    for (const b of targets.slice(i + 1)) {
      const rel = path.relative(a.dir, b.dir);
      const back = path.relative(b.dir, a.dir);
      const nested = (r: string): boolean => r === '' || !escapes(r);
      if (nested(rel) || nested(back)) {
        throw new Error(
          `googleDrive syncs ${a.account} and ${b.account} have overlapping targetDirs (${a.dir}, ${b.dir}); each sync needs its own tree.`,
        );
      }
    }
  }
}
