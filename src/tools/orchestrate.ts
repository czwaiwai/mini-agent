/**
 * tools/orchestrate.ts —— 工具并发调度
 * （参照 claude-code 的 src/services/tools/toolOrchestration.ts）
 *
 * claude-code 的策略：把模型一次返回的多个 tool_use 按
 * isConcurrencySafe 分批——**连续的**只读工具一批并发跑，
 * 写工具独占一批串行。为什么按"连续"分批而不是全局分组？
 * 为了保持执行顺序与模型给出的调用顺序一致——模型有时依赖
 * 前一个工具的结果决定后一个调用。
 *
 * 我们的简化版：isReadOnly(input) === true 且连续 → 并发一批，
 * 其余每个工具独占一批。
 */

import { executeToolCall } from './execute.js';
import type { Tool } from './Tool.js';
import type { ChatMessage, ToolCall, ToolContext } from '../types.js';
import type { PermissionManager } from '../permissions.js';

/** 调度过程吐给上层的事件 */
export type ToolExecEvent =
  | { type: 'tool_start'; name: string; argsSummary: string }
  | { type: 'tool_result'; name: string; success: boolean; durationMs: number }
  /** 一条完整的 role:'tool' 消息，调用方负责 push 进 messages */
  | { type: 'tool_message'; message: ChatMessage };

/** 生成 UI 用的参数摘要 */
function argsSummary(toolCall: ToolCall): string {
  let summary: string;
  try {
    summary = JSON.stringify(JSON.parse(toolCall.function.arguments));
  } catch {
    summary = toolCall.function.arguments;
  }
  return summary.length > 120 ? summary.slice(0, 120) + '...' : summary;
}

/** 把 tool_calls 切成批次：连续只读的一批，写工具独占一批 */
function partitionBatches(toolCalls: ToolCall[], tools: Tool[]): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let currentReadOnly: ToolCall[] = [];

  const flush = () => {
    if (currentReadOnly.length > 0) {
      batches.push(currentReadOnly);
      currentReadOnly = [];
    }
  };

  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.function.name);
    let readOnly = false;
    if (tool) {
      try {
        readOnly = tool.isReadOnly(JSON.parse(tc.function.arguments));
      } catch {
        readOnly = false; // 参数都解析不了，按最保守处理
      }
    }
    if (readOnly) {
      currentReadOnly.push(tc);
    } else {
      flush();
      batches.push([tc]); // 写工具独占一批
    }
  }
  flush();
  return batches;
}

/**
 * 执行一批工具调用（并发），按顺序 yield 每个的事件。
 * 并发执行但**结果按原始顺序**回填——顺序稳定让消息历史可预测。
 */
async function* runBatch(
  batch: ToolCall[],
  tools: Tool[],
  context: ToolContext,
  permissions?: PermissionManager,
): AsyncGenerator<ToolExecEvent> {
  if (batch.length === 1) {
    // 单工具：直接跑
    const tc = batch[0]!;
    const startedAt = Date.now();
    yield { type: 'tool_start', name: tc.function.name, argsSummary: argsSummary(tc) };
    const result = await executeToolCall(tc, tools, context, permissions);
    yield {
      type: 'tool_result',
      name: tc.function.name,
      success: result.type === 'success',
      durationMs: Date.now() - startedAt,
    };
    yield { type: 'tool_message', message: { role: 'tool', tool_call_id: tc.id, content: result.output } };
    return;
  }

  // 多工具并发：全部启动，然后按原始顺序逐个"收割"结果
  const startedAts = batch.map(() => Date.now());
  for (const tc of batch) {
    yield { type: 'tool_start', name: tc.function.name, argsSummary: argsSummary(tc) };
  }

  const promises = batch.map((tc) => executeToolCall(tc, tools, context, permissions));
  for (let i = 0; i < batch.length; i++) {
    const tc = batch[i]!;
    const result = await promises[i]!;
    yield {
      type: 'tool_result',
      name: tc.function.name,
      success: result.type === 'success',
      durationMs: Date.now() - startedAts[i]!,
    };
    yield { type: 'tool_message', message: { role: 'tool', tool_call_id: tc.id, content: result.output } };
  }
}

/** 调度入口：分批 → 逐批执行 */
export async function* runToolCalls(
  toolCalls: ToolCall[],
  tools: Tool[],
  context: ToolContext,
  permissions?: PermissionManager,
): AsyncGenerator<ToolExecEvent> {
  for (const batch of partitionBatches(toolCalls, tools)) {
    yield* runBatch(batch, tools, context, permissions);
  }
}
