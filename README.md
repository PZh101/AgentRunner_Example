# AgentRunner POC

配置驱动的多引擎 Agent 执行器。通过 `agents/agent-<name>.json` 声明 Agent，Runner 按配置选择执行引擎执行任务。

## Monorepo 结构

```
packages/core        类型、配置加载/校验、内置工具、Skill 加载、驱动注册表、Runner
packages/drivers     执行引擎驱动（一个引擎一个文件）
  ├── claude_sdk.ts  @anthropic-ai/claude-agent-sdk 进程内执行
  ├── claude_cli.ts  本机 claude CLI 子进程（claude -p）
  └── pi_agent.ts    Mario Zechner 的 pi（@mariozechner/pi-ai 的 agentLoop + 多 Provider 层）
packages/mcp-bridge  把内置工具暴露为 stdio MCP server（供 claude_sdk / claude_cli 挂载）
apps/cli             命令行入口
apps/e2e             引擎端到端测试（pi_agent 对接 LongCat OpenAI 兼容端点）
agents/              agent-<name>.json 配置
skills/              文件型 Skill（<name>/SKILL.md，注入系统提示词）
```

## 安装与构建

```bash
pnpm install
pnpm -r build
```

## 使用

```bash
# 列出引擎与 Agent 配置
node apps/cli/dist/index.js list

# 运行任务（选择 agents/agent-coder.json 指定的引擎）
node apps/cli/dist/index.js run coder "列出当前目录的文件"
node apps/cli/dist/index.js run reviewer "审查 packages/core/src/runner.ts"
node apps/cli/dist/index.js run pi-coder "解释 package.json 里的脚本"
node apps/cli/dist/index.js run pi-longcat "列出当前目录，告诉我有没有 README.md"
```

## E2E 测试（pi_agent / LongCat）

`apps/e2e` 对 pi_agent 驱动做端到端测试，使用 `agents/agent-pi-longcat.json`
（OpenAI 兼容端点 `https://api.longcat.chat/openai/v1`，模型 `LongCat-2.5`）：

```bash
# key 从 .env.local（已 gitignore）读取，变量名由配置的 model.apiKeyEnv 决定
echo 'LONGCAT_API_KEY=<your-key>' > .env.local
pnpm -r build
pnpm test:pi        # = pnpm --filter @agent-runner/e2e test:pi
```

测试项：1) 基础对话返回；2) 工具调用（list_dir 实际执行并出现在 transcript）；3) 缺少 API key 时快速失败。

## 配置字段（agents/agent-<name>.json）

| 字段 | 说明 |
|---|---|
| `engine` | `claude_sdk` \| `claude_cli` \| `pi_agent`（注册表 key） |
| `systemPrompt` | 系统提示词 |
| `tools` | 内置工具名数组：`read_file` / `write_file` / `list_dir` / `run_command` |
| `mcpServers` | 额外 MCP（stdio）：`{ name, command, args?, env? }[]` |
| `skills` | `skills/` 下的 Skill 目录名，内容注入系统提示词 |
| `model` | `{ provider, baseUrl?, modelId, apiKeyEnv? }`；密钥只从环境变量读 |
| `cwd` | 工作目录（相对仓库根或绝对路径） |
| `autoApprove` | 自动审批，免确认执行工具 |

## 任务输入（TaskInput）

`runAgent(config, task)` / `runAgentByName(name, task)` 的 `task` 支持三类上下文，均为可选：

| 字段 | 说明 |
|---|---|
| `prompt` | 本次任务指令（必填） |
| `history` | 之前轮次的对话，`{ role: 'user' \| 'assistant', content }[]`，按时间升序。pi_agent 原生回放为多轮消息；claude_sdk / claude_cli 拍平进 prompt |
| `context` | 已检索好的外部知识片段（`string[]`，相关性降序），由调用方负责检索，Runner 只负责注入 |

检索本身不放在 Runner 里：小规模知识直接放进 `context`；大规模/按需检索后续做成内置工具
（如 `search_knowledge`），由 Agent 自己决定何时查。

```ts
await runAgentByName('coder', {
  prompt: '基于这些资料总结要点',
  context: ['片段 A……', '片段 B……'],
  history: [
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '之前的回答' },
  ],
});
```

## 新增执行引擎

1. 在 `packages/drivers/src/` 新建 `<engine>.ts`，实现 `EngineDriver`（见 `packages/core/src/types.ts`）。
2. 在 `packages/drivers/src/index.ts` 的 `DRIVERS` 中加入它。
3. 配置里写 `"engine": "<engine>"` 即可。

Driver 需要处理的映射（以现有实现为参考）：系统提示词 + Skill 注入、工具 → 引擎原生机制、MCP 接入、模型地址/ID/Provider、工作目录、自动审批、结果归一化为 `TaskResult`。

## 各引擎能力对照

| 能力 | claude_sdk | claude_cli | pi_agent |
|---|---|---|---|
| 内置工具 | MCP bridge 挂载 | MCP bridge 挂载 | 原生 AgentTool |
| 额外 MCP | 原生支持 | `--mcp-config` | MCP 客户端适配为工具 |
| Skill | 注入系统提示词 | 注入系统提示词 | 注入系统提示词 |
| 自定义 baseUrl | `ANTHROPIC_BASE_URL` | `ANTHROPIC_BASE_URL` | Model.baseUrl 覆盖 |
| 自动审批 | `permissionMode` | `--permission-mode` | pi 自主执行 |
