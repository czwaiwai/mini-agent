/**
 * tools/glob/GlobTool.ts —— 文件模式匹配工具
 * 参照 claude-code 的 src/tools/GlobTool/：zod schema 结构几乎一致
 * （pattern + 可选 path）。claude-code 底层用 ripgrep 二进制，
 * 我们用 Node 22 内置的 fs.globSync，零依赖。
 */

import { globSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../Tool.js';
import { GLOB_DESCRIPTION } from './prompt.js';

const inputSchema = z.strictObject({
  pattern: z.string().describe('glob 匹配模式，如 **/*.ts'),
  path: z.string().describe('搜索的根目录（默认当前目录）').optional(),
});

// 单次返回上限：防御模型的 `**/*` 全仓库扫描
const MAX_RESULTS = 200;

export const globTool = defineTool({
  name: 'glob',
  description: GLOB_DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,

  async call(input, context) {
    const rootDir = input.path ?? '.';
    const absoluteRoot = isAbsolute(rootDir) ? rootDir : join(context.cwd, rootDir);

    let matches: string[];
    try {
      // globSync 返回匹配的路径数组
      matches = globSync(input.pattern, { cwd: absoluteRoot });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { type: 'error', output: `glob 模式无效：${reason}` };
    }

    const sorted = matches.sort();
    if (sorted.length === 0) {
      return { type: 'success', output: `没有匹配 "${input.pattern}" 的文件` };
    }

    const truncated = sorted.length > MAX_RESULTS;
    const shown = truncated ? sorted.slice(0, MAX_RESULTS) : sorted;
    const header = truncated
      ? `共 ${sorted.length} 个匹配（只显示前 ${MAX_RESULTS} 个，请收窄模式）：`
      : `共 ${sorted.length} 个匹配：`;
    return { type: 'success', output: `${header}\n${shown.join('\n')}` };
  },
});
