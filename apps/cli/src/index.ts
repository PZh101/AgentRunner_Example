#!/usr/bin/env node
/**
 * agent-runner CLI
 *
 * Usage:
 *   agent-runner list                        # list agent configs and engines
 *   agent-runner run <agent> "<task>"        # run a task via agents/agent-<agent>.json
 *
 * Registering drivers here wires every engine into the runner.
 */
import { runAgentByName, loadAgentConfig, listAgentNames, listDrivers, listBuiltinTools, type Artifact } from '@agent-runner/core';
import { registerAllDrivers } from '@agent-runner/drivers';

registerAllDrivers();

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Artifacts go to stderr; stdout stays reserved for assistant text. */
function printArtifacts(artifacts: Artifact[]): void {
  if (artifacts.length === 0) return;
  console.error(`[agent-runner] artifacts (${artifacts.length}):`);
  for (const a of artifacts) {
    const change = (a.change ?? 'produced').padEnd(8);
    const path = a.path ?? '(inline)';
    const size = a.bytes !== undefined ? ` ${formatBytes(a.bytes)}` : '';
    const tool = a.tool ? ` [${a.tool}]` : '';
    console.error(`  - ${change} ${path}${size}${tool}`);
  }
}

function printUsage(): void {
  console.log(`Usage:
  agent-runner list
  agent-runner run <agent-name> "<task prompt>"

Engines: ${listDrivers().map((d) => d.name).join(', ')}
Builtin tools: ${listBuiltinTools().join(', ')}`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'list') {
    console.log('Engines:');
    for (const d of listDrivers()) console.log(`  - ${d.name.padEnd(12)} ${d.description}`);
    console.log('\nAgents:');
    for (const name of listAgentNames()) {
      try {
        const c = loadAgentConfig(name);
        console.log(`  - ${name.padEnd(12)} engine=${c.engine} tools=[${(c.tools ?? []).join(',')}] skills=[${(c.skills ?? []).join(',')}] autoApprove=${String(c.autoApprove ?? false)}`);
      } catch (err) {
        console.log(`  - ${name.padEnd(12)} INVALID: ${(err as Error).message}`);
      }
    }
    return;
  }

  if (cmd === 'run') {
    const [agent, ...taskParts] = rest;
    if (!agent || taskParts.length === 0) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const prompt = taskParts.join(' ');
    console.error(`[agent-runner] running agent "${agent}" on task: ${prompt}`);

    const controller = new AbortController();
    const onSigint = (): void => {
      console.error('\n[agent-runner] aborting...');
      controller.abort();
    };
    process.once('SIGINT', onSigint);

    let sawDelta = false;
    let lineOpen = false;
    const result = await runAgentByName(agent, { prompt }, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text_delta') {
          sawDelta = true;
          lineOpen = true;
          process.stdout.write(event.text);
        } else if (event.type === 'tool_call') {
          if (lineOpen) process.stderr.write('\n');
          lineOpen = false;
          process.stderr.write(`[agent-runner] tool: ${event.name}\n`);
        }
      },
    });
    process.removeListener('SIGINT', onSigint);

    if (lineOpen) process.stdout.write('\n');
    if (result.ok) {
      if (!sawDelta) console.log(result.text);
      printArtifacts(result.artifacts);
    } else {
      if (!sawDelta && result.text) console.log(result.text);
      console.error(`[agent-runner] FAILED: ${result.error ?? 'unknown error'}`);
      printArtifacts(result.artifacts);
      process.exitCode = 1;
    }
    return;
  }

  printUsage();
  if (cmd) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[agent-runner] fatal:', err);
  process.exitCode = 1;
});
