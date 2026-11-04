/**
 * tools/write-file/WriteFileTool.ts —— 写文件工具
 * 参照 claude-code 的 src/tools/FileWriteTool/：
 * - 非只读（要弹权限确认、不能并发）
 * - claude-code 强制"读过才能改"（readFileState），我们 MVP 先不做，
 *   Phase 4 权限机制时再补
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../Tool.js';
import { WRITE_FILE_DESCRIPTION } from './prompt.js';

const inputSchema = z.strictObject({
  file_path: z.string().describe('要写入的文件路径'),
  content: z.string().describe('要写入的完整文件内容'),
});

export const writeFileTool = defineTool({
  name: 'write_file',
  description: WRITE_FILE_DESCRIPTION,
  inputSchema,
  // 不写 isReadOnly —— defineTool 默认按"非只读"处理（fail-closed）

  // 工具级权限声明：给用户看清楚要改哪个文件
  checkPermissions: (input) => ({
    behavior: 'ask',
    message: `允许写入文件 ${input.file_path} 吗？（将覆盖原有内容）`,
  }),

  async call(input, context) {
    const absolutePath = isAbsolute(input.file_path)
      ? input.file_path
      : join(context.cwd, input.file_path);

    try {
      // 父目录不存在时自动创建（便利性 > 严格性，MVP 取舍）
      const parentDir = dirname(absolutePath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(absolutePath, input.content, 'utf8');
      return {
        type: 'success',
        output: `已写入 ${absolutePath}（${Buffer.byteLength(input.content, 'utf8')} 字节）`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { type: 'error', output: `写入文件失败：${reason}` };
    }
  },
});
