import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'

/**
 * 团队服务器：按账号的细粒度权限。
 * owner 在成员管理里关闭某业务员的“删除客户” → 该业务员的客户详情里删除按钮禁用并说明原因，
 * 服务端同样拒绝（403 “没有权限：删除客户”）；恢复默认后按钮可用。
 * 文件名排在 team.spec 之后：复用它创建的 owner；单独运行时自己初始化。
 */
test.describe.configure({ mode: 'serial' })

const TEAM = `http://localhost:${process.env.E2E_PORT_TEAMWEB || 52891}`
const OWNER = { email: 'owner@mingchuan.example.com', password: 'Owner-pass-2026', name: 'Koko Chen' }
const PASSWORD = 'Member-pass-2026'
const stamp = Date.now().toString(36)

interface Account {
  token: string
  id: string
  name: string
  email: string
  role: string
}
let owner: Account
let sales: Account
let customerId = ''

async function call<T = unknown>(
  request: APIRequestContext,
  method: string,
  path: string,
  token: string | null,
  data?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await request.fetch(`${TEAM}${path}`, {
    method,
    data: data === undefined ? undefined : data,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  return { status: res.status(), json: (text ? JSON.parse(text) : null) as T }
}

async function signedIn(browser: Browser, account: Account, path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.addInitScript(
    ({ token, user }) => {
      if (!localStorage.getItem('lulux.session'))
        localStorage.setItem('lulux.session', JSON.stringify({ token, user, baseUrl: '' }))
    },
    { token: account.token, user: { id: account.id, name: account.name, email: account.email, role: account.role } },
  )
  const page = await context.newPage()
  await page.goto(`${TEAM}/#${path}`)
  await expect(page).not.toHaveURL(/login/)
  return page
}

test.beforeAll(async ({ request }) => {
  const mode = await call<{ setupRequired: boolean }>(request, 'GET', '/api/auth/mode', null)
  if (mode.json.setupRequired) {
    const setupToken = readFileSync(join(process.env.E2E_SERVER_DATA_DIR as string, 'setup-token'), 'utf8').trim()
    const setup = await call(request, 'POST', '/api/auth/setup', null, { setupToken, orgName: '明川外贸', ...OWNER })
    expect(setup.status).toBe(201)
  }
  const login = await call<{ token: string; user: { id: string } }>(request, 'POST', '/api/auth/login', null, {
    email: OWNER.email,
    password: OWNER.password,
  })
  expect(login.status).toBe(200)
  owner = { token: login.json.token, id: login.json.user.id, name: OWNER.name, email: OWNER.email, role: 'owner' }
  const invite = await call<{ code: string }>(request, 'POST', '/api/team/invites', owner.token, { role: 'member' })
  expect(invite.status).toBe(201)
  const email = `sales.${stamp}@mingchuan.example.com`
  const accepted = await call<{ token: string; user: { id: string } }>(request, 'POST', '/api/auth/invites/accept', null, {
    code: invite.json.code,
    email,
    password: PASSWORD,
    name: '王业务',
  })
  expect(accepted.status).toBe(201)
  sales = { token: accepted.json.token, id: accepted.json.user.id, name: '王业务', email, role: 'member' }
  const created = await call<{ id: string }>(request, 'POST', '/api/customers', sales.token, {
    company: `Nordic Valve AB ${stamp}`,
  })
  expect(created.status).toBe(201)
  customerId = created.json.id
})

test('owner 在成员管理里关闭“删除客户”', async ({ browser }) => {
  const page = await signedIn(browser, owner, '/settings/team')
  await expect(page.getByRole('heading', { name: '团队与权限' })).toBeVisible()
  const row = page.getByTestId('member-row').filter({ hasText: sales.email })
  await row.getByTestId('member-perms-btn').click()
  const dialog = page.getByRole('dialog', { name: `${sales.name} 的权限` })
  await expect(dialog.locator('legend')).toHaveText(['客户', '商机', '报价订单', '任务', '数据导入导出', '邮件', '工作流'])
  const box = dialog.locator('[data-perm="customer:delete"] input')
  await expect(box).toBeChecked()
  await box.uncheck()
  await dialog.getByTestId('perm-save').click()
  await expect(dialog).toBeHidden()
  await expect(row.locator('.perm-count')).toHaveText('1')
  await page.context().close()
})

test('业务员：删除按钮禁用并说明原因；服务端同样拒绝', async ({ browser, request }) => {
  const page = await signedIn(browser, sales, `/customers/${customerId}`)
  const del = page.getByTestId('customer-delete')
  await expect(del).toBeDisabled()
  await expect(del).toHaveAttribute('title', '管理员没有给你「删除客户」权限')
  await page.context().close()

  const res = await call<{ error: { message: string } }>(request, 'DELETE', `/api/customers/${customerId}`, sales.token)
  expect(res.status).toBe(403)
  expect(res.json.error.message).toBe('没有权限：删除客户')
})

test('恢复默认后，业务员可以删除自己的客户', async ({ browser, request }) => {
  const reset = await call(request, 'PUT', `/api/team/members/${sales.id}/permissions`, owner.token, { overrides: {} })
  expect(reset.status).toBe(200)
  const page = await signedIn(browser, sales, `/customers/${customerId}`)
  await expect(page.getByTestId('customer-delete')).toBeEnabled()
  await page.context().close()
})
