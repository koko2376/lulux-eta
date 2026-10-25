/**
 * 数据源共用的串行队列：所有请求排成一队，相邻两次请求结束 / 开始之间至少间隔
 * intervalMs（HMRC 限流很严，必须全局串行；Comtrade 也按 ≥1s 间隔）。
 *
 * 间隔按每次 run() 传入，测试可以传 0，不必真的等待。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface SerialQueue {
  run<T>(task: () => Promise<T>, intervalMs: number): Promise<T>
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve()
  let lastFinishedAt = 0

  return {
    run<T>(task: () => Promise<T>, intervalMs: number): Promise<T> {
      const result = tail.then(async () => {
        // 第一次请求不用等；之后保证「上次结束 → 这次开始」的间隔
        if (lastFinishedAt > 0) {
          const wait = intervalMs - (Date.now() - lastFinishedAt)
          if (wait > 0) await sleep(wait)
        }
        try {
          return await task()
        } finally {
          lastFinishedAt = Date.now()
        }
      })
      // 队列不能因为某个任务失败而断掉
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}
