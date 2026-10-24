import { describe, expect, it, vi } from 'vitest'
import { dispatchStreamEvent } from '../api'
import { compactionNoticeText } from './app'

describe('图片输入：流事件与提示', () => {
  it('vision 事件分发给 onVision；compaction kind=images 的提示文案', () => {
    const onVision = vi.fn()
    dispatchStreamEvent(
      'vision',
      { supported: false, model: 'deepseek-chat', images: 2 },
      { onDelta: () => {}, onDone: () => {}, onError: () => {}, onVision },
    )
    expect(onVision).toHaveBeenCalledWith({ supported: false, model: 'deepseek-chat', images: 2 })
    expect(compactionNoticeText({ agentId: 'a', kind: 'images', droppedImages: 3 })).toBe(
      '上下文较长，已省略较早消息里的 3 张图片',
    )
  })
})
