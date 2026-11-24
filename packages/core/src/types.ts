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

/** Normalized result every driver must return. */
export interface TaskResult {
  ok: boolean;
  /** Final assistant text output */
  text: string;
  /** Full transcript (engine-specific shape), optional */
  messages?: unknown[];
  /** Error message when ok === false */
  error?: string;
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
  run(config: AgentConfig, task: TaskInput): Promise<TaskResult>;
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
