/**
 * @module channel-names
 *
 * Channel result type, the Slack channel-id → name registry, and helpers
 * that build Slack channel results from transcript text.
 */

/** Channel key result from transcript inspection. */
export interface ChannelResult {
  key: string;
  name: string;
}

/**
 * Known Slack channel ID → friendly name mapping.
 * Populated lazily by the collector as channels are discovered.
 */
const CHANNEL_NAMES: Record<string, string> = {};

/**
 * Register a channel-id → name mapping discovered from transcripts.
 */
export function registerChannelName(id: string, name: string): void {
  CHANNEL_NAMES[id] = name;
}

/**
 * Best-effort channel name lookup. Falls back to the raw key.
 */
export function getChannelName(key: string): string {
  return CHANNEL_NAMES[key] ?? key;
}

/**
 * Extract Slack channel from common patterns in text.
 */
export function extractSlackChannel(text: string): ChannelResult | null {
  // "Slack message in #channel-name"
  const nameMatch = text.match(/Slack message (?:edited )?in (#[a-z0-9_-]+)/);
  if (nameMatch) {
    return slackChannelResult(nameMatch[1]);
  }

  // "channel: C0XXXXXXXXX"
  const idMatch = text.match(/channel:\s*(C[A-Z0-9]{8,})/);
  if (idMatch) {
    const id = idMatch[1];
    const name = CHANNEL_NAMES[id] as string | undefined;
    return {
      key: 'slack:channel:' + id,
      name: name ?? '#' + id,
    };
  }

  return null;
}

/**
 * Build a channel result from a Slack channel name or label.
 */
export function slackChannelResult(label: string): ChannelResult {
  const clean = label.startsWith('#') ? label : '#' + label;
  const key = 'slack:channel:' + clean;
  return { key, name: clean };
}

/**
 * Slugify a person's name for use as a DM channel key.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
