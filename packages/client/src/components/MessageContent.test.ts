import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import MessageContent from './MessageContent.vue'

vi.mock('../lib/window', () => ({ openExternal: vi.fn() }))

describe('MessageContent', () => {
  it('助手消息渲染 Markdown（表格 / 代码块），用户消息保持纯文本', async () => {
    const md = mount(MessageContent, {
      props: { content: '**粗体**\n\n| a | b |\n|---|---|\n| 1 | 2 |', markdown: true },
    })
    expect(md.find('.md table').exists()).toBe(true)
    expect(md.find('.md strong').text()).toBe('粗体')
    const plain = mount(MessageContent, { props: { content: '# 不是标题 <b>x</b>' } })
    expect(plain.find('.md').exists()).toBe(false)
    expect(plain.text()).toContain('# 不是标题 <b>x</b>')
  })

  it('XSS：script / onerror 不进入 DOM', () => {
    const w = mount(MessageContent, {
      props: { content: '<img src=x onerror=alert(1)><script>alert(2)</script>', markdown: true },
    })
    expect(w.element.querySelector('script')).toBeNull()
    expect(w.element.querySelector('img')).toBeNull()
    const attrs = [...w.element.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.name))
    expect(attrs.filter((n) => /^on/i.test(n))).toEqual([])
  })

  it('点击链接交给系统浏览器，不在应用里跳转', async () => {
    const { openExternal } = await import('../lib/window')
    const w = mount(MessageContent, { props: { content: '[官网](https://lulux.example)', markdown: true } })
    await w.find('a').trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://lulux.example')
  })

  it('流式：节流渲染，结束后输出完整内容', async () => {
    vi.useFakeTimers()
    const w = mount(MessageContent, { props: { content: '第', markdown: true, streaming: true } })
    expect(w.text()).toBe('第')
    await w.setProps({ content: '第一' })
    await w.setProps({ content: '第一段' })
    expect(w.text()).toBe('第') // 60ms 内不重复渲染
    vi.advanceTimersByTime(80)
    await w.vm.$nextTick()
    expect(w.text()).toBe('第一段')
    await w.setProps({ content: '第一段完成', streaming: false })
    expect(w.text()).toBe('第一段完成')
    vi.useRealTimers()
  })

  it('流式中用户展开 / 收起的长代码块，增量重新渲染后保持用户的选择', async () => {
    const code = '```ts\n' + Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n```\n\n后面的文字'
    const other = '```ts\n' + Array.from({ length: 8 }, (_, i) => `x${i}`).join('\n') + '\n```\n\n'
    const w = mount(MessageContent, { props: { content: code, markdown: true, streaming: true } })
    await flushPromises()
    const blocks = () => w.findAll('details').map((d) => d.element as HTMLDetailsElement)
    expect(blocks()[0].open).toBe(false)
    blocks()[0].open = true
    await new Promise((r) => setTimeout(r, 80))
    await w.setProps({ content: code + '，继续输出\n\n' + other })
    await new Promise((r) => setTimeout(r, 80))
    await flushPromises()
    expect(blocks()).toHaveLength(2)
    expect(blocks()[0].open).toBe(true)
    // 用户再收起：下一次渲染后仍是收起
    blocks()[0].open = false
    await w.setProps({ content: code + '，继续输出\n\n' + other + '尾巴' })
    await new Promise((r) => setTimeout(r, 80))
    await flushPromises()
    expect(blocks()[0].open).toBe(false)
  })
})
