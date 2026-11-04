/**
 * query.ts —— agent 主循环（参照 claude-code 的 src/query.ts）
 *
 * agent 与聊天机器人的本质区别：
 * 聊天机器人：用户问 → 模型答 → 结束。
 * agent：     用户问 → 模型答或调工具 → 执行工具 → 结果喂回模型
 *            → 模型再答或再调工具 → ... 直到模型给出纯文本回复。
 *
 * claude-code 的 query() 是一个 `export async function* query()`，
 * while(true) 循环：callModel → 收集 tool_use → runTools → 回填
 * tool_result → continue。我们照这个结构，工具调用格式用 OpenAI 的
 * tool_calls，执行调度交给 tools/orchestrate.ts（只读并发、写串行）。
 */

import type { OpenAI } from 'openai';
import { z } from 'zod';
import { streamChat } from './agent/client.js';
import { runToolCalls } from './tools/orchestrate.js';
import { compactMessages, getCompactionThreshold, shouldCompact } from './compact.js';
import { estimateMessagesTokens } from './tokenEstimator.js';
import type { Tool } from './tools/Tool.js';
import type { AgentConfig, ChatMessage, ToolContext } from './types.js';
import type { PermissionManager } from './permissions.js';

/** 主循环对外吐出的事件（UI 层据此渲染） */
export type QueryEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; argsSummary: string }
  | { type: 'tool_result'; name: string; success: boolean; durationMs: number }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | { type: 'compacting'; estimatedTokens: number; threshold: number }
  | { type: 'compacted'; beforeTokens: number; afterTokens: number }
  | { type: 'interrupted' }
  | { type: 'done' };

export interface QueryParams {
  client: OpenAI;
  config: AgentConfig;
  /** 消息历史（唯一事实源）——本函数会直接往里 push，属"受控修改" */
  messages: ChatMessage[];
  tools: Tool[];
  context: ToolContext;
  /** 权限管理器（不传则不做权限检查——仅测试用） */
  permissions?: PermissionManager;
  /** 中断信号：用户 Ctrl+C 时 abort 当前轮 */
  signal?: AbortSignal;
}

/** zod schema → OpenAI 的 JSON Schema 参数格式 */
function toolToOpenAIFormat(tool: Tool) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      // zod v4 内置 schema → JSON Schema 转换（.describe() 文字带给模型）
      // claude-code 里对应 utils/zodToJsonSchema.ts
      parameters: z.toJSONSchema(tool.inputSchema),
    },
  };
}

/**
 * agent 主循环。
 * 消费方式：`for await (const event of query({...})) { ... }`
 */
export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const { client, config, messages, tools, context, permissions, signal } = params;
  const openAITools = tools.map(toolToOpenAIFormat);

  while (true) {
    // ── 第 0 步：上下文压缩检查（参照 claude-code 的 auto-compact）──
    // 估算超过阈值就压缩：旧消息换成摘要，messages 原地更新。
    // 注意此时可能刚回填完 tool 结果——压缩器会保证工具组不被切开。
    const threshold = getCompactionThreshold();
    if (shouldCompact(messages, threshold)) {
      const beforeTokens = estimateMessagesTokens(messages);
      yield { type: 'compacting', estimatedTokens: beforeTokens, threshold };
      const compacted = await compactMessages(client, config, messages, signal);
      if (compacted) {
        messages.splice(0, messages.length, ...compacted);
        yield { type: 'compacted', beforeTokens, afterTokens: estimateMessagesTokens(messages) };
      }
    }

    // ── 第 1 步：调模型，流式收集这一轮的完整回复 ──
    let assistantMessage: ChatMessage | undefined;
    try {
      for await (const event of streamChat(client, config, messages, signal)) {
        if (event.type === 'text_delta') {
          yield { type: 'text_delta', text: event.text };
        } else if (event.type === 'message_complete') {
          assistantMessage = event.message;
        } else if (event.type === 'retry') {
          yield event; // 重试进度透传给 UI
        }
      }
    } catch (err) {
      // 用户中断 → 优雅结束本轮（不是错误）
      if (signal?.aborted) {
        yield { type: 'interrupted' };
        return;
      }
      throw err; // 其他错误照常抛出，由 REPL 层展示
    }

    if (!assistantMessage) {
      yield { type: 'done' };
      return; // 流异常结束，防御性退出
    }

    // 【TS 知识点】类型收窄：判断 role 后才能访问 .tool_calls
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

    // 中断保护：如果用户在模型输出期间按了 Ctrl+C，此刻再执行工具
    // 就没意义了。而且必须把刚 push 的 assistant 消息回滚——
    // 否则历史里会留下"有 tool_calls 却没有对应 tool 结果"的悬空
    // 消息，下一轮请求会因协议不完整被服务端拒绝（400）。
    if (signal?.aborted) {
      messages.pop();
      yield { type: 'interrupted' };
      return;
    }

    // ── 第 4 步：调度执行所有工具（只读并发、写串行），结果回填 ──
    // 【协议要点】tool 消息必须紧跟在这条 assistant 消息之后，
    // 且 tool_call_id 一一对应——顺序错了大多数兼容端点直接 400。
    for await (const event of runToolCalls(toolCalls, tools, context, permissions)) {
      if (event.type === 'tool_message') {
        messages.push(event.message);
      } else {
        yield event;
      }
    }

    // ── 第 5 步：continue 下一轮 → 模型看到工具结果，继续思考 ──
  }
}
