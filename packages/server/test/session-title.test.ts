import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 首条用户消息生成的临时标题：客户端“+”添加的 <context> 引用块附在正文末尾，
 * 不能出现在标题里（也不能在只有引用块时把块内容当标题）。
 */
let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'lulux-title-'))
  process.env.LULUX_ETA_HOME = home
})

afterAll(() => {
  delete process.env.LULUX_ETA_HOME
})

const BLOCK = (kind: string, label: string, summary: string) =>
  `<context kind="${kind}" label="${label}">\n以下是用户引用的数据\n${summary}\n</context>`

describe('provisionalTitle', () => {
  it('普通消息折叠空白并截 40 字', async () => {
    const { provisionalTitle } = await import('../src/services/session-service.js')
    expect(provisionalTitle('  你好   世界  ')).toBe('你好 世界')
    expect(provisionalTitle('a'.repeat(50))).toBe('a'.repeat(40) + '…')
    expect(provisionalTitle('a'.repeat(40))).toBe('a'.repeat(40))
  })

  it('剥离尾部 <context> 引用块，只保留用户正文', async () => {
    const { provisionalTitle } = await import('../src/services/session-service.js')
    const content = `帮我回复这封询盘\n\n${BLOCK('email', 'Ball valve DN50 inquiry', '主题: DN50\n正文: ...')}`
    expect(provisionalTitle(content)).toBe('帮我回复这封询盘')
  })

  it('多个引用块（客户/报价/订单）全部剥离', async () => {
    const { provisionalTitle } = await import('../src/services/session-service.js')
    const content = [
      '这些订单一起排产',
      BLOCK('customer', 'Nordlicht', '公司: Nordlicht'),
      BLOCK('quote', 'Q-2026-01', '金额: EUR 1200'),
      BLOCK('order', 'SO-1001', '状态: 已确认'),
    ].join('\n\n')
    expect(provisionalTitle(content)).toBe('这些订单一起排产')
  })

  it('只有引用块时返回 NEW_SESSION_TITLE', async () => {
    const { NEW_SESSION_TITLE, provisionalTitle } = await import('../src/services/session-service.js')
    expect(provisionalTitle(BLOCK('deal', '年框', '阶段: 谈判'))).toBe(NEW_SESSION_TITLE)
    expect(provisionalTitle(`\n\n${BLOCK('email', 'x', 'y')}\n\n`)).toBe(NEW_SESSION_TITLE)
    expect(provisionalTitle('')).toBe(NEW_SESSION_TITLE)
  })

  it('剥离后再截 40 字（块内容不占长度）', async () => {
    const { provisionalTitle } = await import('../src/services/session-service.js')
    const content = `${'长'.repeat(45)}\n\n${BLOCK('email', 'x', '很长的正文'.repeat(500))}`
    expect(provisionalTitle(content)).toBe('长'.repeat(40) + '…')
  })
})

describe('会话标题写入', () => {
  it('addMessage 落库的标题不含引用块；title.ts 的 expected 判断仍成立', async () => {
    const { NEW_SESSION_TITLE, provisionalTitle, sessionService } = await import('../src/services/session-service.js')
    const content = `帮我回复这封询盘\n\n${BLOCK('email', 'Ball valve DN50 inquiry', '正文: ...')}`
    const session = sessionService.create({ agentIds: ['builtin'] })
    expect(session.title).toBe(NEW_SESSION_TITLE)
    sessionService.addMessage(session.id, 'user', content)
    const title = sessionService.get(session.id)!.title
    expect(title).toBe('帮我回复这封询盘')
    expect(title).toBe(provisionalTitle(sessionService.messages(session.id)[0]!.content))
  })

  it('只有引用块的消息不把会话改名', async () => {
    const { NEW_SESSION_TITLE, sessionService } = await import('../src/services/session-service.js')
    const session = sessionService.create({ agentIds: ['builtin'] })
    sessionService.addMessage(session.id, 'user', BLOCK('email', 'Re: DN50', '正文: ...'))
    expect(sessionService.get(session.id)!.title).toBe(NEW_SESSION_TITLE)
  })
})
