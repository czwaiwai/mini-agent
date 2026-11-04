/**
 * index.ts —— REPL 入口（参照 claude-code 的 src/screens/REPL.tsx 的职责）
 *
 * Phase 4 的变化：REPL 提供权限确认的 UI 实现（y/n/a 交互），
 * 通过依赖注入交给 PermissionManager——权限逻辑与交互方式解耦。
 */

import * as readline from 'node:readline';
import { createClient, loadConfig } from './agent/client.js';
import { query } from './query.js';
import { getSystemPrompt } from './prompts.js';
import { getAllTools } from './tools.js';
import { PermissionManager } from './permissions.js';
import type { UserAnswer } from './permissions.js';
import type { ChatMessage } from './types.js';

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

/**
 * 权限确认的 UI 实现：readline 问用户 y / n / a。
 * 这个回调被注入 PermissionManager——权限逻辑与交互方式解耦。
 * （对应 claude-code 的 PermissionRequest 弹窗组件）
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

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);
  const tools = getAllTools();

  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt() },
  ];

  // 权限管理器：注入交互式询问回调（依赖注入）
  const permissions = new PermissionManager((request) => askUserPermission(rl, request));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    `mini-agent 已启动（模型：${config.model}，工具：${tools.map((t) => t.name).join(', ')}）`,
  );
  console.log('输入 exit 退出。\n');

  while (true) {
    let input: string;
    try {
      input = (await ask(rl, 'you> ')).trim();
    } catch {
      break;
    }

    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;

    messages.push({ role: 'user', content: input });

    // 消费 agent 主循环的事件流
    process.stdout.write('agent> ');
    for await (const event of query({ client, config, messages, tools, context: { cwd: process.cwd() }, permissions })) {
      switch (event.type) {
        case 'text_delta':
          // 【TS 知识点】switch + 联合类型：每个 case 里 event 自动收窄，
          // 只有 text_delta 才有 text 字段
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
        case 'done':
          break;
      }
    }
    console.log('\n');
  }

  rl.close();
  console.log('再见！');
  process.exit(0);
}

main().catch((err) => {
  console.error('发生未处理的错误：', err);
  process.exit(1);
});
