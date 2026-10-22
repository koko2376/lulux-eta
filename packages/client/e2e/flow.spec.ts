import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { E2E_LOCAL } from './fixtures/local-account'

/**
 * 主流程：首次打开 → 加 Provider → 新建会话对话 → 新建客户 → 导入 CSV → 建报价 → 预览 → 导出备份 → 本机锁
 * 运行：npm run test:e2e（会自动启动服务端、假模型服务与 vite；见 playwright.config.ts）
 */
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
const company = `E2E Trading ${stamp}`
let customerUrl = ''

async function noErrorToasts(page: Page): Promise<void> {
  await expect(page.locator('.toast.error')).toHaveCount(0)
}

test('已登录本机账户（e2e 账户会话）打开直接进入工作台', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await expect(page).not.toHaveURL(/login|unlock/)
  await expect(page.locator('.stat').first()).toBeVisible()
  await noErrorToasts(page)
})

test('添加 Provider：密钥只显示预览，测试连接给出结果', async ({ page }) => {
  await page.goto('/#/settings/models')
  await page.getByRole('button', { name: '添加 Provider' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称').fill('Mock OpenAI')
  await dialog.getByLabel('Base URL').fill(`http://127.0.0.1:${process.env.E2E_PORT_CHATLLM || 52998}/v1`)
  await dialog.getByLabel('API Key').fill('sk-e2e-secret-1234')
  await dialog.getByLabel('默认模型').fill('mock-model')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()
  const row = page.locator('.prov', { hasText: 'Mock OpenAI' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('默认')
  await expect(page.locator('body')).not.toContainText('sk-e2e-secret-1234')
  await expect(row).toContainText('1234')
  // 假模型服务没有 /models：应显示可读的失败原因，而不是无响应
  await row.getByRole('button', { name: '测试连接' }).click()
  await expect(row.locator('.test-line')).toBeVisible({ timeout: 20_000 })
})

test('新建会话并完成一次流式对话，消息头显示实际模型', async ({ page }) => {
  await page.goto('/#/agent')
  const input = page.getByLabel('消息内容')
  await expect(input).toBeVisible()
  await input.fill('帮我写一版木屋报价')
  await input.press('Enter')
  const reply = page.locator('.message.assistant').last()
  await expect(reply).toContainText('报价', { timeout: 30_000 })
  await expect(reply.locator('.message-runtime')).toContainText('mock-model')
  await expect(page.locator('.chat-view .error-banner')).toHaveCount(0)
})

test('新建客户并进入详情，记录跟进', async ({ page }) => {
  await page.goto('/#/customers')
  await page.getByRole('button', { name: '新建客户' }).first().click()
  const dialog = page.getByRole('dialog')
  // 必填校验：内联提示，不是浏览器原生气泡
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('请填写公司名称')
  await dialog.getByLabel('公司名称').fill(company)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByLabel('国家/地区').fill('瑞典')
  await dialog.getByLabel('联系人 1 姓名').fill('Erik Example')
  await dialog.getByLabel('联系人 1 邮箱').fill(`erik.${stamp}@example.com`)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(page).toHaveURL(/#\/customers\/[^/]+$/)
  customerUrl = page.url()
  await expect(page.getByRole('heading', { name: company, level: 2 })).toBeVisible()
  await page.getByLabel('跟进内容').fill('电话沟通，客户关注交期')
  // 详情页“客户信息 · 下次跟进”也有一个「添加」链接：限定在跟进记录的表单里
  await page
    .locator('form')
    .filter({ has: page.getByLabel('跟进内容') })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  await expect(page.locator('.timeline')).toContainText('客户关注交期')
})

test('导入 CSV：自动映射、文件内去重、导入结果', async ({ page }) => {
  await page.goto('/#/customers/import')
  const csv = [
    'Company Name,Country,Contact,Email,Notes',
    `Import A ${stamp},Germany,Anna,anna.${stamp}@example.com,first`,
    `Import B ${stamp},France,Paul,paul.${stamp}@example.com,"has, comma"`,
    `Import A dup ${stamp},Germany,Anna,ANNA.${stamp}@example.com,duplicate`,
    `,Spain,No Company,nobody.${stamp}@example.com,invalid`,
  ].join('\n')
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.getByRole('heading', { name: '字段映射' })).toBeVisible()
  await expect(page.locator('.panel-sub', { hasText: '将导入' })).toContainText('将导入 2 行')
  await page.getByRole('button', { name: /导入 2 行/ }).click()
  await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible()
  await expect(page.locator('.result')).toContainText('2')
  await page.getByRole('link', { name: '查看客户' }).click()
  await page.getByLabel('搜索客户').fill(`Import B ${stamp}`)
  await expect(page.locator('.data-table')).toContainText(`Import B ${stamp}`)
})

test('新建报价单：行项目计算、保存、预览', async ({ page }) => {
  const customerId = customerUrl.split('/').pop()
  await page.goto(`/#/quotation/new?customer=${customerId}`)
  await expect(page.getByRole('heading', { name: '新建报价单' })).toBeVisible()
  await page.getByLabel('港口 / 地点').fill('Shanghai')
  await page.getByLabel('第 1 行品名').fill('Log cabin kit')
  await page.getByLabel('第 1 行数量').fill('3')
  await page.getByLabel('第 1 行单价').fill('0.1')
  await page.getByRole('button', { name: '添加一行' }).click()
  await page.getByLabel('第 2 行品名').fill('Roof insulation')
  await page.getByLabel('第 2 行数量').fill('2')
  await page.getByLabel('第 2 行单价').fill('2150.5')
  await expect(page.locator('tfoot .total')).toHaveText('USD 4,301.30')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page).toHaveURL(/#\/quotation\/(?!new)[^/?]+$/)
  await expect(page.locator('.qitem.on')).toContainText('USD 4,301.30')
  await page.getByRole('button', { name: '预览 / 导出 PDF' }).click()
  const frame = page.frameLocator('iframe[title="报价单预览"]')
  await expect(frame.locator('body')).toContainText('Log cabin kit')
  await expect(page.getByRole('button', { name: '打印 / 另存为 PDF' })).toBeEnabled()
})

test('导出备份得到不含密钥的 JSON', async ({ page }) => {
  await page.goto('/#/settings/backup')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^lulux-backup-.*\.json$/)
  const text = readFileSync((await download.path()) as string, 'utf8')
  expect(() => JSON.parse(text)).not.toThrow()
  expect(text).not.toContain('sk-e2e-secret-1234')
})

test('本机锁：开启后需要 PIN 才能进入，关闭后直接进入', async ({ page }) => {
  await page.goto('/#/settings/account')
  await page.getByRole('switch', { name: '启动时要求 PIN' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('新 PIN（4–12 位数字）').fill('2468')
  await dialog.getByLabel('再次输入').fill('2468')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('switch', { name: '启动时要求 PIN' })).toHaveAttribute('aria-checked', 'true')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'LULUX ETA 已锁定' })).toBeVisible()
  await page.getByPlaceholder('输入 PIN').fill('1111')
  await page.getByRole('button', { name: '解锁' }).click()
  await expect(page.getByRole('alert')).toContainText('PIN 不正确')
  await page.getByPlaceholder('输入 PIN').fill('2468')
  await page.getByRole('button', { name: '解锁' }).click()
  await expect(page.getByRole('heading', { name: '账户与本机', level: 1 })).toBeVisible()

  // 登录页“LULUX”（本机）栏：本机账户登录后，本机锁仍由 PIN 解锁页把关
  await page.goto('/#/login')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'LULUX', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByLabel('用户名', { exact: true }).fill(E2E_LOCAL.username)
  await page.getByLabel('密码', { exact: true }).fill(E2E_LOCAL.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'LULUX ETA 已锁定' })).toBeVisible()
  await page.getByPlaceholder('输入 PIN').fill('2468')
  await page.getByRole('button', { name: '解锁' }).click()
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible()
  await page.goto('/#/settings/account')

  await page.getByRole('switch', { name: '启动时要求 PIN' }).click()
  await page.getByRole('dialog').getByLabel('当前 PIN').fill('2468')
  await page.getByRole('dialog').getByRole('button', { name: '关闭本机锁' }).click()
  await expect(page.getByRole('switch', { name: '启动时要求 PIN' })).toHaveAttribute('aria-checked', 'false')
  await page.reload()
  await expect(page.getByRole('heading', { name: '账户与本机', level: 1 })).toBeVisible()
})
