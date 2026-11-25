/**
 * Engine driver: pi_agent
 *
 * Runs tasks through the pi agent loop from @mariozechner/pi-ai
 * (Mario Zechner's pi multi-provider LLM layer; the agent loop lives in
 * pi-ai, the old @mariozechner/pi-agent wrapper is deprecated).
 * - systemPrompt + skills -> agent context systemPrompt
 * - builtin tools         -> native pi AgentTools (in-process)
 * - extra MCP servers     -> connected with the MCP client, wrapped as AgentTools
 * - model                 -> pi-ai getModel(provider, modelId); baseUrl override
 * - cwd                   -> process.cwd() switched for tool execution
 * - autoApprove           -> pi executes tool calls autonomously (flag reserved)
 */
import path from 'node:path';
import { agentLoop, getModel, setApiKey, type AgentTool, type KnownProvider, type Message, type Model } from '@mariozechner/pi-ai';
import {
  resolveTools,
  type AgentConfig,
  type BuiltinTool,
  type ContextMessage,
  type EngineDriver,
  type RunOptions,
  type TaskInput,
  type TaskResult,
} from '@agent-runner/core';
import {
  buildSystemPromptText,
  composeTaskPrompt,
  createArtifactCollector,
  isAbortError,
  logDriver,
  resolveApiKey,
  resolveModelId,
  toolResultText,
} from './shared.js';
import { loadMcpTools } from './mcp-tools.js';

/** Wrap a builtin tool as a pi AgentTool. */
function toPiTool(tool: BuiltinTool, cwd: string): AgentTool<any> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // Builtin inputSchema is JSON Schema; TypeBox validation accepts it.
    parameters: tool.inputSchema as AgentTool<any>['parameters'],
    execute: async (_toolCallId, params) => {
      const outcome = await tool.handler((params ?? {}) as Record<string, unknown>, { cwd });
      return { content: [{ type: 'text', text: outcome.content }], details: outcome.ok ? {} : { isError: true } };
    },
  };
}

/** Usage metadata for replayed assistant turns (pi requires a full Message shape). */
const REPLAYED_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Replay prior turns as native pi messages so multi-turn state is preserved. */
function toPiMessages(history: ContextMessage[] | undefined, model: Model<any>): Message[] {
  const now = Date.now();
  return (history ?? []).map(
    (m): Message =>
      m.role === 'user'
        ? { role: 'user', content: m.content, timestamp: now }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: m.content }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: REPLAYED_USAGE,
            stopReason: 'stop',
            timestamp: now,
          },
  );
}

/** Build a pi-ai Model from config. Custom providers need an explicit baseUrl. */
function buildModel(config: AgentConfig): Model<any> {
  const provider = config.model?.provider ?? 'anthropic';
  const modelId = resolveModelId(config, 'claude-sonnet-4-5');
  const baseUrl = config.model?.baseUrl;

  // pi-ai's getModel returns undefined (not throws) for unknown provider/model ids.
  const known = getModel(provider as KnownProvider, modelId as never) as Model<any> | undefined;
  if (known) {
    if (baseUrl) known.baseUrl = baseUrl;
    return known;
  }
  if (!baseUrl) {
    throw new Error(
      `pi_agent: model "${provider}/${modelId}" is not in the pi registry and no model.baseUrl was configured`,
    );
  }
  logDriver('pi_agent', `model "${provider}/${modelId}" not in pi registry, using custom endpoint ${baseUrl}`);
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: provider as never,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 16_384,
  } as Model<any>;
}

/** pi-ai's built-in env var per provider (see pi-ai stream.getApiKey). */
const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  zai: 'ZAI_API_KEY',
};

export const piAgentDriver: EngineDriver = {
  name: 'pi_agent',
  description: 'pi agent loop (Mario Zechner, pi-ai): multi-provider, native tools, MCP via adapter.',

  async run(config: AgentConfig, task: TaskInput, options?: RunOptions): Promise<TaskResult> {
    const cwd = path.resolve(config.cwd ?? process.cwd());
    const previousCwd = process.cwd();
    const emit = options?.onEvent;
    const signal = options?.signal;

    const provider = config.model?.provider ?? 'anthropic';
    const apiKey = resolveApiKey(config);
    if (apiKey) setApiKey(provider, apiKey);

    // Fail fast: pi throws asynchronously inside its loop when no key exists,
    // which would otherwise crash the process outside our try/catch.
    const keyEnvName = config.model?.apiKeyEnv ?? ENV_KEY_BY_PROVIDER[provider];
    if (!apiKey && !(keyEnvName && process.env[keyEnvName])) {
      const error = `pi_agent: no API key for provider "${provider}". Set model.apiKeyEnv to the env var holding the key${
        keyEnvName ? ` (e.g. ${keyEnvName})` : ''
      }, or set ${ENV_KEY_BY_PROVIDER[provider] ?? 'the provider API key env var'}.`;
      emit?.({ type: 'error', error });
      return { ok: false, text: '', artifacts: [], error };
    }

    if (signal?.aborted) {
      return { ok: false, text: '', artifacts: [], error: 'pi_agent: aborted', abortReason: 'aborted' };
    }

    process.chdir(cwd);

    const artifacts = createArtifactCollector(cwd, 'pi_agent', options?.artifacts);
    const finishArtifacts = () => artifacts?.finish() ?? [];

    let mcpBundle: Awaited<ReturnType<typeof loadMcpTools>> | null = null;
    let text = '';
    try {
      // Builtin tools run natively; extra MCP servers are adapted through the client.
      const nativeTools = resolveTools(config.tools ?? []).map((t) => toPiTool(t, cwd));
      mcpBundle = await loadMcpTools(config.mcpServers ?? []);
      const model = buildModel(config);

      logDriver(
        'pi_agent',
        `provider=${provider} model=${model.id} cwd=${cwd} tools=${nativeTools.length + mcpBundle.tools.length}`,
      );

      const stream = agentLoop(
        { role: 'user', content: composeTaskPrompt(task, { includeHistory: false }), timestamp: Date.now() },
        {
          systemPrompt: buildSystemPromptText(config) || 'You are a helpful coding agent.',
          messages: toPiMessages(task.history, model),
          tools: [...nativeTools, ...mcpBundle.tools],
        },
        { model, ...(apiKey ? { apiKey } : {}) },
        signal,
      );

      let finalMessages: unknown[] = [];
      for await (const event of stream) {
        if (event.type === 'message_update') {
          const delta = event.assistantMessageEvent;
          if (delta.type === 'text_delta' && delta.delta) emit?.({ type: 'text_delta', text: delta.delta });
          else if (delta.type === 'thinking_delta' && delta.delta) emit?.({ type: 'thinking_delta', text: delta.delta });
        }
        if (event.type === 'message_start' || event.type === 'message_end') {
          if (options?.includeRawMessages) emit?.({ type: 'message', message: event.message });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          for (const part of event.message.content ?? []) {
            if (part.type === 'text') text += part.text;
          }
        }
        if (event.type === 'tool_execution_start') {
          artifacts?.noteToolCall(event.toolName, event.args);
          emit?.({ type: 'tool_call', id: event.toolCallId, name: event.toolName, input: event.args });
        }
        if (event.type === 'tool_execution_end') {
          emit?.({
            type: 'tool_result',
            id: event.toolCallId,
            name: event.toolName,
            content: toolResultText(event.result),
            isError: event.isError,
          });
        }
        if (event.type === 'agent_end') finalMessages = event.messages;
      }

      if (signal?.aborted) {
        return { ok: false, text: text.trim(), artifacts: finishArtifacts(), error: 'pi_agent: aborted', abortReason: 'aborted' };
      }
      return { ok: true, text: text.trim(), messages: finalMessages, artifacts: finishArtifacts() };
    } catch (err) {
      const aborted = isAbortError(err, signal);
      const error = aborted ? 'pi_agent: aborted' : `pi_agent failed: ${(err as Error).message}`;
      emit?.({ type: 'error', error });
      return {
        ok: false,
        text: text.trim(),
        artifacts: finishArtifacts(),
        error,
        ...(aborted ? { abortReason: 'aborted' as const } : {}),
      };
    } finally {
      if (mcpBundle) await mcpBundle.close();
      try {
        process.chdir(previousCwd);
      } catch {
        /* ignore */
      }
    }
  },
};
