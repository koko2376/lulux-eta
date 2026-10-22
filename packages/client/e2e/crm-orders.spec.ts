import { expect, test, type Page } from '@playwright/test'

/**
 * 契约 §10.3 / §10.5 / §10.7 / §10.8 的界面闭环（真服务端）：
 * 客户详情建商机 → 看板改阶段（输单必须填原因）→ 漏斗加权金额按币种 →
 * 报价“转为订单” → 订单推进状态、填出运信息、登记收款（超额拦截）→ 工作台应收卡片 →
 * 备份：立即快照 → 恢复（确认“重启后生效”）→ 待恢复横幅 → 取消；
 * 设置 → 对话与工具 toolLoading；上游不可达（502）时测试连接显示服务端 message 与请求 ID。
 */
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
const COMPANY = `Orderline ${stamp} GmbH`
let customerId = ''
let quoteId = ''
let quoteNumber = ''

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

test('准备：客户 + 报价', async ({ page }) => {
  const c = await api<{ id: string }>(page, 'POST', '/api/customers', { company: COMPANY, country: 'Germany' })
  customerId = c.id
  const q = await api<{ id: string; number: string }>(page, 'POST', '/api/quotes', {
    customerId,
    currency: 'EUR',
    incoterm: 'FOB',
    port: 'Ningbo',
    items: [{ productId: null, name: 'Ball valve DN25', spec: 'PN16', qty: 1000, unit: 'pcs', unitPrice: 4.2 }],
  })
  quoteId = q.id
  quoteNumber = q.number
})

test('客户详情：新建商机，阶段改为输单必须填原因', async ({ page }) => {
  await page.goto(`/#/customers/${customerId}`)
  const section = page.getByTestId('customer-deals')
  await expect(section).toContainText('还没有商机')
  await section.getByTestId('new-deal').click()
  const dialog = page.getByRole('dialog', { name: '新建商机' })
  await dialog.locator('input[name=title]').fill(`阀门年单 ${stamp}`)
  await dialog.locator('input[name=amount]').fill('20,000')
  await dialog.locator('select[name=currency]').selectOption('EUR')
  await dialog.locator('select[name=stage]').selectOption('proposal')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()
  const row = section.getByTestId('deal-row').first()
  await expect(row).toContainText(`阀门年单 ${stamp}`)
  await expect(row).toContainText('EUR 20,000.00')
  await expect(row).toContainText('加权 EUR 10,000.00') // 方案报价默认 50%

  // 输单：先弹原因框，空原因不能提交，Esc 关闭后阶段不变
  await row.locator('select').selectOption('lost')
  const lost = page.getByRole('dialog', { name: /标记.*为输单/ })
  await expect(lost).toBeVisible()
  await lost.getByRole('button', { name: '标记输单' }).click()
  await expect(lost).toContainText('输单必须填写原因')
  await page.keyboard.press('Escape')
  await expect(lost).toBeHidden()
  await expect(row.locator('select')).toHaveValue('proposal')

  // 改到谈判：直接生效
  await row.locator('select').selectOption('negotiation')
  await expect(row).toContainText('加权 EUR 15,000.00')
})

test('看板：拖到另一列 / “移到…”改阶段；输单填原因后进入输单列；漏斗按币种加权', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const second = await api<{ id: string }>(page, 'POST', '/api/deals', {
    customerId,
    title: `美元试单 ${stamp}`,
    amount: 8000,
    currency: 'USD',
    stage: 'qualified',
  })
  await page.goto('/#/deals')
  const board = page.getByTestId('deal-board')
  const card = board.getByTestId('board-card').filter({ hasText: `美元试单 ${stamp}` })
  await expect(board.locator('[data-stage=qualified]')).toContainText(`美元试单 ${stamp}`)

  // 拖到“方案报价”
  await card.dragTo(board.locator('[data-stage=proposal]'))
  await expect(board.locator('[data-stage=proposal]')).toContainText(`美元试单 ${stamp}`)

  // 用“移到…”标记输单：必须填原因
  await board
    .getByTestId('board-card')
    .filter({ hasText: `美元试单 ${stamp}` })
    .locator('select.move')
    .selectOption('lost')
  const lost = page.getByRole('dialog', { name: /标记.*为输单/ })
  await lost.locator('textarea').fill('价格高于竞品 8%')
  await lost.getByRole('button', { name: '标记输单' }).click()
  await expect(lost).toBeHidden()
  await expect(board.locator('[data-stage=lost]')).toContainText('价格高于竞品 8%')
  const deal = await api<{ stage: string; lostReason: string; probability: number }>(
    page,
    'GET',
    `/api/deals/${second.id}`,
  )
  expect(deal).toMatchObject({ stage: 'lost', lostReason: '价格高于竞品 8%', probability: 0 })

  // 漏斗页：谈判阶段的 EUR 加权金额、输单原因
  await page.getByTestId('deals-funnel-tab').click()
  const table = page.getByTestId('funnel-table')
  await expect(table.locator('tr[data-stage=negotiation]')).toContainText('EUR')
  await expect(page.getByText('价格高于竞品 8%')).toBeVisible()
  await expect(page.getByText('5000%')).toHaveCount(0)
})

test('报价转为订单 → 推进状态 → 出运信息 → 登记收款（超额被拦截）→ 工作台应收', async ({ page }) => {
  await page.goto(`/#/quotation/${quoteId}`)
  await page.getByTestId('convert-order').click()
  const dialog = page.getByRole('dialog', { name: `把 ${quoteNumber} 转为订单` })
  await dialog.locator('input[name=depositAmount]').fill('1260')
  await dialog.getByRole('button', { name: '转为订单' }).click()
  await expect(page).toHaveURL(/#\/orders\/ord_/)
  await expect(page.getByTestId('order-balance')).toHaveText('EUR 4,200.00')

  // 回到报价：按钮变成“查看订单”
  const orderUrl = page.url()
  await page.goto(`/#/quotation/${quoteId}`)
  await expect(page.getByTestId('view-order')).toBeVisible()
  await expect(page.getByTestId('convert-order')).toHaveCount(0)
  await page.goto(orderUrl)

  // 状态步骤：待生产 → 生产中
  await expect(page.getByTestId('order-steps').locator('[aria-current=step]')).toContainText('待生产')
  await page.getByTestId('order-advance').click()
  await expect(page.getByTestId('order-steps').locator('[aria-current=step]')).toContainText('生产中')

  // 出运信息：ETA 早于 ETD 不能保存
  const ship = page.getByTestId('shipment-form')
  await ship.locator('select[name=containerType]').selectOption("40'HQ")
  await ship.locator('input[name=containerNo]').fill('MSKU1234567')
  await ship.locator('input[name=etd]').fill('2026-11-10')
  await ship.locator('input[name=eta]').fill('2026-11-01')
  await expect(ship).toContainText('ETA 不能早于 ETD')
  await expect(ship.getByRole('button', { name: '保存出运信息' })).toBeDisabled()
  await ship.locator('input[name=eta]').fill('2026-12-15')
  await ship.getByRole('button', { name: '保存出运信息' }).click()
  await expect(page.getByText('出运信息已保存')).toBeVisible()

  // 收款：超过余额被拦截；正常登记后余额减少
  await page.getByTestId('record-payment').click()
  const pay = page.getByRole('dialog', { name: '登记收款' })
  await pay.locator('input[name=amount]').fill('99999')
  await pay.getByRole('button', { name: '登记收款' }).click()
  await expect(pay).toContainText('不能超过待收余额')
  await pay.locator('input[name=amount]').fill('1200')
  await pay.locator('input[name=reference]').fill('TT-001')
  await pay.getByRole('button', { name: '登记收款' }).click()
  await expect(pay).toBeHidden()
  await expect(page.getByTestId('order-balance')).toHaveText('EUR 3,000.00')
  await expect(page.getByTestId('payment-table')).toContainText('TT-001')

  // 工作台应收卡片
  await page.goto('/#/')
  await expect(page.getByTestId('receivables-card')).toContainText('EUR')
})

test('备份：立即快照 → 恢复需确认“重启后生效” → 待恢复横幅 → 取消', async ({ page }) => {
  await page.goto('/#/settings/backup')
  const box = page.getByTestId('backup-snapshots')
  await box.getByTestId('snapshot-now').click()
  await expect(page.getByText('已创建快照')).toBeVisible()
  await box.getByTestId('restore-btn').first().click()
  const confirm = page.getByRole('dialog', { name: /恢复到快照/ })
  await expect(confirm).toContainText('重启')
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(box.getByTestId('restore-pending')).toHaveCount(0)

  await box.getByTestId('restore-btn').first().click()
  await page
    .getByRole('dialog', { name: /恢复到快照/ })
    .getByRole('button', { name: '重启后恢复' })
    .click()
  await expect(box.getByTestId('restore-pending')).toContainText('重启应用后生效')
  // 刷新后横幅仍在（来自服务端 GET /api/data/restore）
  await page.reload()
  await expect(page.getByTestId('restore-pending')).toBeVisible()
  await page.getByTestId('restore-cancel').click()
  await expect(page.getByTestId('restore-pending')).toHaveCount(0)
  const state = await api<{ pending: unknown }>(page, 'GET', '/api/data/restore')
  expect(state.pending).toBeNull()
})

test('设置 → 对话与工具：工具加载方式 auto / all 保存到服务端', async ({ page }) => {
  await page.goto('/#/settings/builtin')
  const row = page.getByTestId('tool-loading')
  await row.getByRole('radio', { name: '全部' }).click()
  await page.getByRole('button', { name: '保存' }).first().click()
  await expect
    .poll(
      async () => (await api<{ settings: Record<string, string> }>(page, 'GET', '/api/settings')).settings.toolLoading,
    )
    .toBe('all')
  await row.getByRole('radio', { name: '按需' }).click()
  await page.getByRole('button', { name: '保存' }).first().click()
  await expect
    .poll(
      async () => (await api<{ settings: Record<string, string> }>(page, 'GET', '/api/settings')).settings.toolLoading,
    )
    .toBe('auto')
})

test('上游不可达：测试连接 / 拉取模型显示服务端 message 与请求 ID', async ({ page }) => {
  // 用完即删：否则后续 spec（flow 的流式对话）会被这个不可达 Provider 接管
  const created = await api<{ provider?: { id: string }; id?: string }>(page, 'POST', '/api/providers', {
    name: `Unreachable ${stamp}`,
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-test-unreachable',
    model: 'x-model',
    models: ['x-model'],
  })
  await page.goto('/#/settings/models')
  const card = page.locator('.row-item.prov').filter({ hasText: `Unreachable ${stamp}` })
  await card.getByRole('button', { name: '测试连接' }).click()
  await expect(card.locator('.test-line.bad')).toContainText(/请求 ID：req_[0-9a-f]{16}/)
  await card.getByRole('button', { name: '拉取模型' }).click()
  const toast = page.locator('.toast.error').last()
  await expect(toast).toBeVisible()
  await expect(toast).not.toHaveText(/^\s*×?\s*$/)
  await expect(toast).toContainText(/请求 ID：req_[0-9a-f]{16}/)
  const id = created.provider?.id ?? created.id
  if (id) await api(page, 'DELETE', `/api/providers/${id}`)
})
