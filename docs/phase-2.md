# Phase 2：工具系统 —— agent 主循环闭环

> 目标：模型不仅能"说"，还能"做"——返回 tool_calls 请求执行 `read_file`，
> 我们把执行结果喂回去，循环往复直到模型给出纯文本回复。
> 本阶段新增：`src/query.ts`（主循环）、`src/tools/Tool.ts`、`src/tools/read-file/`、`src/tools.ts`；改造 `src/agent/client.ts`（流式累积 tool_calls）、`src/types.ts`（可辨识联合）

## 1. 架构设计

```
                    ┌──────────────────────────────────────────┐
                    │            query.ts 主循环                │
                    │  while(true):                            │
                    │    ① 调模型（流式收 text + tool_calls）    │
                    │    ② assistant 消息入 messages            │
                    │    ③ 没有 tool_calls？→ return（任务完成） │
                    │    ④ 有 → 逐个执行工具                    │
                    │    ⑤ role:'tool' 结果入 messages          │
                    │    ⑥ continue（模型看到结果继续思考）      │
                    └──────────────────────────────────────────┘
                       │ yield 事件流                ▲
                       ▼                             │ messages[]
              ┌──────────────┐              ┌──────────────┐
              │  index.ts    │              │ agent/client │
              │  (渲染事件)   │              │ (API 层)     │
              └──────────────┘              └──────────────┘
                                                     │
                                   ┌─────────────────┴──────────┐
                                   │ tools.ts 注册表             │
                                   │  └─ tools/read-file/       │
                                   │      ├─ ReadFileTool.ts    │
                                   │      └─ prompt.ts          │
                                   └────────────────────────────┘
```

一次典型交互的消息序列（这是理解 agent 的关键！）：

```
[system] 系统提示词
[user]   "package.json 里 name 是什么？"
[assistant] content: null, tool_calls: [{id:"call_1", function:{name:"read_file", arguments:'{"file_path":"package.json"}'}}]
[tool]      tool_call_id:"call_1", content: "package.json 的内容：{...name: mini-agent...}"
[assistant] "这个项目的 name 是 mini-agent。"   ← 纯文本，循环终止
```

## 2. 代码职责

| 文件 | 职责 |
|---|---|
| `src/tools/Tool.ts` | Tool 接口 + `defineTool` 工厂（schema 即类型来源） |
| `src/tools/read-file/ReadFileTool.ts` | 工具实现：zod schema + call() |
| `src/tools/read-file/prompt.ts` | 给模型看的说明（独立文件，质量决定调用质量） |
| `src/tools.ts` | 注册表：getAllTools() / findToolByName() |
| `src/agent/client.ts` | 流式消费：文本 delta 实时吐出；tool_calls 按 index 累积 |
| `src/query.ts` | agent 主循环：调模型 → 判断 → 执行工具 → 回填 → 循环 |
| `src/index.ts` | 消费 QueryEvent 事件流并渲染 |

## 3. 关键实现思路（本阶段最难的三处）

### ① 流式 tool_calls 的按 index 累积

OpenAI 流式模式下 `tool_calls` 是**分片到达**的：第一个片段带 id 和函数名，之后每片带一小段 arguments 字符串，多个工具调用靠 `index` 区分。用 `Map<index, PartialToolCall>` 累积，流结束后排序、组装。claude-code 处理 Anthropic 的 `input_json_delta` 时是完全一样的套路（`StreamingToolExecutor`）。

### ② 执行链的"绝不抛异常"原则

`executeToolCall` 的四步——查找工具 → `JSON.parse` 参数 → zod 校验 → 执行——任何一步失败都返回 `错误：...` 字符串作为 tool result。原因：**抛异常会杀死整个主循环，而错误字符串会让模型读到后自己换策略重试**（比如改个路径再读一次）。这是 agent 工具设计的黄金法则。此外工具输出超过 20000 字符就截断，防止单个工具撑爆上下文（claude-code 有同样机制）。

### ③ 消息历史的协议约束

`role:'tool'` 消息必须紧跟在带 `tool_calls` 的 assistant 消息之后，且 `tool_call_id` 一一对应——顺序或 id 错了，大多数兼容端点直接返回 400。所以主循环里"push assistant → 逐个执行 → 逐个 push tool 结果"的顺序不能乱。

## 4. 本阶段 TS 知识点

| 概念 | 在哪用的一句话总结 |
|---|---|
| **可辨识联合** | `ChatMessage` 用 `\|` 组合四种消息形状，公共字段 `role` 是"判别符"。建模能力和 OpenAI SDK 的内部类型对齐后，Phase 1 的 `as` 断言删掉了 |
| **类型收窄** | `if (assistantMessage.role !== 'assistant') return;` 之后 TS 才允许访问 `.tool_calls`——判断一次，终身受益 |
| **泛型 + 约束** | `Tool<TInput extends z.ZodType>`：TInput 必须是 zod schema |
| **z.infer 反推类型** | `call(input)` 的参数类型自动 = `z.infer<typeof inputSchema>`。**schema 改了类型自动跟着改**，这是 zod 最强的价值 |
| **z.strictObject** | 拒绝模型多传的字段，错误尽早暴露（claude-code 同款） |
| **`z.toJSONSchema`** | zod v4 内置 schema→JSON Schema 转换，`.describe()` 文字会带给模型 |
| **Map 有序迭代** | `[...map.entries()].sort(([a],[b]) => a-b)` 恢复工具调用顺序 |

## 5. 与参考项目对照

| 借了什么 | 从哪借 | 改了什么、为什么 |
|---|---|---|
| Tool 接口骨架 | `src/Tool.ts:362` 的 `Tool<Input>`：name / description / inputSchema / call / isReadOnly | claude-code 还有权限、UI 渲染、并发等十几个方法；我们只保留核心 5 个，权限留给 Phase 4 |
| defineTool 工厂 + 默认值兜底 | `buildTool` + `TOOL_DEFAULTS`（`src/Tool.ts:757-792`） | fail-closed 原则照搬：isReadOnly 不声明就按 false（更保守） |
| 工具注册表 | `src/tools.ts` 的 `getAllBaseTools()` | 去掉 feature flag 条件展开，MVP 用纯数组 |
| 主循环结构 | `src/query.ts` 的 `async function* query()` + while(true)：调模型→收 tool 块→执行→回填→continue | Anthropic `tool_use`/`tool_result` 块 → OpenAI `tool_calls`/`role:'tool'` 消息 |
| prompt.ts 独立文件 | `src/tools/GlobTool/prompt.ts` 等 | 照搬目录习惯：工具说明与实现分离 |
| 错误工具结果回填 | `toolExecution.ts:396-408` 错误路径产生 `is_error` tool_result | 我们用"错误：..."文本前缀（OpenAI 格式没有 is_error 字段约定，文本足够） |

## 6. 运行与验证

```bash
npm start
# 试：> package.json 里 name 字段的值是什么？
# 观察：⚙ read_file({"file_path":"package.json"}) → ✓ 完成 → 文本回答

# 试：> 读一下 does-not-exist.txt
# 观察：工具返回错误后，模型应主动解释"文件不存在"而不是报错崩溃
```

离线冒烟（不需要 Key）：`npx tsx scripts/_smoke_phase2.ts`，覆盖读取/错误/校验/JSON Schema/注册表共 7 项。

带 Key 的完整验证清单：
- [ ] 问文件内容，观察到 tool_start → tool_result → 文本回答的完整事件序列
- [ ] 连续两轮工具调用（如"先读 package.json，再读 README.md，总结差异"），确认循环多转几轮
- [ ] 让它读不存在的文件，确认错误回传后模型自愈
- [ ] `DEBUG` 心法：在主循环 messages.push 后临时 `console.log(JSON.stringify(messages, null, 2))`，亲眼看看协议长什么样

## 7. 复习自测

1. 模型怎么"知道"有哪些工具可用？工具的 JSON Schema 是怎么生成的？
2. 为什么 `executeToolCall` 里所有失败都返回字符串而不是抛异常？
3. 流式模式下 tool_calls 的 arguments 为什么不能在收到第一个片段时就 JSON.parse？
4. 如果把 tool 消息 push 到 assistant 消息**之前**，会发生什么？
5. `defineTool` 的泛型参数 TInput 是怎么让 `call(input)` 的 input 自动获得精确类型的？

## 下一步预告（Phase 3）

一个工具不够用：补齐 `list_dir` / `glob` / `write_file` / `bash`，并实现"只读工具并发、写工具串行"的调度策略——照搬 claude-code 的 toolOrchestration。
