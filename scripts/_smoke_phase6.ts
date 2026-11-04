/**
 * Phase 6 冒烟测试：token 估算 + 压缩切割安全 + 压缩全流程（假 client，无需 API Key）
 */
import { estimateTokens, estimateMessagesTokens } from '../src/tokenEstimator.js';
import { findCutIndex, shouldCompact, compactMessages, getCompactionThreshold } from '../src/compact.js';
import type { ChatMessage } from '../src/types.js';
import type { OpenAI } from 'openai';

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

// ── 1. token 估算 ──
{
  const en = estimateTokens('hello world, this is a test');
  const zh = estimateTokens('你好世界这是一段中文测试文本'); // 14 个汉字
  check('英文约 4 字符/token', en >= 5 && en <= 10, `实际 ${en}`);
  check('中文约 1 字/token', zh >= 14 && zh <= 17, `实际 ${zh}`);
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'a'.repeat(400) },
    { role: 'assistant', content: 'b'.repeat(400) },
  ];
  const t = estimateMessagesTokens(msgs);
  check('消息估算含结构开销', t >= 200 && t <= 220, `实际 ${t}`);
}

// ── 2. findCutIndex 工具组安全 ──
{
  // 构造：user, asst(tool_calls), tool, tool, user, asst ... 尾部 6 条切割点落在 tool 上
  const messages: ChatMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'q4' },
    { role: 'assistant', content: 'a4' },
  ];
  const cut = findCutIndex(messages, 6);
  // 原始 cut = 10-6 = 4 → messages[4] 是 user，无需回退
  check('普通位置切割', messages[cut]?.role === 'user');

  // 让切割点落在 tool 消息上：keepTail=8 → cut=2，messages[2] 是 tool → 回退到 1
  const cut2 = findCutIndex(messages, 8);
  check('切割点避开工具组', cut2 === 1 && messages[1]?.role === 'assistant', `实际 cut=${cut2}`);
}

// ── 3. shouldCompact ──
{
  const small: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];
  check('短对话不压缩', !shouldCompact(small, 100));

  // 构造超长对话
  const long: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 20; i++) {
    long.push({ role: 'user', content: 'x'.repeat(500) });
    long.push({ role: 'assistant', content: 'y'.repeat(500) });
  }
  check('长对话触发压缩', shouldCompact(long, 2000));
}

// ── 4. compactMessages 全流程（假 client）──
{
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是编程助手' },
    { role: 'user', content: '记住：项目名叫 alpha' },
    { role: 'assistant', content: '好的，记住了' },
  ];
  // 塞入 20 轮长对话，让可压缩的 head 占比足够大
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `第${i}轮问题：${'x'.repeat(500)}` });
    messages.push({ role: 'assistant', content: `第${i}轮回答：${'y'.repeat(500)}` });
  }
  messages.push({ role: 'user', content: '最新问题' });

  // 假 client：返回固定的摘要文本
  const fakeClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: '用户的项目名叫 alpha；此前讨论了长文本处理。' } }],
        }),
      },
    },
  } as unknown as OpenAI;

  const result = await compactMessages(fakeClient, { baseURL: 'x', apiKey: 'x', model: 'm' }, messages);
  check('压缩返回新数组', result !== null && result.length < messages.length);
  if (result) {
    check('system 消息保留在开头', result[0]?.role === 'system' && result[0]?.content === '你是编程助手');
    check('摘要在第二位', result[1]?.role === 'user' && (result[1]?.content ?? '').includes('alpha'));
    const tailContents = result.slice(2).map((m) => (typeof m.content === 'string' ? m.content : ''));
    check('最新用户消息保留在尾部', tailContents.some((c) => c.includes('最新问题')));
    check('压缩后 token 大幅下降', estimateMessagesTokens(result) < estimateMessagesTokens(messages) / 2);
  }

  // 假 client 抛错 → 压缩失败返回 null，原历史保留
  const badClient = {
    chat: { completions: { create: async () => { throw new Error('boom'); } } },
  } as unknown as OpenAI;
  const result2 = await compactMessages(badClient, { baseURL: 'x', apiKey: 'x', model: 'm' }, messages);
  check('压缩失败返回 null（调用方保留原样）', result2 === null);
}

// ── 5. 阈值配置 ──
{
  process.env.MINI_AGENT_CONTEXT_TOKENS = '100000';
  process.env.MINI_AGENT_COMPACT_RATIO = '0.8';
  check('阈值可通过环境变量配置', getCompactionThreshold() === 80000);
  delete process.env.MINI_AGENT_CONTEXT_TOKENS;
  delete process.env.MINI_AGENT_COMPACT_RATIO;
  check('默认阈值 65536×0.7', getCompactionThreshold() === Math.floor(65536 * 0.7));
}

console.log(`\n结果：${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
