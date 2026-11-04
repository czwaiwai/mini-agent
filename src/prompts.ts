/**
 * prompts.ts —— 系统提示词（参照 claude-code 的 src/constants/prompts.ts）
 *
 * claude-code 的 system prompt 有 900+ 行，按"节"拼装（身份、工具使用
 * 规范、环境信息等），并且把"静态部分"和"动态部分"分开以便利用
 * prompt cache。我们从一个最小版本开始，随阶段逐步充实。
 */

/**
 * 【TS 知识点】`export const` + 显式返回类型 `: string`。
 * 函数返回类型可以省略（TS 会推断），但导出的公共函数建议写明，
 * 让读代码的人不用点进函数体就知道返回什么。
 */
export function getSystemPrompt(): string {
  return [
    '你是一个运行在终端里的编程助手（mini-agent）。',
    '用简洁、准确的中文回答用户的问题。',
    '如果用户的问题涉及当前项目，请基于事实回答，不要编造。',
  ].join('\n');
}
