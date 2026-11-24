/**
 * Driver registry wiring.
 *
 * Adding a new engine:
 *   1. Create src/<engine>.ts implementing EngineDriver (see core types).
 *   2. Import it below and add it to DRIVERS.
 * That's it — configs select it via the `engine` field.
 */
import { registerDriver } from '@agent-runner/core';
import { claudeSdkDriver } from './claude_sdk.js';
import { claudeCliDriver } from './claude_cli.js';
import { piAgentDriver } from './pi_agent.js';

export { claudeSdkDriver } from './claude_sdk.js';
export { claudeCliDriver } from './claude_cli.js';
export { piAgentDriver } from './pi_agent.js';

const DRIVERS = [claudeSdkDriver, claudeCliDriver, piAgentDriver];

/** Register all built-in drivers with the core registry. Idempotent. */
export function registerAllDrivers(): void {
  for (const driver of DRIVERS) {
    try {
      registerDriver(driver);
    } catch (err) {
      // Already registered (e.g. hot reload / repeated init) — ignore.
      if (!String((err as Error).message).startsWith('Driver already registered')) throw err;
    }
  }
}
