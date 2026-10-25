import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import InquiryScoreCard from './InquiryScoreCard.vue'

function message(inquiry: api.InquiryScore): api.EmailMessage {
  return {
    id: 'msg_1',
    accountId: 'acc',
    folder: 'inbox',
    uid: 1,
    messageId: '<1@x>',
    threadKey: 't',
    from: { name: 'James', address: 'j@northwind.example.com' },
    to: [],
    cc: [],
    subject: 'RFQ gate valves',
    date: 0,
    snippet: '',
    seen: true,
    flagged: false,
    hasAttachments: false,
    verdict: 'inquiry',
    verdictSource: 'rule',
    verdictReason: '',
    matchedRuleId: null,
    customerId: null,
    customerName: null,
    inquiryScore: inquiry.score,
    inquiryGrade: inquiry.grade,
    createdAt: 0,
    replyTo: [],
    inReplyTo: null,
    references: [],
    text: '',
    hasHtml: false,
    truncated: false,
    attachments: [],
    inquiry,
  }
}

const good: api.InquiryScore = {
  score: 92,
  grade: 'A',
  reasons: [
    { key: 'company_domain', label: 'company domain', points: 10 },
    { key: 'quantity', label: 'quantity', points: 12 },
  ],
  flags: [],
  language: 'es',
  asks: {},
  followUps: ['目标价或预算'],
}

async function mountCard(m: api.EmailMessage) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] })
  await router.push('/mailbox')
  return mount(InquiryScoreCard, { props: { message: m }, global: { plugins: [router] } })
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

describe('InquiryScoreCard', () => {
  it('显示等级、分数、语种；展开后显示逐条理由与追问项', async () => {
    const wrapper = await mountCard(message(good))
    expect(wrapper.find('.iq-grade').text()).toBe('A')
    expect(wrapper.text()).toContain('92')
    expect(wrapper.find('.iq-reasons').exists()).toBe(false)
    await wrapper.find('[data-testid="inquiry-toggle"]').trigger('click')
    expect(wrapper.findAll('.iq-reasons li:not(.iq-base):not(.iq-adjust)')).toHaveLength(2)
    // 起始分 + 逐条理由 + 封顶说明，加起来等于总分
    expect(wrapper.find('.iq-base').text()).toContain('50')
    const shown = wrapper.findAll('.iq-reasons .pts').reduce((sum, el) => sum + Number(el.text()), 0)
    expect(shown).toBe(92)
    expect(wrapper.find('.pts.up').text()).toBe('+10')
    expect(wrapper.find('.iq-follow').text()).toContain('目标价或预算')
    expect(wrapper.find('[data-testid="inquiry-draft"]').exists()).toBe(true)
  })

  it('钓鱼：显示风险提示、不提供“起草首回”', async () => {
    const wrapper = await mountCard(message({ ...good, score: 20, grade: 'D', flags: ['phishing', 'free_mail'] }))
    expect(wrapper.find('[role="alert"]').findAll('li')).toHaveLength(1)
    expect(wrapper.find('[data-testid="inquiry-draft"]').exists()).toBe(false)
  })

  it('没有评分数据时不渲染', async () => {
    const m = message(good)
    m.inquiry = null
    const wrapper = await mountCard(m)
    expect(wrapper.find('[data-testid="inquiry-card"]').exists()).toBe(false)
  })

  it('重新打分：调接口并把结果抛给父组件', async () => {
    const rescored = message({ ...good, score: 70, grade: 'B' })
    const spy = vi.spyOn(api, 'scoreEmailMessage').mockResolvedValue(rescored)
    const wrapper = await mountCard(message(good))
    const btn = wrapper.findAll('button').find((b) => b.text().includes('重新打分') || b.text().toLowerCase().includes('rescore'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('msg_1')
    expect(wrapper.emitted('rescored')![0]![0]).toEqual(rescored)
  })
})
