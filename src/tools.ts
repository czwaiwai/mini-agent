/**
 * tools.ts —— 工具注册表（参照 claude-code 的 src/tools.ts）
 *
 * 新增工具的流程：建 src/tools/<name>/ 目录 → 在这里 import 并加入数组。
 */

import type { Tool } from './tools/Tool.js';
import { readFileTool } from './tools/read-file/ReadFileTool.js';
import { listDirTool } from './tools/list-dir/ListDirTool.js';
import { globTool } from './tools/glob/GlobTool.js';
import { writeFileTool } from './tools/write-file/WriteFileTool.js';
import { bashTool } from './tools/bash/BashTool.js';

/** 所有可用工具。模型只在请求里看到这里的工具。 */
export function getAllTools(): Tool[] {
  return [
    readFileTool,
    listDirTool,
    globTool,
    writeFileTool,
    bashTool,
    // Phase 4 之后如需新工具在这里追加
  ];
}

/** 按名字查找工具（对应 claude-code 的 findToolByName） */
export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
