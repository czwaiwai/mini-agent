/** 给模型看的工具说明：执行 shell 命令 */
export const BASH_DESCRIPTION = `在 shell 中执行一条命令并返回输出。

使用场景：
- 运行构建/测试命令（npm test、git status 等）
- 需要系统信息或管道组合操作时

注意事项：
- 会真实执行命令，破坏性命令（rm 等）执行前会请求用户确认
- 命令最多执行 30 秒，超时会被终止
- stdout 和 stderr 都会返回，超长输出会被截断
- 工作目录是当前项目目录`;
