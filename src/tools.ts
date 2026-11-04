/**
 * tools.ts —— 工具注册表（参照 claude-code 的 src/tools.ts）
 *
 * claude-code 的 getAllBaseTools() 是一个大数组，用条件展开
 * （feature flag / env）决定哪些工具可用，getTools() 再按权限过滤。
 * 我们 MVP 版本就是一个简单的数组 + 查找函数。
 *
 * 新增工具的流程：建 src/tools/<name>/ 目录 → 在这里 import 并加入数组。
 */

import type { Tool } from './tools/Tool.js';
import { readFileTool } from './tools/read-file/ReadFileTool.js';

/** 所有可用工具。模型只在请求里看到这里的工具。 */
export function getAllTools(): Tool[] {
  return [
    readFileTool,
    // Phase 3 在这里追加 list_dir / glob / write_file / bash
  ];
}

/** 按名字查找工具（对应 claude-code 的 findToolByName） */
export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
