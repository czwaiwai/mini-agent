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

/**
 * 【TS 知识点】把回调风格的 exec 包装成 Promise。
 * exec 的回调是 (error, stdout, stderr)，error 上还挂着
 * 退出码等附加信息——TS 会推推断出 err 的类型，我们用
 * 类型守卫（instanceof）安全地取字段。
 */
function execPromise(command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: process.cwd(), timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({ stdout, stderr, code: err ? code : 0 });
      },
    );
  });
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n...（输出超过 ${MAX_OUTPUT_CHARS} 字符，已截断）`;
}

export const bashTool = defineTool({
  name: 'bash',
  description: BASH_DESCRIPTION,
  inputSchema,
  // 非只读：写操作（即使只跑 git status，shell 能力本身就是双刃剑）

  async call(input) {
    const { stdout, stderr, code } = await execPromise(input.command);

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
