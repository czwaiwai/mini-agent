# mini-agent

从零构建的终端 coding agent，以 [claude-code](../claude-code/src/) 源码为架构参照，
用 OpenAI 兼容 API（DeepSeek / GLM / Kimi 等）+ Node.js + TypeScript 实现。

> 学习项目 —— 每个阶段的架构设计、TS 知识点与参考项目对照见 `docs/phase-1.md` ~ `phase-6.md`。

## 快速开始

```bash
npm install
cp .env.example .env    # 填入你的 API Key
npm start

# 恢复上次会话
npm start -- --continue
```

支持的提供商（改 `.env` 或环境变量）：

| 提供商 | MINI_AGENT_BASE_URL | MINI_AGENT_MODEL |
|---|---|---|
| DeepSeek（默认） | https://api.deepseek.com/v1 | deepseek-chat |
| 智谱 GLM | https://open.bigmodel.cn/api/paas/v4 | glm-4-plus |
| Kimi | https://api.moonshot.cn/v1 | moonshot-v1-32k |

## 总体架构

```
┌────────────────────────────────────────────────────────────────┐
│ index.ts (REPL)                                                │
│  readline 交互 · SIGINT 中断 · 会话恢复 · 权限确认 UI(y/n/a)      │
└──────────────┬─────────────────────────────────────────────────┘
               │ for await (event of query(...))
┌──────────────▼─────────────────────────────────────────────────┐
│ query.ts (agent 主循环，async generator)                         │
│  while(true):                                                  │
│   ⓪ shouldCompact? → 压缩历史（compact.ts）                      │
│   ① streamChat 流式调模型（client.ts，含建流重试）                │
│   ② assistant 消息入 messages                                    │
│   ③ 无 tool_calls? → done（终止）                                │
│   ④ runToolCalls 调度执行（orchestrate.ts）                      │
│   ⑤ tool 结果回填 → continue                                     │
└──────┬──────────────────┬───────────────────┬──────────────────┘
       │                  │                   │
┌──────▼───────┐  ┌───────▼────────┐  ┌───────▼─────────┐
│ agent/client │  │ tools.ts 注册表 │  │ permissions.ts  │
│ OpenAI 兼容  │  │  read_file     │  │ 分层权限：       │
│ 流式+重试    │  │  list_dir      │  │ 工具级声明 →     │
│ 信号取消     │  │  glob          │  │ 会话记忆 →       │
└──────────────┘  │  write_file    │  │ 交互询问         │
                  │  bash          │  └─────────────────┘
                  └────────────────┘
辅助模块：session.ts(JSONL 持久化) · compact.ts(上下文压缩)
         tokenEstimator.ts(token 粗估) · prompts.ts(系统提示词)
```

### 核心设计原则（继承自 claude-code）

1. **messages 数组是唯一事实源**——模型的"记忆"完全来自完整历史；压缩、持久化、中断恢复都只是对这个数组的受控变换。
2. **主循环 = async generator 事件流**——`query()` 每发生一件事就 yield 一个事件，UI 只是渲染器；换 UI（Web/TUI）不用动 agent 逻辑。
3. **工具绝不抛异常**——所有失败（参数错、权限拒、执行崩）都变成文字结果回传模型，让它自愈。
4. **fail-closed 默认**——工具不声明只读就按"要权限"处理。
5. **依赖注入**——askUser 回调、signal、permissions 都从外部注入，核心逻辑可离线测试。

## 目录结构

```
src/
├── index.ts            # REPL 入口
├── query.ts            # agent 主循环
├── types.ts            # 共享类型（可辨识联合消息）
├── prompts.ts          # 系统提示词
├── permissions.ts      # 权限管理器
├── session.ts          # JSONL 会话持久化
├── compact.ts          # 自动上下文压缩
├── tokenEstimator.ts   # token 粗估
├── tools.ts            # 工具注册表
├── agent/client.ts     # 模型 API 层（流式 + 重试）
└── tools/
    ├── Tool.ts         # Tool 接口 + defineTool 工厂
    ├── execute.ts      # 单次调用执行链
    ├── orchestrate.ts  # 只读并发/写串行调度
    ├── read-file/  list-dir/  glob/  write-file/  bash/
docs/
├── phase-1.md ~ phase-6.md   # 各阶段开发文档（含 TS 知识点）
scripts/
└── _smoke_phase*.ts          # 离线冒烟测试（npx tsx 运行）
sessions/                     # 会话记录（gitignore）
```

## 验证

```bash
npm run typecheck                    # tsc --noEmit
npx tsx scripts/_smoke_phase3.ts     # 工具 + 调度（16 项）
npx tsx scripts/_smoke_phase4.ts     # 权限（13 项）
npx tsx scripts/_smoke_phase5.ts     # 持久化 + 重试分类（13 项）
npx tsx scripts/_smoke_phase6.ts     # 压缩（15 项）
```

## 可配置环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| MINI_AGENT_API_KEY | （必填） | API Key |
| MINI_AGENT_BASE_URL | https://api.deepseek.com/v1 | 兼容端点 |
| MINI_AGENT_MODEL | deepseek-chat | 模型名 |
| MINI_AGENT_CONTEXT_TOKENS | 65536 | 上下文窗口大小 |
| MINI_AGENT_COMPACT_RATIO | 0.7 | 压缩触发比例 |

## 与 claude-code 的对照索引

| mini-agent | claude-code 源码位置 |
|---|---|
| 主循环 | `src/query.ts`（async generator while(true)） |
| Tool 接口 / defineTool | `src/Tool.ts`（Tool type + buildTool 工厂） |
| 注册表 | `src/tools.ts` |
| 执行链 / 调度 | `src/services/tools/toolExecution.ts` / `toolOrchestration.ts` |
| API 层 / 重试 | `src/services/api/claude.ts` / `withRetry.ts` |
| 权限 | `src/Tool.ts` checkPermissions + `src/hooks/useCanUseTool.tsx` |
| 会话持久化 | `src/utils/sessionStorage.ts` |
| 上下文压缩 | `src/services/compact/` |

未实现（可作为进阶练习）：子 agent 递归调用（`src/tools/AgentTool/runAgent.ts`）、MCP 接入（`src/services/mcp/`）、斜杠命令（`src/commands.ts`）、React Ink UI（`src/screens/REPL.tsx`）。
