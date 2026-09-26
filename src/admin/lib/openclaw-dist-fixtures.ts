/**
 * @module openclaw-dist-fixtures
 *
 * Verbatim snippets from the OpenClaw v2026.9.6 global install
 * (`openclaw/dist/*.mjs`), used as test fixtures for the post-install
 * patch helpers. Do not reformat the string contents: whitespace and
 * punctuation are exactly what the bundler emitted.
 */

/** `sessions-spawn-tool-*.mjs`: sub-agent launch request (spawn flag). */
export const SPAWN_LAUNCH_REQUEST = [
  '//#region src/agents/subagents/spawn/subagent-spawn-launch-request.ts',
  'function buildSubagentLaunchRequest(params) {',
  '\tconst bootstrapContextMode = params.lightContext ? "lightweight" : void 0;',
  '\tconst collect = params.completionMode === "collector";',
  '\tconst spawnedMetadata = normalizeSpawnedRunMetadata({',
  '\t\tspawnedBy: params.spawnedByKey,',
  '\t\t...params.toolSpawnMetadata,',
  '\t\tworkspaceDir: params.spawnedWorkspaceDir',
  '\t});',
  '\tconst { spawnedBy: _spawnedBy, workspaceDir: _workspaceDir, ...publicSpawnedMetadata } = spawnedMetadata;',
  '\tconst childLaunch = {',
  '\t\trequest: {',
  '\t\t\tmessage: params.message,',
  '\t\t\tsessionKey: params.childSessionKey,',
  '\t\t\t...collect ? {} : {',
  '\t\t\t\tchannel: params.childSessionOrigin?.channel,',
  '\t\t\t\tto: params.childSessionOrigin?.to ?? void 0,',
  '\t\t\t\taccountId: params.childSessionOrigin?.accountId ?? void 0,',
  '\t\t\t\tthreadId: params.childSessionOrigin?.threadId != null ? stringifyRouteThreadId(params.childSessionOrigin.threadId) : void 0',
  '\t\t\t},',
  '\t\t\tidempotencyKey: params.childIdem,',
  '\t\t\tdeliver: params.completionMode === "thread-direct",',
  '\t\t\tlane: AGENT_LANE_SUBAGENT,',
  '\t\t\tdisableMessageTool: true,',
  '\t\t\tswarmCollector: collect,',
  '\t\t\tswarmOutputSchema: params.outputSchema,',
  '\t\t\tcleanupBundleMcpOnRunEnd: params.spawnMode !== "session",',
  '\t\t\textraSystemPrompt: params.childSystemPrompt,',
  '\t\t\tthinking: params.thinkingOverride,',
  '\t\t\ttimeout: params.runTimeoutSeconds,',
  '\t\t\t...bootstrapContextMode ? {',
  '\t\t\t\tbootstrapContextMode,',
  '\t\t\t\tbootstrapContextRunKind: "default"',
  '\t\t\t} : {},',
  '\t\t\t...publicSpawnedMetadata',
  '\t\t},',
].join('\n');

/** `acp-spawn-*.mjs`: same lane, no disableMessageTool (must not match). */
export const ACP_SPAWN_GATEWAY = [
  '\tconst response = await callSubagentGateway(withSubagentGatewayExecutionIdentity({',
  '\t\tmethod: "agent",',
  '\t\tassertDispatchCurrent: params.assertDispatchCurrent,',
  '\t\tparams: {',
  '\t\t\tmessage: params.task,',
  '\t\t\tsessionKey: params.sessionKey,',
  '\t\t\tchannel: params.deliveryPlan.channel,',
  '\t\t\tto: params.deliveryPlan.to,',
  '\t\t\taccountId: params.deliveryPlan.accountId,',
  '\t\t\tthreadId: params.deliveryPlan.threadId,',
  '\t\t\tidempotencyKey: params.childIdem,',
  '\t\t\tdeliver: params.deliveryPlan.useInlineDelivery,',
  '\t\t\tlane: AGENT_LANE_SUBAGENT,',
  '\t\t\tacpTurnSource: "manual_spawn",',
  '\t\t\ttimeout: params.runTimeoutSeconds,',
  '\t\t\tlabel: params.label || void 0,',
  '\t\t\t...params.attachments ? { attachments: params.attachments } : {}',
  '\t\t},',
  '\t\ttimeoutMs: 1e4',
  '\t}, {',
].join('\n');

/** `recall-run-*.mjs`: unrelated `disableMessageTool: true` (must not match). */
export const RECALL_RUN = [
  '\t\t\tmodel: modelRef.model,',
  '\t\t\tlane: ACTIVE_MEMORY_RECALL_LANE,',
  '\t\t\ttimeoutMs: embeddedTimeoutMs,',
  '\t\t\trunId: subagentSessionId,',
  '\t\t\ttrigger: "manual",',
  '\t\t\tconversationRecall: params.conversationRecall,',
  '\t\t\ttoolsAllow: [...params.config.toolsAllow],',
  '\t\t\tdisableMessageTool: true,',
  '\t\t\tallowGatewaySubagentBinding: true,',
  '\t\t\tbootstrapContextMode: "lightweight",',
  '\t\t\tverboseLevel: "off",',
  '\t\t\tthinkLevel: params.config.thinking,',
  '\t\t\tfastMode: params.fastMode,',
].join('\n');

/** `agent-tools.policy-*.mjs`: sub-agent deny lists. */
export const AGENT_TOOLS_POLICY = [
  '//#region src/agents/agent-tools.policy.ts',
  '/**',
  '* Resolves sandbox tool policies for agents, providers, sub-agents, and group',
  '* sessions. Keeps runtime tool filtering tied to canonical config, session',
  '* provenance, and inherited sub-agent capabilities.',
  '*/',
  '/**',
  '* Tools always denied for sub-agents regardless of depth.',
  '* These are system-level or interactive tools that sub-agents should never use.',
  '*/',
  'const SUBAGENT_TOOL_DENY_ALWAYS = [',
  '\t"gateway",',
  '\t"agents_list",',
  '\t"openclaw",',
  '\t"session_status",',
  '\t"progress_card",',
  '\tAUTOMATIONS_TOOL_NAME,',
  '\t"message",',
  '\t"sessions_send",',
  '\t"conversations_list",',
  '\t"conversations_send",',
  '\t"conversations_turn"',
  '];',
  '/** Tools that only make sense for orchestrator sub-agents that can spawn children. */',
  'const SUBAGENT_TOOL_DENY_LEAF = [',
  '\t"subagents",',
  '\t"sessions_list",',
  '\t"sessions_history",',
  '\t"sessions_search",',
  '\t"sessions_spawn"',
  '];',
  'function resolveSubagentDenyListForRole(role) {',
  '\tif (role === "leaf") return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];',
  '\treturn [...SUBAGENT_TOOL_DENY_ALWAYS];',
  '}',
].join('\n');

/** `tool-policy-*.mjs`: upstream-fixed `hasRestrictiveAllowPolicy`. */
export const TOOL_POLICY_HAS_RESTRICTIVE = [
  '/** Returns true when an allow policy is narrower than all/default plugin tools. */',
  'function hasRestrictiveAllowPolicy(policy) {',
  '\tif (!Array.isArray(policy?.allow)) return false;',
  '\tconst restrictions = readToolAllowlistIntersection(policy.allow);',
  '\tif (restrictions) return restrictions.some((allow) => allow.length === 0 || hasRestrictiveAllowPolicy({ allow }));',
  '\tconst normalizedAllow = policy.allow.map((entry) => normalizeToolPolicyName(entry));',
  '\tif (normalizedAllow.includes("*")) return false;',
  '\treturn normalizedAllow.some((entry) => Boolean(entry) && entry !== "__openclaw_default_plugin_tools__");',
  '}',
].join('\n');
