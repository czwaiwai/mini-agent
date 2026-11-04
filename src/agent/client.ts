/**
 * agent/client.ts —— 模型 API 层（参照 claude-code 的 src/services/api/claude.ts）
 *
 * Phase 2 新增：流式接收 tool_calls。
 *
 * 【最大的坑】OpenAI 流式模式下，tool_calls 不是一次性到达的：
 * 每个 chunk 的 delta 里可能带 tool_calls 的一小片——第一次带
 * id 和函数名，之后每次带一小段 arguments 字符串，还可能一次
 * 返回多个工具调用（靠 index 区分）。必须自己按 index 累积拼接，
 * 流结束后才能得到完整的 tool_calls。
 * claude-code 处理 Anthropic 的 input_json_delta 时是同样的套路
 * （partial_json 累积，见 src/query.ts 的 StreamingToolExecutor）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI, { APIError } from 'openai';
import type { AgentConfig, ChatMessage, ToolCall } from '../types.js';

/** 极简 .env 加载器：环境变量 > .env 文件 > 默认值 */
function loadDotEnv(): void {
  try {
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
    // .env 不存在也没关系
  }
}

export function loadConfig(): AgentConfig {
  loadDotEnv();
  const apiKey = process.env.MINI_AGENT_API_KEY;
  if (!apiKey) {
    console.error(
      '缺少 API Key。请在项目根目录创建 .env（参考 .env.example），或设置环境变量：\n' +
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

export function createClient(config: AgentConfig): OpenAI {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
}

/** 消息历史 → OpenAI API 参数。形状已对齐，不再需要 `as` 断言。 */
function toApiMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages;
}

/**
 * 流式消费一整轮模型输出，结束后 yield 完整的助手消息。
 *
 * 【TS 知识点】泛型 + 工具调用累积。
 * 返回的事件流：过程中不断 yield text_delta（给 UI 打印用），
 * 流结束 yield message_complete（带完整的 content + tool_calls）。
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_complete'; message: ChatMessage }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | { type: 'done' };

/**
 * ── 重试机制（参照 claude-code 的 src/services/api/withRetry.ts）──
 *
 * claude-code 的 withRetry 是一个 async generator：每次尝试 yield 一次
 * 进度，指数退避，尊重 Retry-After 头。它的注释很有教学价值：
 * "default to no-retry — add here only if the user is waiting on the result"
 * （默认不重试——只有用户在等结果的场景才加重试）。
 *
 * 我们的重试范围：只覆盖"建立流连接"这一步。一旦流建立、开始吐字，
 * 中途断掉就不重试了（否则已打印的内容会重复）——这是流式 + 重试
 * 的经典取舍，claude-code 的非流式 fallback 也是类似思路。
 */

const MAX_RETRIES = 3;

/** 判断一个错误是否值得重试：429/5xx/超时/网络错误值得，4xx 参数错误不值得 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof APIError) {
    const status = err.status;
    if (status === undefined) return true; // 无状态码的 API 错误（如连接失败）
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  const name = (err as { name?: string }).name;
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError';
}

/** 计算退避延迟：优先用服务器的 Retry-After，否则指数退避 + 随机抖动 */
export function getRetryDelay(err: unknown, attempt: number): number {
  if (err instanceof APIError) {
    // 【TS 知识点】headers 是 Fetch API 的 Headers 对象，
    // 取值要用 .get() 方法，不能用下标
    const retryAfter = err.headers?.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, 60_000);
    }
  }
  // 指数退避：1s → 2s → 4s...，加 0~500ms 随机抖动避免同时重试踩踏
  return Math.min(1000 * 2 ** attempt + Math.random() * 500, 30_000);
}

/** 支持 AbortSignal 的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** 用于按 index 累积一个正在"生长"的 tool_call */
interface PartialToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export async function* streamChat(
  client: OpenAI,
  config: AgentConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // ── 建立流连接（带重试）──
  let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
  for (let attempt = 0; ; attempt++) {
    try {
      stream = await client.chat.completions.create(
        {
          model: config.model,
          messages: toApiMessages(messages) as Parameters<
            typeof client.chat.completions.create
          >[0]['messages'],
          stream: true,
        },
        // signal 传给底层 fetch：abort 时请求立刻取消
        { signal },
      );
      break;
    } catch (err) {
      // 用户主动中断 → 不重试，直接抛出（上层会识别 AbortError）
      if (signal?.aborted) throw err;
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      const delayMs = getRetryDelay(err, attempt);
      const reason = err instanceof Error ? err.message : String(err);
      yield { type: 'retry', attempt: attempt + 1, maxRetries: MAX_RETRIES, delayMs, reason };
      await sleep(delayMs, signal);
    }
  }

  let content = '';
  // 累积中的 tool_calls：key 是流里的 index（一个回复可能调多个工具）
  const toolCalls = new Map<number, PartialToolCall>();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // 1. 文本片段：立即吐给 UI
    if (delta.content) {
      content += delta.content;
      yield { type: 'text_delta', text: delta.content };
    }

    // 2. 工具调用片段：按 index 累积
    for (const tc of delta.tool_calls ?? []) {
      const existing = toolCalls.get(tc.index);
      if (!existing) {
        // 这个 tool_call 的第一个片段：带 id 和函数名
        toolCalls.set(tc.index, {
          id: tc.id ?? '',
          function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
        });
      } else {
        // 后续片段：arguments 继续追加
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        if (tc.function?.name) existing.function.name += tc.function.name;
      }
    }
  }

  // 流结束：把累积结果组装成完整的 assistant 消息
  if (toolCalls.size > 0) {
    const calls: ToolCall[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b) // 按 index 排序，保持模型给出的调用顺序
      .map(([, tc]) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    yield {
      type: 'message_complete',
      message: { role: 'assistant', content: content || null, tool_calls: calls },
    };
  } else {
    yield {
      type: 'message_complete',
      message: { role: 'assistant', content },
    };
  }
  yield { type: 'done' };
}
