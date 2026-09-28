/**
 * @module channel-mapper
 *
 * Maps OpenClaw session transcripts to channel keys.
 *
 * Inspects the first few lines of a JSONL session file to determine
 * the originating channel (Slack channel, DM, heartbeat, subagent, etc.).
 * Used by collect-token-metrics to attribute token usage to channels.
 */

import {
  type ChannelResult,
  extractSlackChannel,
  slackChannelResult,
  slugify,
} from './channel-names.js';
import { detectMetaPhase, detectSubagentLabel } from './subagent-label.js';
import { extractText, extractUserTexts } from './transcript-text.js';

export {
  type ChannelResult,
  getChannelName,
  registerChannelName,
  slugify,
} from './channel-names.js';
export { detectMetaPhase } from './subagent-label.js';

/**
 * Detect channel from the first N lines of a session transcript.
 *
 * Priority:
 * 1. Explicit subagent markers → `meta-synthesis` or `subagent`
 * 2. Internal subagent completion events → `meta-synthesis` or `subagent`
 * 3. Main session thread (inter-session announces / completion events
 *    mixed with heartbeat) → `main-thread`
 * 4. HEARTBEAT marker (pure heartbeat sessions only) → `heartbeat`
 * 5. `conversation_label` in metadata JSON block → Slack channel
 * 6. "Slack DM from" pattern → `slack:dm`
 * 7. "Slack message in #channel" → `slack:channel:#name`
 * 8. "channel: CXXXX" → `slack:channel:CXXXX`
 * 9. Fallback: `unknown`
 */
export function detectChannel(lines: string[]): ChannelResult {
  const head = lines.slice(0, 120);
  const userTexts = extractUserTexts(head);
  // userTexts[0] reserved for future first-message-based detection
  const text = extractText(head);

  // Also check raw lines for non-message markers and provenance JSON.
  const rawHead = head.join('\n');

  // Subagent prompts injected directly into a session
  if (text.includes('Subagent Context') || text.includes('Subagent Task')) {
    // Detect meta synthesis phase from H1 headers or session labels
    const metaPhase = detectMetaPhase(text);
    if (metaPhase) return metaPhase;
    if (
      text.includes('jeeves-meta-synthesis') ||
      /jeeves-meta[/\\]output-/.test(text)
    ) {
      return { key: 'meta-synthesis', name: 'Meta Synthesis' };
    }
    const chanRef = extractSlackChannel(text);
    if (chanRef) return chanRef;

    // Granular subagent cascade before generic fallback
    const subLabel = detectSubagentLabel(text);
    if (subLabel) return subLabel;

    return { key: 'subagent', name: 'Subagent' };
  }

  // Meta synthesis worker output or recovery sessions.
  if (
    /jeeves-meta[/\\]output-/.test(text) ||
    text.includes('jeeves-meta-dev') ||
    text.includes('Write output JSON file with the brief and return its path')
  ) {
    const metaPhase = detectMetaPhase(text);
    if (metaPhase) return metaPhase;
    return { key: 'meta-synthesis', name: 'Meta Synthesis' };
  }

  // Detect signals used by multiple categories below.
  const hasInternalCompletions =
    text.includes('[Internal task completion event]') ||
    text.includes('source: subagent') ||
    rawHead.includes('"sourceTool":"subagent_announce"') ||
    text.includes('sourceTool=subagent_announce') ||
    (text.includes('[Inter-session message]') &&
      text.includes('sourceSession=agent:main:subagent:')) ||
    /session_key:\s*agent:main:subagent:/i.test(text);
  const hasHeartbeat = userTexts.some((t) =>
    t.includes(
      'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.',
    ),
  );

  // Main session thread: long-lived topic threads that receive a mix of
  // heartbeat prompts AND subagent completion announces / inter-session
  // messages. A pure subagent session won't have heartbeat prompts.
  if (hasInternalCompletions && hasHeartbeat) {
    return { key: 'main-thread', name: 'Main Thread' };
  }

  // Internal completion events in a session WITHOUT heartbeat prompts —
  // this is a subagent orchestrator receiving child completions.
  if (hasInternalCompletions) {
    if (/task:\s*jeeves-meta-synthesis-/i.test(text)) {
      const metaPhase = detectMetaPhase(text);
      if (metaPhase) return metaPhase;
      return { key: 'meta-synthesis', name: 'Meta Synthesis' };
    }

    // Granular subagent cascade before generic fallback
    const subLabel = detectSubagentLabel(text);
    if (subLabel) return subLabel;

    return { key: 'subagent', name: 'Subagent' };
  }

  // Pure heartbeat session (no announce traffic).
  if (hasHeartbeat) {
    return { key: 'heartbeat', name: 'Heartbeat' };
  }

  // conversation_label from parsed metadata block
  const labelMatch = text.match(/"conversation_label"\s*:\s*"([^"]+)"/);
  if (labelMatch) {
    return slackChannelResult(labelMatch[1]);
  }

  // Slack DM. The name ends at a colon or end of line: OpenClaw 2026.9
  // puts "Slack DM from <name>" on its own line, followed by injected
  // runtime-context text that must not leak into the key.
  const dmMatch = /Slack DM from ([^:\n]+?)[ \t]*(?::|$)/m.exec(text);
  if (dmMatch) {
    const person = dmMatch[1].trim();
    return { key: 'slack:dm:' + slugify(person), name: 'DM: ' + person };
  }

  // General Slack channel extraction
  const chanRef = extractSlackChannel(text);
  if (chanRef) return chanRef;

  return { key: 'unknown', name: 'Unknown' };
}
