import { expect, test, type Page } from '@playwright/test'

/**
 * 邮箱主流程（真服务 + 本机测试 IMAP/SMTP + 假模型）：
 * 配置邮箱账户 → 测试连接 → 同步 → 规则 / 模型判定 → 从邮件建客户 → AI 草稿 → 二次确认后发送
 */
test.describe.configure({ mode: 'serial' })

const IMAP = Number(process.env.E2E_PORT_IMAP || 52143)
const SMTP = Number(process.env.E2E_PORT_SMTP || 52025)
const LLM = Number(process.env.E2E_PORT_MAILLLM || 52999)
const ACCOUNT = 'sales@lulux-demo.example.com'

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.request.fetch(path, {
    method,
    data: body === undefined ? undefined : body,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  })
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy()
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

test('准备：邮件专用假模型设为默认，询盘规则', async ({ page }) => {
  await page.goto('/')
  const { provider } = await api<{ provider: { id: string } }>(page, 'POST', '/api/providers', {
    name: 'Mail Mock',
    kind: 'openai',
    baseUrl: `http://127.0.0.1:${LLM}/v1`,
    apiKey: 'sk-mail-mock-0001',
    model: 'mock-gpt',
    models: ['mock-gpt'],
  })
  await api(page, 'PATCH', '/api/settings', { defaultProviderId: provider.id, emailSyncIntervalMinutes: 0 })
  await api(page, 'POST', '/api/inquiry-rules', {
    name: 'RFQ 询价',
    enabled: true,
    action: 'inquiry',
    priority: 20,
    conditions: [{ field: 'subject', op: 'contains', value: 'RFQ' }],
  })
  await api(page, 'POST', '/api/inquiry-rules', {
    name: '推广邮件',
    enabled: true,
    action: 'spam',
    priority: 10,
    conditions: [{ field: 'domain', op: 'contains', value: 'rank-boost' }],
  })
})

test('设置 → 邮箱账户：填写服务器、测试连接、保存', async ({ page }) => {
  await page.goto('/#/settings/mailbox')
  await expect(page.getByText('还没有绑定邮箱')).toBeVisible()
  await page.getByRole('button', { name: '添加邮箱' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name=email]').fill(ACCOUNT)
  await dialog.locator('select[name=preset]').selectOption('custom')
  await dialog.locator('input[name=password]').fill('wrong-pass')
  await dialog.locator('input[name=displayName]').fill('Koko Chen')
  await dialog.locator('input[name=imapHost]').fill('127.0.0.1')
  await dialog.locator('input[name=imapPort]').fill(String(IMAP))
  await dialog.locator('input[name=smtpHost]').fill('127.0.0.1')
  await dialog.locator('input[name=smtpPort]').fill(String(SMTP))
  for (const box of await dialog.getByLabel('SSL/TLS').all()) await box.uncheck()
  // 错误的授权码：给出可读的失败原因
  await dialog.getByRole('button', { name: '测试连接' }).click()
  await expect(dialog.locator('.test-list .bad').first()).toBeVisible({ timeout: 30_000 })
  await dialog.locator('input[name=password]').fill('demo-app-pass')
  await dialog.getByRole('button', { name: '测试连接' }).click()
  await expect(dialog.locator('.test-list .ok')).toHaveCount(2, { timeout: 30_000 })
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  const row = page.getByTestId('mail-account-row')
  await expect(row).toContainText(ACCOUNT)
  await expect(page.locator('body')).not.toContainText('demo-app-pass')
})

test('邮箱：同步后按规则判定，模型复核给出理由', async ({ page }) => {
  await page.goto('/#/mailbox')
  await page.getByTestId('mail-sync').click()
  const rows = page.getByTestId('mail-row')
  await expect(rows).toHaveCount(5, { timeout: 30_000 })
  await expect(rows.filter({ hasText: 'RFQ: Brass ball valves' })).toContainText('询盘')
  await expect(rows.filter({ hasText: 'Rank #1 on Google' })).toContainText('垃圾')
  const catalogue = rows.filter({ hasText: 'Catalogue and price list' })
  await expect(catalogue).toContainText('待复核')

  // 按判定筛选
  await page.getByRole('group', { name: '按判定筛选' }).getByRole('button', { name: '询盘' }).click()
  await expect(rows).toHaveCount(1)
  await page.getByRole('group', { name: '按判定筛选' }).getByRole('button', { name: '全部' }).click()
  await expect(rows).toHaveCount(5)

  await catalogue.click()
  await expect(page.getByTestId('verdict-reason')).toContainText('没有命中规则')
  await page.getByRole('button', { name: '让模型复核' }).click()
  await expect(page.getByTestId('verdict-box')).toContainText('模型', { timeout: 20_000 })
  await expect(page.getByTestId('verdict-reason')).toContainText('进口商')
  await expect(catalogue).toContainText('询盘')
})

test('邮箱：从邮件建客户 → AI 草稿 → 确认收件人后发送', async ({ page }) => {
  await page.goto('/#/mailbox')
  const rfq = page.getByTestId('mail-row').filter({ hasText: 'RFQ: Brass ball valves' })
  await rfq.click()
  const reader = page.getByTestId('mail-reader')
  await expect(reader).toContainText('Nordlicht Armaturen')

  await page.getByTestId('create-customer').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name=company]').fill('Nordlicht Armaturen GmbH')
  await dialog.locator('input[name=country]').fill('Germany')
  await dialog.getByRole('button', { name: '建客户' }).click()
  await expect(page.getByTestId('customer-box')).toContainText('Nordlicht Armaturen GmbH')
  await expect(rfq).toContainText('Nordlicht')

  await page.getByTestId('ai-draft').click()
  await page.locator('input[name=instructions]').fill('报 FOB 宁波价，强调交期')
  await page.getByTestId('ai-generate').click()
  const editor = page.getByTestId('draft-editor')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await expect(editor).toContainText('AI 起草')
  await expect(editor.locator('textarea[name=text]')).toHaveValue(/Dear Hans/)
  await expect(editor.locator('input[name=to]')).toHaveValue(/hans\.becker@nordlicht-armaturen\.example\.com/)
  await expect(editor.locator('input[name=subject]')).toHaveValue(/^Re: RFQ/)

  // 修改正文 → 发送 → 二次确认里必须列出收件人；先取消，确认没有发出
  await editor
    .locator('textarea[name=text]')
    .fill('Dear Hans,\n\nThanks for the RFQ. Our offer: DN25 USD 3.85/pc FOB Ningbo, 25 days.\n\nBest regards,\nKoko')
  await page.getByTestId('draft-send').click()
  const confirm = page.getByRole('dialog', { name: '确认发送这封邮件？' })
  await expect(confirm).toContainText('收件人：Hans Becker <hans.becker@nordlicht-armaturen.example.com>')
  await expect(confirm).toContainText(`发件人：Koko Chen <${ACCOUNT}>`)
  await confirm.getByRole('button', { name: '取消' }).click()
  let sent = await (await page.request.get(`http://127.0.0.1:${IMAP + 1}/sent`)).json()
  expect(sent).toHaveLength(0)

  await page.getByTestId('draft-send').click()
  await page.getByRole('dialog', { name: '确认发送这封邮件？' }).getByRole('button', { name: '确认发送' }).click()
  await expect(page.locator('.toast').filter({ hasText: '已发送给' })).toBeVisible({ timeout: 30_000 })
  sent = await (await page.request.get(`http://127.0.0.1:${IMAP + 1}/sent`)).json()
  expect(sent).toHaveLength(1)
  expect(sent[0].to).toEqual(['hans.becker@nordlicht-armaturen.example.com'])
  expect(sent[0].subject).toContain('RFQ')

  // 已发送文件夹里出现这封信；客户阶段推进、记一条邮件跟进
  await page.getByRole('tab', { name: '已发送' }).click()
  await expect(page.getByTestId('mail-row').first()).toContainText('Re: RFQ')
  await page.getByRole('tab', { name: '收件箱' }).click()
  await rfq.click()
  await page.getByTestId('customer-box').getByRole('link').click()
  await expect(page.getByRole('heading', { name: 'Nordlicht Armaturen GmbH' }).first()).toBeVisible()
  await expect(page.locator('.timeline')).toContainText('邮件')
})

test('邮箱：工作台 / 客户页 / 全局搜索的链接参数 verdict、message、compose', async ({ page }) => {
  // ?verdict=inquiry：只看询盘，判定筛选按钮处于按下状态
  await page.goto('/#/mailbox?verdict=inquiry')
  const rows = page.getByTestId('mail-row')
  await expect(rows.first()).toBeVisible({ timeout: 20_000 })
  const group = page.getByRole('group', { name: '按判定筛选' })
  await expect(group.getByRole('button', { name: '询盘' })).toHaveAttribute('aria-pressed', 'true')
  const n = await rows.count()
  for (let i = 0; i < n; i++) await expect(rows.nth(i)).toContainText('询盘')
  await expect(rows.filter({ hasText: 'Rank #1 on Google' })).toHaveCount(0)
  // 进入邮箱自动打开第一封
  await expect(page.getByTestId('mail-reader').locator('.read-subj')).toBeVisible()
  await expect(rows.first()).toHaveAttribute('aria-current', 'true')

  // ?message=<id>：打开指定那封（不是列表第一封），不被“自动打开第一封”顶掉
  const list = await api<{ items: Array<{ id: string; subject: string }> }>(
    page,
    'GET',
    '/api/email/messages?folder=inbox&pageSize=50',
  )
  expect(list.items.length).toBeGreaterThan(1)
  const target = list.items[list.items.length - 1]!
  await page.goto(`/#/mailbox?message=${target.id}`)
  await expect(page.getByTestId('mail-reader').locator('.read-subj')).toHaveText(target.subject, { timeout: 20_000 })
  await expect(rows.filter({ hasText: target.subject }).first()).toHaveAttribute('aria-current', 'true')
  await page.waitForTimeout(800)
  await expect(page.getByTestId('mail-reader').locator('.read-subj')).toHaveText(target.subject)

  // ?compose=1&to=：新建草稿并预填收件人
  const to = `buyer.${Date.now()}@example.com`
  await page.goto(`/#/mailbox?compose=1&to=${encodeURIComponent(to)}`)
  const editor = page.getByTestId('draft-editor')
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await expect(editor.locator('input[name=to]')).toHaveValue(new RegExp(to.replace(/[.]/g, '\\.')))
  await expect(page.getByRole('tab', { name: /草稿/ })).toHaveAttribute('aria-selected', 'true')
  const drafts = await api<Array<{ id: string; to: Array<{ address: string }> }>>(page, 'GET', '/api/email/drafts')
  const mine = (Array.isArray(drafts) ? drafts : (drafts as { items: typeof drafts }).items).filter((d) =>
    d.to.some((a) => a.address === to),
  )
  expect(mine).toHaveLength(1)
  await api(page, 'DELETE', `/api/email/drafts/${mine[0]!.id}`)
})
