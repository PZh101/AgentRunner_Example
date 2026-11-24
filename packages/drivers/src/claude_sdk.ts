/**
 * Engine driver: claude_sdk
 *
 * Runs tasks through @anthropic-ai/claude-agent-sdk's `query()` in-process.
 * - systemPrompt + skills  -> options.systemPrompt (claude_code preset + append)
 * - builtin tools          -> attached as a stdio MCP server (mcp-bridge)
 * - extra MCP servers      -> options.mcpServers (stdio)
 * - model                  -> options.model; custom baseUrl via env
 * - cwd                    -> options.cwd
 * - autoApprove            -> permissionMode 'bypassPermissions' | 'default'
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, EngineDriver, TaskInput, TaskResult } from '@agent-runner/core';
import {
  buildSystemPromptText,
  builtinToolsMcpServer,
  composeTaskPrompt,
  logDriver,
  resolveApiKey,
  resolveModelId,
  type McpServerConfig,
} from './shared.js';

/** Convert AgentConfig MCP servers to the SDK's mcpServers record. */
function toSdkMcpServers(config: AgentConfig): Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }> {
  const servers: Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }> = {};
  const bridge = builtinToolsMcpServer(config);
  const all: McpServerConfig[] = [...(bridge ? [bridge] : []), ...(config.mcpServers ?? [])];
  for (const s of all) {
    servers[s.name] = {
      type: 'stdio',
      command: s.command,
      args: s.args ?? [],
      env: { ...(s.env ?? {}) },
    };
  }
  return servers;
}

export const claudeSdkDriver: EngineDriver = {
  name: 'claude_sdk',
  description: 'Claude Agent SDK (in-process). Full support for tools (via MCP bridge), MCP, skills, permissions.',

  async run(config: AgentConfig, task: TaskInput): Promise<TaskResult> {
    const cwd = config.cwd ?? process.cwd();
    const systemText = buildSystemPromptText(config);
    const apiKey = resolveApiKey(config);
    const env: Record<string, string> = {};
    if (config.model?.baseUrl) {
      env.ANTHROPIC_BASE_URL = config.model.baseUrl;
      if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }

    logDriver('claude_sdk', `cwd=${cwd} model=${resolveModelId(config, '(sdk default)')} autoApprove=${String(config.autoApprove ?? false)}`);

    const messages: unknown[] = [];
    let text = '';
    let isError = false;
    let errorText = '';

    try {
      const q = query({
        prompt: composeTaskPrompt(task),
        options: {
          cwd,
          model: config.model?.modelId,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            ...(systemText ? { append: systemText } : {}),
          },
          mcpServers: toSdkMcpServers(config),
          allowedTools: config.tools?.map((t) => `mcp__builtin-tools__${t}`),
          permissionMode: config.autoApprove ? 'bypassPermissions' : 'default',
          settingSources: [],
          ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
        },
      });

      for await (const message of q) {
        messages.push(message);
        if (message.type === 'assistant') {
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text') text += block.text;
          }
        }
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            if (typeof message.result === 'string' && message.result) text = message.result;
          } else {
            isError = true;
            errorText = message.subtype;
          }
        }
      }
    } catch (err) {
      return { ok: false, text, messages, error: `claude_sdk failed: ${(err as Error).message}` };
    }

    if (isError) return { ok: false, text, messages, error: `claude_sdk result error: ${errorText}` };
    return { ok: true, text: text.trim(), messages };
  },
};
