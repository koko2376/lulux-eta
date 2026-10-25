import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { effectiveAllowed, roleDefault, toggleOverride } from '../lib/fine-permissions'
import { vPerm } from '../lib/perm-directive'
import { auth, canDelete, denyReason } from '../lib/session'
import CustomerDeals from './CustomerDeals.vue'
import MemberPermissionsEditor from './MemberPermissionsEditor.vue'

function member(extra: Partial<api.Member> = {}): api.Member {
  return {
    id: 'u1',
    email: 'sales@acme.example.com',
    name: 'Sales',
    role: 'member',
    disabled: false,
    createdAt: 0,
    lastLoginAt: null,
    permissionOverrides: {},
    ...extra,
  }
}
const box = (wrapper: ReturnType<typeof mount>, perm: string) =>
  wrapper.get(`[data-perm="${perm}"] input`).element as HTMLInputElement
const setBox = (wrapper: ReturnType<typeof mount>, perm: string, value: boolean) =>
  wrapper.get(`[data-perm="${perm}"] input`).setValue(value)

afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
  vi.restoreAllMocks()
})

describe('细粒度权限：覆盖项计算', () => {
  it('角色默认值 ± 覆盖项；与默认相同时去掉覆盖项', () => {
    expect(roleDefault('member', 'customer:delete')).toBe(true)
    expect(roleDefault('member', 'data:export')).toBe(false)
    expect(roleDefault('viewer', 'data:write')).toBe(false)
    expect(effectiveAllowed('member', { 'customer:delete': 'deny' }, 'customer:delete')).toBe(false)
    expect(effectiveAllowed('owner', { 'customer:delete': 'deny' }, 'customer:delete')).toBe(true)
    expect(toggleOverride('member', {}, 'customer:delete', false)).toEqual({ 'customer:delete': 'deny' })
    expect(toggleOverride('member', { 'customer:delete': 'deny' }, 'customer:delete', true)).toEqual({})
    expect(toggleOverride('member', {}, 'data:export', true)).toEqual({ 'data:export': 'grant' })
  })
})

describe('MemberPermissionsEditor', () => {
  it('按分组列出权限；勾选状态反映角色默认值与覆盖项；保存交出覆盖项', async () => {
    const wrapper = mount(MemberPermissionsEditor, {
      props: { member: member({ permissionOverrides: { 'deal:delete': 'deny' } }) },
    })
    const legends = wrapper.findAll('legend').map((l) => l.text())
    expect(legends).toEqual(['客户', '商机', '报价订单', '任务', '数据导入导出', '邮件', '工作流'])
    expect(box(wrapper, 'customer:delete').checked).toBe(true)
    expect(box(wrapper, 'deal:delete').checked).toBe(false)
    expect(box(wrapper, 'data:export').checked).toBe(false)
    expect(wrapper.find('[data-perm="deal:delete"] [data-testid="perm-custom"]').exists()).toBe(true)
    // 没改动时不能保存
    expect((wrapper.get('[data-testid="perm-save"]').element as HTMLButtonElement).disabled).toBe(true)

    await setBox(wrapper, 'customer:delete', false)
    await setBox(wrapper, 'data:export', true)
    await setBox(wrapper, 'deal:delete', true)
    await wrapper.get('[data-testid="perm-save"]').trigger('click')
    expect(wrapper.emitted('save')?.[0]).toEqual([{ 'customer:delete': 'deny', 'data:export': 'grant' }])
  })

  it('收回“修改业务数据”时，删除类权限提示需要同时允许', async () => {
    const wrapper = mount(MemberPermissionsEditor, { props: { member: member() } })
    expect(wrapper.find('[data-perm="customer:delete"] .perm-need').exists()).toBe(false)
    await setBox(wrapper, 'data:write', false)
    expect(wrapper.find('[data-perm="customer:delete"] .perm-need').text()).toContain('修改业务数据')
    expect(wrapper.find('[data-perm="email:send"] .perm-need').exists()).toBe(false)
  })

  it('owner：全部勾选且不可编辑', () => {
    const wrapper = mount(MemberPermissionsEditor, { props: { member: member({ role: 'owner' }) } })
    expect(wrapper.text()).toContain('owner 始终拥有全部权限')
    expect(box(wrapper, 'customer:delete').checked).toBe(true)
    expect(box(wrapper, 'customer:delete').disabled).toBe(true)
    expect(wrapper.find('[data-testid="perm-save"]').exists()).toBe(false)
  })

  it('恢复默认：清空覆盖项', async () => {
    const wrapper = mount(MemberPermissionsEditor, {
      props: { member: member({ permissionOverrides: { 'task:delete': 'deny', 'data:export': 'grant' } }) },
    })
    expect(wrapper.text()).toContain('2 项已调整')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '恢复默认')!
      .trigger('click')
    await wrapper.get('[data-testid="perm-save"]').trigger('click')
    expect(wrapper.emitted('save')?.[0]).toEqual([{}])
  })
})

describe('按钮按生效权限禁用（v-perm 支持多项权限）', () => {
  const Probe = {
    directives: { perm: vPerm },
    template: `<div>
      <button data-testid="del" v-perm="['data:write', 'customer:delete']">del</button>
      <button data-testid="exp" v-perm="'data:export'">exp</button>
      <a data-testid="imp" v-perm:hide="['data:write', 'customer:import']">imp</a>
    </div>`,
  }

  it('本机模式：全部可用', () => {
    const wrapper = mount(Probe)
    expect((wrapper.get('[data-testid="del"]').element as HTMLButtonElement).disabled).toBe(false)
    expect(canDelete('customer:delete')).toBe(true)
  })

  it('团队服务器：管理员关闭了删除客户 → 删除按钮禁用并说明原因；没有导入权限 → 隐藏', () => {
    auth.mode = 'server'
    auth.me = {
      mode: 'server',
      user: { id: 'u1', role: 'member' },
      permissions: ['data:read', 'data:write', 'deal:delete', 'email:send'],
    } as unknown as api.Me
    const wrapper = mount(Probe)
    const del = wrapper.get('[data-testid="del"]').element as HTMLButtonElement
    expect(del.disabled).toBe(true)
    expect(del.title).toBe('管理员没有给你「删除客户」权限')
    expect(denyReason('customer:delete')).toBe('管理员没有给你「删除客户」权限')
    // 角色本来就没有的权限：沿用角色说明
    const exp = wrapper.get('[data-testid="exp"]').element as HTMLButtonElement
    expect(exp.disabled).toBe(true)
    expect(exp.title).toContain('成员')
    expect((wrapper.get('[data-testid="imp"]').element as HTMLElement).style.display).toBe('none')
    expect(canDelete('customer:delete')).toBe(false)
    expect(canDelete('deal:delete')).toBe(true)
  })

  it('客户详情的商机列表：没有 deal:delete 时删除按钮禁用', async () => {
    vi.spyOn(api.dealsApi, 'list').mockResolvedValue({
      items: [
        { id: 'd1', title: 'Valve order', stage: 'qualified', amount: 1, currency: 'USD' } as unknown as api.Deal,
      ],
      total: 1,
    } as Awaited<ReturnType<typeof api.dealsApi.list>>)
    auth.mode = 'server'
    auth.me = {
      mode: 'server',
      user: { id: 'u1', role: 'member' },
      permissions: ['data:read', 'data:write', 'customer:delete'],
    } as unknown as api.Me
    const wrapper = mount(CustomerDeals, {
      props: { customerId: 'c1', customerName: 'Acme', canEdit: true },
      global: { directives: { perm: vPerm } },
    })
    await flushPromises()
    const del = wrapper.get('button.icon-btn.danger').element as HTMLButtonElement
    expect(del.disabled).toBe(true)
    expect(del.title).toBe('管理员没有给你「删除商机」权限')
  })
})
