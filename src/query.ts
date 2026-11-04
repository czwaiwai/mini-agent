/**
 * query.ts —— agent 主循环（参照 claude-code 的 src/query.ts）
 *
 * 这就是"agent"和"聊天机器人"的本质区别：
 * 聊天机器人：用户问 → 模型答 → 结束。
 * agent：     用户问 → 模型答或调工具 → 执行工具 → 结果喂回模型
 *            → 模型再答或再调工具 → ... 直到模型给出纯文本回复。
 *
 * claude-code 的 query() 是一个 `export async function* query()`，
 * while(true) 循环：callModel → 收集 tool_use → runTools → 回填
 * tool_result → continue。我们完全照这个结构来，只是把 Anthropic
 * 的 tool_use 块换成了 OpenAI 的 tool_calls。
 *
 * 【TS 知识点】async generator 作为"事件流"：主循环每发生一件事
 * （模型输出文字、开始调工具、工具返回结果）就 yield 一个事件，
 * UI 层用 for await 消费——UI 和主循环彻底解耦。
 */

import type { OpenAI } from 'openai';
import { z } from 'zod';
import { streamChat } from './agent/client.js';
import { findToolByName } from './tools.js';
import type { Tool } from './tools/Tool.js';
import type { AgentConfig, ChatMessage, ToolCall, ToolContext } from './types.js';

/** 工具输出给模型的最大长度（超出截断，防止单个工具撑爆上下文） */
const MAX_TOOL_OUTPUT_CHARS = 20_000;

/** 主循环对外吐出的事件（UI 层据此渲染） */
export type QueryEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; argsSummary: string }
  | { type: 'tool_result'; name: string; success: boolean; durationMs: number }
  | { type: 'done' };

export interface QueryParams {
  client: OpenAI;
  config: AgentConfig;
  /** 消息历史（唯一事实源）——本函数会直接往里 push，属"受控修改" */
  messages: ChatMessage[];
  tools: Tool[];
  context: ToolContext;
}

/** zod schema → OpenAI 的 JSON Schema 参数格式 */
function toolToOpenAIFormat(tool: Tool) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      // 【TS 知识点】zod v4 内置了 schema → JSON Schema 的转换，
      // schema 里的 .describe() 文字会变成 description 字段。
      // claude-code 里对应 utils/zodToJsonSchema.ts。
      parameters: z.toJSONSchema(tool.inputSchema),
    },
  };
}

/**
 * 执行单次工具调用：查找 → 解析参数 → 校验 → 执行。
 * 任何一步失败都返回"给模型看的错误信息"，绝不抛异常——
 * 抛异常会杀死整个主循环，而返回错误字符串能让模型自愈。
 * （对照 claude-code 的 runToolUse，src/services/tools/toolExecution.ts:337）
 */
async function executeToolCall(
  toolCall: ToolCall,
  tools: Tool[],
  context: ToolContext,
): Promise<string> {
  const tool = findToolByName(tools, toolCall.function.name);
  if (!tool) {
    return `错误：不存在名为 "${toolCall.function.name}" 的工具。可用工具：${tools
      .map((t) => t.name)
      .join(', ')}`;
  }

  // 解析 arguments —— 它是 JSON 字符串！模型可能给出非法 JSON
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(toolCall.function.arguments);
  } catch {
    return `错误：工具参数不是合法 JSON。收到的内容：${toolCall.function.arguments.slice(0, 200)}`;
  }

  // zod 校验：类型不对/缺字段/多字段都拦截在这
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return `错误：工具参数校验失败 - ${parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}`;
  }

  // 执行（有真实类型了！parsed.data 就是 z.infer 出来的形状）
  try {
    const result = await tool.call(parsed.data, context);
    let output = result.output;
    if (output.length > MAX_TOOL_OUTPUT_CHARS) {
      output = output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...（输出过长，已截断）';
    }
    return output;
  } catch (err) {
    return `错误：工具执行异常 - ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * agent 主循环。
 * 消费方式：`for await (const event of query({...})) { ... }`
 */
export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const { client, config, messages, tools, context } = params;
  const openAITools = tools.map(toolToOpenAIFormat);

  while (true) {
    // ── 第 1 步：调模型，流式收集这一轮的完整回复 ──
    let assistantMessage: ChatMessage | undefined;
    for await (const event of streamChat(client, config, messages)) {
      if (event.type === 'text_delta') {
        yield { type: 'text_delta', text: event.text };
      } else if (event.type === 'message_complete') {
        assistantMessage = event.message;
      }
      // 'done' 忽略，message_complete 才是我们要的
    }

    if (!assistantMessage) {
      yield { type: 'done' };
      return; // 流异常结束，防御性退出
    }

    // 【TS 知识点】类型收窄（narrowing）：ChatMessage 是四种消息的联合，
    // 直接访问 .tool_calls 会报错（system 消息没有这个字段）。
    // 但只要用 if 判断 role，TS 就把类型"收窄"到对应分支——
    // 判断过后 assistantMessage 一定是 assistant 消息，才允许访问 tool_calls。
    if (assistantMessage.role !== 'assistant') {
      yield { type: 'done' };
      return; // message_complete 只会产出 assistant 消息，这里是防御
    }

    // 2. 助手消息入历史（带 tool_calls 的也要入！）
    messages.push(assistantMessage);

    // ── 第 3 步：判断终止条件 ──
    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // 模型没有调用任何工具 = 纯文本回复 = 任务完成
      yield { type: 'done' };
      return;
    }

    // ── 第 4 步：执行所有工具，结果作为 role:'tool' 消息回填 ──
    // 【协议要点】tool 消息必须紧跟在这条 assistant 消息之后，
    // 且 tool_call_id 一一对应——顺序错了大多数兼容端点直接 400。
    for (const toolCall of toolCalls) {
      const startedAt = Date.now();
      let argsSummary = '';
      try {
        const parsed: unknown = JSON.parse(toolCall.function.arguments);
        argsSummary = JSON.stringify(parsed);
      } catch {
        argsSummary = toolCall.function.arguments.slice(0, 100);
      }
      // 参数摘要太长就截断（只影响 UI 显示）
      if (argsSummary.length > 120) argsSummary = argsSummary.slice(0, 120) + '...';
      yield { type: 'tool_start', name: toolCall.function.name, argsSummary };

      const output = await executeToolCall(toolCall, tools, context);
      const durationMs = Date.now() - startedAt;
      yield { type: 'tool_result', name: toolCall.function.name, success: !output.startsWith('错误'), durationMs };

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
    }

    // ── 第 5 步：continue 下一轮 → 模型看到工具结果，继续思考 ──
  }
}
