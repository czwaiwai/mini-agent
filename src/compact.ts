/**
 * compact.ts —— 自动上下文压缩
 * （参照 claude-code 的 src/services/compact/autoCompact.ts + compact.ts + prompt.ts）
 *
 * claude-code 的核心思想：**messages 数组仍是唯一事实源**，
 * 压缩不是"删历史"，而是"用一段摘要消息替换旧消息前缀"：
 *
 *   [system]                    [system]
 *   [user]  早期消息      →      [user]  📜 之前对话的摘要（模型写的）
 *   [assistant] ...             [assistant]
 *   [user]  ...                 [...最近的尾部消息原样保留]
 *   ...（几十条）
 *
 * 这样模型仍然"记得"早期关键事实（在摘要里），但 token 大幅下降。
 *
 * 关键安全约束：切割点绝不能落在一个"工具调用组"中间
 * （assistant 带 tool_calls + 若干 tool 结果是原子的），否则协议
 * 不完整。findCutIndex 负责把切割点往前挪到安全位置。
 */

import type { OpenAI } from 'openai';
import type { AgentConfig, ChatMessage } from './types.js';
import { estimateMessagesTokens } from './tokenEstimator.js';

/** 压缩后保留的最近消息条数 */
const KEEP_TAIL_COUNT = 6;

/**
 * 压缩摘要提示词（参照 claude-code 的 services/compact/prompt.ts 精神：
 * 结构化保留——目标、决策、文件路径、未完成任务、用户偏好）
 */
const COMPACTION_PROMPT = `你是对话记录压缩器。请把以下对话历史压缩成一段结构化摘要，供后续对话作为上下文使用。

要求保留：
1. 用户的核心目标和需求
2. 已做出的重要决定和结论
3. 提到过的文件路径、命令、关键代码信息
4. 尚未完成的任务
5. 用户表达过的偏好

直接输出摘要内容，不要任何开场白。`;

/**
 * 找到安全的切割点：tail 从这里开始保留。
 * 如果切割点落在 tool 结果消息上，往前挪直到跳过整个工具组。
 */
export function findCutIndex(messages: ChatMessage[], keepTail: number): number {
  // 至少保留 system 之后的第一条
  let cut = Math.max(1, messages.length - keepTail);
  // 【协议安全】tool 结果必须和它前面的 assistant(tool_calls) 在同一侧
  while (cut < messages.length && messages[cut]?.role === 'tool') {
    cut--;
  }
  return cut;
}

/** 是否该压缩了：超过 阈值（上下文窗口 × 比例）且确实有可压缩的历史 */
export function shouldCompact(
  messages: ChatMessage[],
  thresholdTokens: number,
): boolean {
  if (messages.length < KEEP_TAIL_COUNT + 3) return false; // 太短，没得压
  return estimateMessagesTokens(messages) > thresholdTokens;
}

/**
 * 执行压缩：把 head 部分交给模型写摘要，返回压缩后的新消息数组。
 * 返回 null 表示无需压缩（或压缩失败，调用方保留原样继续）。
 */
export async function compactMessages(
  client: OpenAI,
  config: AgentConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChatMessage[] | null> {
  // 1. 拆出 system 消息（永远保留在开头）
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');
  if (conversation.length <= KEEP_TAIL_COUNT) return null;

  // 2. 切 head / tail（组安全）
  const cut = findCutIndex(conversation, KEEP_TAIL_COUNT);
  const head = conversation.slice(0, cut);
  const tail = conversation.slice(cut);
  if (head.length === 0) return null;

  // 3. 序列化 head 为"角色: 内容"的纯文本，交给模型写摘要
  const transcript = head
    .map((m) => {
      const content = m.content ?? (m.role === 'assistant' ? '（调用工具）' : '');
      return `[${m.role}] ${content}`;
    })
    .join('\n\n');

  try {
    // 非流式调用：压缩本身不需要打字机效果
    const response = await client.chat.completions.create(
      {
        model: config.model,
        messages: [
          { role: 'system', content: COMPACTION_PROMPT },
          { role: 'user', content: `请压缩以下对话历史：\n\n${transcript}` },
        ],
      },
      { signal },
    );
    const summary = response.choices[0]?.message?.content?.trim();
    if (!summary) return null;

    // 4. 组装：system + 摘要 + 原样尾部
    const summaryMessage: ChatMessage = {
      role: 'user',
      content: `📜 [以下是此前对话的自动摘要，原始消息已压缩以节省上下文]\n\n${summary}`,
    };
    return [...systemMessages, summaryMessage, ...tail];
  } catch {
    // 压缩失败不致命：返回 null，调用方带着原历史继续（可能超限报错，但可重试）
    return null;
  }
}

/** 当前配置下的压缩阈值 */
export function getCompactionThreshold(): number {
  const contextTokens = Number(process.env.MINI_AGENT_CONTEXT_TOKENS ?? 65536);
  const ratio = Number(process.env.MINI_AGENT_COMPACT_RATIO ?? 0.7);
  return Math.floor(contextTokens * ratio);
}
