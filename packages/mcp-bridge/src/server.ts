#!/usr/bin/env node
/**
 * stdio MCP server that exposes @agent-runner/core builtin tools.
 *
 * Used by engines that can only attach tools through MCP (claude_sdk and
 * claude_cli both mount this server; pi_agent can also use it or wrap tools
 * natively). The parent passes the task cwd via AGENT_RUNNER_CWD.
 *
 * Uses the low-level Server API so JSON Schemas from builtin tools are passed
 * through verbatim (no Zod conversion needed).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getBuiltinTool, listBuiltinTools, type ToolContext } from '@agent-runner/core';

const ctx: ToolContext = { cwd: process.env.AGENT_RUNNER_CWD ?? process.cwd() };

const server = new Server(
  { name: 'agent-runner-builtin-tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listBuiltinTools().map((name) => {
    const t = getBuiltinTool(name)!;
    return { name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' } };
  }),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = getBuiltinTool(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const outcome = await tool.handler((args ?? {}) as Record<string, unknown>, ctx);
  return { content: [{ type: 'text', text: outcome.content }], isError: !outcome.ok };
});

await server.connect(new StdioServerTransport());
