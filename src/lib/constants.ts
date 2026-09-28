/**
 * @module constants
 *
 * Centralized constants — paths, config values, and magic strings
 * used across multiple scripts. This barrel re-exports the cohesive
 * modules under `src/lib/constants/`; always import from here.
 *
 * THESE ARE THE FIRST FILES TO EDIT on a new instance. Update each
 * section with your instance-specific values:
 *
 * - `constants/instance.ts` — identity, roots, pipeline config, silo
 *   routing, credentials, gateway, spawn worker, Qdrant
 * - `constants/integrations.ts` — GitHub, email, Google auth, meetings,
 *   Slack, Notion, X / Twitter
 * - `constants/trackers.ts` — Jira, Linear, entity pipeline
 * - `constants/token-metrics.ts` — token metrics, Claude Code, session
 *   refresh
 *
 * Sections marked [REQUIRED] must be filled in before the associated
 * pipeline domain will work. Sections marked [OPTIONAL] have sensible
 * defaults or are only needed for specific integrations.
 */

export * from './constants/instance.js';
export * from './constants/integrations.js';
export * from './constants/token-metrics.js';
export * from './constants/trackers.js';
