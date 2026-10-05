/**
 * @module pipeline-config
 *
 * Zod-validated pipeline configuration loader. Reads the config file
 * specified by PIPELINE_CONFIG_PATH in constants.ts, validates the
 * schema, and provides typed accessors.
 *
 * The config file controls which email accounts to poll, calendar sync
 * settings, domain-to-bucket routing for email classification, email
 * pipeline feature flags, and named refs for external service IDs
 * (Notion databases, Slack channels, etc.).
 *
 * On jeeves-tools-managed instances, this file is rendered by the
 * `configure` command. On standalone instances, create it manually —
 * see PipelineConfigSchema below for required fields.
 *
 * Config dependencies: PIPELINE_CONFIG_PATH from constants.ts.
 */

import fs from 'node:fs';

import { z } from 'zod';

import type { SyncEntryConfig } from '../google-drive/lib/config.js';
import { GoogleDriveConfigSchema } from '../google-drive/lib/config.js';
import { IMAP_SECRETS_DIR, PIPELINE_CONFIG_PATH } from './constants.js';
import { isSafeSecretRef, UNSAFE_SECRET_REF_MESSAGE } from './imap-secrets.js';

// ── Zod schemas ─────────────────────────────────────────────────────

const warnedDeprecations = new Set<string>();

/**
 * Log a one-line `pipeline-config:` deprecation warning, at most once per
 * process for each message (cleared by {@link resetPipelineConfig}).
 */
function warnDeprecated(message: string): void {
  if (warnedDeprecations.has(message)) return;
  warnedDeprecations.add(message);
  console.warn(`pipeline-config: ${message}`);
}

/** Deprecation warning for a literal `imap.password` (never the value). */
const PLAIN_IMAP_PASSWORD_WARNING = `accounts[].imap.password as a plain string is deprecated; put the password in a file in ${IMAP_SECRETS_DIR} and set imap.password to { "secretRef": "<file name>" }.`;

/**
 * `imap.password`: `{ secretRef }` naming a file in IMAP_SECRETS_DIR
 * (read at connect time by lib/imap-secrets.ts), or a literal string
 * (deprecated; accepted with a once-per-process warning).
 */
const ImapPasswordSchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') warnDeprecated(PLAIN_IMAP_PASSWORD_WARNING);
    return value;
  },
  z.union([
    z.string(),
    z.strictObject({
      secretRef: z.string().refine(isSafeSecretRef, UNSAFE_SECRET_REF_MESSAGE),
    }),
  ]),
);

const ImapConnectionSchema = z.object({
  host: z.string(),
  port: z.number(),
  tls: z.boolean(),
  user: z.string(),
  password: ImapPasswordSchema,
});

const CalendarConfigSchema = z.union([
  z.object({ tokenFile: z.string() }),
  z.object({ serviceAccount: z.literal('auto') }),
]);

const AccountSchema = z
  .object({
    email: z.string(),
    type: z.enum(['gmail', 'imap']),
    calendar: CalendarConfigSchema.optional(),
    emailPolling: z.boolean(),
    imap: ImapConnectionSchema.optional(),
    folders: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'imap' && !data.imap) {
      ctx.addIssue({
        code: 'custom',
        message: 'IMAP accounts require an imap connection block',
        path: ['imap'],
      });
    }
  });

const DomainEntrySchema = z.object({
  pattern: z.string(),
  bucket: z.string(),
});

const BucketsSchema = z.object({
  domains: z.array(DomainEntrySchema),
  priority: z.array(z.string()),
});

/** Deprecated name of `emailConfig.receipt.forwardEnabled`. */
const LEGACY_RECEIPT_FORWARD_KEY = 'forwardJGS';

/**
 * Map the deprecated `receipt.forwardJGS` key to `forwardEnabled` so
 * existing pipeline-config.json files keep loading. When both are
 * present, `forwardEnabled` wins and the legacy key is ignored. Either
 * way a one-line deprecation warning is logged (once per process).
 */
function migrateReceiptConfig(raw: unknown): unknown {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !(LEGACY_RECEIPT_FORWARD_KEY in raw)
  )
    return raw;
  const { [LEGACY_RECEIPT_FORWARD_KEY]: legacy, ...rest } = raw as Record<
    string,
    unknown
  >;
  if ('forwardEnabled' in rest) {
    warnDeprecated(
      `emailConfig.receipt.${LEGACY_RECEIPT_FORWARD_KEY} is deprecated and ignored because forwardEnabled is set; remove it.`,
    );
    return rest;
  }
  warnDeprecated(
    `emailConfig.receipt.${LEGACY_RECEIPT_FORWARD_KEY} is deprecated; rename it to forwardEnabled.`,
  );
  return { ...rest, forwardEnabled: legacy };
}

const ReceiptConfigSchema = z.preprocess(
  migrateReceiptConfig,
  z.object({
    /** Whether detected receipts are forwarded to `sparkReceiptsForwardTo`. */
    forwardEnabled: z.boolean(),
    /** Address receipts are forwarded to. */
    sparkReceiptsForwardTo: z.string(),
  }),
);

const DigestConfigSchema = z.object({
  slackChannelId: z.string(),
});

/**
 * Paced historical Gmail backfill (email/google-workspace/
 * backfill-historical.ts). Optional: absent means the backfill job has
 * nothing configured and fails if run without CLI args. No defaults.
 */
const BackfillConfigSchema = z.object({
  /** Gmail accounts to backfill. */
  accounts: z.array(z.string().min(1)).min(1),
  /** How far back from now to walk, in days. */
  lookbackDays: z.number().int().positive(),
  /** Days searched per run, per account. */
  windowDays: z.number().int().positive(),
});

const EmailConfigSchema = z.object({
  reportOnly: z.boolean(),
  receipt: ReceiptConfigSchema,
  digest: DigestConfigSchema,
  backfill: BackfillConfigSchema.optional(),
});

const PipelineConfigSchema = z.object({
  accounts: z.array(AccountSchema),
  buckets: BucketsSchema,
  refs: z.record(z.string(), z.string()),
  emailConfig: EmailConfigSchema,
  /** Google Drive sync (docs/google-drive-spec.md §8). Absent → the job skips. */
  googleDrive: GoogleDriveConfigSchema.optional(),
});

// ── Derived types ───────────────────────────────────────────────────

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type AccountConfig = z.infer<typeof AccountSchema>;
export type ImapConnection = z.infer<typeof ImapConnectionSchema>;
export type BucketsConfig = z.infer<typeof BucketsSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type BackfillConfig = z.infer<typeof BackfillConfigSchema>;
export type {
  GoogleDriveConfig,
  SyncEntryConfig,
} from '../google-drive/lib/config.js';

/** Configured Google Drive syncs, or `[]` when the block is absent. */
export function getGoogleDriveSyncs(): SyncEntryConfig[] {
  return loadPipelineConfig().googleDrive?.syncs ?? [];
}

// ── Cached loader ───────────────────────────────────────────────────

let _config: PipelineConfig | null = null;
let _bucketPriorityCache: Record<string, number> | null = null;

export function loadPipelineConfig(): PipelineConfig {
  if (!_config) {
    const raw = fs.readFileSync(PIPELINE_CONFIG_PATH, 'utf8');
    _config = PipelineConfigSchema.parse(JSON.parse(raw));
  }
  return _config;
}

/** Reset cached config (for testing). */
export function resetPipelineConfig(): void {
  _config = null;
  warnedDeprecations.clear();
  _bucketPriorityCache = null;
}

// ── Accessors ───────────────────────────────────────────────────────

/** Get a ref value by dotted key, throws if missing. */
export function getRef(key: string): string {
  const config = loadPipelineConfig();
  if (!Object.prototype.hasOwnProperty.call(config.refs, key)) {
    throw new Error(`Missing pipeline config ref: ${key}`);
  }
  return config.refs[key];
}

/**
 * Safe ref accessor — returns empty string instead of throwing when
 * the key is missing. Use in prerequisite guards where you need to
 * check whether a ref is configured without crashing.
 */
export function tryGetRef(key: string): string {
  try {
    return getRef(key);
  } catch {
    return '';
  }
}

/** Accounts that have calendar config. */
export function getCalendarAccounts(): AccountConfig[] {
  return loadPipelineConfig().accounts.filter((a) => a.calendar);
}

/** Email addresses of accounts with emailPolling enabled. */
export function getEmailAccounts(): string[] {
  return loadPipelineConfig()
    .accounts.filter((a) => a.emailPolling)
    .map((a) => a.email);
}

/**
 * Email addresses served by gog (Gmail / Google Workspace), deduplicated:
 * emailPolling accounts without an `imap` block, plus
 * `emailConfig.backfill.accounts`. Backfill feeds the same `email-pending`
 * and `email-updates` queues, so the gog consumers (download,
 * drain-updates) must run for backfill-only accounts too.
 */
export function getGmailAccounts(): string[] {
  const config = loadPipelineConfig();
  const polled = config.accounts
    .filter((a) => a.emailPolling && !a.imap)
    .map((a) => a.email);
  return [
    ...new Set([...polled, ...(config.emailConfig.backfill?.accounts ?? [])]),
  ];
}

/**
 * Every configured bucket name, deduplicated: `buckets.priority` order
 * first, then any bucket that appears only in `buckets.domains`. Bucket
 * names double as Gmail labels.
 */
export function getBucketNames(): string[] {
  const { buckets } = loadPipelineConfig();
  return [
    ...new Set([...buckets.priority, ...buckets.domains.map((d) => d.bucket)]),
  ];
}

/** Match a domain to a bucket name, or null if no match. */
export function getBucketForDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  for (const entry of loadPipelineConfig().buckets.domains) {
    if (entry.pattern.toLowerCase() === d) return entry.bucket;
  }
  return null;
}

/** Bucket name → priority index. Lower = higher priority. */
export function getBucketPriority(): Record<string, number> {
  if (!_bucketPriorityCache) {
    const priority = loadPipelineConfig().buckets.priority;
    const result: Record<string, number> = {};
    for (let i = 0; i < priority.length; i++) {
      result[priority[i]] = i;
    }
    _bucketPriorityCache = result;
  }
  return _bucketPriorityCache;
}
