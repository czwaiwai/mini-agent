/**
 * tools/read-file/ReadFileTool.ts —— 第一个工具：读文件
 *
 * 参照 claude-code 的 src/tools/FileReadTool/FileReadTool.ts：
 * - zod schema 声明输入（.describe() 的文字会进入 JSON Schema 给模型看）
 * - call() 只负责干活，不负责校验（校验在主循环统一做）
 * - 错误不抛异常，而是返回 success: false 的结果——让模型看到错误后
 *   自己调整策略（自愈），这是 agent 工具设计的黄金法则
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../Tool.js';
import { READ_FILE_DESCRIPTION } from './prompt.js';

const MAX_LINES = 2000;

/**
 * 【TS 知识点】zod schema：运行时的"数据形状验证器"。
 * - `z.string().describe('...')`：字符串字段，describe 写给模型看
 * - `z.strictObject({...})`：严格模式对象——模型多传字段会报错，
 *   帮模型尽早暴露错误（claude-code 也用 z.strictObject）
 * - 下面 call() 里的 input 参数**不需要任何类型注解**：
 *   defineTool 的泛型会从 inputSchema 自动推断出
 *   `{ file_path: string }`——这就是 z.infer 的魔力
 */
const inputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('要读取的文件路径（绝对路径，或相对当前目录的路径）'),
});

export const readFileTool = defineTool({
  name: 'read_file',
  description: READ_FILE_DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,

  async call(input, context) {
    // 解析为绝对路径：相对路径以 cwd 为基准
    const absolutePath = isAbsolute(input.file_path)
      ? input.file_path
      : join(context.cwd, input.file_path);

    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch (err) {
      // 把错误变成"给模型看的信息"而不是崩溃
      const reason = err instanceof Error ? err.message : String(err);
      return { type: 'error', output: `无法读取文件 ${input.file_path}：${reason}` };
    }

    const lines = content.split('\n');
    if (lines.length > MAX_LINES) {
      return {
        type: 'success',
        output: `${absolutePath} 的前 ${MAX_LINES} 行（共 ${lines.length} 行，已截断）：\n${lines
          .slice(0, MAX_LINES)
          .join('\n')}`,
      };
    }

    return { type: 'success', output: `${absolutePath} 的内容：\n${content}` };
  },
});
