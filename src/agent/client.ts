/**
 * agent/client.ts —— 模型 API 层（参照 claude-code 的 src/services/api/claude.ts）
 *
 * claude-code 里这一层负责：构造 API 请求、流式消费、重试、错误分类。
 * 它被注入到主循环里（见 src/query/deps.ts 的依赖注入模式），
 * 让"主循环逻辑"和"怎么调 API"彻底解耦。
 *
 * 我们 Phase 1 先做最核心的两件事：创建客户端 + 流式对话。
 * 重试留给 Phase 5。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentConfig, ChatMessage, StreamEvent } from '../types.js';

/**
 * 极简 .env 加载器：启动时把项目根目录 .env 文件里的
 * KEY=value 行注入 process.env（已存在的环境变量优先，不覆盖）。
 * 免去安装 dotenv 依赖，也顺便演示"读文件"这个最基础的能力。
 */
function loadDotEnv(): void {
  try {
    // 【TS 知识点】`import.meta.url` 是 ESM 模块里"当前文件"的 URL，
    // `fileURLToPath` 把它转成普通路径。CommonJS 里对应的写法是
    // `__dirname`，ESM 里没有了，得这样拼出来。
    const here = dirname(fileURLToPath(import.meta.url)); // <root>/src/agent
    const envPath = join(here, '..', '..', '.env'); // <root>/.env
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env 不存在也没关系，环境变量照样能用
  }
}

export function loadConfig(): AgentConfig {
  loadDotEnv();
  const apiKey = process.env.MINI_AGENT_API_KEY;
  if (!apiKey) {
    console.error(
      '缺少 API Key。请设置环境变量：\n' +
        '  export MINI_AGENT_API_KEY=sk-xxx\n' +
        '可选：MINI_AGENT_BASE_URL（默认 DeepSeek）、MINI_AGENT_MODEL（默认 deepseek-chat）',
    );
    process.exit(1);
  }
  return {
    apiKey,
    baseURL: process.env.MINI_AGENT_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.MINI_AGENT_MODEL ?? 'deepseek-chat',
  };
}

/** 创建 OpenAI 兼容客户端。换成 GLM/Kimi 等只需改 baseURL 和 model。 */
export function createClient(config: AgentConfig): OpenAI {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
}

/**
 * 流式对话：发送全部消息，逐段 yield 模型输出的文本。
 *
 * 【TS 知识点】async generator —— 本项目最重要的抽象！
 * - `async function*` 声明一个"异步生成器"：它能一边执行一边"吐出"多个值，
 *   调用方用 `for await (const x of gen())` 逐个接收。
 * - `yield` 就是"吐出一个值"，吐完后函数**暂停**，等下一次被要值才继续。
 * - claude-code 的整个 agent 主循环（src/query.ts）就是一个
 *   `export async function* query()`，用同样的方式把每一轮的
 *   模型输出、工具执行进度源源不断"流"给 UI 层渲染。
 * - 为什么用它？因为 agent 运行过程中 UI 需要实时知道发生了什么
 *   （打字了、调工具了），async generator 天然适合"边生产边消费"。
 */
export async function* streamChat(
  client: OpenAI,
  config: AgentConfig,
  messages: ChatMessage[],
): AsyncGenerator<StreamEvent> {
  // 向兼容端点发起流式请求。`stream: true` 是关键：
  // 返回的不是一次性结果，而是一个可以逐块读取的"流"。
  //
  // 【TS 知识点】这里要先做一次类型转换（`as`）：
  // OpenAI SDK 要求的消息类型是"可辨识联合"——`role: 'tool'` 的消息
  // 必须带 `tool_call_id` 字段，`role: 'assistant'` 的必须带
  // `tool_calls`。而我们的简化版 ChatMessage 只有 role + content。
  // Phase 2 引入工具后，我们会让类型定义向 SDK 靠拢，届时删掉 `as`。
  // `as` 的含义是"我比编译器更清楚这个值的类型"，用多了会失去
  // 类型保护，所以只允许出现在这种"有明确理由"的边界处。
  const apiMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  })) as ChatCompletionMessageParam[];

  const stream = await client.chat.completions.create({
    model: config.model,
    messages: apiMessages,
    stream: true,
  });

  // for await：异步地逐个取出每个 chunk（一小段 JSON）
  for await (const chunk of stream) {
    // 【TS 知识点】可选链 `?.`：chunk.choices[0] 可能是 undefined
    // （某些兼容端点会发空 chunk），`?.` 会在 undefined 时直接返回
    // undefined 而不是抛错。`?? ''` 兜底为空字符串。
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (delta) {
      yield { type: 'text_delta', text: delta };
    }
  }

  yield { type: 'done' };
}

/**
 * 流式对话的"便捷封装"：边打印边把完整文本拼出来。
 * REPL 层调用它，就不用自己关心流的事件细节了。
 */
export async function streamChatToConsole(
  client: OpenAI,
  config: AgentConfig,
  messages: ChatMessage[],
): Promise<string> {
  let full = '';
  for await (const event of streamChat(client, config, messages)) {
    if (event.type === 'text_delta') {
      full += event.text;
      // 不换行地实时打印（流式打字机效果）
      process.stdout.write(event.text);
    }
  }
  process.stdout.write('\n');
  return full;
}
