import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  computerStatus: vi.fn(),
  setComputerEnabled: vi.fn(),
  computerControl: vi.fn(),
}))
vi.mock('../api', () => api)

import {
  computerAgent,
  controlComputer,
  loadComputerStatus,
  recordComputerActivity,
  recordComputerEvent,
  resetComputerAgent,
  toggleComputer,
} from './computer-agent'

beforeEach(() => {
  resetComputerAgent()
  vi.clearAllMocks()
})

describe('电脑操作状态', () => {
  it('切换会话读取开关；接口失败视为不可用；过期的响应不覆盖新会话', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined
    api.computerStatus.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    api.computerStatus.mockResolvedValueOnce({ enabled: true, state: 'running', available: true })
    const first = loadComputerStatus('a')
    await loadComputerStatus('b')
    resolveFirst({ enabled: false, state: 'running', available: false })
    await first
    expect(computerAgent).toMatchObject({ sessionId: 'b', enabled: true, available: true })
    api.computerStatus.mockRejectedValueOnce(new Error('404'))
    await loadComputerStatus('c')
    expect(computerAgent).toMatchObject({ sessionId: 'c', enabled: false, available: false })
  })

  it('没开启时忽略桌面端活动；开启后累计步数，用户动鼠标进入暂停并记原因，继续后清掉', async () => {
    api.computerStatus.mockResolvedValue({ enabled: false, state: 'running', available: true })
    await loadComputerStatus('s')
    recordComputerActivity({ action: 'click' })
    expect(computerAgent.visible).toBe(false)
    api.setComputerEnabled.mockResolvedValue({ enabled: true, state: 'running' })
    expect(await toggleComputer()).toBe(true)
    recordComputerActivity({ action: 'screenshot' })
    recordComputerActivity({ action: 'click' })
    expect(computerAgent).toMatchObject({ visible: true, step: 2, action: 'click', state: 'running' })
    recordComputerEvent({ event: 'pause', reason: 'user-moved-mouse' })
    expect(computerAgent).toMatchObject({ state: 'paused', pauseReason: 'user-moved-mouse' })
    api.computerControl.mockResolvedValue({ state: 'running' })
    await controlComputer('resume')
    expect(api.computerControl).toHaveBeenCalledWith('s', 'resume')
    expect(computerAgent).toMatchObject({ state: 'running', pauseReason: '' })
    recordComputerEvent({ event: 'stop', reason: 'hotkey' })
    expect(computerAgent.state).toBe('stopped')
  })
})
