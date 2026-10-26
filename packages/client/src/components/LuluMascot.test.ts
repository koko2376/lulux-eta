import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LuluMascot from './LuluMascot.vue'

describe('LuluMascot', () => {
  it('按状态换表情：idle 是 lu、生成中是思考、完成是开心、出错是惊讶', async () => {
    const w = mount(LuluMascot, { props: { state: 'idle', x: 30 } })
    expect(w.find('[data-testid="lulu"]').attributes('style')).toContain('translateX(30px)')
    expect(w.findAll('.eyes path').length).toBe(1) // u
    await w.setProps({ state: 'thinking' })
    expect(w.find('.lulu').classes()).toContain('walking')
    expect(w.findAll('.eyes path').length).toBe(0)
    await w.setProps({ state: 'happy' })
    expect(w.findAll('.eyes path').length).toBe(2)
    await w.setProps({ state: 'wow' })
    expect(w.findAll('.eyes .eye-o').length).toBe(2)
    w.unmount()
  })

  it('减少动态效果：不走动', async () => {
    const w = mount(LuluMascot, { props: { state: 'typing', reduceMotion: true } })
    expect(w.find('.lulu').classes()).not.toContain('walking')
    expect(w.find('.lulu').classes()).toContain('still')
    w.unmount()
  })
})
