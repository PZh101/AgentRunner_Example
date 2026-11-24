import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { BuiltinTool } from './types.js';

/**
 * Builtin tools: concrete JS implementations registered by name.
 * Agent configs reference them by name via the `tools` field.
 * Drivers adapt these into whatever tool mechanism their engine uses
 * (in-process MCP, CLI flags, native tool defs, ...).
 */

const TOOL_DEFS: BuiltinTool[] = [
  {
    name: 'read_file',
    description: 'Read a text file. Args: { path: string }. Path is relative to the task cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
      },
      required: ['path'],
    },
    handler: async (args, ctx) => {
      const p = path.resolve(ctx.cwd, String(args.path ?? ''));
      if (!existsSync(p)) return { ok: false, content: `File not found: ${p}` };
      try {
        return { ok: true, content: readFileSync(p, 'utf8') };
      } catch (err) {
        return { ok: false, content: `Failed to read ${p}: ${(err as Error).message}` };
      }
    },
  },
  {
    name: 'write_file',
    description: 'Write text to a file (creates parents). Args: { path: string, content: string }.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
    handler: async (args, ctx) => {
      const p = path.resolve(ctx.cwd, String(args.path ?? ''));
      try {
        writeFileSync(p, String(args.content ?? ''), 'utf8');
        return { ok: true, content: `Wrote ${p}` };
      } catch (err) {
        return { ok: false, content: `Failed to write ${p}: ${(err as Error).message}` };
      }
    },
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory. Args: { path?: string } (default ".").',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: cwd)' },
      },
    },
    handler: async (args, ctx) => {
      const p = path.resolve(ctx.cwd, String(args.path ?? '.'));
      try {
        const names = readdirSync(p)
          .map((n) => {
            const full = path.join(p, n);
            return statSync(full).isDirectory() ? `${n}/` : n;
          })
          .sort();
        return { ok: true, content: names.join('\n') };
      } catch (err) {
        return { ok: false, content: `Failed to list ${p}: ${(err as Error).message}` };
      }
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the task cwd and return stdout/stderr. Args: { command: string }. Uses the system shell; on Windows cmd.exe, otherwise /bin/sh.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
    handler: async (args, ctx) => {
      const command = String(args.command ?? '');
      if (!command.trim()) return { ok: false, content: 'Empty command' };
      return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        execFile(
          isWin ? 'cmd.exe' : '/bin/sh',
          isWin ? ['/c', command] : ['-c', command],
          { cwd: ctx.cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsVerbatimArguments: isWin },
          (err, stdout, stderr) => {
            if (err) {
              const out = [stdout, stderr].filter(Boolean).join('\n---\n');
              resolve({ ok: false, content: `Exit code ${('code' in err ? err.code : '?') ?? '?'}\n${out || err.message}` });
              return;
            }
            resolve({ ok: true, content: [stdout, stderr].filter(Boolean).join('\n---\n') || '(no output)' });
          },
        );
      });
    },
  },
];

const registry = new Map<string, BuiltinTool>(TOOL_DEFS.map((t) => [t.name, t]));

/** Get a builtin tool by name, or undefined. */
export function getBuiltinTool(name: string): BuiltinTool | undefined {
  return registry.get(name);
}

/** All registered builtin tool names. */
export function listBuiltinTools(): string[] {
  return [...registry.keys()];
}

/** Resolve config tool names to BuiltinTool defs; throws on unknown names. */
export function resolveTools(names: string[]): BuiltinTool[] {
  return names.map((n) => {
    const t = registry.get(n);
    if (!t) throw new Error(`Unknown tool "${n}". Available: ${[...registry.keys()].join(', ')}`);
    return t;
  });
}
