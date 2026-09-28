/**
 * @module channel-mapper
 *
 * Maps OpenClaw session transcripts to channel keys.
 *
 * Inspects the first few lines of a JSONL session file to determine
 * the originating channel (Slack channel, DM, heartbeat, subagent, etc.).
 * Used by collect-token-metrics to attribute token usage to channels.
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
 * Extract text chunks from JSONL session lines. When `roleFilter` is set,
 * only messages with that role are included.
 */
function extractChunks(lines: string[], roleFilter?: string): string[] {
  const chunks: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Handle custom_message lines (e.g. openclaw.runtime-context)
      if (parsed.type === 'custom_message') {
        const content = parsed.content;
        if (typeof content === 'string' && content.trim()) {
          chunks.push(content);
        }
        continue;
      }

      if (parsed.type !== 'message') continue;

      const msg = parsed.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      if (roleFilter && msg.role !== roleFilter) continue;

      const content = msg.content;
      if (typeof content === 'string') {
        if (content.trim()) chunks.push(content);
      } else if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            const p = part as Record<string, unknown>;
            return typeof p.text === 'string' ? p.text : '';
          })
          .join('\n')
          .trim();
        if (text) chunks.push(text);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return chunks;
}

/** Extract user-only text chunks from session JSONL lines. */
function extractUserTexts(lines: string[]): string[] {
  return extractChunks(lines, 'user');
}

/** Extract all text from session JSONL lines, joined into a single string. */
function extractText(lines: string[]): string {
  return extractChunks(lines).join('\n');
}

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

/**
 * Detect granular subagent label from transcript text.
 *
 * Cascade (first match wins):
 * 1. taskName= or taskName: patterns
 * 2. label= or label: with quoted string
 * 3. Slack channel ID refs <#CXXX|name>
 * 4. Repo references {drive}:\repos\{org}\{repo} or /repos/{org}/{repo}
 * 5. First H1 header (skip generic dispatcher prompts)
 * 6. Spec references {name}/spec.md
 */
function detectSubagentLabel(text: string): ChannelResult | null {
  // 1. Task name: taskName= or taskName: (quoted or unquoted)
  const taskNameMatch =
    /taskName[=:]\s*(?:["']([^"']+)["']|([^\s,;"'\]}{)]+))/i.exec(text);
  if (taskNameMatch) {
    const name = (taskNameMatch[1] || taskNameMatch[2]).slice(0, 60);
    return {
      key: `subagent:task:${name}`,
      name: `Subagent: task ${name}`,
    };
  }

  // 2. Session label: label= or label: with quoted value
  const labelMatch = /\blabel[=:]\s*["']([^"']+)["']/i.exec(text);
  if (labelMatch) {
    const value = labelMatch[1].slice(0, 60);
    return {
      key: `subagent:label:${value}`,
      name: `Subagent: label ${value}`,
    };
  }

  // 3. Slack channel ID refs: <#C0XXXXXXXX|display-name>
  const slackRefMatch = /<#(C[A-Z0-9]{8,})\|?([^>]*)>/.exec(text);
  if (slackRefMatch) {
    const channelId = slackRefMatch[1];
    const displayName = slackRefMatch[2].trim();
    if (displayName) {
      const cleanName = displayName.startsWith('#')
        ? displayName
        : `#${displayName}`;
      return {
        key: `subagent:for:${cleanName}`,
        name: `Subagent: for ${cleanName}`,
      };
    }
    return {
      key: `subagent:for:${channelId}`,
      name: `Subagent: for ${channelId}`,
    };
  }

  // 4. Repo references: {drive}:\repos\{org}\{repo} or /repos/{org}/{repo}
  const repoMatch =
    /(?:[a-zA-Z]:)?[/\\]repos[/\\]([a-zA-Z0-9_.-]+)[/\\]([a-zA-Z0-9_.-]+)/.exec(
      text,
    );
  if (repoMatch) {
    const org = repoMatch[1];
    const repo = repoMatch[2];
    return {
      key: `subagent:repo:${org}/${repo}`,
      name: `Subagent: repo ${org}/${repo}`,
    };
  }

  // 5. First H1 header (skip generic dispatcher and boilerplate headers)
  const h1Match = /^# (.+)$/m.exec(text);
  if (h1Match) {
    const h1Content = h1Match[1].trim();
    const lowerH1 = h1Content.toLowerCase();
    const isGeneric =
      lowerH1.startsWith('is in the system prompt') ||
      lowerH1.includes('system prompt') ||
      [
        'instructions',
        'context',
        'task description',
        'user query',
        'response',
        'summary',
      ].includes(lowerH1);
    if (!isGeneric) {
      const truncated = h1Content.slice(0, 60);
      return {
        key: `subagent:task:${truncated}`,
        name: `Subagent: task ${truncated}`,
      };
    }
  }

  // 6. Spec references: {name}/spec.md or {name}\spec.md
  const specMatch = /([a-z0-9-]+)[/\\]spec\.md/.exec(text);
  if (specMatch) {
    const specName = specMatch[1];
    return {
      key: `subagent:spec:${specName}`,
      name: `Subagent: spec ${specName}`,
    };
  }

  return null;
}

/**
 * Detect meta synthesis phase from H1 headers or session labels.
 *
 * Recognizes:
 * - H1 headers: `# jeeves-meta · ARCHITECT · <path>` (and BUILDER, CRITIC)
 * - Session labels: `meta-architect`, `meta-builder`, `meta-critic`
 *
 * Returns null if no phase is detected.
 */
export function detectMetaPhase(text: string): ChannelResult | null {
  // H1 header pattern: # jeeves-meta · ARCHITECT|BUILDER|CRITIC · <path>
  const h1Match = /# jeeves-meta\s*[·•]\s*(ARCHITECT|BUILDER|CRITIC)/i.exec(
    text,
  );
  if (h1Match) {
    const phase = h1Match[1].toLowerCase();
    return {
      key: `meta-${phase}`,
      name: `Meta ${phase.charAt(0).toUpperCase() + phase.slice(1)}`,
    };
  }

  // Session label pattern: meta-architect, meta-builder, meta-critic
  const labelMatch = /\bmeta-(architect|builder|critic)\b/i.exec(text);
  if (labelMatch) {
    const phase = labelMatch[1].toLowerCase();
    return {
      key: `meta-${phase}`,
      name: `Meta ${phase.charAt(0).toUpperCase() + phase.slice(1)}`,
    };
  }

  return null;
}

/**
 * Extract Slack channel from common patterns in text.
 */
function extractSlackChannel(text: string): ChannelResult | null {
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
function slackChannelResult(label: string): ChannelResult {
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
