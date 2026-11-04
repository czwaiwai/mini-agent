/**
 * tokenEstimator.ts —— token 粗略估算
 *
 * 为什么估算就够？
 * 1. 各兼容端点返回的 usage 字段口径不一，不能依赖；
 * 2. 引入精确 tokenizer（tiktoken 等）是一个重依赖；
 * 3. 压缩触发只需要"数量级正确"，阈值留 30% 安全余量即可。
 *
 * 经验规则（粗估）：
 * - 英文约 4 字符 ≈ 1 token
 * - 中文约 1 字 ≈ 1 token（1~1.2 之间）
 */

const CJK_REGEX = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.1 + other / 4);
}

/** 估算一组消息的总 token（含 role 等结构开销的少量冗余） */
export function estimateMessagesTokens(messages: { role: string; content: unknown }[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    total += 8; // 每条消息的 role/结构开销
  }
  return total;
}
