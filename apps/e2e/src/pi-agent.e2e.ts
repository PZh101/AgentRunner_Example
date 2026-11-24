/**
 * pi_agent E2E test (apps/e2e)
 *
 * Exercises the pi_agent driver against an OpenAI-compatible endpoint
 * (default config: agents/agent-pi-longcat.json -> https://api.longcat.chat/openai/v1).
 *
 * The API key is read from the env var named in the agent config
 * (`model.apiKeyEnv`, default LONGCAT_API_KEY). @agent-runner/core loads the
 * gitignored repo-root .env.local automatically, so the key never lives in source.
 *
 * Tests:
 *   1. basic completion  — ok result with non-empty text
 *   2. tool use          — model calls list_dir; a toolResult for it appears
 *   3. missing API key   — driver fails fast with a clear error
 *
 * Run: pnpm --filter @agent-runner/e2e test:pi   (build core/drivers first)
 */
import { loadAgentConfig, runAgent, type AgentConfig, type TaskResult } from '@agent-runner/core';
import { registerAllDrivers } from '@agent-runner/drivers';

registerAllDrivers();

interface TestOutcome {
  name: string;
  ok: boolean;
  detail: string;
}

const results: TestOutcome[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ? `— ${detail}` : ''}`);
}

/** Has a toolResult message for the given tool name in the pi transcript. */
function usedTool(result: TaskResult, toolName: string): boolean {
  return (result.messages ?? []).some(
    (m) => typeof m === 'object' && m !== null && (m as { role?: string }).role === 'toolResult' &&
      (m as { toolName?: string }).toolName === toolName,
  );
}

async function testBasicCompletion(): Promise<void> {
  const result = await runAgentByName('pi-longcat', '只回复一个单词：pong');
  const text = result.text.trim();
  record(
    'basic completion',
    result.ok && text.length > 0 && /pong/i.test(text),
    result.ok ? `reply=${JSON.stringify(text.slice(0, 80))}` : `error=${result.error}`,
  );
}

async function testToolUse(): Promise<void> {
  const result = await runAgentByName(
    'pi-longcat',
    '请使用 list_dir 工具列出当前目录的内容，然后回答 README.md 是否存在于该目录中，只回答"有"或"没有"。',
  );
  const toolRan = usedTool(result, 'list_dir');
  const answered = /有|没有|yes|no/i.test(result.text);
  record(
    'tool use (list_dir)',
    result.ok && toolRan && answered,
    result.ok ? `toolRan=${toolRan} reply=${JSON.stringify(result.text.trim().slice(0, 80))}` : `error=${result.error}`,
  );
}

async function testMissingApiKey(): Promise<void> {
  const base = loadAgentConfig('pi-longcat');
  const config: AgentConfig = {
    ...base,
    model: { ...base.model, apiKeyEnv: 'E2E_DEFINITELY_MISSING_KEY' },
  };
  delete process.env.E2E_DEFINITELY_MISSING_KEY;
  const result = await runAgent(config, { prompt: 'hi' });
  record(
    'missing api key fail-fast',
    !result.ok && /no API key/i.test(result.error ?? ''),
    result.ok ? 'unexpected success' : `error=${result.error}`,
  );
}

async function main(): Promise<void> {
  const config = loadAgentConfig('pi-longcat');
  const keyEnv = config.model?.apiKeyEnv ?? 'LONGCAT_API_KEY';
  if (!process.env[keyEnv]) {
    console.error(`[e2e] ${keyEnv} is not set. Put it in .env.local (gitignored) or export it.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[e2e] pi_agent -> ${config.model?.baseUrl} model=${config.model?.modelId} keyEnv=${keyEnv}`);

  await testBasicCompletion();
  await testToolUse();
  await testMissingApiKey();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

async function runAgentByName(name: string, prompt: string): Promise<TaskResult> {
  const config = loadAgentConfig(name);
  return runAgent(config, { prompt });
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  process.exitCode = 1;
});
