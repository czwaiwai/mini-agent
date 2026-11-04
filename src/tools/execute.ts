/**
 * tools/execute.ts —— 单次工具调用执行链
 * （从 query.ts 抽出，参照 claude-code 的
 * src/services/tools/toolExecution.ts 的 runToolUse）
 *
 * 四步：查找 → JSON.parse → zod 校验 → 执行。
 * 任何一步失败都返回 type:'error' 结果，绝不抛异常——
 * 让模型读到错误后自愈，而不是杀死主循环。
 */

import { findToolByName } from '../tools.js';
import type { Tool, ToolResult } from './Tool.js';
import type { ToolCall, ToolContext } from '../types.js';

/** 工具输出给模型的最大长度（超出截断，防止单个工具撑爆上下文） */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export async function executeToolCall(
  toolCall: ToolCall,
  tools: Tool[],
  context: ToolContext,
): Promise<ToolResult> {
  const tool = findToolByName(tools, toolCall.function.name);
  if (!tool) {
    return {
      type: 'error',
      output: `错误：不存在名为 "${toolCall.function.name}" 的工具。可用工具：${tools
        .map((t) => t.name)
        .join(', ')}`,
    };
  }

  // arguments 是 JSON 字符串！模型可能产出非法 JSON
  let rawInput: unknown;
  try {
    rawInput = JSON.parse(toolCall.function.arguments);
  } catch {
    return {
      type: 'error',
      output: `错误：工具参数不是合法 JSON。收到的内容：${toolCall.function.arguments.slice(0, 200)}`,
    };
  }

  // zod 校验：类型不对/缺字段/多字段都拦截在这
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      type: 'error',
      output: `错误：工具参数校验失败 - ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    };
  }

  try {
    const result = await tool.call(parsed.data, context);
    if (result.output.length > MAX_TOOL_OUTPUT_CHARS) {
      result.output =
        result.output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...（输出过长，已截断）';
    }
    return result;
  } catch (err) {
    return { type: 'error', output: `错误：工具执行异常 - ${err instanceof Error ? err.message : String(err)}` };
  }
}
