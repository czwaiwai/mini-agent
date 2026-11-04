# Phase 1：MVP —— 能对话的最小 Agent

> 目标：终端里输入一句话 → 调用大模型 → 流式打印回复 → 多轮对话记住上文。
> 本阶段代码：`src/index.ts`、`src/agent/client.ts`、`src/types.ts`、`src/prompts.ts`

## 1. 架构设计

```
┌─────────────┐     读取用户输入      ┌──────────────────┐
│  index.ts   │ ──────────────────▶ │  agent/client.ts │
│  (REPL 层)  │ ◀────────────────── │  (API 层)        │
└─────────────┘   流式吐出文本片段    └──────────────────┘
       │                                    │
       │  维护 messages[]（唯一事实源）       │  HTTP SSE 流
       ▼                                    ▼
  ChatMessage[]                       OpenAI 兼容端点
  （内存中的对话历史）                  (DeepSeek / GLM / Kimi ...)
```

数据流：`用户输入 → push 进 messages → 整个 messages 发给模型 → 流式收 delta 并实时打印 → 完整回复 push 回 messages → 下一轮`。

**为什么 messages 数组是核心？** 模型本身是无状态的——"记得上文"完全靠客户端把历史完整传过去。claude-code 里对应 `QueryEngine.mutableMessages`（`src/QueryEngine.ts:184`），整个项目后续的上下文压缩（auto-compact）、会话持久化都建立在这个数组上。这是第一天就要养成的核心心智模型。

## 2. 代码职责

| 文件 | 职责 | 对应 claude-code |
|---|---|---|
| `src/types.ts` | 共享类型：消息、配置、流事件 | `src/types/message.ts`（简化版） |
| `src/agent/client.ts` | 读配置、建客户端、流式调用模型 | `src/services/api/claude.ts` + `client.ts` |
| `src/prompts.ts` | 系统提示词拼装 | `src/constants/prompts.ts`（900+ 行 → 我们 10 行） |
| `src/index.ts` | readline REPL 主循环、维护历史 | `src/screens/REPL.tsx`（React+Ink，5000 行 → 我们 80 行） |

## 3. 关键实现思路

1. **流式输出**：`chat.completions.create({ stream: true })` 返回一个可逐块迭代的流；每个 chunk 里取 `choices[0].delta.content` 拼接。UI 层用 `process.stdout.write` 实时打印（打字机效果），最后拿到完整文本存入历史。
2. **回调转 Promise**：`rl.question(prompt, callback)` 包装成 Promise，才能在 `while (true)` 里用 `await` 写出线性的 REPL 循环，避免"回调地狱"。
3. **配置三级优先**：环境变量 > `.env` 文件 > 默认值（DeepSeek）。`.env` 加载器手写 20 行，已存在的环境变量不覆盖——方便临时 `MINI_AGENT_MODEL=xxx npm start` 覆盖调试。

## 4. 本阶段 TS 知识点

| 概念 | 在哪用的一句话总结 |
|---|---|
| **union 联合类型** | `type ChatRole = 'system' \| 'user' \| ...`，字符串取值被约束，拼错直接编译报错 |
| **interface** | 描述对象形状；`content?: string` 的 `?` 表示可选字段 |
| **async generator** | `async function*` + `yield` + `for await`——**本项目最重要抽象**。它能"边执行边吐值"，调用方逐个消费。claude-code 的整个主循环 `query()` 就是它 |
| **`?.` 可选链 + `??` 空值合并** | `chunk.choices[0]?.delta?.content ?? ''`：可能不存在就不取、null/undefined 才用默认值 |
| **`as` 类型断言** | 只在"我比编译器更清楚"的边界处用（我们的简化消息类型 → SDK 的联合类型），Phase 2 会删掉 |
| **`import.meta.url`** | ESM 里替代 `__dirname` 定位当前文件（`.env` 加载器用到） |

## 5. 与参考项目对照

| 借了什么 | 从哪借 | 改了什么、为什么 |
|---|---|---|
| 分层：REPL / API 层分离 | `src/screens/REPL.tsx` + `src/services/api/claude.ts` | claude-code 的 UI 是 React+Ink 组件树，我们用 readline——UI 形式不影响 agent 核心逻辑，MVP 选最简单的 |
| messages 数组是事实源 | `QueryEngine.mutableMessages`（`src/QueryEngine.ts`） | 概念照搬，实现就是一个普通数组 |
| 流式消费 | `queryModelWithStreaming`（`src/services/api/claude.ts`） | claude-code 消费 Anthropic SSE 事件流并区分 content/thinking/tool_use 块；我们 Phase 1 只有文本 delta |
| 配置分层 | `src/utils/settings/settings.ts` 的多级合并 | 简化为 环境变量 > .env > 默认值 |

## 6. 运行与验证

```bash
cd /Users/waiwai/work/git/mini-agent
cp .env.example .env   # 填入你的 API Key
npm start
```

冒烟测试清单：
- [ ] 问"你是谁"，看到流式打字机输出
- [ ] 第一句说"我叫XX"，第二句问"我叫什么"，验证多轮记忆
- [ ] 空输入直接回车，提示符正常返回
- [ ] 输入 `exit` 正常退出；Ctrl+D 也能退出

## 7. 复习自测

1. 为什么第二句模型能"记得"第一句？数据是怎么流动的？
2. `async function*` 和普通 `async function` 的区别是什么？`yield` 执行到那里时函数发生了什么？
3. `chunk.choices[0]?.delta?.content ?? ''` 里如果去掉 `?.` 会发生什么风险？
4. 如果把 `messages.push({ role: 'assistant', ... })` 这行删掉，多轮对话会出现什么现象？（提示：模型会忘记自己说过的话）

## 下一步预告（Phase 2）

让模型能"动手"：引入工具系统。模型不再只能说话，还能返回 `tool_calls` 要求执行 `read_file`，我们把执行结果喂回去让它继续——这就是 agent 循环的雏形。
