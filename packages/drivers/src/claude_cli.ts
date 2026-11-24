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
import type { AgentConfig, EngineDriver, TaskInput, TaskResult } from '@agent-runner/core';
import {
  buildSystemPromptText,
  builtinToolsMcpServer,
  composeTaskPrompt,
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

  async run(config: AgentConfig, task: TaskInput): Promise<TaskResult> {
    const isWin = process.platform === 'win32';
    const cwd = config.cwd ?? process.cwd();
    const systemText = buildSystemPromptText(config);
    const apiKey = resolveApiKey(config);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.model?.baseUrl) env.ANTHROPIC_BASE_URL = config.model.baseUrl;
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

    let tmpDir: string | null = null;
    const args: string[] = ['-p', '--output-format', 'json'];

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

    try {
      const result = await new Promise<TaskResult>((resolve) => {
        // Windows: .cmd shims need a shell; build one pre-quoted command string
        // (the task prompt goes through stdin, so it never needs quoting).
        const child = isWin
          ? spawn(['claude', ...args.map(quoteForCmd)].join(' '), { cwd, env, shell: true, windowsHide: true })
          : spawn('claude', args, { cwd, env, windowsHide: true });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

        child.on('error', (err) => {
          resolve({ ok: false, text: '', error: `failed to spawn claude CLI: ${err.message}` });
        });

        child.on('close', (code) => {
          if (code !== 0 && !stdout.trim()) {
            resolve({ ok: false, text: '', error: `claude CLI exited with ${code}: ${stderr.trim() || '(no stderr)'}` });
            return;
          }
          const parsed = parseCliOutput(stdout);
          if (!parsed) {
            resolve({
              ok: false,
              text: stdout.trim(),
              error: `unparseable claude CLI output: ${stderr.trim() || stdout.slice(0, 300)}`,
            });
            return;
          }
          if (parsed.is_error) {
            resolve({ ok: false, text: parsed.result ?? '', error: `claude CLI reported error (${parsed.subtype ?? 'unknown'})` });
            return;
          }
          resolve({ ok: true, text: (parsed.result ?? '').trim() });
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
