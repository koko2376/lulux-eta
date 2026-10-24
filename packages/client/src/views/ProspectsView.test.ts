import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import { vPerm } from '../lib/perm-directive'
import { uiState } from '../stores/ui'
import ProspectsView from './ProspectsView.vue'

function prospect(id: string, company: string, extra: Partial<api.Prospect> = {}): api.Prospect {
  return {
    id,
    company,
    country: 'GB',
    website: '',
    address: '1 Test Road, London',
    products: '',
    hsCodes: ['84137030'],
    emails: [],
    phones: [],
    socialLinks: [],
    lastImportAt: Date.UTC(2026, 7, 1),
    shipments: 3,
    evidence: [{ kind: 'customs', source: 'hmrc', url: 'https://api.uktradeinfo.com/Import?x', title: 'HMRC', snippet: '', observedAt: 0, fields: [] }],
    flags: [],
    score: 62,
    scoreReasons: [{ key: 'customs', label: 'Customs evidence', points: 20 }],
    status: 'new',
    customerId: null,
    searchQuery: 'hs:841370',
    notes: '',
    ownerId: 'local',
    ownerName: 'koko',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

const counts: api.ProspectCounts = { total: 2, byStatus: { new: 2, contacted: 0, converted: 0, ignored: 0 }, customerExists: 0 }

async function mountView(items: api.Prospect[]) {
  const list = vi.spyOn(api, 'listProspects').mockResolvedValue({ items, total: items.length })
  vi.spyOn(api, 'getProspectCounts').mockResolvedValue(counts)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: ProspectsView }] })
  await router.push('/prospects')
  const wrapper = mount(ProspectsView, {
    global: { plugins: [router], directives: { perm: vPerm }, stubs: { PageTopbar: true, teleport: true } },
  })
  await flushPromises()
  return { wrapper, list }
}

afterEach(() => {
  vi.restoreAllMocks()
  uiState.toasts.splice(0)
  uiState.confirm = null
})

describe('线索列表', () => {
  it('区分海关证据与官网发现，显示评分与标记', async () => {
    const { wrapper } = await mountView([
      prospect('p1', 'Purmo Group (UK) Ltd'),
      prospect('p2', 'Web Found Ltd', {
        evidence: [{ kind: 'website', source: 'agent', url: 'https://web-found.example', title: '', snippet: '', observedAt: 0, fields: [] }],
        flags: ['sanctions_hit'],
        score: 15,
      }),
    ])
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('.ev-customs').exists()).toBe(true)
    expect(rows[1]!.find('.ev-web').exists()).toBe(true)
    expect(rows[1]!.find('.f-sanctions_hit').exists()).toBe(true)
    expect(rows[0]!.text()).toContain('62')
  })

  it('“有海关证据”筛选把 hasCustomsEvidence=true 传给接口', async () => {
    const { wrapper, list } = await mountView([prospect('p1', 'A Ltd')])
    await wrapper.get('[data-testid="filter-customs"]').trigger('click')
    await flushPromises()
    expect(list.mock.calls.at(-1)![0]).toMatchObject({ hasCustomsEvidence: true, offset: 0 })
  })

  it('空列表给出“让 Agent 找客户”引导', async () => {
    const { wrapper } = await mountView([])
    expect(wrapper.find('[data-testid="prospects-empty"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="prospects-ask"]').length).toBeGreaterThan(0)
  })

  it('抽屉里转客户：查重命中先确认，确认后带 force 再转', async () => {
    const p = prospect('p1', 'Dup Ltd')
    const { wrapper } = await mountView([p])
    const convert = vi
      .spyOn(api, 'convertProspect')
      .mockResolvedValueOnce({ converted: false, duplicate: true, message: '', matches: [{ company: 'Dup Ltd', owner: 'bob', matchedBy: ['company'] }] })
      .mockResolvedValueOnce({ converted: true, prospect: { ...p, status: 'converted', customerId: 'c1' }, customer: { id: 'c1', company: 'Dup Ltd' } })
    await wrapper.get('tbody tr').trigger('click')
    await wrapper.get('[data-testid="prospect-convert"]').trigger('click')
    await flushPromises()
    expect(uiState.confirm?.message).toContain('Dup Ltd (bob)')
    uiState.confirm!.resolve(true)
    await flushPromises()
    expect(convert).toHaveBeenNthCalledWith(1, 'p1', false)
    expect(convert).toHaveBeenNthCalledWith(2, 'p1', true)
    expect(uiState.toasts.at(-1)?.kind).toBe('success')
    expect(wrapper.find('[data-testid="prospect-convert"]').exists()).toBe(false)
  })
})
