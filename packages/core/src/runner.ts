import type { AgentConfig, TaskInput, TaskResult } from './types.js';
import { loadAgentConfig } from './config.js';
import { getDriver } from './registry.js';
import { resolveTools } from './builtin-tools.js';

/**
 * Runner: the single entry point orchestrating everything.
 *   agent name -> load config -> validate tools -> pick driver by `engine`
 *   -> driver.run(config, task)
 *
 * Drivers are selected by config, so the same task can run on any engine.
 */

/** Validate that configured tool names all exist. Cheap fail-fast before engine starts. */
function validateConfig(config: AgentConfig): void {
  resolveTools(config.tools ?? []);
}

/**
 * Run a task for a named agent, e.g. runAgent('coder', { prompt: '...' })
 * looks up agents/agent-coder.json and executes with its engine.
 */
export async function runAgentByName(name: string, task: TaskInput): Promise<TaskResult> {
  const config = loadAgentConfig(name);
  return runAgent(config, task);
}

/** Run a task with an already-resolved config. */
export async function runAgent(config: AgentConfig, task: TaskInput): Promise<TaskResult> {
  try {
    validateConfig(config);
    const driver = getDriver(config.engine);
    return await driver.run(config, task);
  } catch (err) {
    return { ok: false, text: '', error: (err as Error).message };
  }
}
