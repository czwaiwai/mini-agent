# Phase 5：健壮性 —— 重试、会话持久化、中断

> 目标：断网自动重试（指数退避）、对话历史落盘可恢复（--continue）、Ctrl+C 只中断当前轮不杀程序。
> 本阶段新增：`src/session.ts`；改造 `src/agent/client.ts`（重试）、`src/query.ts`（signal 贯穿 + 悬空清理）、`src/tools/bash/BashTool.ts`（signal 终止子进程）、`src/index.ts`

## 1. 架构设计

三条独立的健壮性线，都汇入"消息历史一致性"这个核心约束：

```
① 重试（API 层内部消化）           ② 持久化（REPL 层透明记录）      ③ 中断（信号贯穿全链路）
streamChat 建立连接失败             addMessage() = push + append     SIGINT
  → 分类：429/5xx/网络 → 重试        （所有历史变更走同一个口）          ↓
  → Retry-After 优先，否则指数退避   sessions/session-*.jsonl         activeAbort.abort()
  → 最多 3 次，每次 yield retry 事件  每行一条 JSON（追加写）             ↓
  → 流一旦开始吐字就不再重试          --continue → loadLatest()       signal 同时传给：
      （否则已打印内容会重复）          （损坏行跳过）                    · API 请求（fetch 取消）
                                                                       · bash 子进程（kill）
消息历史一致性保障：中断时若 assistant 已入历史但 tool 结果未回填
  → 回滚该消息（query.ts）/ cleanupDanglingToolCalls（兜底）
```

## 2. 代码职责

| 文件 | 职责 |
|---|---|
| `src/agent/client.ts` | `isRetryable()`（429/5xx/超时/网络）、`getRetryDelay()`（Retry-After 优先 + 指数退避 + 抖动）、建流重试循环、signal 传入 fetch |
| `src/session.ts` | SessionStore：start/append/loadLatest/load，JSONL 追加写 + 损坏行容错；`cleanupDanglingToolCalls()`；类型守卫 `isChatMessage` |
| `src/query.ts` | signal 参数贯穿；中断时 yield 'interrupted' 并回滚未完成的 assistant 消息 |
| `src/tools/bash/BashTool.ts` | `exec(..., { signal })`——中断立刻 kill 子进程 |
| `src/index.ts` | SIGINT 处理（activeAbort 判空区分"中断当前轮"和"空闲"）、`--continue` 恢复、addMessage 统一记账 |

## 3. 关键实现思路

### ① 重试的范围取舍（最重要的一处设计决策）
只重试**建立流连接**，不重试流中途的失败。原因：流式输出已经打印了一半，重试会重复内容；要让中途断流可恢复，得记录"已消费 offset"并断点续传——大多数兼容端点不支持，投入产出比极低。claude-code 的做法印证同一原则：它有非流式 fallback 而不是中途重放。另外记住 claude-code withRetry 里的注释："默认不重试——只给用户在等结果的路径加重试"。

### ② JSONL 追加写 + 容错解析
每行一条 JSON，追加写崩溃只损失半行；加载时半行直接跳过。如果用整文件 JSON，崩溃就是全损。恢复后要检查 system 提示词是否存在（补一条），再继续追加。

### ③ 中断的一致性：回滚悬空消息
中断可能发生在任意时刻，最危险的位置是"assistant 消息（带 tool_calls）已 push、tool 结果还没回填"。此时直接开下一轮，服务端会因协议不完整返回 400。两个防线：query.ts 在执行工具前检查 `signal.aborted` → pop 掉刚 push 的消息；index.ts 每轮结束兜底跑 `cleanupDanglingToolCalls`。

## 4. 本阶段 TS 知识点

| 概念 | 在哪用的一句话总结 |
|---|---|
| **类型守卫（type predicate）** | `x is ChatMessage`——JSON.parse 出来的 unknown 必须先守卫才能当 ChatMessage 用 |
| **AbortController/AbortSignal** | `new AbortController()` → `controller.signal` 传给 fetch/exec/sleep → `controller.abort()` 一处触发处处响应 |
| **`Awaited<ReturnType<typeof fn>>`** | 推导 `client.chat.completions.create` 的返回类型，给 stream 变量注型 |
| **DOMException('...', 'AbortError')** | 标准的"取消"错误类型，catch 时可按 name 识别 |
| **class 字段初始化** | `private sessionFile: string \| null = null`——可空状态字段先声明再赋值 |
| **`as const` 收窄** | 见 Phase 4；本阶段的联合事件类型同理 |

## 5. 与参考项目对照

| 借了什么 | 从哪借 | 改了什么、为什么 |
|---|---|---|
| withRetry 指数退避 | `src/services/api/withRetry.ts`（822 行 async generator） | 保留：429/529 特判、Retry-After、指数退避+抖动；简化：内联进 streamChat 建流阶段，且只重试建流 |
| JSONL 会话转录 | `src/utils/sessionStorage.ts` recordTranscript | 保留追加写+恢复；去掉 sidechain、flush 队列等 |
| abort 传播 | claude-code 全链路 abortController（QueryEngine → query → 工具） | signal 同时到达 API fetch、bash 子进程、sleep；概念一致 |
| 悬空消息处理 | claude-code 对中断后历史一致性的处理（yieldMissingToolResultBlocks 的反向问题） | 我们直接回滚，claude-code 选择补齐缺失块——两种策略都成立，回滚更简单 |

## 6. 运行与验证

```bash
npm start
# 试：对话几轮 → exit → npm start -- --continue → 问"我们刚才聊了什么？"

# 试：把 .env 里的 Key 改错 → 发消息 → 观察重试日志（401 不会重试！改成无效 baseURL 观察网络错误重试）

# 试：> 用 bash 执行 sleep 60
# 观察权限确认后，Ctrl+C → 命令被终止，回到 you> 提示符，程序没退出
```

离线冒烟：`npx tsx scripts/_smoke_phase5.ts`（13 项：持久化/损坏行/悬空清理/重试分类/退避计算），并回归 Phase 3/4。

带 Key 验证清单：
- [ ] --continue 恢复后模型记得上文
- [ ] 网络错误（改错 baseURL）触发最多 3 次重试后报错
- [ ] 401 错误（改错 Key）不重试直接报错
- [ ] sleep 60 中 Ctrl+C 回到提示符；恢复后继续对话不 400

## 7. 复习自测

1. 为什么流式开始后不重试？如果一定要支持中途重试需要什么前提？
2. 为什么选 JSONL 而不是整个 JSON 文件？各自的崩溃恢复表现？
3. 中断时为什么必须回滚"带 tool_calls 的 assistant 消息"？不回滚下次请求会发生什么？
4. `x is ChatMessage` 和返回 boolean 的普通函数，对 TS 来说差别在哪？
5. SIGINT 处理里为什么要区分 activeAbort 是否为 null？

## 下一步预告（Phase 6）

最后一个阶段：对话太长时自动压缩上下文（借鉴 claude-code auto-compact），以及流式中实时显示工具调用状态，最后写一份总体架构文档收尾。
