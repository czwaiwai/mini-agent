/**
 * Phase 4 冒烟测试：权限机制（不需要 API Key / 终端交互）
 * 用注入假 askUser 的方式验证 PermissionManager 全部路径
 */
import { PermissionManager } from '../src/permissions.js';
import type { UserAnswer, AskUserFn } from '../src/permissions.js';
import { getAllTools } from '../src/tools.js';
import { findToolByName } from '../src/tools.js';
import { executeToolCall } from '../src/tools/execute.js';
import type { ToolCall } from '../src/types.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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

const tmp = mkdtempSync(join(tmpdir(), 'mini-agent-perm-'));
const ctx = { cwd: tmp };
const tools = getAllTools();
const writeFileTool = findToolByName(tools, 'write_file')!;
const bashTool = findToolByName(tools, 'bash')!;
const readFileTool = findToolByName(tools, 'read_file')!;

function mkCall(id: string, tool: { name: string }, args: object): ToolCall {
  return { id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(args) } };
}

// ── 1. 工具级权限声明 ──
const wp = writeFileTool.checkPermissions?.({ file_path: '/tmp/x.txt', content: 'y' });
check('write_file 声明 ask 且消息包含路径', wp?.behavior === 'ask' && wp.message.includes('/tmp/x.txt'));
const bp = bashTool.checkPermissions?.({ command: 'rm -rf /' });
check('bash 声明 ask 且展示命令', bp?.behavior === 'ask' && bp.message.includes('rm -rf /'));
const rp = readFileTool.checkPermissions?.({ file_path: 'a.txt' });
check('read_file 默认 allow', rp?.behavior === 'allow');

// ── 2. PermissionManager：allow 直通 ──
{
  let asked = 0;
  const pm = new PermissionManager(async () => {
    asked++;
    return 'deny';
  });
  const d = await pm.resolve('read_file', '', { behavior: 'allow' });
  check('allow 直通不问用户', d === 'allow' && asked === 0);
}

// ── 3. PermissionManager：deny 直通 ──
{
  const pm = new PermissionManager(async () => {
    throw new Error('不应被询问');
  });
  const d = await pm.resolve('x', '', { behavior: 'deny', message: 'no' });
  check('deny 直通不问用户', d === 'deny');
}

// ── 4. ask → 用户拒绝 → 工具不执行，返回拒绝结果 ──
{
  const answers: UserAnswer[] = ['deny'];
  let askCount = 0;
  const pm = new PermissionManager(async () => answers[askCount++] ?? 'deny');
  const result = await executeToolCall(mkCall('t1', writeFileTool, { file_path: join(tmp, 'no.txt'), content: 'x' }), tools, ctx, pm);
  check('用户拒绝后工具未执行', result.type === 'error' && result.output.includes('拒绝') && !existsSync(join(tmp, 'no.txt')));
  check('拒绝信息告知模型换策略', result.output.includes('不要重试'));
}

// ── 5. ask → 用户允许 → 工具执行 ──
{
  const pm = new PermissionManager(async () => 'allow');
  const result = await executeToolCall(mkCall('t2', writeFileTool, { file_path: join(tmp, 'yes.txt'), content: 'ok' }), tools, ctx, pm);
  check('用户允许后工具执行', result.type === 'success' && existsSync(join(tmp, 'yes.txt')));
}

// ── 6. always_allow → 本会话记住，第二次不再问 ──
{
  let askCount = 0;
  const pm = new PermissionManager(async () => {
    askCount++;
    return 'always_allow';
  });
  await executeToolCall(mkCall('t3', bashTool, { command: 'echo first' }), tools, ctx, pm);
  check('第一次询问了用户', askCount === 1);
  await executeToolCall(mkCall('t4', bashTool, { command: 'echo second' }), tools, ctx, pm);
  check('第二次直接放行（会话记忆）', askCount === 1);
  check('isAlwaysAllowed 状态正确', pm.isAlwaysAllowed('bash'));
  // 不同工具不受影响
  const pm2 = new PermissionManager(async () => 'deny');
  const r = await executeToolCall(mkCall('t5', writeFileTool, { file_path: join(tmp, 'z.txt'), content: '' }), tools, ctx, pm2);
  check('记忆按工具隔离', r.type === 'error');
}

// ── 7. 不传 permissions 时不做检查（测试逃生门）──
{
  const result = await executeToolCall(mkCall('t6', writeFileTool, { file_path: join(tmp, 'noperm.txt'), content: 'x' }), tools, ctx);
  check('未注入权限管理器则直接执行', result.type === 'success');
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
