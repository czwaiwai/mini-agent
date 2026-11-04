/**
 * tools/Tool.ts —— 工具接口定义（参照 claude-code 的 src/Tool.ts）
 *
 * claude-code 的 Tool 接口有 300+ 行，包含权限、UI 渲染、并发安全等
 * 十几个方法。我们借用它**最核心的骨架**：
 *
 *   name          —— 工具名（模型用它来调用）
 *   description   —— 给模型看的说明（质量决定模型用得好不好！）
 *   inputSchema   —— zod schema：既做运行时校验，又自动生成 JSON Schema
 *   call()        —— 真正干活
 *   isReadOnly()  —— 只读工具可以并发执行、不弹权限确认（Phase 3/4 用）
 *
 * 【TS 知识点】泛型（generics）：`Tool<TInput extends z.ZodType>` 里的
 * `<...>` 是"类型参数"。`extends z.ZodType` 是"泛型约束"——要求传入的
 * 类型必须是 zod schema。好处：`z.infer<TInput>` 能从 schema 反推出
 * call() 收到的参数类型，**schema 改了，参数类型自动跟着改**，
 * 这就是"schema 即类型来源"，claude-code 的 inputSchema 也是这么用的。
 */

import type { z } from 'zod';
import type { ToolContext } from '../types.js';

/** 工具执行结果。Phase 3 会升级为可辨识联合。 */
export interface ToolResult {
  success: boolean;
  /** 给模型看的内容（会作为 tool result 发回去） */
  output: string;
}

/**
 * 工具定义接口。
 * 【TS 知识点】`readonly`：字段一旦初始化不能再赋值，防止运行时
 * 意外改掉 schema。
 */
export interface Tool<TInput extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  isReadOnly(input: z.infer<TInput>): boolean;
  call(input: z.infer<TInput>, context: ToolContext): Promise<ToolResult>;
}

/**
 * 工具定义工厂（参照 claude-code 的 buildTool，src/Tool.ts:783）。
 *
 * 为什么要工厂函数而不直接写对象字面量？——**类型推断的接力**：
 * 你传入 inputSchema 的那一刻，TInput 就被锁定为这个 schema 的类型，
 * call() 的 input 参数自动变成 z.infer 出来的精确类型。
 * 如果直接手写 `Tool<SomeZod>` 注解，反而要手动指定泛型，麻烦。
 */
export function defineTool<TInput extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: TInput;
  isReadOnly?: (input: z.infer<TInput>) => boolean;
  call: (input: z.infer<TInput>, context: ToolContext) => Promise<ToolResult>;
}): Tool<TInput> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    // 【TS 知识点】默认值兜底：不声明 isReadOnly 就当"非只读"处理，
    // 对应 claude-code TOOL_DEFAULTS 的 fail-closed 原则——
    // 默认按更保守的方式对待工具。
    isReadOnly: def.isReadOnly ?? (() => false),
    call: def.call,
  };
}
