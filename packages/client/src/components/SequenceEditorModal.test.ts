import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import SequenceEditorModal from './SequenceEditorModal.vue'

const account = { id: 'acc1', email: 'sales@lulux-demo.example.com' } as api.EmailAccount

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

describe('parseContactLines', () => {
  it('每行一个邮箱，可带姓名 / 公司 / 国家；无邮箱的行计入 invalid', () => {
    const r = api.parseContactLines('Anna@Nordic.example.com, Anna Berg, Nordic Tools AB, SE\n\n<lars@x.example.com>\tLars\nno email here\nAnna Berg；mia@y.example.com')
    expect(r.contacts).toEqual([
      { email: 'anna@nordic.example.com', name: 'Anna Berg', company: 'Nordic Tools AB', country: 'SE' },
      { email: 'lars@x.example.com', name: 'Lars', company: undefined, country: undefined },
      { email: 'mia@y.example.com', name: 'Anna Berg', company: undefined, country: undefined },
    ])
    expect(r.invalid).toEqual(['no email here'])
  })
})

describe('SequenceEditorModal', () => {
  it('默认两步模板（含变量）；高级项默认收起；校验后提交', async () => {
    const created = { id: 'seq1' } as api.Sequence
    const spy = vi.spyOn(api, 'createSequence').mockResolvedValue(created)
    const wrapper = mount(SequenceEditorModal, { props: { accounts: [account] }, attachTo: document.body })
    await flushPromises()
    const steps = document.querySelectorAll('[data-testid="seq-step"]')
    expect(steps).toHaveLength(2)
    expect((steps[0]!.querySelector('textarea') as HTMLTextAreaElement).value).toContain('{{firstName|there}}')
    expect(document.querySelector('[data-testid="seq-autosend"]')).toBeNull()
    expect(document.body.textContent).toContain('{{senderName}}')
    ;(document.querySelector('[data-testid="seq-save"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    const name = document.querySelector('[data-testid="seq-name"]') as HTMLInputElement
    name.value = '北欧'
    name.dispatchEvent(new Event('input'))
    document.querySelectorAll<HTMLInputElement>('[data-testid="seq-step"] input.input:not(.days)').forEach((el, i) => {
      el.value = `Subject ${i}`
      el.dispatchEvent(new Event('input'))
    })
    ;(document.querySelector('[data-testid="seq-save"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
    const body = spy.mock.calls[0]![0]
    expect(body).toMatchObject({ name: '北欧', accountId: 'acc1', autoSend: false, windowStart: 9, windowEnd: 17, skipWeekends: true })
    expect(body.steps.map((s) => s.delayDays)).toEqual([0, 3])
    expect(wrapper.emitted('saved')![0]![0]).toEqual(created)
    wrapper.unmount()
  })
})
