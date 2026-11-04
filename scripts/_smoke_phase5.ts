/**
 * Phase 5 冒烟测试：会话持久化 + 悬空消息清理 + 重试分类（不需要 API Key）
 */
import { SessionStore, cleanupDanglingToolCalls } from '../src/session.js';
import { isRetryable, getRetryDelay } from '../src/agent/client.js';
import { APIError } from 'openai';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
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

// 收集我们创建的临时目录，结束时只删自己的
const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mini-agent-sess-'));
  tempDirs.push(dir);
  return dir;
}

// ── 1. SessionStore 基本读写 ──
{
  const dir = join(makeTempDir(), 'sessions');
  const store = new SessionStore(dir);
  store.start();
  store.append({ role: 'user', content: '你好' });
  store.append({ role: 'assistant', content: '你好！' });

  check('会话文件已创建', existsSync(dir) && store.listSessions().length === 1);

  const store2 = new SessionStore(dir);
  const restored = store2.loadLatest();
  check('恢复最近会话', restored?.length === 2 && restored[1]?.role === 'assistant');
}

// ── 2. 损坏行容错 ──
{
  const dir = join(makeTempDir(), 'sessions');
  const store = new SessionStore(dir);
  store.start();
  store.append({ role: 'user', content: 'a' });
  // 模拟崩溃留下的半行
  const file = join(dir, store.listSessions()[0]!);
  appendFileSync(file, '{"role":"user","cont'); // 截断的 JSON

  const store2 = new SessionStore(dir);
  const restored = store2.loadLatest();
  check('损坏行被跳过，好的行恢复', restored?.length === 1 && restored[0]?.content === 'a');
}

// ── 3. 空会话 loadLatest 返回 null ──
{
  const dir = join(makeTempDir(), 'sessions');
  const store = new SessionStore(dir);
  check('空目录 loadLatest 为 null', store.loadLatest() === null);
}

// ── 4. 悬空 tool_calls 清理 ──
{
  const messages: import('../src/types.js').ChatMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  ];
  check('检测到悬空消息并移除', cleanupDanglingToolCalls(messages) === true && messages.length === 1);
  const ok: import('../src/types.js').ChatMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'done' },
  ];
  check('正常历史不受影响', cleanupDanglingToolCalls(ok) === false && ok.length === 2);
}

// ── 5. 重试分类 ──
{
  const mkAPIError = (status: number | undefined) =>
    new APIError(
      status ?? 500,
      { error: { message: 'x' } },
      'x',
      status !== undefined ? new Headers({ 'retry-after': '2' }) : undefined,
    );
  check('429 可重试', isRetryable(mkAPIError(429)));
  check('500 可重试', isRetryable(mkAPIError(500)));
  check('401 不可重试', !isRetryable(mkAPIError(401)));
  check('400 不可重试', !isRetryable(mkAPIError(400)));
  check('未知错误不重试', !isRetryable(new Error('whatever')));

  const delay = getRetryDelay(mkAPIError(429), 0);
  check('Retry-After: 2 → 延迟 2s', delay === 2000);
  const delay2 = getRetryDelay(new Error('conn'), 2);
  check('指数退避约 4s 级', delay2 >= 4000 && delay2 <= 4500);
}

// 只清理我们自己创建的临时目录
for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
