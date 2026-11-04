/**
 * types.ts —— 全项目共享的类型定义
 *
 * 【TS 知识点】union（联合类型）：`role` 只能是这几个字符串之一，
 * 写错会直接编译报错。这比 JS 里"随手传个字符串"安全得多。
 * claude-code 的消息类型在 src/types/message.ts，用的是更复杂的
 * "可辨识联合"（discriminated union），我们后面 Phase 2 会学到。
 */

/** OpenAI 兼容 API 的消息角色 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 一条对话消息。
 *
 * 【TS 知识点】interface：描述对象的"形状"。
 * `content?: string` 里的 `?` 表示可选字段——assistant 消息在
 * 发起工具调用时 content 可以为空（Phase 2 会遇到）。
 */
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
}

/** Agent 配置项（从环境变量读取） */
export interface AgentConfig {
  /** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
  baseURL: string;
  /** API Key */
  apiKey: string;
  /** 模型名，如 deepseek-chat */
  model: string;
}

/** 流式调用时收到的"事件"：一小段文本 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'done' };
