/**
 * types.ts —— 全项目共享的类型定义
 *
 * 【TS 知识点】本阶段核心：可辨识联合（discriminated union）。
 * 不同 role 的消息携带的字段不同：assistant 可能带 tool_calls，
 * tool 消息必须带 tool_call_id。用"联合 + 一个公共判别字段（role）"
 * 建模最准确——TS 会根据你判断的 role 自动收窄出对应的字段。
 * 这正是 OpenAI SDK 内部消息类型的建模方式（Phase 1 里那个
 * 逼我们写 `as` 的类型），现在我们对齐了它，`as` 就能删掉。
 */

/** 一次工具调用请求（模型返回的 tool_calls 数组元素） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** 注意：这是 JSON **字符串**，不是对象！需要 JSON.parse */
    arguments: string;
  };
}

/**
 * 一条对话消息。
 * 【TS 知识点】`|` 联合：ChatMessage 类型的值是这四种之一。
 * 之后写 `if (msg.role === 'tool')` 时，TS 自动知道 msg 有
 * tool_call_id 而没有 tool_calls——这叫"类型收窄"。
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Agent 配置项（从环境变量读取） */
export interface AgentConfig {
  /** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
  baseURL: string;
  /** API Key */
  apiKey: string;
  /** 模型名，如 deepseek-chat */
  model: string;
}

/** 工具执行时传给工具的上下文 */
export interface ToolContext {
  /** 工作目录（相对路径的解析基准） */
  cwd: string;
  /** 中断信号：bash 等长任务工具应响应它 */
  signal?: AbortSignal;
}
