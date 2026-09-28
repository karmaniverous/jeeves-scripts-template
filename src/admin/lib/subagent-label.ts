/**
 * @module subagent-label
 *
 * Granular labels for subagent and meta-synthesis sessions, derived from
 * transcript text.
 */

import type { ChannelResult } from './channel-names.js';

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
export function detectSubagentLabel(text: string): ChannelResult | null {
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
