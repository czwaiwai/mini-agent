# Phase 4：权限机制 —— 安全执行写操作

> 目标：write_file / bash 执行前询问用户 allow/deny，支持"本会话总是允许"。
> 拒绝的信息会回传给模型，让它调整策略而不是死磕重试。
> 本阶段新增：`src/permissions.ts`；改造 `src/tools/Tool.ts`（checkPermissions 层）、`src/tools/execute.ts`、`src/tools/orchestrate.ts`、`src/query.ts`、`src/index.ts`

## 1. 架构设计

权限检查发生在执行链的**zod 校验之后、真正执行之前**（坏参数不值得问用户）：

```
executeToolCall 执行链（对标 claude-code runToolUse 的四层）：
  ① 查找工具 → ② JSON.parse → ③ zod 校验
  → ④ 权限层（本阶段新增）：
       工具级 checkPermissions(input) → PermissionResult
          allow │ deny │ ask(带给用户看的信息)
       → 全局层 PermissionManager.resolve()
          ask → 查会话记忆 Map → 没有则问用户(注入的 askUser 回调)
  → ⑤ tool.call()
```

```
REPL(index.ts)                    PermissionManager              executeToolCall
     │                                  │                              │
     │── new PermissionManager(askUser)─▶                              │
     │                                  │◀── resolve('ask','写 x.txt') ─│
     │◀── askUser(request)─────────────▶│                              │
     │  打印 ⚠ 权限请求 + y/n/a 提示      │── 决定 allow/deny ──────────▶│
     └── 交互发生在 UI 层                 │        （deny→工具不执行，     │
                                        │          错误信息回传模型）    │
```

## 2. 代码职责

| 文件 | 职责 |
|---|---|
| `src/permissions.ts` | PermissionManager：会话记忆 Map + 裁决逻辑；AskUserFn 回调类型 |
| `src/tools/Tool.ts` | Tool 接口新增可选 `checkPermissions(input)`；defineTool 默认规则：只读→allow，写→ask |
| `src/tools/write-file/`、`src/tools/bash/` | 自定义 checkPermissions，把**文件路径/命令原文**展示给用户 |
| `src/tools/execute.ts` | 执行链插入权限层；deny → 返回"用户拒绝了..."的 error 结果 |
| `src/index.ts` | askUserPermission：readline 实现的 y/n/a 确认框 |

## 3. 关键实现思路

### ① 拒绝是"信息"，不是"故障"
用户 deny 后，工具返回 `错误：用户拒绝了这次 write_file 调用。请不要重试同样的操作，改为询问用户或调整方案。`——模型读到这段话会换思路（比如先问用户想写哪），而不是把同样的调用再发三遍。claude-code 的 deny 结果同理带解释信息。

### ② "本会话总是允许"= 内存 Map
`Map<toolName, 'allow'>`，键是**工具名**而不是具体调用——和 claude-code 的 alwaysAllowRules 粒度一致（我们的规则简化为"整个工具"，claude-code 支持到 `Bash(git *)` 前缀级）。不持久化：跨会话的信任应该显式配置，而不是悄悄记住。

### ③ 依赖注入让权限可测试
`new PermissionManager(askUser)` 把"怎么问用户"作为回调注入。冒烟测试里注入一个 `async () => 'deny'` 的假回调，就能在没有终端、没有 API Key 的情况下验证全部 7 条权限路径——这就是 Phase 5 要学的 QueryDeps 依赖注入的预热。

## 4. 本阶段 TS 知识点

| 概念 | 在哪用的一句话总结 |
|---|---|
| **字面量联合 + 可辨识联合** | `PermissionResult = {behavior:'allow'} \| {behavior:'ask';message} \| {behavior:'deny';message}`——三个分支携带不同数据，switch 收窄后各取所需 |
| **依赖注入** | PermissionManager 构造时收 askUser 回调；权限逻辑不知道 readline 的存在 |
| **class + private** | `private memory = new Map(...)`——TS 的 private 是编译期检查，阻止外部乱摸内部状态 |
| **`as const`** | `{behavior:'allow' as const}`：让对象字面量的 behavior 收窄为字面量类型而非 string |
| **可选方法调用** | `tool.checkPermissions?.(input)`——接口里的可选方法用 `?.` 调用 |

## 5. 与参考项目对照

| 借了什么 | 从哪借 | 改了什么、为什么 |
|---|---|---|
| 分层权限模型 | `src/Tool.ts:500` checkPermissions（工具级）+ `useCanUseTool.tsx:27` CanUseToolFn（全局）+ ToolPermissionContext 的 alwaysAllow 规则 | 两层保留，规则简化为内存 Map；claude-code 还有 hooks（PreToolUse 可改写输入）和 allowlist/denylist 规则引擎，MVP 不需要 |
| deny 的处理 | 权限拒绝产生带解释的 tool_result 回传模型 | 文案直接借鉴精神：告知模型"不要重试" |
| 权限 UI | `src/components/permissions/PermissionRequest.tsx`（React 弹窗） | readline 问答（y/n/a）——UI 形式不同，决策流相同 |
| fail-closed 默认 | defineTool 默认：非只读 → ask | 与 claude-code TOOL_DEFAULTS 同原则 |

## 6. 运行与验证

```bash
npm start
# 试：> 在当前目录创建 test.txt 内容为 hello
# 观察：⚠ 权限请求 [write_file] → y 允许 → 执行成功
# 再试一次同样的请求，选 a → 本会话内不再询问

# 试：> 执行 rm -rf /tmp/some-test-dir
# 选 n 拒绝 → 观察模型收到拒绝信息后如何调整（应解释/询问，而不是重试）
```

离线冒烟：`npx tsx scripts/_smoke_phase4.ts`（13 项，覆盖 allow/deny 直通、拒绝不执行、会话记忆、工具隔离、无权限逃生门）。

带 Key 验证清单：
- [ ] 写文件 / bash 触发询问；只读工具（read_file/glob/list_dir）不询问
- [ ] 选 a 后同工具后续调用静默放行
- [ ] 拒绝后模型改变策略（如向你确认路径）

## 7. 复习自测

1. 为什么权限检查放在 zod 校验之后而不是之前？
2. 用户 deny 之后，如果把返回给模型的文字换成简单的 "denied"，模型行为可能有什么区别？
3. 为什么"总是允许"不持久化到磁盘？claude-code 是怎么处理跨会话信任的（settings 的 alwaysAllow 规则）？
4. 依赖注入在本阶段解决了什么测试问题？如果没有注入机制，测试权限逻辑要怎么做？

## 下一步预告（Phase 5）

现在 Ctrl+C 会杀死整个程序、断网一次就崩溃、对话历史重启即失。补上健壮性三件套：指数退避重试、JSONL 会话持久化、信号中断处理。
