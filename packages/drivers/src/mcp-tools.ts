/**
 * MCP tool adapter: connects to stdio MCP servers with the official client
 * SDK and exposes their tools as pi-ai AgentTools.
 *
 * pi-agent has no built-in MCP client, so this is how extra MCP servers
 * (and optionally the builtin-tools bridge) work for the pi engine.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AgentTool } from '@mariozechner/pi-ai';
import type { McpServerConfig } from '@agent-runner/core';
import { logDriver } from './shared.js';

export interface McpToolBundle {
  tools: AgentTool<any>[];
  close: () => Promise<void>;
}

/** Connect to all MCP servers and wrap their tools. On failure, keeps going with a warning. */
export async function loadMcpTools(servers: McpServerConfig[]): Promise<McpToolBundle> {
  const clients: Client[] = [];
  const tools: AgentTool<any>[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    try {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
        stderr: 'inherit',
      });
      const client = new Client({ name: `agent-runner-${server.name}`, version: '0.1.0' });
      await client.connect(transport);
      clients.push(client);

      const listed = await client.listTools();
      for (const mcpTool of listed.tools) {
        if (seen.has(mcpTool.name)) {
          logDriver('pi_agent', `MCP tool name clash, skipping duplicate: ${mcpTool.name}`);
          continue;
        }
        seen.add(mcpTool.name);
        tools.push(wrapMcpTool(client, mcpTool));
      }
      logDriver('pi_agent', `MCP server "${server.name}" connected, ${listed.tools.length} tool(s)`);
    } catch (err) {
      logDriver('pi_agent', `MCP server "${server.name}" failed to connect: ${(err as Error).message}`);
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    },
  };
}

function wrapMcpTool(client: Client, mcpTool: { name: string; description?: string; inputSchema?: unknown }): AgentTool<any> {
  return {
    name: mcpTool.name,
    label: mcpTool.name,
    description: mcpTool.description ?? '',
    // MCP inputSchema is JSON Schema; pi validates with TypeBox which accepts it.
    parameters: (mcpTool.inputSchema ?? { type: 'object', properties: {} }) as AgentTool<any>['parameters'],
    execute: async (_toolCallId, params) => {
      const response = await client.callTool({
        name: mcpTool.name,
        arguments: (params ?? {}) as Record<string, unknown>,
      });
      const content = Array.isArray(response.content)
        ? response.content.filter((c): c is { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } =>
            c.type === 'text' || c.type === 'image',
          )
        : [];
      return { content, details: response.isError ? { isError: true } : {} };
    },
  };
}
