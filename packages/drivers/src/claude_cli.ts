/**
 * Engine driver: claude_cli
 *
 * Runs tasks by spawning the locally installed `claude` CLI in print mode.
 * - systemPrompt + skills -> --append-system-prompt
 * - builtin tools         -> mcp-bridge stdio MCP server via --mcp-config
 * - extra MCP servers     -> merged into the same --mcp-config temp file
 * - model                 -> --model <id>; baseUrl via env passed to child
 * - cwd                   -> spawn cwd
 * - autoApprove           -> --permission-mode bypassPermissions
 *
 * The task prompt is written to stdin (not argv) so arbitrary text is safe.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentConfig, EngineDriver, RunOptions, TaskInput, TaskResult } from '@agent-runner/core';
import {
  asContentBlocks,
  buildSystemPromptText,
  builtinToolsMcpServer,
  composeTaskPrompt,
  createArtifactCollector,
  emitClaudeBlocks,
  logDriver,
  resolveApiKey,
  type McpServerConfig,
} from './shared.js';

interface ClaudeCliResultJson {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
}

/** Build mcpServers JSON content for --mcp-config. */
function buildMcpConfig(config: AgentConfig): string | null {
  const bridge = builtinToolsMcpServer(config);
  const all: McpServerConfig[] = [...(bridge ? [bridge] : []), ...(config.mcpServers ?? [])];
  if (all.length === 0) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const s of all) {
    mcpServers[s.name] = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  }
  return JSON.stringify({ mcpServers });
}

/** Quote one argv token for cmd.exe (used only on Windows, where shell:true is required for .cmd shims). */
function quoteForCmd(token: string): string {
  if (/^[A-Za-z0-9_\-./:=,@+\\]+$/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

export const claudeCliDriver: EngineDriver = {
  name: 'claude_cli',
  description: 'Claude Code CLI subprocess (claude -p). Needs `claude` installed on PATH.',

  async run(config: AgentConfig, task: TaskInput, options?: RunOptions): Promise<TaskResult> {
    const isWin = process.platform === 'win32';
    const cwd = config.cwd ?? process.cwd();
    const systemText = buildSystemPromptText(config);
    const apiKey = resolveApiKey(config);
    const emit = options?.onEvent;
    const signal = options?.signal;

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.model?.baseUrl) env.ANTHROPIC_BASE_URL = config.model.baseUrl;
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

    let tmpDir: string | null = null;
    // stream-json: one JSON message per line, so text/tool events can be forwarded live.
    // --verbose is required by the CLI for stream-json in print mode.
    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (emit) args.push('--include-partial-messages');

    const mcpJson = buildMcpConfig(config);
    if (mcpJson) {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-runner-'));
      const mcpConfigPath = path.join(tmpDir, 'mcp.json');
      writeFileSync(mcpConfigPath, mcpJson, 'utf8');
      args.push('--mcp-config', mcpConfigPath);
    }

    if (config.model?.modelId) args.push('--model', config.model.modelId);
    if (systemText) {
      // cmd.exe cannot carry embedded newlines in an argument; flatten on Windows.
      const systemArg = isWin ? systemText.replace(/\s+/g, ' ') : systemText;
      args.push('--append-system-prompt', systemArg);
    }
    if (config.autoApprove) args.push('--permission-mode', 'bypassPermissions');
    if (config.tools?.length) {
      args.push('--allowedTools', config.tools.map((t) => `mcp__builtin-tools__${t}`).join(','));
    }

    logDriver(
      'claude_cli',
      `cwd=${cwd} model=${config.model?.modelId ?? '(cli default)'} autoApprove=${String(config.autoApprove ?? false)}`,
    );

    if (signal?.aborted) {
      return { ok: false, text: '', artifacts: [], error: 'claude_cli: aborted', abortReason: 'aborted' };
    }

    const artifacts = createArtifactCollector(cwd, 'claude_cli', options?.artifacts);
    const finishArtifacts = () => artifacts?.finish() ?? [];

    try {
      const result = await new Promise<TaskResult>((resolve) => {
        // Windows: .cmd shims need a shell; build one pre-quoted command string
        // (the task prompt goes through stdin, so it never needs quoting).
        const child = isWin
          ? spawn(['claude', ...args.map(quoteForCmd)].join(' '), { cwd, env, shell: true, windowsHide: true })
          : spawn('claude', args, { cwd, env, windowsHide: true });

        let stdout = '';
        let stderr = '';
        let buffer = '';
        let text = '';
        let finalResult: ClaudeCliResultJson | null = null;
        const messages: unknown[] = [];
        let settled = false;

        const settle = (r: TaskResult): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        const fail = (error: string, partialText = text): TaskResult => {
          emit?.({ type: 'error', error });
          return { ok: false, text: partialText.trim(), messages, artifacts: finishArtifacts(), error };
        };

        /** Handle one stream-json line (assistant/user/result/stream_event/...). */
        const handleLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return;
          }
          const type = typeof msg.type === 'string' ? msg.type : '';

          if (type === 'stream_event') {
            const event = msg.event as
              | { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
              | undefined;
            if (event?.type === 'content_block_delta' && event.delta) {
              if (event.delta.type === 'text_delta' && event.delta.text) {
                emit?.({ type: 'text_delta', text: event.delta.text });
              } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                emit?.({ type: 'thinking_delta', text: event.delta.thinking });
              }
            }
            return; // raw stream events are noise in the transcript
          }

          messages.push(msg);
          if (options?.includeRawMessages) emit?.({ type: 'message', message: msg });

          if (type === 'assistant') {
            const content = (msg.message as { content?: unknown } | undefined)?.content;
            text += emitClaudeBlocks(asContentBlocks(content), emit, (n, i) => artifacts?.noteToolCall(n, i));
          } else if (type === 'user') {
            const content = (msg.message as { content?: unknown } | undefined)?.content;
            emitClaudeBlocks(asContentBlocks(content), emit, undefined);
          } else if (type === 'result') {
            finalResult = msg as ClaudeCliResultJson;
            if (!finalResult.is_error && typeof finalResult.result === 'string' && finalResult.result) {
              text = finalResult.result;
            }
          }
        };

        const onAbort = (): void => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          stdout += chunk;
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            handleLine(line);
          }
        });
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
        child.stdin?.on('error', () => {
          /* child may exit before the prompt is fully written */
        });

        child.on('error', (err) => {
          signal?.removeEventListener('abort', onAbort);
          settle(fail(`failed to spawn claude CLI: ${err.message}`, ''));
        });

        child.on('close', (code) => {
          signal?.removeEventListener('abort', onAbort);
          if (buffer.trim()) handleLine(buffer);

          if (signal?.aborted) {
            settle({
              ok: false,
              text: text.trim(),
              messages,
              artifacts: finishArtifacts(),
              error: 'claude_cli: aborted',
              abortReason: 'aborted',
            });
            return;
          }

          // Defensive fallback for builds that print a single JSON object instead.
          if (!finalResult) {
            const parsed = parseCliOutput(stdout);
            if (parsed) {
              finalResult = parsed;
              if (!parsed.is_error && parsed.result) text = parsed.result;
            }
          }

          if (finalResult?.is_error) {
            settle(fail(`claude CLI reported error (${finalResult.subtype ?? 'unknown'})`, finalResult.result ?? text));
            return;
          }
          if (finalResult) {
            settle({ ok: true, text: (finalResult.result ?? text).trim(), messages, artifacts: finishArtifacts() });
            return;
          }
          if (code !== 0 && !stdout.trim()) {
            settle(fail(`claude CLI exited with ${code}: ${stderr.trim() || '(no stderr)'}`, ''));
            return;
          }
          if (text.trim()) {
            settle({ ok: true, text: text.trim(), messages, artifacts: finishArtifacts() });
            return;
          }
          settle(fail(`unparseable claude CLI output: ${stderr.trim() || stdout.slice(0, 300)}`, ''));
        });

        // Prompt via stdin: `claude -p` reads the task from stdin when no positional prompt is given.
        // History/context are flattened here since the CLI gets a single string.
        child.stdin?.end(composeTaskPrompt(task));
      });
      return result;
    } finally {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
};

/** Parse `--output-format json` output (an object or, defensively, the last JSON line). */
function parseCliOutput(stdout: string): ClaudeCliResultJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeCliResultJson;
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line) as ClaudeCliResultJson;
      } catch {
        /* keep scanning */
      }
    }
    return null;
  }
}
