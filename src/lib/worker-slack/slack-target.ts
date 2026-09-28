/**
 * @module worker-slack/slack-target
 *
 * Normalize Slack targets to the gateway message tool's target syntax:
 * `channel:<C|G|D id>` or `user:<U|W id>`. Bare Slack IDs are accepted
 * and prefixed; channel names (`#ops`) are rejected, because the job must
 * post only to explicitly configured IDs. A prefix must match its ID
 * family (`channel:` C/G/D, `user:` U/W): `channel:U…` / `user:C…` are
 * rejected.
 */

const PREFIXED = /^(channel|user):([A-Z0-9]+)$/i;
const FAMILY: Record<string, RegExp> = {
  channel: /^[CGD][A-Z0-9]{6,}$/i,
  user: /^[UW][A-Z0-9]{6,}$/i,
};
const BARE = /^([CGDUW])[A-Z0-9]{6,}$/i;

/**
 * Normalize a Slack target.
 *
 * @param raw - `C…`/`G…`/`D…` channel id, `U…`/`W…` user id, or an
 *   already-prefixed `channel:…` / `user:…` target.
 * @returns The prefixed, upper-cased target, or null when unrecognized.
 */
export function normalizeSlackTarget(raw: string): string | null {
  const value = raw.trim();
  const prefixed = PREFIXED.exec(value);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    return FAMILY[kind].test(prefixed[2])
      ? `${kind}:${prefixed[2].toUpperCase()}`
      : null;
  }
  const bare = BARE.exec(value);
  if (!bare) return null;
  const kind = /^[UW]$/i.test(bare[1]) ? 'user' : 'channel';
  return `${kind}:${value.toUpperCase()}`;
}

/**
 * Normalize a target or throw.
 *
 * @param raw - Target to normalize.
 * @returns The normalized target.
 * @throws Error when the target is not a Slack ID or prefixed target.
 */
export function requireSlackTarget(raw: string): string {
  const target = normalizeSlackTarget(raw);
  if (!target)
    throw new Error(`Invalid Slack target "${raw}" (use a channel/user ID)`);
  return target;
}
