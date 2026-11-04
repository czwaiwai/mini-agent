/**
 * permissions.ts —— 权限机制
 * （参照 claude-code 的分层权限模型：
 *   zod 校验 → 工具级 checkPermissions → 全局 canUseTool，src/Tool.ts:500）
 *
 * 我们的两层：
 * 1. 工具层：每个工具通过 checkPermissions 声明自己要不要询问
 *    （只读工具默认 allow，写工具默认 ask）——对应 claude-code
 *    工具的 checkPermissions 方法
 * 2. 全局层：PermissionManager 统一裁决——"本会话记住选择"的
 *    内存 Map 对应 claude-code 的 ToolPermissionContext 里的
 *    alwaysAllow 规则（我们简化为 Map，不持久化）
 *
 * 【TS 知识点】依赖注入：PermissionManager 不自己"问用户"，
 * 而是构造时接收一个 askUser 回调——权限逻辑与 UI 交互彻底解耦。
 * 主循环不直接依赖 readline，测试时可以注入假的 askUser。
 * 这正是 claude-code 的 CanUseToolFn（src/hooks/useCanUseTool.tsx:27）
 * 与 query/deps.ts 依赖注入的思想。
 */

/** 工具级权限声明（对应 claude-code 的 PermissionResult） */
export type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'ask'; message: string }
  | { behavior: 'deny'; message: string };

/** 全局裁决的最终决定 */
export type PermissionDecision = 'allow' | 'deny';

/** 用户对询问的回答 */
export type UserAnswer = 'allow' | 'always_allow' | 'deny';

/** 问用户的回调（由 UI 层提供，这里是 REPL 的 readline 确认框） */
export type AskUserFn = (request: {
  toolName: string;
  argsSummary: string;
  message: string;
}) => Promise<UserAnswer>;

export class PermissionManager {
  /** 会话内记住的选择：toolName → decision */
  private memory = new Map<string, PermissionDecision>();

  constructor(private askUser: AskUserFn) {}

  /** 工具是否已被本会话记住为允许 */
  isAlwaysAllowed(toolName: string): boolean {
    return this.memory.get(toolName) === 'allow';
  }

  /**
   * 裁决一次权限请求：
   * allow 直接放行；deny 直接拒绝；ask 先查记忆、再问用户。
   */
  async resolve(
    toolName: string,
    argsSummary: string,
    result: PermissionResult,
  ): Promise<PermissionDecision> {
    if (result.behavior === 'allow') return 'allow';
    if (result.behavior === 'deny') return 'deny';

    // ask：先查会话记忆
    const remembered = this.memory.get(toolName);
    if (remembered) return remembered;

    // 再问用户
    const answer = await this.askUser({ toolName, argsSummary, message: result.message });
    if (answer === 'always_allow') {
      this.memory.set(toolName, 'allow');
      return 'allow';
    }
    return answer;
  }
}
