/**
 * @module worker-slack/worker-slack-config
 *
 * Zod 4 schema (source of truth) for a job's worker-slack configuration:
 * pre-dispatch reads, allowed post targets, and the operations each target
 * permits (exact edit timestamps, pinning). Types are derived with
 * `z.infer`; {@link parseWorkerSlackConfig} validates at the dispatch
 * boundary so bad limits, labels, purposes, targets or account ids fail
 * the job before any gateway side effect. Pure.
 */

import { z } from 'zod';

import { normalizeSlackTarget } from './slack-target.js';

/** A Slack message timestamp (`<seconds>.<micros>`). */
export const slackTsSchema = z.string().regex(/^\d+\.\d+$/);

/** A Slack channel/user id or prefixed target (`channel:…` / `user:…`). */
const targetSchema = z
  .string()
  .refine((t) => normalizeSlackTarget(t) !== null, {
    message: 'Invalid Slack target (use a channel/user ID)',
  });

/** A Slack read made before dispatch. */
const slackReadSpecSchema = z
  .object({
    /** Channel/user id or prefixed target. */
    target: targetSchema,
    /** Label shown to the worker, e.g. `#ops-ceo`. */
    label: z.string().trim().min(1).max(200),
    /** Messages to read (default 20). */
    limit: z.number().int().min(1).max(200).optional(),
    /** Read this thread instead of the channel. */
    threadTs: slackTsSchema.optional(),
  })
  .strict();

/** A target the worker may post to, with the operations it permits. */
const slackPostTargetSchema = z
  .object({
    /** Channel/user id or prefixed target. */
    target: targetSchema,
    /** What posts there are for (shown to the worker). */
    purpose: z.string().trim().min(1).max(1000),
    /**
     * Exact message timestamps the worker may edit here (e.g. the pinned
     * quick-links message). Any other `edit_ts` fails the job.
     */
    editTs: z.array(slackTsSchema).optional(),
    /** Whether the worker may pin new messages here (default false). */
    pin: z.boolean().optional(),
  })
  .strict();

/** Slack configuration for one job. */
const workerSlackConfigSchema = z
  .object({
    /** Gateway Slack account id (multi-account gateways, e.g. `<account-id>`). */
    accountId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    /** Reads made before dispatch. */
    reads: z.array(slackReadSpecSchema).optional(),
    /**
     * Targets the worker may post to. Each normalized target may appear
     * once: aliases (`C…` vs `channel:C…`) would otherwise overwrite each
     * other's `editTs`/`pin` permissions order-dependently.
     */
    posts: z
      .array(slackPostTargetSchema)
      .superRefine((posts, ctx) => {
        const seen = new Set<string>();
        posts.forEach(({ target }, index) => {
          const normalized = normalizeSlackTarget(target);
          if (normalized === null) return;
          if (seen.has(normalized))
            ctx.addIssue({
              code: 'custom',
              path: [index, 'target'],
              message: `Duplicate post target ${normalized} ("${target}")`,
            });
          seen.add(normalized);
        });
      })
      .optional(),
  })
  .strict();

/** A target the worker may post to. */
export type SlackPostTarget = z.infer<typeof slackPostTargetSchema>;
/** Slack configuration for one job. */
export type WorkerSlackConfig = z.infer<typeof workerSlackConfigSchema>;

/**
 * Validate a job's Slack configuration.
 *
 * @param config - Raw configuration.
 * @returns The validated configuration.
 * @throws Error listing every invalid field.
 */
export function parseWorkerSlackConfig(config: unknown): WorkerSlackConfig {
  const parsed = workerSlackConfigSchema.safeParse(config);
  if (!parsed.success)
    throw new Error(
      `Invalid worker-slack config: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}
