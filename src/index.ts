/**
 * index.ts —— REPL 入口（参照 claude-code 的 src/screens/REPL.tsx 的职责）
 *
 * Phase 2 的变化：REPL 不再直接调 streamChatToConsole，
 * 而是消费 query() 主循环吐出的事件流——UI 彻底变成"事件渲染器"。
 * 这正是 claude-code 的 REPL.tsx 消费 query() 生成器的方式。
 */

import * as readline from 'node:readline';
import { createClient, loadConfig } from './agent/client.js';
import { query } from './query.js';
import { getSystemPrompt } from './prompts.js';
import { getAllTools } from './tools.js';
import type { ChatMessage } from './types.js';

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);
  const tools = getAllTools();

  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt() },
  ];

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
    for await (const event of query({ client, config, messages, tools, context: { cwd: process.cwd() } })) {
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
