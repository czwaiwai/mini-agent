/**
 * session.ts —— 会话持久化（参照 claude-code 的 src/utils/sessionStorage.ts）
 *
 * claude-code 把每条消息以 JSONL（每行一个 JSON）追加写入会话文件，
 * 支持 --resume 恢复。JSONL 的好处：追加写不需要重写整个文件，
 * 即使程序崩溃，已写入的行也不会丢。
 *
 * 【TS 知识点】Node 的 fs 同步 API（appendFileSync 等）在 CLI 工具里
 * 完全够用且更好推理；服务器高并发场景才需要异步版本。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from './types.js';

export class SessionStore {
  private sessionFile: string | null = null;

  constructor(private sessionsDir: string) {
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
  }

  /** 新建一个会话文件，文件名含时间戳便于辨认 */
  start(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.sessionFile = join(this.sessionsDir, `session-${ts}.jsonl`);
    return this.sessionFile;
  }

  /** 追加一条消息到当前会话文件 */
  append(message: ChatMessage): void {
    if (!this.sessionFile) return;
    appendFileSync(this.sessionFile, JSON.stringify(message) + '\n', 'utf8');
  }

  /** 列出所有会话文件（按时间排序，最新的最后） */
  listSessions(): string[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  }

  /**
   * 加载最近的会话。解析失败的行直接跳过（崩溃时可能留下半行）——
   * JSONL 格式的容错优势。
   */
  loadLatest(): ChatMessage[] | null {
    const sessions = this.listSessions();
    const latest = sessions[sessions.length - 1];
    if (!latest) return null;
    return this.load(join(this.sessionsDir, latest));
  }

  load(path: string): ChatMessage[] | null {
    if (!existsSync(path)) return null;
    const messages: ChatMessage[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isChatMessage(parsed)) messages.push(parsed);
      } catch {
        // 半行/损坏行跳过
      }
    }
    return messages.length > 0 ? messages : null;
  }
}

/**
 * 【TS 知识点】类型守卫（type guard）：`x is ChatMessage` 这种返回类型
 * 告诉 TS"这个函数返回 true 时，x 就能当 ChatMessage 用"。
 * JSON.parse 的返回是 unknown（什么都可能是），必须先守卫再使用。
 */
function isChatMessage(x: unknown): x is ChatMessage {
  if (typeof x !== 'object' || x === null) return false;
  const role = (x as { role?: unknown }).role;
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool';
}

/**
 * 清理悬空消息：如果最后一条是"带 tool_calls 的 assistant 消息"
 * 却没有对应的 tool 结果，把它移除，保证下一轮请求协议完整。
 * （中断/崩溃的边角情况可能留下这种消息）
 */
export function cleanupDanglingToolCalls(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
    messages.pop();
    return true;
  }
  return false;
}
