/**
 * index.ts —— REPL 入口（参照 claude-code 的 src/screens/REPL.tsx 的职责）
 *
 * Phase 5 新增：
 * - 会话持久化：每条消息追加写入 sessions/*.jsonl，--continue 恢复
 * - Ctrl+C 中断当前轮（不退出程序）：SIGINT → AbortController → abort
 *   传播到 API 请求和 bash 子进程
 */

import * as readline from 'node:readline';
import { join } from 'node:path';
import { createClient, loadConfig } from './agent/client.js';
import { query } from './query.js';
import { getSystemPrompt } from './prompts.js';
import { getAllTools } from './tools.js';
import { PermissionManager } from './permissions.js';
import type { UserAnswer } from './permissions.js';
import { SessionStore, cleanupDanglingToolCalls } from './session.js';
import type { ChatMessage } from './types.js';

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

/**
 * 权限确认的 UI 实现：readline 问用户 y / n / a。
 * 这个回调被注入 PermissionManager——权限逻辑与交互方式解耦。
 */
async function askUserPermission(
  rl: readline.Interface,
  request: { toolName: string; argsSummary: string; message: string },
): Promise<UserAnswer> {
  console.log(`\n  ⚠ 权限请求 [${request.toolName}]`);
  console.log(`  ${request.message.replace(/\n/g, '\n  ')}`);
  while (true) {
    const answer = await ask(rl, '  允许执行？(y=允许 / n=拒绝 / a=本会话总是允许) ');
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 'y') return 'allow';
    if (trimmed === 'n') return 'deny';
    if (trimmed === 'a') return 'always_allow';
    console.log('  请输入 y、n 或 a');
  }
}

/** 消息入历史 + 落盘，二合一（所有历史变更都走这里，防止漏写） */
function addMessage(messages: ChatMessage[], session: SessionStore, message: ChatMessage): void {
  messages.push(message);
  session.append(message);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);
  const tools = getAllTools();

  // ── 会话：新建或恢复 ──
  const session = new SessionStore(join(process.cwd(), 'sessions'));
  const wantContinue = process.argv.includes('--continue') || process.argv.includes('-c');

  const messages: ChatMessage[] = [];
  if (wantContinue) {
    const restored = session.loadLatest();
    if (restored) {
      messages.push(...restored);
      console.log(`已恢复上次会话（${messages.length} 条消息）。`);
    } else {
      console.log('没有找到历史会话，开启新会话。');
    }
  }
  // 保证有 system 提示词（恢复的历史里也带，但没有就补一条）
  if (!messages.some((m) => m.role === 'system')) {
    addMessage(messages, session, { role: 'system', content: getSystemPrompt() });
  }
  session.start();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── 权限管理器：注入交互式询问回调（依赖注入）──
  const permissions = new PermissionManager((request) => askUserPermission(rl, request));

  // ── Ctrl+C 中断机制 ──
  // activeAbort 非 null 表示"agent 正在干活"，此时 SIGINT = 中断当前轮；
  // 为 null 表示"正等待输入"，此时不退出程序只清空当前行。
  // （注意：一旦注册了 SIGINT 监听器，Node 的默认退出行为就没了）
  let activeAbort: AbortController | null = null;
  process.on('SIGINT', () => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      process.stdout.write('\n(再次 Ctrl+C 退出，输入继续)\n');
      rl.prompt(true);
    }
  });

  console.log(
    `mini-agent 已启动（模型：${config.model}，工具：${tools.map((t) => t.name).join(', ')}）`,
  );
  console.log('输入 exit 退出；agent 运行中按 Ctrl+C 中断当前轮；npm start -- --continue 恢复会话。\n');

  while (true) {
    let input: string;
    try {
      input = (await ask(rl, 'you> ')).trim();
    } catch {
      break;
    }

    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;

    addMessage(messages, session, { role: 'user', content: input });

    // 每一轮一个独立的 AbortController
    const abortController = new AbortController();
    activeAbort = abortController;

    process.stdout.write('agent> ');
    try {
      for await (const event of query({
        client,
        config,
        messages,
        tools,
        permissions,
        signal: abortController.signal,
        context: { cwd: process.cwd(), signal: abortController.signal },
      })) {
        switch (event.type) {
          case 'text_delta':
            process.stdout.write(event.text);
            break;
          case 'tool_start':
            console.log(`\n  ⚙ ${event.name}(${event.argsSummary})`);
            break;
          case 'tool_result':
            console.log(
              `  ✓ ${event.name} 完成（${event.durationMs}ms）${event.success ? '' : ' [失败]'}`,
            );
            process.stdout.write('agent> ');
            break;
          case 'retry':
            console.log(
              `\n  ⟳ API 错误（${event.reason.slice(0, 80)}），${event.delayMs}ms 后进行第 ${event.attempt}/${event.maxRetries} 次重试...`,
            );
            process.stdout.write('agent> ');
            break;
          case 'compacting':
            console.log(
              `\n  📦 上下文约 ${event.estimatedTokens} tokens，超过阈值 ${event.threshold}，正在压缩历史...`,
            );
            break;
          case 'compacted':
            console.log(
              `  📦 压缩完成：${event.beforeTokens} → ${event.afterTokens} tokens（早期对话已转为摘要）`,
            );
            process.stdout.write('agent> ');
            break;
          case 'interrupted':
            console.log('\n(已中断当前轮，历史保持完整)');
            break;
          case 'done':
            break;
        }
      }
    } catch (err) {
      // signal.aborted 的中断已被 query 内部处理；这里是真错误
      if (abortController.signal.aborted) {
        console.log('\n(已中断当前轮)');
      } else {
        console.error('\n本轮出错：', err instanceof Error ? err.message : err);
        console.error('（输入历史已保存，可继续对话）');
      }
    } finally {
      activeAbort = null;
      // 中断可能留下"assistant 有 tool_calls 但没结果"的悬空消息
      // （在中断时序的边角情况下），下次请求前做一次清理
      cleanupDanglingToolCalls(messages);
    }
    console.log('\n');
  }

  rl.close();
  console.log(`再见！会话已保存到 sessions/ 目录（--continue 可恢复）。`);
  process.exit(0);
}

main().catch((err) => {
  console.error('发生未处理的错误：', err);
  process.exit(1);
});
