/**
 * Core types for the Agent Runner POC.
 *
 * An `EngineDriver` is one execution engine (Claude Code SDK, Claude CLI,
 * pi, ...). Drivers live in separate files under packages/drivers/src.
 * Adding a new engine = implement EngineDriver + register it.
 */

/** Config for connecting to a model provider. API keys come from env vars only. */
export interface ModelConfig {
  /** Provider id, e.g. "anthropic" | "openai" | "openai-compatible" */
  provider?: string;
  /** Base URL of an OpenAI/Anthropic-compatible endpoint */
  baseUrl?: string;
  /** Model id, e.g. "claude-sonnet-4-5" */
  modelId?: string;
  /** Name of the env var that holds the API key (value never lives in config files) */
  apiKeyEnv?: string;
}

/** An MCP server the agent should connect to (stdio transport). */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Fully resolved, validated agent configuration. */
export interface AgentConfig {
  /** Agent name (matches agent-<name>.json) */
  name: string;
  /** Execution engine key, must exist in the driver registry */
  engine: string;
  /** System prompt prepended to skills */
  systemPrompt?: string;
  /** Names of builtin tools to enable (see builtin-tools.ts) */
  tools?: string[];
  /** Extra MCP servers to attach */
  mcpServers?: McpServerConfig[];
  /** Skill directory names under skills/ (each contains SKILL.md) */
  skills?: string[];
  /** Model endpoint configuration */
  model?: ModelConfig;
  /** Working directory the task runs in (default: repo root) */
  cwd?: string;
  /** Auto-approve tool executions without asking */
  autoApprove?: boolean;
}

/** One turn of prior conversation, engine-agnostic. */
export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Input handed to a driver. */
export interface TaskInput {
  prompt: string;
  /**
   * Prior conversation turns, oldest first. Drivers whose engine supports
   * native multi-turn replay them as messages; the rest flatten them into
   * the prompt.
   */
  history?: ContextMessage[];
  /**
   * Pre-retrieved external knowledge snippets, most relevant first.
   * Injected ahead of the task. Retrieval itself stays caller-side (or in a
   * future `search_knowledge` tool), never inside the runner.
   */
  context?: string[];
}

/** One thing an execution produced, normalized across engines. */
export interface Artifact {
  /** `file` = a workspace file change; `text` = inline output; `other` = engine-specific. */
  kind: 'file' | 'text' | 'other';
  /**
   * Path for file artifacts: POSIX-style relative to `cwd` when inside it,
   * absolute otherwise. Absent for inline text artifacts.
   */
  path?: string;
  /** How the file changed, when the engine or snapshot can tell. */
  change?: 'created' | 'modified' | 'deleted';
  /** File size in bytes (post-run), when known. */
  bytes?: number;
  /** Inline content for small text files / text artifacts (see ArtifactOptions). */
  content?: string;
  /** MIME type when known (text artifacts default to text/plain). */
  mimeType?: string;
  /** Tool that produced it, when the engine reported one. */
  tool?: string;
  /** How the artifact was discovered. */
  source: 'workspace' | 'tool' | 'engine';
  /** Free-form engine-specific extras. */
  metadata?: Record<string, unknown>;
}

/** Normalized result every driver must return. */
export interface TaskResult {
  ok: boolean;
  /** Final assistant text output */
  text: string;
  /** Full transcript (engine-specific shape), optional */
  messages?: unknown[];
  /** Everything the execution produced. Always present; `[]` when none. */
  artifacts: Artifact[];
  /** Set when the run stopped for a reason other than normal completion. */
  abortReason?: 'aborted' | 'timeout';
  /** Error message when ok === false */
  error?: string;
}

/**
 * Normalized incremental event stream, emitted by every driver through
 * `RunOptions.onEvent`. Text deltas are best-effort (engines that cannot
 * stream fall back to complete-message granularity).
 */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id?: string; name: string; input?: unknown }
  | { type: 'tool_result'; id?: string; name?: string; content: string; isError?: boolean }
  /** Raw engine message, only when `includeRawMessages` is set. */
  | { type: 'message'; message: unknown }
  | { type: 'error'; error: string }
  /** Emitted exactly once by the runner when the execution is over. */
  | { type: 'done'; result: TaskResult };

/** Artifact collection tuning. */
export interface ArtifactOptions {
  /** Diff the workspace before/after the run (default true). */
  workspaceDiff?: boolean;
  /** Inline file content up to this many bytes; 0 disables (default 16384). */
  inlineContentBytes?: number;
  /** Abort the workspace scan after this many files (default 5000). */
  maxFiles?: number;
  /** Extra directory names or cwd-relative path prefixes to skip. */
  ignore?: string[];
}

/** Per-run options accepted by every driver. */
export interface RunOptions {
  /** Receives normalized streaming events as the engine produces them. */
  onEvent?: (event: AgentEvent) => void;
  /** Cancels the run. Drivers kill subprocesses / abort engine loops. */
  signal?: AbortSignal;
  /**
   * Collect artifacts (default: on). `false` disables collection;
   * an object tunes workspace diffing.
   */
  artifacts?: boolean | ArtifactOptions;
  /** Forward raw engine messages as `message` events (default false). */
  includeRawMessages?: boolean;
}

/**
 * The contract every execution engine driver implements.
 * Each driver lives in its own file (packages/drivers/src/<engine>.ts).
 */
export interface EngineDriver {
  /** Registry key, e.g. "claude_sdk" */
  name: string;
  /** Human-readable description for `list` */
  description: string;
  /** Execute a task using the given resolved agent config */
  run(config: AgentConfig, task: TaskInput, options?: RunOptions): Promise<TaskResult>;
}

/** A builtin tool: JSON schema + executable handler. */
export interface BuiltinTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
  /** Execute the tool. Args are already validated by the driver. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** Context passed to tool handlers. */
export interface ToolContext {
  /** Working directory the task runs in */
  cwd: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** Result text (or error description) returned to the model */
  content: string;
}

/** Result of loading skills: a prompt fragment to inject into the system prompt. */
export interface LoadedSkill {
  name: string;
  description: string;
  promptFragment: string;
}
