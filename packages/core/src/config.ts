import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from './types.js';

/**
 * Repo root: agents/, skills/ and default cwd are resolved against this.
 * Resolved as <monorepo root> = 3 levels up from this package's dist (or src).
 */
function findRepoRoot(): string {
  let dir = path.resolve(import.meta.dirname ?? '.');
  // Walk up looking for pnpm-workspace.yaml
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve();
}

export const REPO_ROOT = findRepoRoot();

/**
 * Load repo-root .env.local (KEY=VALUE lines) into process.env.
 * Never overrides variables already set; secrets stay out of source/config files.
 */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(REPO_ROOT, '.env.local'));

const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const agentConfigSchema = z.object({
  name: z.string().min(1),
  engine: z.string().min(1),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  skills: z.array(z.string()).optional(),
  model: z
    .object({
      provider: z.string().optional(),
      baseUrl: z.string().optional(),
      modelId: z.string().optional(),
      apiKeyEnv: z.string().optional(),
    })
    .optional(),
  cwd: z.string().optional(),
  autoApprove: z.boolean().optional(),
});

/** Directory that holds agent-<name>.json files. */
export const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
/** Directory that holds <skill-name>/SKILL.md files. */
export const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

/**
 * Load and validate an agent config: agents/agent-<name>.json
 * Relative `cwd` values are resolved against the repo root.
 */
export function loadAgentConfig(name: string): AgentConfig {
  const file = path.join(AGENTS_DIR, `agent-${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Agent config not found: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Config validation failed for ${file}: ${issues}`);
  }
  const data = parsed.data;
  const config: AgentConfig = { ...data, cwd: data.cwd ? path.resolve(REPO_ROOT, data.cwd) : REPO_ROOT };
  return config;
}

/** List all agent names that have a config file. */
export function listAgentNames(): string[] {
  try {
    return readdirSync(AGENTS_DIR)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.json'))
      .map((f) => f.slice('agent-'.length, -'.json'.length));
  } catch {
    return [];
  }
}
