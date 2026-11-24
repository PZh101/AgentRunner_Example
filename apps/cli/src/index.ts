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
import { runAgentByName, loadAgentConfig, listAgentNames, listDrivers, listBuiltinTools } from '@agent-runner/core';
import { registerAllDrivers } from '@agent-runner/drivers';

registerAllDrivers();

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
    const result = await runAgentByName(agent, { prompt });
    if (result.ok) {
      console.log(result.text);
    } else {
      console.error(`[agent-runner] FAILED: ${result.error ?? 'unknown error'}`);
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
