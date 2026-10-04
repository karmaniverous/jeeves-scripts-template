/**
 * @module x/lib/poll-handles
 *
 * Which X account handles a poll script polls this run.
 *
 * The X accounts an instance ingests are listed once, in `X_ACCOUNTS`
 * (handle → output directory, `src/lib/constants/integrations.ts`). With
 * no handle argument a poller polls every handle there, the same set
 * `drain-queues` drains, so the `jobs/x.json` entries work as registered.
 * A handle argument narrows the run to that one handle. Either way a
 * handle is polled only when it is in `X_ACCOUNTS` (otherwise its items
 * would never be drained) and its OAuth file exists; every other handle
 * is reported as skipped with the reason.
 */

/** A handle that will not be polled, and why. */
export interface SkippedHandle {
  handle: string;
  reason: string;
}

/** Result of {@link resolvePollHandles}. */
export interface PollHandles {
  /** Handles to poll, in `X_ACCOUNTS` order (or just the argument). */
  handles: string[];
  /** Handles left out, with the reason. */
  skipped: SkippedHandle[];
  /** Set when there is nothing to poll at all (no handles configured). */
  notConfigured?: string;
}

/**
 * Resolve the handles to poll.
 *
 * @param argHandle - First CLI argument, if any.
 * @param accounts - `X_ACCOUNTS` (handle → output directory).
 * @param hasOAuth - Whether a handle's OAuth file exists.
 */
export function resolvePollHandles(
  argHandle: string | undefined,
  accounts: Readonly<Record<string, string>>,
  hasOAuth: (handle: string) => boolean,
): PollHandles {
  const candidates = argHandle ? [argHandle] : Object.keys(accounts);
  if (candidates.length === 0)
    return {
      handles: [],
      skipped: [],
      notConfigured:
        'no X accounts configured in X_ACCOUNTS (src/lib/constants/integrations.ts)',
    };
  const handles: string[] = [];
  const skipped: SkippedHandle[] = [];
  for (const handle of candidates) {
    if (!Object.prototype.hasOwnProperty.call(accounts, handle))
      skipped.push({ handle, reason: 'not configured in X_ACCOUNTS' });
    else if (!hasOAuth(handle))
      skipped.push({ handle, reason: 'X OAuth2 credentials not configured' });
    else handles.push(handle);
  }
  return { handles, skipped };
}

/**
 * Log the skip lines for `resolved` and return the handles to poll.
 *
 * @param resolved - Output of {@link resolvePollHandles}.
 */
export function logPollHandles(resolved: PollHandles): string[] {
  if (resolved.notConfigured) console.log(`[skip] ${resolved.notConfigured}`);
  for (const s of resolved.skipped)
    console.log(`[skip] @${s.handle}: ${s.reason}`);
  return resolved.handles;
}
