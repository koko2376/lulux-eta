/**
 * 本地服务意外退出后的重启节奏：1s → 3s → 10s → 30s；
 * 时间窗口内退出次数超过上限就放弃（多半是数据目录 / 端口等持续性问题，反复重启没有意义）。
 * 服务稳定运行超过 stableMs 后，下一次失败重新从最短间隔开始。
 */
export interface RestartPolicyOptions {
  delays?: number[]
  maxRestarts?: number
  windowMs?: number
  stableMs?: number
}

export class RestartPolicy {
  private readonly delays: number[]
  private readonly maxRestarts: number
  private readonly windowMs: number
  private readonly stableMs: number
  private failures: number[] = []
  private lastStart = 0

  constructor(options: RestartPolicyOptions = {}) {
    this.delays = options.delays ?? [1000, 3000, 10_000, 30_000]
    this.maxRestarts = options.maxRestarts ?? 5
    this.windowMs = options.windowMs ?? 10 * 60_000
    this.stableMs = options.stableMs ?? 5 * 60_000
  }

  /** 服务（重新）启动成功时调用 */
  started(now = Date.now()): void {
    this.lastStart = now
  }

  /** 服务意外退出：返回下一次重启前的等待毫秒数；null 表示放弃 */
  nextDelay(now = Date.now()): number | null {
    if (this.lastStart && now - this.lastStart >= this.stableMs) this.failures = []
    this.failures = this.failures.filter((at) => now - at < this.windowMs)
    if (this.failures.length >= this.maxRestarts) return null
    const delay = this.delays[Math.min(this.failures.length, this.delays.length - 1)]!
    this.failures.push(now)
    return delay
  }

  /** 第几次连续重启（从 1 开始） */
  get attempts(): number {
    return this.failures.length
  }
}
