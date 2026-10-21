import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * 团队服务器模式（LULUX_MODE=server）：
 * owner 初始化并登录 → 建客户并共享给全组织 → 邀请只读成员 → 成员通过邀请加入 → 只读校验
 */
test.describe.configure({ mode: 'serial' })

const TEAM = `http://localhost:${process.env.E2E_PORT_TEAMWEB || 52891}`
const OWNER = { email: 'owner@mingchuan.example.com', password: 'Owner-pass-2026', name: 'Koko Chen' }
const VIEWER = { email: 'lin.viewer@mingchuan.example.com', password: 'Viewer-pass-2026', name: 'Lin Yu' }
let inviteCode = ''

test('owner：用初始化口令创建所有者并进入团队页', async ({ page }) => {
  await page.goto(`${TEAM}/`)
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByRole('heading', { name: '初始化团队服务器' })).toBeVisible()
  const token = readFileSync(join(process.env.E2E_SERVER_DATA_DIR as string, 'setup-token'), 'utf8').trim()
  await page.getByLabel('初始化口令').fill(token)
  await page.getByLabel('组织名称').fill('明川外贸')
  await page.getByLabel('你的名字').fill(OWNER.name)
  await page.getByLabel('邮箱', { exact: true }).fill(OWNER.email)
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: '创建所有者并登录' }).click()
  await expect(page.getByRole('heading', { name: '团队与权限' })).toBeVisible()
  await expect(page.getByTestId('member-row')).toContainText(OWNER.email)
})

test('owner：建客户并共享给全组织；内核 / MCP 默认禁用', async ({ page }) => {
  await page.goto(`${TEAM}/#/login`)
  // 同源团队服务器：直接落在“云端 LULUX”栏，地址是本站；错误密码在页内提示
  await expect(page.getByRole('tab', { name: '云端 LULUX' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('服务器地址')).toHaveValue(TEAM)
  await page.getByLabel('邮箱', { exact: true }).fill(OWNER.email)
  await page.getByLabel('密码', { exact: true }).fill('wrong-pass-2026')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('alert')).toHaveText('邮箱或密码错误')
  await expect(page).toHaveURL(/#\/login/)
  await page.getByLabel('邮箱', { exact: true }).fill(OWNER.email)
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).not.toHaveURL(/login/)

  await page.goto(`${TEAM}/#/customers`)
  await page.getByRole('button', { name: '新建客户' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('公司名称').fill('Harbourline Imports Ltd')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()
  await page.getByText('Harbourline Imports Ltd').first().click()
  await expect(page.getByTestId('customer-owner')).toContainText(OWNER.name)
  await page.getByRole('button', { name: '转移 / 共享' }).click()
  const assign = page.getByRole('dialog', { name: '转移负责人 / 共享' })
  await assign.locator('select[name=visibility]').selectOption('org')
  await assign.getByRole('button', { name: '保存' }).click()
  await expect(page.getByTestId('customer-owner')).toContainText('全组织可见')

  await page.goto(`${TEAM}/#/settings/mcp`)
  await expect(page.getByTestId('server-feature-note')).toContainText('禁用MCP 工具')
})

test('owner：生成只读邀请，邀请码只显示一次', async ({ page }) => {
  await page.goto(`${TEAM}/#/login`)
  await page.getByLabel('邮箱', { exact: true }).fill(OWNER.email)
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: '登录' }).click()
  // 等登录真正完成再跳转，否则登录回调可能在团队页挂载后才到达
  await expect(page).not.toHaveURL(/login/)
  await page.goto(`${TEAM}/#/settings/team`)
  await expect(page.getByRole('heading', { name: '团队与权限' })).toBeVisible()
  await page.getByRole('tab', { name: '邀请' }).click()
  await page.getByTestId('new-invite').click()
  const dialog = page.getByRole('dialog', { name: '邀请成员' })
  await dialog.locator('select[name=role]').selectOption('viewer')
  await dialog.locator('input[name=email]').fill(VIEWER.email)
  await dialog.getByRole('button', { name: '生成邀请' }).click()
  inviteCode = await page.getByTestId('invite-code').inputValue()
  expect(inviteCode).toMatch(/^lxi_[0-9a-f]{32}$/)
  await expect(page.getByTestId('invite-url')).toHaveValue(/#\/join\?code=lxi_/)
  await page.getByRole('button', { name: '完成' }).click()
  await expect(page.getByTestId('invite-row')).toContainText(VIEWER.email)
  await expect(page.getByTestId('invite-row')).toContainText('只读')
  await expect(page.locator('body')).not.toContainText(inviteCode)

  // 退出登录
  await page.goto(`${TEAM}/#/settings/account`)
  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/#\/login/)
})

test('成员：通过邀请加入，只读角色看不到写操作', async ({ page }) => {
  await page.goto(`${TEAM}/#/join?code=${inviteCode}`)
  await expect(page.getByTestId('invite-info')).toContainText('明川外贸')
  await expect(page.getByTestId('invite-info')).toContainText('只读')
  await page.locator('input[name=name]').fill(VIEWER.name)
  await expect(page.locator('input[name=email]')).toHaveValue(VIEWER.email)
  await page.locator('input[name=password]').fill(VIEWER.password)
  await page.getByRole('button', { name: '加入并登录' }).click()
  await expect(page).not.toHaveURL(/join|login/)

  // 客户：能看到共享客户，不能新建 / 编辑
  await page.goto(`${TEAM}/#/customers`)
  await expect(page.getByTestId('perm-note')).toBeVisible()
  await expect(page.getByRole('button', { name: '新建客户' }).first()).toBeDisabled()
  await expect(page.getByRole('link', { name: '导入表格' })).toHaveCount(0)
  await page.getByText('Harbourline Imports Ltd').first().click()
  await expect(page.getByRole('button', { name: '编辑' }).first()).toBeDisabled()
  await expect(page.getByRole('button', { name: '删除' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '转移 / 共享' })).toHaveCount(0)

  // 模型、规则只读；团队页没有邀请与审计
  await page.goto(`${TEAM}/#/settings/models`)
  await expect(page.getByTestId('perm-note')).toBeVisible()
  await page.goto(`${TEAM}/#/settings/rules`)
  await expect(page.getByRole('button', { name: '新建规则' }).first()).toBeDisabled()
  await page.goto(`${TEAM}/#/settings/team`)
  await expect(page.getByRole('tab', { name: '邀请' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '审计日志' })).toHaveCount(0)
  await expect(page.getByTestId('member-row')).toHaveCount(2)
  await expect(page.locator('select[aria-label$="的角色"]')).toHaveCount(0)

  // 服务端同样拒绝（界面之外的兜底）
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('lulux.session') || '{}').token as string)
  const res = await page.request.post(`${TEAM}/api/customers`, {
    data: { company: 'Should Fail' },
    headers: { Authorization: `Bearer ${session}` },
  })
  expect(res.status()).toBe(403)
})

test('owner：审计日志可按操作筛选', async ({ page }) => {
  await page.goto(`${TEAM}/#/login`)
  await page.getByLabel('邮箱', { exact: true }).fill(OWNER.email)
  await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).not.toHaveURL(/login/)
  await page.goto(`${TEAM}/#/settings/team`)
  await expect(page.getByRole('heading', { name: '团队与权限' })).toBeVisible()
  await page.getByRole('tab', { name: '审计日志' }).click()
  await expect(page.getByTestId('audit-row').first()).toBeVisible()
  await page.getByLabel('按操作筛选').selectOption('invite.')
  await expect(page.getByTestId('audit-row').first()).toContainText('invite.')
  await expect(page.getByTestId('audit-row').filter({ hasText: 'invite.accept' })).toHaveCount(1)
})
