/**
 * Phase 3 冒烟测试（不需要 API Key）：
 * 覆盖 5 个工具 + 并发调度器
 */
import { readFileTool } from '../src/tools/read-file/ReadFileTool.js';
import { listDirTool } from '../src/tools/list-dir/ListDirTool.js';
import { globTool } from '../src/tools/glob/GlobTool.js';
import { writeFileTool } from '../src/tools/write-file/WriteFileTool.js';
import { bashTool } from '../src/tools/bash/BashTool.js';
import { getAllTools } from '../src/tools.js';
import { runToolCalls } from '../src/tools/orchestrate.js';
import type { ToolExecEvent } from '../src/tools/orchestrate.js';
import type { ToolCall } from '../src/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const projectDir = '/Users/waiwai/work/git/mini-agent';
const tmp = mkdtempSync(join(tmpdir(), 'mini-agent-test-'));
const ctx = { cwd: tmp };

// ── 1. read_file ──
const r1 = await readFileTool.call({ file_path: join(projectDir, 'package.json') }, { cwd: tmp });
check('read_file 读取文件', r1.type === 'success' && r1.output.includes('mini-agent'));
const r1b = await readFileTool.call({ file_path: 'no/such/file.txt' }, ctx);
check('read_file 错误返回 error 结果', r1b.type === 'error' && r1b.output.includes('无法读取'));

// ── 2. list_dir ──
const r2 = await listDirTool.call({ path: projectDir }, ctx);
check('list_dir 列出目录', r2.type === 'success' && r2.output.includes('src/'));
const r2b = await listDirTool.call({ path: join(tmp, 'nope') }, ctx);
check('list_dir 不存在目录报错', r2b.type === 'error');

// ── 3. glob ──
const r3 = await globTool.call({ pattern: 'src/**/*.ts', path: projectDir }, ctx);
check(
  'glob 匹配 src 下的 ts 文件',
  r3.type === 'success' && r3.output.includes('src/query.ts') && r3.output.includes('src/tools/Tool.ts'),
);
const r3b = await globTool.call({ pattern: '*.nonexistent-ext', path: tmp }, ctx);
check('glob 无匹配返回提示', r3b.type === 'success' && r3b.output.includes('没有匹配'));

// ── 4. write_file ──
const r4 = await writeFileTool.call({ file_path: join(tmp, 'a', 'b.txt'), content: 'hello' }, ctx);
check('write_file 写入（自动建父目录）', r4.type === 'success' && r4.output.includes('字节'));
const r4b = await readFileTool.call({ file_path: join(tmp, 'a', 'b.txt') }, ctx);
check('写后能读回', r4b.type === 'success' && r4b.output.includes('hello'));

// ── 5. bash ──
const r5 = await bashTool.call({ command: 'echo hello-bash' }, ctx);
check('bash 执行 echo', r5.type === 'success' && r5.output.includes('hello-bash'));
const r5b = await bashTool.call({ command: 'exit 3' }, ctx);
check('bash 非零退出码报错', r5b.type === 'error' && r5b.output.includes('3'));
const r5c = await bashTool.call({ command: 'echo "0123456789".repeat && yes | head -c 200000' }, ctx);
check('bash 超长输出被截断', r5c.type === 'success' && r5c.output.length < 30000);

// ── 6. isReadOnly 标志 ──
check(
  '只读标志正确',
  readFileTool.isReadOnly({ file_path: 'x' }) &&
    listDirTool.isReadOnly({}) &&
    globTool.isReadOnly({ pattern: 'x' }) &&
    !writeFileTool.isReadOnly({ file_path: 'x', content: '' }) &&
    !bashTool.isReadOnly({ command: 'ls' }),
);

// ── 7. 并发调度：3 个只读并发 + 1 个写串行 ──
function mkCall(id: string, name: string, args: object): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const calls: ToolCall[] = [
  mkCall('c1', 'bash', { command: 'sleep 0.3 && echo w1' }), // 写工具，独占第一批
  mkCall('c2', 'bash', { command: 'sleep 0.3 && echo r1' }), // 只读？bash 非只读……
];
// bash 是非只读，为了验证并发，用 glob/read 组合：
const concurrentCalls: ToolCall[] = [
  mkCall('g1', 'read_file', { file_path: join(projectDir, 'package.json') }),
  mkCall('g2', 'read_file', { file_path: join(projectDir, 'README.md') }),
  mkCall('g3', 'glob', { pattern: '*.json', path: projectDir }),
];

const events: ToolExecEvent[] = [];
const t0 = Date.now();
for await (const ev of runToolCalls(concurrentCalls, getAllTools(), { cwd: tmp })) {
  events.push(ev);
}
const elapsed = Date.now() - t0;

const starts = events.filter((e) => e.type === 'tool_start').length;
const msgs = events.filter((e) => e.type === 'tool_message');
check('并发批产生 3 个 tool_start', starts === 3);
check(
  '并发批产生 3 条 tool 消息且 id 匹配',
  msgs.length === 3 &&
    msgs.every((m) => m.type === 'tool_message' && m.message.role === 'tool' && ['g1', 'g2', 'g3'].includes(m.message.tool_call_id)),
);

// 并发验证：3 个本地操作通常 <100ms 总耗时；若串行执行也不会明显更长，
// 用真实 sleep 验证 —— 让 3 个 bash 并发跑（改用 orchestrate 层面不好绕过 bash 非只读），
// 改为直接对比：单个 read + sleep 0.3 的 bash 大约 300ms，串行 3 个只读近似 900ms
// （本地工具太快，这里只验证事件顺序正确性）：
const order = events.filter((e) => e.type === 'tool_result').map((e) => (e as { name: string }).name);
check(
  '结果按原始顺序回填',
  JSON.stringify(order) === JSON.stringify(['read_file', 'read_file', 'glob']),
  `实际: ${order.join(',')}`,
);
console.log(`  ℹ 并发批总耗时 ${elapsed}ms（本地工具极快，此数值仅作记录）`);

// ── 8. 混合批次：read + write + read → 应切成 [read并发批] [write] [read并发批] ──
const mixed: ToolCall[] = [
  mkCall('m1', 'read_file', { file_path: join(tmp, 'a', 'b.txt') }),
  mkCall('m2', 'write_file', { file_path: join(tmp, 'w.txt'), content: 'x' }),
  mkCall('m3', 'read_file', { file_path: join(tmp, 'a', 'b.txt') }),
];
const ev2: ToolExecEvent[] = [];
for await (const ev of runToolCalls(mixed, getAllTools(), { cwd: tmp })) ev2.push(ev);
const msgIds = ev2.filter((e) => e.type === 'tool_message').map((e) => (e as { message: { tool_call_id: string } }).message.tool_call_id);
check('混合批次全部执行且 id 顺序正确', JSON.stringify(msgIds) === JSON.stringify(['m1', 'm2', 'm3']), `实际: ${msgIds.join(',')}`);

// 清理
rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
