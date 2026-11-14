/**
 * 草稿落盘的纯函数部分（打包 / 解包）。
 * 关键约束：不把 blob: / data: 预览与截图正文写进本机存储；单账号总量有上限；
 * 上传到一半的附件恢复后标成失败（可移除的 chip）；坏数据当空处理。
 */
import { describe, expect, it } from 'vitest'
import {
  DRAFTS_BUDGET_BYTES,
  DRAFTS_VERSION,
  NO_SESSION_KEY,
  draftKey,
  emptyDraft,
  isEmptyDraft,
  mergeDrafts,
  packDrafts,
  stripAttachment,
  stripDraft,
  unpackDrafts,
  type StoredDraft,
} from './composer-draft'

const draft = (over: Partial<StoredDraft> = {}): StoredDraft => ({
  text: '报价说明',
  attachments: [],
  refs: [],
  at: 1,
  ...over,
})

describe('草稿键与合并（原有行为不变）', () => {
  it('没有会话时用空字符串当键', () => {
    expect(draftKey(null)).toBe(NO_SESSION_KEY)
    expect(draftKey('s1')).toBe('s1')
    expect(isEmptyDraft(emptyDraft())).toBe(true)
  })

  it('合并两份草稿：文字不丢、附件按 path 去重、引用按 kind:id 去重', () => {
    const merged = mergeDrafts(
      { text: '第一段', attachments: [{ path: 'a', name: 'a', size: 1, status: 'done' }], refs: [{ kind: 'customer', id: 'c1', label: '甲', summary: '' }] },
      { text: '第二段', attachments: [{ path: 'a', name: 'a', size: 1, status: 'done' }, { path: 'b', name: 'b', size: 2, status: 'done' }], refs: [{ kind: 'customer', id: 'c1', label: '甲', summary: '' }] },
    )
    expect(merged.text).toBe('第一段\n第二段')
    expect(merged.attachments.map((a) => a.path)).toEqual(['a', 'b'])
    expect(merged.refs).toHaveLength(1)
  })
})

describe('落盘前剥掉本机存不下的东西', () => {
  it('附件只留元数据：preview 丢掉，path/name/size/status 留着', () => {
    const stripped = stripAttachment({
      path: 'uploads/a.png',
      name: 'a.png',
      size: 68,
      status: 'done',
      image: true,
      mime: 'image/png',
      preview: 'data:image/png;base64,AAAA',
      width: 10,
      height: 20,
    })
    expect(stripped).toEqual({
      path: 'uploads/a.png',
      name: 'a.png',
      size: 68,
      status: 'done',
      image: true,
      mime: 'image/png',
      width: 10,
      height: 20,
    })
    expect(stripped.preview).toBeUndefined()
  })

  it('框选截图只留页面与元素信息，PNG 正文丢掉', () => {
    const stripped = stripAttachment({
      path: 'captures/c1.png',
      name: '截图',
      size: 10,
      status: 'done',
      capture: {
        id: 'cap-1',
        mode: 'region',
        image: 'data:image/png;base64,AAAA',
        width: 40,
        height: 30,
        url: 'https://example.com/p',
        title: 'P',
        element: null,
      },
    })
    expect(stripped.capture?.image).toBe('')
    expect(stripped.capture?.url).toBe('https://example.com/p')
  })

  it('整份草稿剥完不残留任何 base64 / blob 串', () => {
    const json = JSON.stringify(
      stripDraft({
        text: 'x',
        attachments: [{ path: 'a', name: 'a', size: 1, status: 'done', preview: 'blob:http://x/1' }],
        refs: [{ kind: 'quote', id: 'q1', label: 'Q', summary: '' }],
      }),
    )
    expect(json).not.toContain('blob:')
    expect(json).not.toContain('base64')
  })
})

describe('打包 / 解包', () => {
  it('打包后能原样读回文字、附件元数据、引用', () => {
    const { raw, dropped } = packDrafts([
      {
        key: 's1',
        at: 5,
        draft: {
          text: '你好',
          attachments: [{ path: 'uploads/a.png', name: 'a.png', size: 68, status: 'done', image: true }],
          refs: [{ kind: 'customer', id: 'c1', label: '客户甲', summary: '资料' }],
        },
      },
    ])
    expect(dropped).toEqual([])
    const back = unpackDrafts(raw)
    expect(back.s1?.text).toBe('你好')
    expect(back.s1?.attachments).toEqual([
      { path: 'uploads/a.png', name: 'a.png', size: 68, status: 'done', image: true },
    ])
    expect(back.s1?.refs[0]).toEqual({ kind: 'customer', id: 'c1', label: '客户甲', summary: '资料' })
  })

  it('落盘格式带版本号', () => {
    const { raw } = packDrafts([{ key: 's1', at: 1, draft: draft() }])
    expect(JSON.parse(raw).v).toBe(DRAFTS_VERSION)
  })

  it('超预算时按最后改动时间从新到旧装，装不下的丢最老的', () => {
    const big = (mark: string): StoredDraft => draft({ text: `${mark}${'y'.repeat(400)}`, at: 0 })
    const entries = [
      { key: 'oldest', at: 1, draft: big('C') },
      { key: 'middle', at: 2, draft: big('B') },
      { key: 'newest', at: 3, draft: big('A') },
    ]
    const { raw, dropped } = packDrafts(entries, 900)
    const kept = Object.keys(JSON.parse(raw).drafts)
    expect(kept).toContain('newest')
    expect(dropped.length).toBeGreaterThan(0)
    // 被丢的一定是最老的
    expect(dropped).toContain('oldest')
    expect(raw.length).toBeLessThanOrEqual(900)
  })

  it('默认预算 1 MB：装出来的字符串不超过它', () => {
    expect(DRAFTS_BUDGET_BYTES).toBe(1024 * 1024)
    const huge = Array.from({ length: 20 }, (_, i) => ({
      key: `s${i}`,
      at: i,
      draft: draft({ text: 'z'.repeat(100_000) }),
    }))
    const { raw, dropped } = packDrafts(huge)
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(DRAFTS_BUDGET_BYTES)
    expect(dropped.length).toBeGreaterThan(0)
  })

  it('上传到一半的附件恢复后标成失败，并给出可移除的提示（不阻塞发送）', () => {
    const { raw } = packDrafts([
      { key: 's1', at: 1, draft: draft({ text: '保留的文字', attachments: [{ path: 'uploads/h.pdf', name: 'h.pdf', size: 9, status: 'uploading' }] }) },
    ])
    const back = unpackDrafts(raw)
    expect(back.s1?.text).toBe('保留的文字')
    expect(back.s1?.attachments[0].status).toBe('error')
    expect(back.s1?.attachments[0].error).toBeTruthy()
  })

  it('坏 JSON / 版本不符 / 空串都当空处理，不抛错', () => {
    expect(unpackDrafts(null)).toEqual({})
    expect(unpackDrafts('')).toEqual({})
    expect(unpackDrafts('{"v":1,"drafts":')).toEqual({})
    expect(unpackDrafts(JSON.stringify({ v: 99, drafts: { s1: { text: 'x' } } }))).toEqual({})
  })

  it('空草稿不占位（读回来是空表）', () => {
    const { raw } = packDrafts([{ key: 's1', at: 1, draft: emptyDraft() }])
    expect(unpackDrafts(raw)).toEqual({})
  })
})
