/**
 * tools/list-dir/ListDirTool.ts —— 列目录工具
 * 参照 claude-code 的 src/tools/LS/（LS 工具）：只读、可并发
 */

import { readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../Tool.js';
import { LIST_DIR_DESCRIPTION } from './prompt.js';

const inputSchema = z.strictObject({
  path: z
    .string()
    .describe('要列出的目录路径（默认当前目录）')
    .optional(),
});

export const listDirTool = defineTool({
  name: 'list_dir',
  description: LIST_DIR_DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,

  async call(input, context) {
    const dirPath = input.path ?? '.';
    const absolutePath = isAbsolute(dirPath) ? dirPath : join(context.cwd, dirPath);

    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { type: 'error', output: `无法列出目录 ${dirPath}：${reason}` };
    }

    if (entries.length === 0) {
      return { type: 'success', output: `${absolutePath} 是空目录` };
    }

    // 排序：目录在前，按名称
    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const lines = sorted.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { type: 'success', output: `${absolutePath}（${lines.length} 项）：\n${lines.join('\n')}` };
  },
});
