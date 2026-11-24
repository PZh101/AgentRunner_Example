import { createRequire } from 'node:module';
import path from 'node:path';
import { loadSkills, type AgentConfig, type ContextMessage, type McpServerConfig, type TaskInput } from '@agent-runner/core';

export type { McpServerConfig } from '@agent-runner/core';

const require = createRequire(import.meta.url);

/** Absolute path to the mcp-bridge stdio server entry (dist/server.js). */
export function mcpBridgePath(): string {
  return require.resolve('@agent-runner/mcp-bridge');
}

/**
 * Compose the effective system prompt from config.systemPrompt + skill bodies.
 * Shared by all drivers so skill injection behaves identically across engines.
 */
export function buildSystemPromptText(config: AgentConfig): string {
  const parts: string[] = [];
  if (config.systemPrompt?.trim()) parts.push(config.systemPrompt.trim());
  for (const skill of loadSkills(config.skills ?? [])) parts.push(skill.promptFragment);
  return parts.join('\n\n');
}

/** Render pre-retrieved knowledge snippets as prompt text ('' when none). */
export function formatContextBlock(context?: string[]): string {
  const snippets = (context ?? []).map((s) => s.trim()).filter(Boolean);
  if (snippets.length === 0) return '';
  const body = snippets.map((s, i) => `[${i + 1}] ${s}`).join('\n\n');
  return `Relevant background material (for reference only):\n\n${body}`;
}

/** Flatten prior turns into prompt text, for engines without stateless history replay. */
export function formatHistoryBlock(history?: ContextMessage[]): string {
  const turns = (history ?? []).filter((m) => m.content.trim());
  if (turns.length === 0) return '';
  const body = turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`).join('\n');
  return `Prior conversation:\n${body}`;
}

/**
 * Compose the effective prompt for engines that take a single string.
 * Pass `includeHistory: false` when the driver replays history natively.
 */
export function composeTaskPrompt(task: TaskInput, opts: { includeHistory?: boolean } = {}): string {
  const parts: string[] = [];
  const contextBlock = formatContextBlock(task.context);
  if (contextBlock) parts.push(contextBlock);
  if (opts.includeHistory !== false) {
    const historyBlock = formatHistoryBlock(task.history);
    if (historyBlock) parts.push(historyBlock);
  }
  parts.push(task.prompt);
  return parts.length === 1 ? task.prompt : parts.join('\n\n---\n\n');
}

/** Stdio MCP server entry for the builtin-tools bridge, or null if no tools configured. */
export function builtinToolsMcpServer(config: AgentConfig): McpServerConfig | null {
  if (!config.tools?.length) return null;
  return {
    name: 'builtin-tools',
    command: process.execPath,
    args: [mcpBridgePath()],
    env: { AGENT_RUNNER_CWD: config.cwd ?? process.cwd() },
  };
}

/** All stdout-free logging goes to stderr (stdout is reserved for results). */
export function logDriver(driver: string, msg: string): void {
  console.error(`[${driver}] ${msg}`);
}

/** Resolve model id: config.model?.modelId, else a sane default per provider. */
export function resolveModelId(config: AgentConfig, fallback: string): string {
  return config.model?.modelId ?? fallback;
}

/** Read API key from the configured env var name, if any. */
export function resolveApiKey(config: AgentConfig): string | undefined {
  const envName = config.model?.apiKeyEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return undefined;
}

/** Join path safely for messages. */
export function displayCwd(config: AgentConfig): string {
  return path.resolve(config.cwd ?? process.cwd());
}
