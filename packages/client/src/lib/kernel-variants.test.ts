import { describe, expect, it } from 'vitest'
import { agentAvatarSource } from './group-avatar'
import { kernelVariantAvatar } from './kernel-logos'

describe('同一内核多实例的形象', () => {
  it('第 2–6 个实例各用一个形象，第 7 个起循环；第 1 个沿用原头像', () => {
    expect(kernelVariantAvatar('builtin', 1)).toBeNull()
    expect(kernelVariantAvatar('builtin', 2)).toBe('/agents/variants/builtin-2.png')
    expect(kernelVariantAvatar('builtin', 6)).toBe('/agents/variants/builtin-6.png')
    expect(kernelVariantAvatar('builtin', 7)).toBe('/agents/variants/builtin-2.png')
    expect(kernelVariantAvatar('unknown-kernel', 2)).toBeNull()
  })

  it('agentAvatarSource 按成员实例 id 取形象', () => {
    const lulux = { kind: 'builtin' as const, kernelId: null, avatar: '' }
    expect(agentAvatarSource({ ...lulux, id: 'builtin' }).src).toBe('/icon.png')
    expect(agentAvatarSource({ ...lulux, id: 'builtin#3' }).src).toBe('/agents/variants/builtin-3.png')
    const codex = { kind: 'kernel' as const, kernelId: 'codex', avatar: '' }
    expect(agentAvatarSource({ ...codex, id: 'kernel-codex#2' })).toEqual({
      src: '/agents/variants/codex-2.png',
      tile: false,
    })
    expect(agentAvatarSource({ ...codex, id: 'kernel-codex' }).src).toBe('/agents/codex.png')
  })
})

describe('单聊会话形象', () => {
  it('优先用服务端编号；没有时同一会话 id 永远同一个形象，取值 1..6', async () => {
    const { sessionLook, AVATAR_LOOKS } = await import('./group-avatar')
    expect(sessionLook({ id: 's-abc' })).toBe(sessionLook({ id: 's-abc' }))
    expect(sessionLook({ id: 's-abc', avatarLook: 4 })).toBe(4)
    expect(sessionLook({ id: 's-abc', avatarLook: 9 })).toBe(sessionLook({ id: 's-abc' }))
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const look = sessionLook({ id: `session-${i}` })
      expect(look).toBeGreaterThanOrEqual(1)
      expect(look).toBeLessThanOrEqual(AVATAR_LOOKS)
      seen.add(look)
    }
    expect(seen.size).toBe(AVATAR_LOOKS)
    expect(sessionLook(null)).toBe(1)
  })
  it('look>1 换实例形象，群里第 n 个实例优先于 look', async () => {
    const { agentAvatarSource } = await import('./group-avatar')
    const codex = { kind: 'kernel' as const, kernelId: 'codex', avatar: '' }
    expect(agentAvatarSource({ ...codex, id: 'codex' }, 1).src).toBe('/agents/codex.png')
    expect(agentAvatarSource({ ...codex, id: 'codex' }, 3).src).toBe('/agents/variants/codex-3.png')
    expect(agentAvatarSource({ ...codex, id: 'codex#2' }, 5).src).toBe('/agents/variants/codex-2.png')
  })
})
