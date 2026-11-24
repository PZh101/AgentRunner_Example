import type { EngineDriver } from './types.js';

/**
 * Driver registry: engines register themselves here under a key
 * (e.g. "claude_sdk"). Agent configs select an engine via the
 * `engine` field; the runner looks it up here.
 */

const drivers = new Map<string, EngineDriver>();

export function registerDriver(driver: EngineDriver): void {
  if (drivers.has(driver.name)) {
    throw new Error(`Driver already registered: ${driver.name}`);
  }
  drivers.set(driver.name, driver);
}

export function getDriver(name: string): EngineDriver {
  const d = drivers.get(name);
  if (!d) {
    throw new Error(`Unknown engine "${name}". Registered engines: ${listDriverNames().join(', ') || '(none)'}`);
  }
  return d;
}

export function listDrivers(): EngineDriver[] {
  return [...drivers.values()];
}

export function listDriverNames(): string[] {
  return [...drivers.keys()];
}
