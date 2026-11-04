/**
 * Phase 2 冒烟测试（不需要 API Key）：
 * 验证工具定义 → 执行 → 错误处理 → JSON Schema 转换 全链路
 */
import { readFileTool } from '../src/tools/read-file/ReadFileTool.js';
import { getAllTools, findToolByName } from '../src/tools.js';
import { z } from 'zod';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const ctx = { cwd: '/Users/waiwai/work/git/mini-agent' };

// 1. 正常读取
const r1 = await readFileTool.call({ file_path: 'package.json' }, ctx);
check('read_file 读取 package.json', r1.success && r1.output.includes('mini-agent'));

// 2. 读取不存在的文件 → 错误以字符串返回（模型可自愈）
const r2 = await readFileTool.call({ file_path: 'no/such/file.txt' }, ctx);
check('read_file 不存在文件返回错误信息', !r2.success && r2.output.includes('无法读取'));

// 3. zod 校验：多传字段应被 strictObject 拦截（模拟主循环行为）
const parsed = readFileTool.inputSchema.safeParse({ file_path: 'a.txt', extra: 1 });
check('strictObject 拒绝多余字段', !parsed.success);

// 4. 缺字段被拦截
const parsed2 = readFileTool.inputSchema.safeParse({});
check('缺少 file_path 被拦截', !parsed2.success);

// 5. JSON Schema 转换（发模型请求时用）
const jsonSchema = z.toJSONSchema(readFileTool.inputSchema);
check('zod → JSON Schema 包含 description', jsonSchema.type === 'object' && JSON.stringify(jsonSchema).includes('要读取的文件路径'));

// 6. 注册表查找
check('findToolByName 命中', findToolByName(getAllTools(), 'read_file') === readFileTool);
check('findToolByName 未命中返回 undefined', findToolByName(getAllTools(), 'nope') === undefined);

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
