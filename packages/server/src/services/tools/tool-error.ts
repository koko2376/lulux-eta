/** 工具内部的可预期失败（参数越界、路径不合法…），以文本回给模型 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}
