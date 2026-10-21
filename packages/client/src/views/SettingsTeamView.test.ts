import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'
import SettingsTeamView from './SettingsTeamView.vue'

function user(id: string, role: api.Role, extra: Partial<api.Member> = {}): api.Member {
  return {
    id,
    email: `${id}@acme.example.com`,
    name: id,
    role,
    disabled: false,
    createdAt: 0,
    lastLoginAt: null,
    permissionOverrides: {},
    ...extra,
  }
}
function signIn(role: api.Role): void {
  auth.mode = 'server'
  auth.me = {
    mode: 'server',
    user: user('me', role),
    org: { id: 'o', name: 'Acme', createdAt: 0 },
    teams: [],
    permissions:
      role === 'owner' ? [...api.ALL_PERMISSIONS] : api.ALL_PERMISSIONS.filter((p) => p !== 'security:manage'),
    session: null,
  }
}
async function mountView(members: api.Member[]) {
  vi.spyOn(api, 'listMembers').mockResolvedValue(members)
  vi.spyOn(api, 'listTeams').mockResolvedValue([])
  const wrapper = mount(SettingsTeamView, {
    global: { stubs: { SettingsSidebar: true, PageTopbar: true, RouterLink: true, teleport: true } },
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
  vi.restoreAllMocks()
})

describe('成员管理：权限编辑', () => {
  it('owner 可以给 member / admin 设置权限，不能给 owner 或自己；保存调用 PUT 并刷新行', async () => {
    signIn('owner')
    const set = vi
      .spyOn(api, 'setMemberPermissions')
      .mockImplementation(async (id, overrides) => ({ ...user(id, 'member'), permissionOverrides: overrides }))
    const wrapper = await mountView([
      user('me', 'owner'),
      user('boss', 'owner'),
      user('adm', 'admin'),
      user('sales', 'member'),
    ])
    const rows = wrapper.findAll('tbody tr')
    const btnIn = (i: number) => rows[i]!.find('[data-testid="member-perms-btn"]')
    expect(btnIn(0).exists()).toBe(false)
    expect(btnIn(1).exists()).toBe(false)
    expect(btnIn(2).exists()).toBe(true)
    expect(btnIn(3).exists()).toBe(true)

    await btnIn(3).trigger('click')
    const editor = wrapper.get('[data-testid="member-permissions"]')
    await editor.get('[data-perm="customer:delete"] input').setValue(false)
    await editor.get('[data-testid="perm-save"]').trigger('click')
    await flushPromises()
    expect(set).toHaveBeenCalledWith('sales', { 'customer:delete': 'deny' })
    expect(wrapper.find('[data-testid="member-permissions"]').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')[3]!.get('.perm-count').text()).toBe('1')
  })

  it('admin 不能调整其他管理员的权限', async () => {
    signIn('admin')
    const wrapper = await mountView([user('me', 'admin'), user('adm2', 'admin'), user('sales', 'member')])
    const rows = wrapper.findAll('tbody tr')
    expect(rows[1]!.find('[data-testid="member-perms-btn"]').exists()).toBe(false)
    expect(rows[2]!.find('[data-testid="member-perms-btn"]').exists()).toBe(true)
  })
})

describe('服务器安全：管理员可查看成员邮箱', () => {
  async function openSecurity(role: api.Role) {
    signIn(role)
    vi.spyOn(api, 'getSecurity').mockResolvedValue({ allowKernels: false, allowMcp: false, adminMailboxAccess: false, warning: 'w' })
    vi.spyOn(api, 'listAudit').mockResolvedValue({ items: [], total: 0 })
    const wrapper = await mountView([user('me', role)])
    const tabs = wrapper.findAll('[role="tab"]')
    const security = tabs.find((t) => t.text().includes('安全与隐私'))!
    await security.trigger('click')
    await flushPromises()
    return wrapper
  }

  it('owner 开启需要确认，确认后调用 PATCH adminMailboxAccess', async () => {
    const { uiState } = await import('../stores/ui')
    const update = vi
      .spyOn(api, 'updateSecurity')
      .mockResolvedValue({ allowKernels: false, allowMcp: false, adminMailboxAccess: true, warning: 'w' })
    const wrapper = await openSecurity('owner')
    const row = wrapper.get('[data-testid="admin-mailbox-access"]')
    expect(row.text()).toContain('管理员可查看成员邮箱')
    await row.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(uiState.confirm?.danger).toBe(true)
    uiState.confirm?.resolve(true)
    await flushPromises()
    expect(update).toHaveBeenCalledWith({ adminMailboxAccess: true })
  })

  it('admin（没有 security:manage）只能看，开关禁用', async () => {
    const wrapper = await openSecurity('admin')
    expect(wrapper.get('[data-testid="admin-mailbox-access"] [role="switch"]').attributes('disabled')).toBeDefined()
  })
})

describe('成员管理：离职交接', () => {
  const counts: api.HandoverCounts = {
    customers: 3,
    quotes: 2,
    deals: 1,
    orders: 1,
    tasks: 4,
    emailAccounts: 2,
    workflows: 1,
    schedules: 2,
  }

  it('对话框按类型显示数量，选择接收人与邮箱处理方式后提交，提示里汇总各类结果', async () => {
    signIn('admin')
    const preview = vi.spyOn(api, 'getHandoverPreview').mockResolvedValue(counts)
    const transfer = vi.spyOn(api, 'transferCustomers').mockResolvedValue({
      moved: 3,
      emailAccounts: { mode: 'disable', count: 2 },
      workflows: 1,
      schedules: 2,
    })
    const { toast } = await import('../stores/ui')
    const success = vi.spyOn(toast, 'success')
    const wrapper = await mountView([
      user('me', 'admin'),
      user('leaver', 'member'),
      user('carol', 'member'),
      user('gone', 'member', { disabled: true }),
    ])
    await wrapper.findAll('tbody tr')[1]!.get('[data-testid="member-handover-btn"]').trigger('click')
    await flushPromises()
    expect(preview).toHaveBeenCalledWith('leaver')
    const dialog = wrapper.get('[data-testid="handover-dialog"]')
    expect(dialog.get('[data-type="customers"]').text()).toContain('3')
    expect(dialog.get('[data-type="emailAccounts"]').text()).toContain('邮箱账户')
    expect(dialog.get('[data-type="schedules"]').text()).toContain('2')
    // 接收人不含交接人自己和已停用的成员
    const options = dialog.findAll('[data-testid="handover-receiver"] option').map((o) => o.attributes('value'))
    expect(options).toEqual(['', 'me', 'carol'])
    expect(wrapper.get('[data-testid="handover-submit"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="handover-dialog"]').get('[data-testid="handover-receiver"]').setValue('carol')
    await wrapper
      .get('[data-testid="handover-dialog"]')
      .get('input[name="handover-email"][value="disable"]')
      .setValue(true)
    // 取消工作流时定时任务也一并取消（定时任务可能依赖工作流）
    await wrapper.get('[data-testid="handover-dialog"]').get('[data-testid="handover-workflows"]').setValue(false)
    await flushPromises()
    expect(
      (
        wrapper.get('[data-testid="handover-dialog"]').get('[data-testid="handover-schedules"]')
          .element as HTMLInputElement
      ).checked,
    ).toBe(false)
    await wrapper.get('[data-testid="handover-dialog"]').get('[data-testid="handover-schedules"]').setValue(true)
    await flushPromises()
    expect(
      (
        wrapper.get('[data-testid="handover-dialog"]').get('[data-testid="handover-workflows"]')
          .element as HTMLInputElement
      ).checked,
    ).toBe(true)

    await wrapper.get('[data-testid="handover-submit"]').trigger('click')
    await flushPromises()
    expect(transfer).toHaveBeenCalledWith('leaver', 'carol', {
      emailAccounts: 'disable',
      workflows: true,
      schedules: true,
    })
    expect(success).toHaveBeenCalledWith('已交接 3 个客户，停用了 2 个邮箱的同步，1 个工作流，2 个定时任务')
    expect(wrapper.find('[data-testid="handover-dialog"]').exists()).toBe(false)
  })

  it('旧服务端没有预览接口：仍可只交接客户', async () => {
    signIn('admin')
    vi.spyOn(api, 'getHandoverPreview').mockRejectedValue(new api.ApiError('HTTP_404', 'x', 404))
    const transfer = vi.spyOn(api, 'transferCustomers').mockResolvedValue({ moved: 1 })
    const wrapper = await mountView([user('me', 'admin'), user('leaver', 'member'), user('carol', 'member')])
    await wrapper.findAll('tbody tr')[1]!.get('[data-testid="member-handover-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="handover-counts"]').exists()).toBe(false)
    await wrapper.get('[data-testid="handover-receiver"]').setValue('carol')
    await wrapper.get('[data-testid="handover-submit"]').trigger('click')
    await flushPromises()
    expect(transfer).toHaveBeenCalledWith('leaver', 'carol', {})
  })
})

describe('成员管理：直接添加成员与待改密标记', () => {
  it('填写邮箱、姓名、初始密码后创建；新成员显示“待改密”', async () => {
    signIn('admin')
    const create = vi
      .spyOn(api, 'createMember')
      .mockImplementation(async (body) =>
        user('dave', body.role, { email: body.email, name: body.name, mustChangePassword: true }),
      )
    const wrapper = await mountView([user('me', 'admin')])
    // PageTopbar 被 stub：直接调用打开方法对应的按钮不在 DOM 里，改为触发组件内部状态
    ;(wrapper.vm as unknown as { openCreate: () => void }).openCreate()
    await flushPromises()
    const form = wrapper.get('[data-testid="create-member-form"]')
    await form.get('input[name=email]').setValue('dave@acme.example.com')
    await form.get('input[name=name]').setValue('Dave')
    await form.get('input[name=password]').setValue('short')
    await form.trigger('submit')
    expect(wrapper.get('[role=alert]').text()).toContain('8')
    expect(create).not.toHaveBeenCalled()
    // admin 不能直接创建管理员
    expect(form.findAll('select[name=role] option').map((o) => o.attributes('value'))).toEqual(['member', 'viewer'])
    await form.get('input[name=password]').setValue('initial pass 1')
    await form.trigger('submit')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({
      email: 'dave@acme.example.com',
      name: 'Dave',
      role: 'member',
      password: 'initial pass 1',
      teamId: undefined,
    })
    expect(wrapper.find('[data-testid="create-member-form"]').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')[1]!.get('[data-testid="must-change-tag"]').text()).toBe('待改密')
  })

  it('邮箱已注册：表单内提示', async () => {
    signIn('owner')
    vi.spyOn(api, 'createMember').mockRejectedValue(new api.ApiError('EMAIL_TAKEN', 'x', 409))
    const wrapper = await mountView([user('me', 'owner')])
    ;(wrapper.vm as unknown as { openCreate: () => void }).openCreate()
    await flushPromises()
    const form = wrapper.get('[data-testid="create-member-form"]')
    expect(form.findAll('select[name=role] option').map((o) => o.attributes('value'))).toEqual([
      'member',
      'viewer',
      'admin',
    ])
    await form.get('input[name=email]').setValue('x@acme.example.com')
    await form.get('input[name=name]').setValue('X')
    await form.get('input[name=password]').setValue('initial pass 1')
    await form.trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('该邮箱已注册')
  })
})
