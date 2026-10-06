/**
 * @module pipeline-config-email
 *
 * Zod schema for the `emailConfig` block of pipeline-config.json: email
 * pipeline flags, receipt forwarding (with the legacy `forwardJGS` key
 * migrated), digest, historical backfill, and meeting-email actions.
 */

import { z } from 'zod';

import { warnDeprecated } from './pipeline-config-deprecations.js';

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

/**
 * Gmail actions meetings/extract.ts takes on a meeting's source email.
 * Optional: absent keeps the original behaviour (archive inbox meeting
 * emails). The `meeting` label is always applied (unless reportOnly).
 */
const MeetingsEmailConfigSchema = z.object({
  /** Archive the source email out of INBOX after packaging (never `watch`ed mail). */
  archive: z.boolean(),
});

export const EmailConfigSchema = z.object({
  reportOnly: z.boolean(),
  receipt: ReceiptConfigSchema,
  digest: DigestConfigSchema,
  backfill: BackfillConfigSchema.optional(),
  meetings: MeetingsEmailConfigSchema.optional(),
});

export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type BackfillConfig = z.infer<typeof BackfillConfigSchema>;
export type MeetingsEmailConfig = z.infer<typeof MeetingsEmailConfigSchema>;
