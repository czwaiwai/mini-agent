/**
 * index.ts —— REPL 入口（参照 claude-code 的 src/screens/REPL.tsx 的职责）
 *
 * claude-code 的 REPL 用 React + Ink 渲染，有 5000 行；我们的 MVP 用
 * Node 内置的 readline，几十行搞定同样的事：读用户输入 → 交给 agent →
 * 流式打印回复 → 继续等下一句。UI 层只做"展示"，不做任何业务逻辑——
 * 这个分层原则和 claude-code 完全一致。
 */

import * as readline from 'node:readline';
import { createClient, loadConfig, streamChatToConsole } from './agent/client.js';
import { getSystemPrompt } from './prompts.js';
import type { ChatMessage } from './types.js';

/**
 * 把 readline 的 question 回调风格包装成 Promise。
 *
 * 【TS 知识点】Promise 构造函数的参数是 `(resolve, reject)` 两个函数。
 * 这叫"回调转 Promise"，是从回调风格代码迁移到 async/await 的标准手法。
 */
function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient(config);

  /**
   * 【核心设计】messages 数组是整个 agent 的"唯一事实源"。
   * claude-code 里对应 QueryEngine.mutableMessages（src/QueryEngine.ts）：
   * 每次调用模型都把完整历史传过去，模型因此"记得"上文。
   * 后面所有的工具调用、上下文压缩，本质都是对这个数组的增删改。
   */
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt() },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`mini-agent 已启动（模型：${config.model}），输入 exit 退出。\n`);

  // 主循环：读一句 → 调模型 → 打印 → 存历史 → 下一句
  while (true) {
    let input: string;
    try {
      input = (await ask(rl, 'you> ')).trim();
    } catch {
      // stdin 关闭（Ctrl+D）时退出
      break;
    }

    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;

    // 1. 用户消息入历史
    messages.push({ role: 'user', content: input });

    // 2. 流式调用模型并打印
    process.stdout.write('agent> ');
    const reply = await streamChatToConsole(client, config, messages);

    // 3. 助手回复也入历史（下一轮模型才能"记得"自己说过什么）
    messages.push({ role: 'assistant', content: reply });
    console.log('');
  }

  rl.close();
  console.log('再见！');
  process.exit(0);
}

main().catch((err) => {
  console.error('发生未处理的错误：', err);
  process.exit(1);
});
