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
import type { AgentConfig, EngineDriver, RunOptions, TaskInput, TaskResult } from '@agent-runner/core';
import {
  asContentBlocks,
  buildSystemPromptText,
  builtinToolsMcpServer,
  composeTaskPrompt,
  createArtifactCollector,
  emitClaudeBlocks,
  isAbortError,
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

  async run(config: AgentConfig, task: TaskInput, options?: RunOptions): Promise<TaskResult> {
    const cwd = config.cwd ?? process.cwd();
    const systemText = buildSystemPromptText(config);
    const apiKey = resolveApiKey(config);
    const emit = options?.onEvent;
    const signal = options?.signal;
    const env: Record<string, string> = {};
    if (config.model?.baseUrl) {
      env.ANTHROPIC_BASE_URL = config.model.baseUrl;
      if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }

    if (signal?.aborted) {
      return { ok: false, text: '', artifacts: [], error: 'claude_sdk: aborted', abortReason: 'aborted' };
    }

    const artifacts = createArtifactCollector(cwd, 'claude_sdk', options?.artifacts);
    const finishArtifacts = () => artifacts?.finish() ?? [];
    const noteTool = (name: string, input: unknown) => artifacts?.noteToolCall(name, input);

    logDriver('claude_sdk', `cwd=${cwd} model=${resolveModelId(config, '(sdk default)')} autoApprove=${String(config.autoApprove ?? false)}`);

    const messages: unknown[] = [];
    let text = '';
    let isError = false;
    let errorText = '';

    let abortController: AbortController | undefined;
    if (signal) {
      abortController = new AbortController();
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController?.abort(), { once: true });
    }

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
          // Token-level deltas for `onEvent` consumers; complete messages still arrive.
          ...(emit ? { includePartialMessages: true } : {}),
          ...(abortController ? { abortController } : {}),
          ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
        },
      });

      for await (const message of q) {
        // Deltas only; the complete assistant message arrives separately below.
        if (message.type === 'stream_event') {
          const raw = message.event as {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
          };
          if (raw.type === 'content_block_delta' && raw.delta) {
            if (raw.delta.type === 'text_delta' && raw.delta.text) emit?.({ type: 'text_delta', text: raw.delta.text });
            else if (raw.delta.type === 'thinking_delta' && raw.delta.thinking) {
              emit?.({ type: 'thinking_delta', text: raw.delta.thinking });
            }
          }
          continue;
        }

        messages.push(message);
        if (options?.includeRawMessages) emit?.({ type: 'message', message });

        if (message.type === 'assistant') {
          const blocks = asContentBlocks((message as unknown as { message?: { content?: unknown } }).message?.content);
          text += emitClaudeBlocks(blocks, emit, noteTool);
        }
        if (message.type === 'user') {
          const blocks = asContentBlocks((message as unknown as { message?: { content?: unknown } }).message?.content);
          emitClaudeBlocks(blocks, emit, undefined);
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
      if (isAbortError(err, signal)) {
        emit?.({ type: 'error', error: 'claude_sdk: aborted' });
        return { ok: false, text, messages, artifacts: finishArtifacts(), error: 'claude_sdk: aborted', abortReason: 'aborted' };
      }
      const error = `claude_sdk failed: ${(err as Error).message}`;
      emit?.({ type: 'error', error });
      return { ok: false, text, messages, artifacts: finishArtifacts(), error };
    }

    if (signal?.aborted) {
      return { ok: false, text, messages, artifacts: finishArtifacts(), error: 'claude_sdk: aborted', abortReason: 'aborted' };
    }
    if (isError) {
      const error = `claude_sdk result error: ${errorText}`;
      emit?.({ type: 'error', error });
      return { ok: false, text, messages, artifacts: finishArtifacts(), error };
    }
    return { ok: true, text: text.trim(), messages, artifacts: finishArtifacts() };
  },
};
