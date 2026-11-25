import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  loadSkills,
  type AgentConfig,
  type AgentEvent,
  type Artifact,
  type ArtifactOptions,
  type ContextMessage,
  type McpServerConfig,
  type TaskInput,
} from '@agent-runner/core';

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

// ---------------------------------------------------------------------------
// Artifact collection
// ---------------------------------------------------------------------------

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', 'coverage', '.nyc_output', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'target', 'vendor',
  '.idea', '.vscode', '.gradle', '.parcel-cache',
]);

const MAX_ARTIFACTS = 200;

interface FileEntry {
  size: number;
  mtimeMs: number;
}

/** Case-normalized absolute path key (Windows paths are case-insensitive). */
function absKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Recursively snapshot file size+mtime under `root`, skipping noise dirs. */
export function snapshotWorkspace(root: string, maxFiles: number, ignore: Set<string>): Map<string, FileEntry> {
  const snapshot = new Map<string, FileEntry>();
  let truncated = false;

  const walk = (dir: string): void => {
    if (snapshot.size >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.size >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || ignore.has(entry.name) || ignore.has(rel)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ignore.has(entry.name) || ignore.has(rel)) continue;
      try {
        const st = statSync(full);
        snapshot.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* file vanished mid-scan */
      }
    }
  };

  walk(root);
  if (truncated) logDriver('artifacts', `workspace scan capped at ${maxFiles} files; later changes may be missed`);
  return snapshot;
}

/** Tool names (last `__` segment) that write a single file, and the input keys carrying its path. */
const WRITE_TOOL_PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'filename', 'target_file', 'file'];
const WRITE_TOOLS = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'multiedit', 'multi_edit',
  'notebookedit', 'notebook_edit', 'apply_patch', 'str_replace_editor',
]);

function extractWrittenPath(toolName: string, input: unknown): string | null {
  const base = (toolName.split('__').pop() ?? toolName).toLowerCase();
  if (!WRITE_TOOLS.has(base) || !input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of WRITE_TOOL_PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export interface ArtifactCollector {
  /** Feed every tool invocation so writes outside the diffed workspace are still captured. */
  noteToolCall(name: string, input: unknown): void;
  /** Compute the final artifact list. Call once, after the engine has finished. */
  finish(): Artifact[];
}

function readTextFile(abs: string): string | null {
  try {
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function safeSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function fileArtifact(
  cwd: string,
  abs: string,
  change: Artifact['change'],
  bytes: number,
  inlineBytes: number,
  tool?: string,
): Artifact {
  const rel = path.relative(cwd, abs);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const artifact: Artifact = {
    kind: 'file',
    path: inside ? rel.split(path.sep).join('/') : abs,
    bytes,
    source: tool ? 'tool' : 'workspace',
  };
  if (change) artifact.change = change;
  if (tool) artifact.tool = tool;
  if (change !== 'deleted' && inlineBytes > 0 && bytes <= inlineBytes) {
    const content = readTextFile(abs);
    if (content !== null) {
      artifact.content = content;
      artifact.mimeType = 'text/plain';
    }
  }
  return artifact;
}

/**
 * Build an artifact collector for one run. Uses a before/after workspace snapshot
 * (universal across engines) plus tool-reported write paths (catches writes that
 * the snapshot misses: ignored dirs, outside cwd, unchanged mtime).
 */
export function createArtifactCollector(
  cwd: string,
  engine: string,
  option: boolean | ArtifactOptions | undefined,
): ArtifactCollector | null {
  if (option === false) return null;
  const opts: ArtifactOptions = typeof option === 'object' && option !== null ? option : {};
  const inlineBytes = opts.inlineContentBytes ?? 16 * 1024;
  const maxFiles = opts.maxFiles ?? 5000;
  const ignore = new Set(opts.ignore ?? []);
  const diffEnabled = opts.workspaceDiff !== false;
  const before = diffEnabled ? snapshotWorkspace(cwd, maxFiles, ignore) : new Map<string, FileEntry>();
  const touched = new Map<string, { abs: string; tool: string }>();

  return {
    noteToolCall(name, input) {
      const target = extractWrittenPath(name, input);
      if (!target) return;
      const abs = path.resolve(cwd, target);
      const key = absKey(abs);
      if (!touched.has(key)) touched.set(key, { abs, tool: name.split('__').pop() ?? name });
    },

    finish() {
      const after = diffEnabled ? snapshotWorkspace(cwd, maxFiles, ignore) : new Map<string, FileEntry>();
      const artifacts: Artifact[] = [];
      const seen = new Set<string>();

      for (const [rel, entry] of after) {
        const abs = path.join(cwd, rel);
        const key = absKey(abs);
        seen.add(key);
        const prev = before.get(rel);
        if (prev && prev.size === entry.size && prev.mtimeMs === entry.mtimeMs) continue;
        artifacts.push(fileArtifact(cwd, abs, prev ? 'modified' : 'created', entry.size, inlineBytes, touched.get(key)?.tool));
      }

      for (const [rel, entry] of before) {
        if (after.has(rel)) continue;
        const abs = path.join(cwd, rel);
        const key = absKey(abs);
        seen.add(key);
        artifacts.push(fileArtifact(cwd, abs, 'deleted', entry.size, 0, touched.get(key)?.tool));
      }

      for (const [key, target] of touched) {
        if (seen.has(key) || !existsSync(target.abs)) continue;
        artifacts.push(fileArtifact(cwd, target.abs, undefined, safeSize(target.abs), inlineBytes, target.tool));
      }

      logDriver(engine, `artifacts: ${artifacts.length}`);
      return artifacts.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '')).slice(0, MAX_ARTIFACTS);
    },
  };
}

// ---------------------------------------------------------------------------
// Claude-style content blocks (shared by claude_sdk and claude_cli)
// ---------------------------------------------------------------------------

export interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export function asContentBlocks(content: unknown): ClaudeContentBlock[] {
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

/** Flatten a tool result payload (string, content-block array, or `{ content }`). */
export function toolResultText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    return payload
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as { type?: string; text?: string };
          if (p.type === 'text' && typeof p.text === 'string') return p.text;
          if (p.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (payload && typeof payload === 'object') {
    const p = payload as { content?: unknown };
    if (p.content !== undefined) return toolResultText(p.content);
  }
  return '';
}

/**
 * Map one assistant/user content-block array to normalized events and return
 * its plain text. Used by both Claude engines (SDK messages and CLI stream-json).
 */
export function emitClaudeBlocks(
  blocks: ClaudeContentBlock[],
  emit: ((event: AgentEvent) => void) | undefined,
  noteToolCall: ((name: string, input: unknown) => void) | undefined,
): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      noteToolCall?.(block.name, block.input);
      emit?.({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
    } else if (block.type === 'tool_result') {
      emit?.({
        type: 'tool_result',
        id: block.tool_use_id,
        content: toolResultText(block.content),
        isError: block.is_error === true,
      });
    }
  }
  return text;
}

/** True for abort-shaped errors thrown by engines / fetch when a signal fires. */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'AbortError' || /abort|cancel/i.test(message);
}
