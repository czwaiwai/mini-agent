# Phase 6：自动上下文压缩 + 收尾

> 目标：对话接近上下文上限时，自动把旧消息压缩成一段摘要（借鉴 claude-code auto-compact），让 agent 可以长时间连续工作。
> 本阶段新增：`src/tokenEstimator.ts`、`src/compact.ts`；改造 `src/query.ts`（循环顶压缩检查）、`src/index.ts`（渲染压缩事件）；新增 `README.md` 总体架构文档

## 1. 架构设计

```
query.ts 主循环 while(true) 每轮开头：
  ⓪ shouldCompact(messages, threshold)?
       threshold = MINI_AGENT_CONTEXT_TOKENS(默认65536) × MINI_AGENT_COMPACT_RATIO(默认0.7)
       │ 是
       ▼
     compactMessages():
       [system]                 保留
       user/asst ... 早期消息  → 交给模型写结构化摘要
       ...中间几十条       →
       最近 6 条(组安全切割)     原样保留
       │
       ▼
     messages.splice(0, len, ...compacted)   ← 原地替换，引用不变
       │
       ▼
     ① 调模型（拿着"摘要 + 近期消息 + 新输入"继续对话）
```

压缩前后消息形态：

```
压缩前                                压缩后
[system] 系统提示词                    [system] 系统提示词
[user]   记住项目名叫 alpha            [user]   📜 此前对话的自动摘要：……项目名叫 alpha……
[asst]   好的                          [asst]   （尾部的倒数第二条……）
[user]   长消息×20轮                   [user]   最新问题
...40+ 条
[user]   最新问题
```

## 2. 代码职责

| 文件 | 职责 |
|---|---|
| `src/tokenEstimator.ts` | 粗估 token：中文 ≈1 字/token，英文 ≈4 字符/token（各端点 usage 口径不一，估算 + 阈值余量足够） |
| `src/compact.ts` | `shouldCompact`（触发判断）、`findCutIndex`（组安全切割点）、`compactMessages`（摘要生成 + 消息重组）、`getCompactionThreshold` |
| `src/query.ts` | 循环第 0 步：压缩检查 → yield compacting/compacted 事件 → 原地替换 messages |
| `README.md` | 总体架构文档（六个阶段的最终形态） |

## 3. 关键实现思路

### ① 切割点必须"组安全"（本阶段最精妙的一处）
消息历史里 `assistant(tool_calls) + 若干 tool 结果` 是一个**原子组**——切割点落在组中间，下一轮请求就协议不完整（400）。`findCutIndex` 在切到 tool 消息时往前回退，把整个组划进 tail。claude-code 的 compact 同样要处理这个约束。

### ② 原地替换 vs 返回新数组
`messages.splice(0, messages.length, ...compacted)` 保持数组引用不变——因为 REPL、session、query 三方都持有同一个数组引用。claude-code 用 `mutableMessages` 命名强调同一件事：引用共享是有意设计，不是巧合。

### ③ 压缩失败不致命
模型写摘要的调用可能失败（网络/限流），此时返回 null，主循环带着原历史继续——宁可下一轮可能超限报错（用户可重试），也不丢对话。这延续 Phase 2 的"错误是信息不是故障"原则。

## 4. 本阶段 TS 知识点

| 概念 | 在哪用的一句话总结 |
|---|---|
| **正则 + Unicode 范围** | `/[\u4e00-\u9fff...]/` 匹配 CJK 字符用于 token 粗估 |
| **`for...of` 遍历字符串** | `for (const ch of text)` 按**码点**迭代（不是按 UTF-16 单元），emoji/生僻字不会劈成两半 |
| **splice 原地替换** | `arr.splice(0, arr.length, ...newItems)` 清空并替换且保持引用 |
| **类型断言做测试替身** | `fakeClient as unknown as OpenAI`——测试里用"双重断言"伪造 SDK 客户端（仅在测试代码中可接受） |
| **可选链兜底读** | `response.choices[0]?.message?.content?.trim()`——SDK 响应字段层层可空 |

## 5. 与参考项目对照

| 借了什么 | 从哪借 | 改了什么、为什么 |
|---|---|---|
| auto-compact 触发模型 | `src/services/compact/autoCompact.ts`：接近上限自动触发 | 阈值可配置（env），估算代替精确 tokenizer |
| 压缩 = 摘要替换前缀 | `src/services/compact/compact.ts` 核心思想 | 保留最近 6 条（claude-code 保留窗口更大且含文件状态恢复） |
| 摘要 prompt 结构化保留 | `src/services/compact/prompt.ts`：目标/决策/文件路径/未完成任务 | 直接借用该结构，prompt 文字精简 |
| token 预算意识 | `src/query/tokenBudget.ts` | 我们只做总量估算；claude-code 还有 per-tool 输出预算 |

## 6. 运行与验证

```bash
# 长对话压测：把阈值调小强制触发压缩
MINI_AGENT_CONTEXT_TOKENS=2000 npm start
# 试：> 记住两件事：1、我的项目叫 alpha；2、我喜欢用 pnpm。
#     然后连续问长问题灌上下文，观察 📦 压缩日志
#     压缩后问："我的项目叫什么？"——模型应能从摘要中答出 alpha
```

离线冒烟：`npx tsx scripts/_smoke_phase6.ts`（15 项：token 估算、切割组安全、触发判断、假 client 全流程、失败容错、阈值配置）。

## 7. 复习自测

1. 为什么压缩时必须保证切割点不落在工具组中间？用什么方法保证？
2. token 为什么用估算而不是精确计数？估算错了会有什么后果（两个方向）？
3. 压缩摘要用 user 消息承载而不是 system，有什么考虑？
4. `messages.splice(0, messages.length, ...compacted)` 为什么比 `messages = compacted` 更安全？
5. 如果想恢复"压缩前完整历史"，结合 Phase 5 的会话持久化该怎么设计？

## 六个阶段完成 🎉

回看整条路线：**能聊（P1）→ 能读（P2）→ 能干活（P3）→ 有安全闸（P4）→ 可靠（P5）→ 可长期使用（P6）**。
总体架构与参考项目对照索引见 `README.md`。

进阶练习方向（对应 claude-code 源码）：
1. 子 agent：`src/tools/AgentTool/runAgent.ts` —— 递归调用同一个 query() 引擎
2. MCP：`src/services/mcp/` —— 接入外部工具生态
3. 斜杠命令：`src/commands.ts` —— /compact、/resume 等
4. Web UI：把 query() 的事件流接到 WebSocket + 浏览器（架构已为此做好准备）
