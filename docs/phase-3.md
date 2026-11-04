# Phase 3：工具全家桶 + 并发执行

> 目标：从"只能读"升级为"能干活的 agent"——新增 `list_dir` / `glob` / `write_file` / `bash`，
> 并实现 claude-code 的核心调度策略：**只读工具并发、写工具串行**。
> 本阶段新增：`src/tools/{list-dir,glob,write-file,bash}/`、`src/tools/execute.ts`、`src/tools/orchestrate.ts`；重构 `src/query.ts`、`src/tools/Tool.ts`

## 1. 架构设计

```
query.ts 主循环
   │ 模型返回 N 个 tool_calls
   ▼
tools/orchestrate.ts  runToolCalls()
   │
   ├─ partitionBatches()  切批：
   │    连续只读 → 一批（并发）    [read, read, glob]
   │    写工具   → 独占一批        [write] / [bash]
   │    例子: read, write, read  →  [read] | [write] | [read]
   │
   ├─ runBatch()  批内执行：
   │    单工具 → 直接 await
   │    多工具 → Promise.all 并发启动，按原始顺序"收割"结果
   │
   └─ tools/execute.ts  executeToolCall()（每批内每个调用走一遍）
        查找工具 → JSON.parse 参数 → zod 校验 → tool.call()
        （任何一步失败返回 type:'error' 结果，绝不抛异常）
```

为什么按**连续**分批而不是"所有只读一组"？——保持与模型给出的调用顺序一致。模型经常这样思考："先读 A，再写 B，再读 C 确认"。乱序执行可能产生语义错误。

## 2. 代码职责

| 文件 | 职责 |
|---|---|
| `src/tools/Tool.ts` | Tool 接口 + defineTool 工厂；`ToolResult` 升级为 `{type:'success'\|'error'}` 可辨识联合 |
| `src/tools/execute.ts` | 单次调用执行链（四步 + 输出截断），从 query.ts 抽出 |
| `src/tools/orchestrate.ts` | 分批调度 + 并发执行 + 事件流 |
| `src/tools/read-file/` | 读文件（2000 行截断） |
| `src/tools/list-dir/` | 列目录（目录在前排序，`/` 标注目录） |
| `src/tools/glob/` | glob 模式匹配（Node 22 内置 `fs.globSync`，200 条上限防御全仓库扫描） |
| `src/tools/write-file/` | 写文件（自动建父目录；非只读 → Phase 4 弹确认） |
| `src/tools/bash/` | 执行 shell（30s 超时、10K 输出截断、非零退出码报错） |

## 3. 关键实现思路

### ① bash 工具的三个安全阀（一个都不能少）
1. **超时上限 30s**——防止模型跑了个挂死的命令卡住整个 agent；
2. **输出截断 10K 字符**——防止 `cat` 一个大文件撑爆上下文；
3. **非零退出码 → error 结果**——模型能看到 stderr 自己修（比如发现命令拼错了重试）。
claude-code 的 BashTool 还有持久 shell 会话、`Bash(git *)` 前缀权限规则等，那些是锦上添花，安全阀是底线。

### ② 并发批的"收割"模式
`Promise.all` 启动全部并发任务后，**按原始顺序逐个 await**：结果回填顺序稳定（tool_call_id 与消息顺序可预测），同时不牺牲并发度——所有任务已在跑，await 第一个时其余的也在执行。

### ③ glob 用 Node 22 内置 `fs.globSync`
claude-code 底层用 ripgrep 二进制（快但引入外部依赖）。教学项目用内置能力零依赖，够用——工具选型要根据项目阶段取舍，这是照搬 vs 借鉴的区别。

## 4. 本阶段 TS 知识点

| 概念 | 在哪用的一句话总结 |
|---|---|
| **可辨识联合（实战）** | `ToolResult = {type:'success';output} \| {type:'error';output}`，消费方判断 `result.type` 后访问字段，编译器保证不踩空 |
| **Promise.all 并发** | `batch.map(tc => executeToolCall(tc, ...))` 先启动全部，再按序 await |
| **类型守卫** | `err instanceof Error ? err.message : String(err)`——catch 的 err 是 unknown，必须收窄才能用 |
| **类型推断了无痕** | 各工具的 `call(input)` 都**没写类型注解**，全靠 defineTool 泛型从 schema 推断 |
| **`import('node:fs').Dirent`** | 类型位置上直接写 import()，临时引用一个类型不必单独 import |
| **`noUncheckedIndexedAccess`** | tsconfig 开了它后 `batch[0]` 类型是 `ToolCall \| undefined`，用 `!` 断言非空（循环索引确定存在时安全） |

## 5. 与参考项目对照

| 借了什么 | 从哪借 | 改了什么、为什么 |
|---|---|---|
| 分批调度策略 | `src/services/tools/toolOrchestration.ts` 的 `partitionToolCalls`：连续 isConcurrencySafe 并发、其余串行 | 用 isReadOnly 兼任并发安全标志（两者在 claude-code 里也高度重合），减少概念 |
| 单次执行链 | `src/services/tools/toolExecution.ts` runToolUse：查找→校验→执行，错误产生 is_error tool_result | 去掉 hooks / 权限层（Phase 4 补），错误用文本前缀约定 |
| read_file | `src/tools/FileReadTool/`：offset/limit、行截断、错误信息 | 去掉图片/PDF/notebook 支持，只留文本 |
| glob | `src/tools/GlobTool/`：pattern+path、结果上限 | ripgrep → Node 内置 globSync |
| write_file | `src/tools/FileWriteTool/` | 去掉"读过才能改"约束（readFileState），Phase 4 再考虑 |
| bash | `src/tools/BashTool/` | 保留超时+截断两个安全阀，去掉持久 shell 会话 |

## 6. 运行与验证

```bash
npm start
# 试：> 列出 src 目录下有哪些文件，统计这些文件一共有多少行代码
# 观察：list_dir → 多个 read_file 并发 → bash(wc -l) → 汇总回答

# 试：> 在 /tmp 下创建 hello.txt 内容是 "hi from mini-agent"，然后读出来验证
# 观察：write_file → read_file 组合
```

离线冒烟：`npx tsx scripts/_smoke_phase3.ts`（16 项：5 工具 + 错误路径 + 只读标志 + 并发/混合批次调度）。

带 Key 验证清单：
- [ ] 组合任务能触发多个工具、多个轮次
- [ ] 并发批次观察到 3 个 tool_start 连续出现
- [ ] 让它执行一个会失败的命令（如 `cat /nonexistent`），确认模型读到 stderr 后自己调整

## 7. 复习自测

1. 为什么分批按"连续只读"切，而不是把所有只读工具合成一大批？
2. 并发批里 Promise.all 启动后为什么还要按顺序 await收割结果？不按顺序会怎样？
3. bash 工具如果去掉超时会引入什么风险？去掉输出截断呢？
4. `ToolResult` 改成可辨识联合后， compared 到 boolean 的 `success` 字段，写错代码时 TS 能帮你拦截什么？

## 下一步预告（Phase 4）

write_file 和 bash 现在可以静默执行——太危险了。引入 claude-code 的分层权限模型：写工具执行前询问用户 allow/deny，会话内记住选择。
