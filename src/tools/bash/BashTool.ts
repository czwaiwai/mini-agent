/**
 * tools/bash/BashTool.ts —— 执行 shell 命令工具
 * 参照 claude-code 的 src/tools/BashTool/。claude-code 的实现有
 * 持久 shell 会话、权限前缀匹配（Bash(git *)）等复杂机制，
 * 我们取最核心的部分，但**三个安全阀一个不少**：
 * 1. 超时上限（30s）—— 防止挂死
 * 2. 输出截断 —— 防止一个 cat 大文件撑爆上下文
 * 3. 非只读标记 —— 写操作走权限确认（Phase 4）
 */

import { exec } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../Tool.js';
import { BASH_DESCRIPTION } from './prompt.js';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

const inputSchema = z.strictObject({
  command: z.string().describe('要执行的 shell 命令'),
});

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n...（输出超过 ${MAX_OUTPUT_CHARS} 字符，已截断）`;
}

export const bashTool = defineTool({
  name: 'bash',
  description: BASH_DESCRIPTION,
  inputSchema,
  // 非只读：写操作（即使只跑 git status，shell 能力本身就是双刃剑）

  // 工具级权限声明：把要跑的命令原样展示给用户
  checkPermissions: (input) => ({
    behavior: 'ask',
    message: `允许执行命令吗？\n  $ ${input.command}`,
  }),

  async call(input, context) {
    // signal：用户 Ctrl+C 时立刻终止子进程（对应 claude-code 的
    // abort 传播——中断不能只停模型调用，工具也要能停）
    const { stdout, stderr, code, killed } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      killed: boolean;
    }>((resolve) => {
      exec(
        input.command,
        {
          cwd: context.cwd,
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          signal: context.signal,
        },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              stdout,
              stderr,
              code: typeof err.code === 'number' ? err.code : 1,
              killed: err.killed === true,
            });
          } else {
            resolve({ stdout, stderr, code: 0, killed: false });
          }
        },
      );
    });

    if (killed) {
      return { type: 'error', output: '错误：命令被用户中断。' };
    }

    if (code !== 0) {
      return {
        type: 'error',
        output: `命令退出码 ${code}。\nstdout:\n${truncate(stdout)}\nstderr:\n${truncate(stderr)}`,
      };
    }
    const parts = [stdout && `stdout:\n${truncate(stdout)}`, stderr && `stderr:\n${truncate(stderr)}`]
      .filter(Boolean)
      .join('\n');
    return { type: 'success', output: parts || '（命令执行成功，无输出）' };
  },
});
